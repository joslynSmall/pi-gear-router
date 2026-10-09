import { GENERIC_DEFAULT_GEARS } from "./defaults.ts";
import {
	HEAVY_XHIGH_MIN,
	LIGHT_MAX,
	MAX_BIAS_SHIFT,
	STANDARD_MAX,
	STANDARD_MEDIUM_MAX,
	type Band,
	type Gear,
	type GearSettings,
	type GearTarget,
} from "./types.ts";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";

export function clampScore(score: number): number {
	return Math.max(0, Math.min(2, score));
}

/**
 * Map a Jev score to a gear after applying the user's bias.
 *
 * `gearBias` in [-1, 1] shifts the score by up to `MAX_BIAS_SHIFT`, which is how the user
 * trades cost against quality without touching boundaries: negative bias shifts toward
 * cheaper gears, positive bias shifts toward stronger gears.
 */
export function gearForScore(
	score: number,
	gearBias: number,
): { gear: Gear; thinkingLevel: ModelThinkingLevel; adjustedScore: number } {
	const adjustedScore = clampScore(score + gearBias * MAX_BIAS_SHIFT);
	return { ...targetForBand(bandForScore(adjustedScore)), adjustedScore };
}

export function defaultSettings(): GearSettings {
	return {
		enabled: true,
		gearBias: 0,
		gears: structuredClone(GENERIC_DEFAULT_GEARS),
		judgeTimeoutMs: 15_000,
		taskRouting: { maxInheritedTurns: 3, downgradeWindow: 2, downgradeMargin: 0.08, minConfidence: 0.8 },
	};
}

export function bandForScore(score: number, bias = 0): Band {
	const adjusted = clampScore(score + bias * MAX_BIAS_SHIFT);
	return adjusted < LIGHT_MAX ? 0 : adjusted < STANDARD_MEDIUM_MAX ? 1 : adjusted < STANDARD_MAX ? 2 : adjusted < HEAVY_XHIGH_MIN ? 3 : 4;
}

const BAND_TARGETS: readonly { gear: Gear; thinkingLevel: ModelThinkingLevel }[] = [
	{ gear: "light", thinkingLevel: "low" },
	{ gear: "standard", thinkingLevel: "medium" },
	{ gear: "standard", thinkingLevel: "high" },
	{ gear: "heavy", thinkingLevel: "high" },
	{ gear: "heavy", thinkingLevel: "xhigh" },
];
export function targetForBand(band: Band): { gear: Gear; thinkingLevel: ModelThinkingLevel } {
	return { ...BAND_TARGETS[band]! };
}

export function gearTarget(settings: GearSettings, gear: Gear): GearTarget {
	return settings.gears[gear];
}
