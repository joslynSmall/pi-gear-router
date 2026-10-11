import type { GearSettings } from "./types.ts";

/** Configure models already present and authenticated in Pi, in capability order. */
export function defaultSettings(): GearSettings {
	return {
		enabled: true, judgeTimeoutMs: 15_000,
		gears: {
			light: { provider: "anthropic", model: "claude-haiku-4-5", thinkingLevel: "high" },
			standard: { provider: "anthropic", model: "claude-sonnet-4-5", thinkingLevel: "medium" },
			heavy: { provider: "anthropic", model: "claude-opus-4-5", thinkingLevel: "high" },
		},
	};
}
