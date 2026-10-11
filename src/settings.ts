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

/** Strip line and block comments from JSONC while preserving string contents such as `https://`. */
function stripJsonComments(text: string): string {
	let result = "";
	let inString = false;
	let escaped = false;
	for (let index = 0; index < text.length; index++) {
		const char = text.charAt(index);
		if (inString) {
			result += char;
			if (escaped) escaped = false;
			else if (char === "\\") escaped = true;
			else if (char === "\"") inString = false;
			continue;
		}
		if (char === "\"") { inString = true; result += char; continue; }
		if (char === "/" && text.charAt(index + 1) === "/") {
			while (index < text.length && text.charAt(index) !== "\n") index++;
			result += "\n";
			continue;
		}
		if (char === "/" && text.charAt(index + 1) === "*") {
			index += 2;
			while (index < text.length && !(text.charAt(index) === "*" && text.charAt(index + 1) === "/")) index++;
			index++;
			result += " ";
			continue;
		}
		result += char;
	}
	return result;
}

function readJson(path: string): unknown {
	try { return JSON.parse(stripJsonComments(readFileSync(path, "utf8"))); } catch { return undefined; }
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
 * falls back to the user value rather than the built-in default. Exceptions: an invalid
 * explicit mode disables observer opt-in; when observer is selected/requested, project
 * overrides require `projectTrusted:true`. Missing trust capability is not consent.
 */
export function loadSettings(cwd?: string, options: { projectTrusted?: boolean } = {}): GearSettings {
	const agentSignature = fileSignature(SETTINGS_PATH);
	const projectPath = cwd ? projectSettingsPath(cwd) : undefined;
	const projectSignature = projectPath ? fileSignature(projectPath) : undefined;
	const signature = `${agentSignature ?? "none"}|${projectPath ?? ""}|${projectSignature ?? "none"}|${options.projectTrusted === true}`;
	if (cache?.signature === signature) return cloneSettings(cache.settings);
	const user = agentSignature ? parseSettings(readJson(SETTINGS_PATH), defaultSettings()) : defaultSettings();
	const project = projectSignature && projectPath ? readJson(projectPath) : undefined;
	const projectRecord = typeof project === "object" && project !== null && !Array.isArray(project) ? project as Record<string, unknown> : {};
	// Protect all project router fields when observer is selected or requested; do not
	// alter the existing task/legacy overlay contract when observer is not involved.
	const observerScope = user.routingMode === "observer" || projectRecord.routingMode === "observer";
	const settings = observerScope && options.projectTrusted !== true ? user : parseSettings(project, user);
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
		workflow: readWorkflow(file.workflow, fallback.workflow, readBands(file.bands, fallback.bands).length),
		...readMode(file, fallback),
		observer: readObserver(file.observer, fallback.observer),
		judgeTimeoutMs:
			typeof file.judgeTimeoutMs === "number" && Number.isFinite(file.judgeTimeoutMs) && file.judgeTimeoutMs > 0
				? file.judgeTimeoutMs
				: fallback.judgeTimeoutMs,
	};
}

function readMode(file: Record<string, unknown>, fallback: GearSettings): Pick<GearSettings, "routingMode" | "routingModeInvalid"> {
	if (!Object.hasOwn(file, "routingMode")) return {
		...(fallback.routingMode !== undefined ? { routingMode: fallback.routingMode } : {}),
		...(fallback.routingModeInvalid ? { routingModeInvalid: true } : {}),
	};
	const mode = file.routingMode;
	if (mode === "observer" || mode === "task" || mode === "legacy-workflow") return { routingMode: mode };
	return { routingModeInvalid: true };
}

function readObserver(value: unknown, fallback: GearSettings["observer"]): GearSettings["observer"] {
	const raw = (v: unknown): Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v) ? v as Record<string, unknown> : {};
	const r = raw(value), g = raw(r.guidance), skills = raw(r.skills), floors = raw(r.minBands);
	const flag = (v: unknown, f: boolean) => typeof v === "boolean" ? v : f;
	const integer = (v: unknown, f: number, min: number, max: number) => typeof v === "number" && Number.isSafeInteger(v) && v >= min && v <= max ? v : f;
	return {
		guidance: { enabled: flag(g.enabled, fallback.guidance.enabled),
			maxCandidates: integer(g.maxCandidates, fallback.guidance.maxCandidates, 0, 2),
			maxChars: integer(g.maxChars, fallback.guidance.maxChars, 1, 800),
			maxPerTask: integer(g.maxPerTask, fallback.guidance.maxPerTask, 0, 12) },
		skills: { enabled: flag(skills.enabled, fallback.skills.enabled) },
		stageAware: flag(r.stageAware, fallback.stageAware),
		minBands: {
			converge: integer(floors.converge, fallback.minBands.converge, 0, Number.MAX_SAFE_INTEGER),
			implement: integer(floors.implement, fallback.minBands.implement, 0, Number.MAX_SAFE_INTEGER),
			verify: integer(floors.verify, fallback.minBands.verify, 0, Number.MAX_SAFE_INTEGER),
			respond: integer(floors.respond, fallback.minBands.respond, 0, Number.MAX_SAFE_INTEGER),
		},
		maxCallsPerTask: integer(r.maxCallsPerTask, fallback.maxCallsPerTask, 1, 64),
		maxTransitions: integer(r.maxTransitions, fallback.maxTransitions, 1, 8),
		maxTransportRetries: integer(r.maxTransportRetries, fallback.maxTransportRetries, 0, 1) as 0 | 1,
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

function readWorkflow(value: unknown, fallback: GearSettings["workflow"], bandCount: number): GearSettings["workflow"] {
	const raw = typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
	const band = (key: keyof Pick<GearSettings["workflow"], "planningMinBand" | "executionMinBand" | "atomicExecutionMinBand" | "verificationMinBand" | "recoveryMinBand">) => {
		const n = raw[key];
		return typeof n === "number" && Number.isInteger(n) && n >= 0 && n < bandCount ? n : Math.min(fallback[key], bandCount - 1);
	};
	const confidence = raw.handoffMinConfidence;
	const transitions = raw.maxTransitions;
	const reminders = raw.maxReminderContinuations;
	return {
		enabled: typeof raw.enabled === "boolean" ? raw.enabled : fallback.enabled,
		planningMinBand: band("planningMinBand"),
		executionMinBand: band("executionMinBand"),
		atomicExecutionMinBand: band("atomicExecutionMinBand"),
		verificationMinBand: band("verificationMinBand"),
		recoveryMinBand: band("recoveryMinBand"),
		handoffMinConfidence: typeof confidence === "number" && Number.isFinite(confidence) && confidence >= .5 && confidence <= 1 ? confidence : fallback.handoffMinConfidence,
		maxTransitions: typeof transitions === "number" && Number.isInteger(transitions) && transitions >= 1 && transitions <= 8 ? transitions : fallback.maxTransitions,
		maxReminderContinuations: reminders === 0 || reminders === 1 ? reminders : fallback.maxReminderContinuations,
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
