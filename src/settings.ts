import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { defaultSettings } from "./gears.ts";
import { cloneSettings } from "./defaults.ts";
import { MAX_BANDS, type BandSpec, type Gear, type GearSettings, type GearTarget } from "./types.ts";

/** Overridable so tests and throwaway runs do not touch the user's real config. */
const DATA_DIR = process.env.PI_GEAR_ROUTER_DATA_DIR ?? join(homedir(), ".pi", "agent", "pi-gear-router");
const SETTINGS_PATH = join(DATA_DIR, "settings.json");

/** Project-level override, mirroring the user layout under the project's `.pi` directory. */
export function projectSettingsPath(cwd: string): string {
	return join(cwd, ".pi", "pi-gear-router", "settings.json");
}

const GEAR_NAMES: readonly Gear[] = ["light", "standard", "heavy"];
const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
let cache: { signature: string; settings: GearSettings } | undefined;

/** File identity for the settings cache: changes whenever the file is replaced or rewritten. */
function fileSignature(path: string): string | undefined {
	try {
		const stat = statSync(path, { bigint: true });
		return `${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
	} catch { return undefined; }
}

function readJson(path: string): unknown {
	try { return JSON.parse(readFileSync(path, "utf8")); } catch { return undefined; }
}

/**
 * Read settings, falling back to defaults.
 *
 * Deliberately lenient: a malformed or partial file must not stop the agent from running, so
 * any gear we cannot read keeps its fallback target. gearshift is strict here and disables
 * routing; for a router that is an optimisation, degrading is better than failing.
 *
 * Passing `cwd` layers the project file `.pi/pi-gear-router/settings.json` over the user file:
 * fields it sets win, everything else inherits the user value, and an invalid project field
 * falls back to the user value rather than the built-in default.
 */
export function loadSettings(cwd?: string): GearSettings {
	const agentSignature = fileSignature(SETTINGS_PATH);
	const projectPath = cwd ? projectSettingsPath(cwd) : undefined;
	const projectSignature = projectPath ? fileSignature(projectPath) : undefined;
	const signature = `${agentSignature ?? "none"}|${projectPath ?? ""}|${projectSignature ?? "none"}`;
	if (cache?.signature === signature) return cloneSettings(cache.settings);
	const user = agentSignature ? parseSettings(readJson(SETTINGS_PATH), defaultSettings()) : defaultSettings();
	const settings = projectSignature && projectPath ? parseSettings(readJson(projectPath), user) : user;
	cache = { signature, settings };
	return cloneSettings(settings);
}

function parseSettings(raw: unknown, fallback: GearSettings): GearSettings {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return fallback;
	const file = raw as Record<string, unknown>;

	const gears = { ...fallback.gears };
	const fileGears = file.gears;
	if (typeof fileGears === "object" && fileGears !== null) {
		for (const gear of GEAR_NAMES) {
			const candidate = (fileGears as Record<string, unknown>)[gear];
			const target = readTarget(candidate);
			if (target) gears[gear] = target;
		}
	}

	return {
		enabled: typeof file.enabled === "boolean" ? file.enabled : fallback.enabled,
		gearBias: typeof file.gearBias === "number" && Math.abs(file.gearBias) <= 1 ? file.gearBias : fallback.gearBias,
		bands: readBands(file.bands, fallback.bands),
		gears,
		taskRouting: readPolicy(file.taskRouting, fallback.taskRouting),
		judgeTimeoutMs:
			typeof file.judgeTimeoutMs === "number" && Number.isFinite(file.judgeTimeoutMs) && file.judgeTimeoutMs > 0
				? file.judgeTimeoutMs
				: fallback.judgeTimeoutMs,
	};
}

function readPolicy(value: unknown, fallback: GearSettings["taskRouting"]): GearSettings["taskRouting"] {
	const raw = typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
	const read = (key: keyof typeof fallback, min: number, max: number, integer = false) => {
		const n = raw[key];
		return typeof n === "number" && Number.isFinite(n) && n >= min && n <= max && (!integer || Number.isInteger(n)) ? n : fallback[key];
	};
	return {
		maxInheritedTurns: read("maxInheritedTurns", 0, 10, true),
		downgradeWindow: read("downgradeWindow", 2, 8, true),
		downgradeMargin: read("downgradeMargin", 0, 0.15),
		minConfidence: read("minConfidence", 0.5, 1),
	};
}

function readBands(value: unknown, fallback: BandSpec[]): BandSpec[] {
	const defaults = () => fallback.map((band) => ({ ...band }));
	if (!Array.isArray(value) || value.length < 1 || value.length > MAX_BANDS) return defaults();
	const bands: BandSpec[] = [];
	for (let index = 0; index < value.length; index++) {
		const raw = value[index];
		if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return defaults();
		const record = raw as Record<string, unknown>;
		if (!GEAR_NAMES.includes(record.gear as Gear)) return defaults();
		if (typeof record.thinkingLevel !== "string" || !THINKING_LEVELS.has(record.thinkingLevel)) return defaults();
		const gear = record.gear as Gear;
		const thinkingLevel = record.thinkingLevel as BandSpec["thinkingLevel"];
		if (index === value.length - 1) {
			if (record.max !== undefined) return defaults();
			bands.push({ gear, thinkingLevel });
			continue;
		}
		const max = record.max;
		if (typeof max !== "number" || !Number.isFinite(max) || max <= 0 || max >= 2) return defaults();
		if (max <= (bands.at(-1)?.max ?? 0)) return defaults();
		bands.push({ max, gear, thinkingLevel });
	}
	return bands;
}

function readTarget(value: unknown): GearTarget | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const record = value as Record<string, unknown>;
	if (typeof record.provider !== "string" || !record.provider.trim()
		|| typeof record.model !== "string" || !record.model.trim()) return undefined;
	if (typeof record.thinkingLevel !== "string" || !THINKING_LEVELS.has(record.thinkingLevel)) return undefined;
	return {
		provider: record.provider,
		model: record.model,
		thinkingLevel: record.thinkingLevel as GearTarget["thinkingLevel"],
	};
}

export function saveSettings(settings: GearSettings): void {
	mkdirSync(dirname(SETTINGS_PATH), { recursive: true });
	writeFileSync(SETTINGS_PATH, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
	cache = undefined;
}

export { SETTINGS_PATH };
