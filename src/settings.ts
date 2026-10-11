import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { defaultSettings } from "./defaults.ts";
import { THINKING_LEVELS, type Gear, type GearSettings, type GearTarget } from "./types.ts";

const DATA_DIR = process.env.PI_GEAR_ROUTER_DATA_DIR ?? join(homedir(), ".pi", "agent", "pi-gear-router");
export const SETTINGS_PATH = join(DATA_DIR, "settings.json");
export const projectSettingsPath = (cwd: string): string => join(cwd, ".pi", "pi-gear-router", "settings.json");
let cache: { signature: string; settings: GearSettings } | undefined;

function signature(path: string): string {
	try { const s = statSync(path, { bigint: true }); return `${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`; }
	catch { return "missing"; }
}

/** JSONC comments only: do not corrupt URLs or escaped quotes inside strings. */
function stripComments(text: string): string {
	let result = "", quoted = false, escaped = false;
	for (let i = 0; i < text.length; i++) {
		const c = text.charAt(i);
		if (quoted) {
			result += c;
			if (escaped) escaped = false; else if (c === "\\") escaped = true; else if (c === "\"") quoted = false;
		} else if (c === "\"") { quoted = true; result += c; }
		else if (c === "/" && text.charAt(i + 1) === "/") {
			while (i < text.length && text.charAt(i) !== "\n") i++;
			result += "\n";
		} else if (c === "/" && text.charAt(i + 1) === "*") {
			i += 2;
			while (i < text.length && !(text.charAt(i) === "*" && text.charAt(i + 1) === "/")) i++;
			i++; result += " ";
		} else result += c;
	}
	return result;
}

function readJson(path: string): unknown {
	try { return JSON.parse(stripComments(readFileSync(path, "utf8"))); } catch { return undefined; }
}
export function validTarget(value: unknown): value is GearTarget {
	if (!value || typeof value !== "object") return false;
	const v = value as GearTarget;
	return typeof v.provider === "string" && !!v.provider.trim() && typeof v.model === "string" && !!v.model.trim()
		&& THINKING_LEVELS.includes(v.thinkingLevel);
}
function overlay(raw: unknown, base: GearSettings): GearSettings {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return base;
	const r = raw as Record<string, unknown>, gears = { ...base.gears };
	if (r.gears && typeof r.gears === "object") for (const g of ["light", "standard", "heavy"] as Gear[]) {
		const target = (r.gears as Record<string, unknown>)[g];
		if (validTarget(target)) gears[g] = { provider: target.provider, model: target.model, thinkingLevel: target.thinkingLevel };
	}
	return {
		enabled: typeof r.enabled === "boolean" ? r.enabled : base.enabled, gears,
		judgeTimeoutMs: typeof r.judgeTimeoutMs === "number" && Number.isFinite(r.judgeTimeoutMs) && r.judgeTimeoutMs > 0 && r.judgeTimeoutMs <= 2_147_483_647 ? r.judgeTimeoutMs : base.judgeTimeoutMs,
	};
}

/** Read-only. Unknown/retired fields have no effect; untrusted projects cannot redirect models. */
export function loadSettings(cwd?: string, options: { projectTrusted?: boolean } = {}): GearSettings {
	const project = cwd && options.projectTrusted === true ? projectSettingsPath(cwd) : undefined;
	const key = `${SETTINGS_PATH}:${signature(SETTINGS_PATH)}|${project ?? ""}:${project ? signature(project) : ""}`;
	if (cache?.signature === key) return structuredClone(cache.settings);
	const user = overlay(readJson(SETTINGS_PATH), defaultSettings());
	const settings = project ? overlay(readJson(project), user) : user;
	cache = { signature: key, settings };
	return structuredClone(settings);
}
