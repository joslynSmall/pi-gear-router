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
	/** Raw Jev score before bias, for display. `-1` when the verdict fell back without a fresh score. */
	score: number;
	/** Score after bias, which is what the mapping actually used. */
	adjustedScore: number;
	/** Confidence reported by Jev. */
	confidence: number;
	/** Stable user entry identity plus content hash. Optional for legacy session states. */
	turnId?: string;
	/** Tokens Jev consumed for the verdict. Optional on legacy states. */
	inputTokens?: number;
	/** True when classification or target selection fell back. */
	fallback?: boolean;
	fallbackReason?: "judge-unavailable" | "target-unavailable" | "disabled";
	/** Actual physical pair, frozen for the turn even if configuration changes. */
	dispatch?: GearTarget;
	task?: TaskState;
	decision?: DecisionTrace;
}

/** Minimal recent message shape sent to the classifier. */
export interface RecentMessage {
	role: "user" | "assistant";
	text: string;
}

export interface GearSettings {
	/** False bypasses routing and passes the previously used model through. True by default. */
	enabled: boolean;
	/** -1..1 shifts scores by up to ±0.4. 0 is neutral. */
	gearBias: number;
	gears: Record<Gear, GearTarget>;
	/** Jev call timeout in milliseconds. Decision calls need more than the usual 5s. */
	judgeTimeoutMs: number;
	taskRouting: TaskRoutingSettings;
}

export type Band = 0 | 1 | 2 | 3 | 4;
export type TaskRelation = "same_task" | "new_task" | "uncertain";
export interface TaskRoutingSettings {
	maxInheritedTurns: number;
	downgradeWindow: number;
	downgradeMargin: number;
	minConfidence: number;
}
export interface Sample {
	turnId: string;
	evidenceKey: string;
	rawScore: number;
	confidence: number;
}
export interface TaskState {
	version: 1;
	taskId: string;
	anchor: string;
	userChanges: string[];
	continuity: "confirmed" | "uncertain";
	committedBand: Band;
	committedRawScore: number;
	biasAtCommit: number;
	samples: Sample[];
	seenEvidenceKeys: string[];
	lastJudgment: Sample;
	inheritedTurns: number;
	review?: { evidenceKey: string; expedited: boolean };
	requireRejudge: boolean;
	policyFingerprint: string;
	observationCursor?: string;
}
export interface DecisionTrace {
	source: "judged" | "inherited" | "fallback";
	trigger: string;
	action: "new-task" | "upgrade" | "hold" | "downgrade" | "uncertain" | "inherit" | "fallback" | "config-remap";
	classifierAttempted: boolean;
	scoreTurnId?: string;
	requestedBand?: Band;
	windowMaxRaw?: number;
	protectedScore?: number;
	provisionalBand?: Band;
	relation?: TaskRelation;
	relationConfidence?: number;
	relationProbability?: number;
	usageReported?: boolean;
}
export interface BranchFacts {
	coverage: "known" | "unknown";
	nextCursor?: string;
	verificationFailed: boolean;
	completionHint: boolean;
	manualModelGap: boolean;
	contextMissing: boolean;
}
export interface JudgeInput {
	request: string;
	task?: { anchor: string; userChanges: string[] };
	recent: RecentMessage[];
	observations: string[];
	nonTextInput: boolean;
}
export interface JudgeOutcome {
	kind: "valid" | "partial" | "unavailable";
	judgment?: GearJudgment;
	relation?: TaskRelation;
	relationConfidence?: number;
	relationProbability?: number;
	usageReported?: boolean;
	attempted?: boolean;
}

/** Score thresholds for the five model/thinking-level bands. */
export const LIGHT_MAX = 0.5;
export const STANDARD_MEDIUM_MAX = 1;
export const STANDARD_MAX = 1.5;
export const HEAVY_XHIGH_MIN = 1.8;

/** Largest score shift `gearBias` of 1 can apply. */
export const MAX_BIAS_SHIFT = 0.4;