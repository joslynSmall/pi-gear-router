import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { defaultSettings } from "./gears.ts";
import { cloneSettings } from "./defaults.ts";
import type { Gear, GearSettings, GearTarget } from "./types.ts";

/** Overridable so tests and throwaway runs do not touch the user's real config. */
const DATA_DIR = process.env.PI_GEAR_ROUTER_DATA_DIR ?? join(homedir(), ".pi", "agent", "pi-gear-router");
const SETTINGS_PATH = join(DATA_DIR, "settings.json");

const GEAR_NAMES: readonly Gear[] = ["light", "standard", "heavy"];
const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
let cache: { signature: string; settings: GearSettings } | undefined;

/**
 * Read settings, falling back to defaults.
 *
 * Deliberately lenient: a malformed or partial file must not stop the agent from running, so
 * any gear we cannot read keeps its default target. gearshift is strict here and disables
 * routing; for a router that is an optimisation, degrading is better than failing.
 */
export function loadSettings(): GearSettings {
	let signature: string;
	try {
		const stat = statSync(SETTINGS_PATH, { bigint: true });
		signature = `${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
	} catch {
		cache = undefined;
		return defaultSettings();
	}
	if (cache?.signature === signature) return cloneSettings(cache.settings);
	let settings: GearSettings;
	try {
		settings = parseSettings(JSON.parse(readFileSync(SETTINGS_PATH, "utf8")));
	} catch {
		settings = defaultSettings();
	}
	cache = { signature, settings };
	return cloneSettings(settings);
}

function parseSettings(raw: unknown): GearSettings {
	const fallback = defaultSettings();
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
