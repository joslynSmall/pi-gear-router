import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { defaultSettings } from "./gears.ts";
import type { Gear, GearSettings, GearTarget } from "./types.ts";

/** Overridable so tests and throwaway runs do not touch the user's real config. */
const DATA_DIR = process.env.PI_GEAR_ROUTER_DATA_DIR ?? join(homedir(), ".pi", "agent", "pi-gear-router");
const SETTINGS_PATH = join(DATA_DIR, "settings.json");

const GEAR_NAMES: readonly Gear[] = ["light", "standard", "heavy"];

/**
 * Read settings, falling back to defaults.
 *
 * Deliberately lenient: a malformed or partial file must not stop the agent from running, so
 * any gear we cannot read keeps its default target. gearshift is strict here and disables
 * routing; for a router that is an optimisation, degrading is better than failing.
 */
export function loadSettings(): GearSettings {
	const fallback = defaultSettings();
	let raw: unknown;
	try {
		if (!existsSync(SETTINGS_PATH)) return fallback;
		raw = JSON.parse(readFileSync(SETTINGS_PATH, "utf8"));
	} catch {
		return fallback;
	}
	if (typeof raw !== "object" || raw === null) return fallback;
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
		judgeTimeoutMs:
			typeof file.judgeTimeoutMs === "number" && file.judgeTimeoutMs > 0
				? file.judgeTimeoutMs
				: fallback.judgeTimeoutMs,
	};
}

function readTarget(value: unknown): GearTarget | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const record = value as Record<string, unknown>;
	if (typeof record.provider !== "string" || typeof record.model !== "string") return undefined;
	if (typeof record.thinkingLevel !== "string") return undefined;
	return {
		provider: record.provider,
		model: record.model,
		thinkingLevel: record.thinkingLevel as GearTarget["thinkingLevel"],
	};
}

export function saveSettings(settings: GearSettings): void {
	mkdirSync(dirname(SETTINGS_PATH), { recursive: true });
	writeFileSync(SETTINGS_PATH, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
}

export { SETTINGS_PATH };