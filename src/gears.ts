import { GENERIC_DEFAULT_GEARS } from "./defaults.ts";
import {
	DEFAULT_BANDS,
	MAX_BIAS_SHIFT,
	type Band,
	type BandSpec,
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
	bands: readonly BandSpec[] = DEFAULT_BANDS,
): { gear: Gear; thinkingLevel: ModelThinkingLevel; adjustedScore: number } {
	const adjustedScore = clampScore(score + gearBias * MAX_BIAS_SHIFT);
	const spec = bands[bandForScore(adjustedScore, 0, bands)]!;
	return { gear: spec.gear, thinkingLevel: spec.thinkingLevel, adjustedScore };
}

export function defaultSettings(): GearSettings {
	return {
		enabled: true,
		gearBias: 0,
		bands: DEFAULT_BANDS.map((band) => ({ ...band })),
		gears: structuredClone(GENERIC_DEFAULT_GEARS),
		judgeTimeoutMs: 15_000,
		taskRouting: { maxInheritedTurns: 3, downgradeWindow: 2, downgradeMargin: 0.08, minConfidence: 0.8 },
	};
}

export function bandForScore(score: number, bias = 0, bands: readonly BandSpec[] = DEFAULT_BANDS): Band {
	const adjusted = clampScore(score + bias * MAX_BIAS_SHIFT);
	for (let index = 0; index < bands.length - 1; index++) {
		if (adjusted < bands[index]!.max!) return index;
	}
	return bands.length - 1;
}

export function targetForBand(settings: GearSettings, band: Band): { gear: Gear; thinkingLevel: ModelThinkingLevel } {
	const spec = settings.bands[band] ?? settings.bands[settings.bands.length - 1]!;
	return { gear: spec.gear, thinkingLevel: spec.thinkingLevel };
}

export function gearTarget(settings: GearSettings, gear: Gear): GearTarget {
	return settings.gears[gear];
}
