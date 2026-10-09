import { GENERIC_DEFAULT_GEARS } from "./defaults.ts";
import {
	LIGHT_MAX,
	MAX_BIAS_SHIFT,
	STANDARD_MAX,
	type Gear,
	type GearSettings,
	type GearTarget,
} from "./types.ts";

export function clampScore(score: number): number {
	return Math.max(0, Math.min(2, score));
}

/**
 * Map a Jev score to a gear after applying the user's bias.
 *
 * `gearBias` in [-1, 1] shifts the score by up to `MAX_BIAS_SHIFT`, which is how the user
 * trades cost against quality without touching boundaries: -1 keeps nearly everything on
 * standard, +1 pushes borderline work to heavy.
 */
export function gearForScore(score: number, gearBias: number): { gear: Gear; adjustedScore: number } {
	const adjustedScore = clampScore(score + gearBias * MAX_BIAS_SHIFT);
	const gear: Gear = adjustedScore < LIGHT_MAX ? "light" : adjustedScore < STANDARD_MAX ? "standard" : "heavy";
	return { gear, adjustedScore };
}

export function defaultSettings(): GearSettings {
	return {
		enabled: true,
		gearBias: 0,
		gears: { ...GENERIC_DEFAULT_GEARS },
		judgeTimeoutMs: 15_000,
	};
}

export function gearTarget(settings: GearSettings, gear: Gear): GearTarget {
	return settings.gears[gear];
}

export function describeGear(target: GearTarget): string {
	return `${target.provider}/${target.model} @ ${target.thinkingLevel}`;
}