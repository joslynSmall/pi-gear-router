import type { GearSettings, GearTarget } from "./types.ts";

/**
 * Generic defaults: any provider with three capability tiers can use these by editing ids.
 *
 * Thinking levels matter as much as the models. `light` defaults to `high`, matching the
 * light capability band. A reasoning-heavy cheap model can still spend its whole output
 * budget on reasoning and return an empty answer, which reads to the user as "the cheap
 * tier is broken"; validate a light model against real tasks and pin it lower if it does.
 */
export const GENERIC_DEFAULT_GEARS: Record<"light" | "standard" | "heavy", GearTarget> = {
	light: { provider: "anthropic", model: "claude-haiku-4-5", thinkingLevel: "high" },
	standard: { provider: "anthropic", model: "claude-sonnet-4-5", thinkingLevel: "medium" },
	heavy: { provider: "anthropic", model: "claude-opus-4-5", thinkingLevel: "high" },
};

/**
 * Defaults measured against a local Magpie gateway (2026-10-09), eight real coding tasks.
 *
 * Why these and not the obvious cheap/free models:
 *
 * - `light` = space-bunny-free. This endpoint marks it free. The shipped default thinking
 *   level is `high` (matching the routing band); note the 2026-10-09 measurement at `high`
 *   burned the entire output budget on reasoning and returned empty bodies on two of eight
 *   tasks, while `low` answered normally. Keep the default only if your traffic tolerates
 *   that failure mode, otherwise pin this model to `low`.
 * - `standard` = gpt-6-luna @ high. Cleared all eight tasks and was the fastest tier
 *   measured (85s total vs 271s for gpt-6.1-sol on the same set).
 * - `heavy` = gpt-6.1-sol @ high. Cleared all eight tasks including subtle-debugging and
 *   design prompts; slower and slightly longer output than luna.
 *
 * deepseek-v4.1-flash was rejected as `light`: at `high` it exhausted the 4000-token budget
 * on four of eight tasks and returned a 502 on a fifth. Its cheapness does not survive contact
 * with real tasks.
 *
 * Copy this block into `settings.gears` in `~/.pi/agent/pi-gear-router/settings.json` to use it.
 */
export const MAGPIE_DEFAULT_GEARS: Record<"light" | "standard" | "heavy", GearTarget> = {
	light: { provider: "magpie", model: "luckyg/space-bunny-free", thinkingLevel: "high" },
	standard: { provider: "magpie", model: "zies/gpt-6-luna", thinkingLevel: "high" },
	heavy: { provider: "magpie", model: "zies/gpt-6.1-sol", thinkingLevel: "high" },
};

export function cloneSettings(settings: GearSettings): GearSettings {
	return structuredClone(settings);
}
