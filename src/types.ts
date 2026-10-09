import type { ModelThinkingLevel } from "@earendil-works/pi-ai";

/** Capability tiers, in increasing order. Jev scores 0..2 and lands on one of these. */
export const GEARS = ["light", "standard", "heavy"] as const;
export type Gear = (typeof GEARS)[number];

/** A physical model plus the thinking level to run it at. */
export interface GearTarget {
	provider: string;
	model: string;
	thinkingLevel: ModelThinkingLevel;
}

/** Jev's verdict for one turn. */
export interface GearJudgment {
	/** 0..2 continuous complexity score. */
	score: number;
	/** 0..1 classifier confidence in that score. */
	confidence: number;
	/** Tokens Jev consumed for the verdict. */
	inputTokens: number;
}

/** Router state persisted on the session branch. */
export interface GearState {
	/** Gear chosen for the current turn. */
	gear: Gear;
	/** Raw Jev score before bias, for display. */
	score: number;
	/** Score after bias, which is what the mapping actually used. */
	adjustedScore: number;
	/** Confidence reported by Jev. */
	confidence: number;
}

/** Minimal recent message shape sent to the classifier. */
export interface RecentMessage {
	role: "user" | "assistant";
	text: string;
}

export interface GearSettings {
	/** Off by default: the user opts in after the wizard. */
	enabled: boolean;
	/** -1 routes everything down, +1 routes everything up. 0 is neutral. */
	gearBias: number;
	gears: Record<Gear, GearTarget>;
	/** Jev call timeout in milliseconds. Decision calls need more than the usual 5s. */
	judgeTimeoutMs: number;
}

/** Score below this is light, below the next boundary is standard, above is heavy. */
export const LIGHT_MAX = 0.5;
export const STANDARD_MAX = 1.5;

/** Largest score shift `gearBias` of 1 can apply. */
export const MAX_BIAS_SHIFT = 0.4;