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
		observer: {
			guidance: { enabled: true, maxCandidates: 2, maxChars: 800, maxPerTask: 6 },
			skills: { enabled: true }, stageAware: true,
			minBands: { converge: 3, implement: 1, verify: 1, respond: 0 },
			maxCallsPerTask: 24, maxTransitions: 4, maxTransportRetries: 0,
		},
		workflow: {
			enabled: false,
			planningMinBand: 3,
			executionMinBand: 1,
			atomicExecutionMinBand: 0,
			verificationMinBand: 1,
			recoveryMinBand: 3,
			handoffMinConfidence: 0.8,
			maxTransitions: 6,
			maxReminderContinuations: 1,
		},
	};
}

/** Single mode resolver; runtime consumers are migrated together at task 6.2. */
export function resolveRoutingMode(settings: Pick<GearSettings, "enabled" | "workflow" | "routingMode" | "routingModeInvalid">): {
	mode: "disabled" | "task" | "legacy-workflow" | "observer";
	diagnostic?: "invalid-mode" | "mode-conflict";
} {
	if (!settings.enabled) return { mode: "disabled" };
	const mode = settings.routingMode;
	const legacy = settings.workflow.enabled;
	if (settings.routingModeInvalid || (mode !== undefined && !["task", "legacy-workflow", "observer"].includes(mode))) {
		return { mode: legacy ? "legacy-workflow" : "task", diagnostic: "invalid-mode" };
	}
	if (legacy && (mode === "observer" || mode === "task")) return { mode: "legacy-workflow", diagnostic: "mode-conflict" };
	return { mode: mode ?? (legacy ? "legacy-workflow" : "task") };
}

/** Out-of-table floors protect with the highest available band, never the cheapest. */
export function resolveObserverPolicy(settings: GearSettings) {
	const observer = structuredClone(settings.observer);
	const clampedFloors: (keyof typeof observer.minBands)[] = [];
	for (const profile of Object.keys(observer.minBands) as (keyof typeof observer.minBands)[]) {
		if (observer.minBands[profile] >= settings.bands.length) {
			observer.minBands[profile] = settings.bands.length - 1;
			clampedFloors.push(profile);
		}
	}
	return { ...observer, clampedFloors };
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
