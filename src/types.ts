import type { ModelThinkingLevel } from "@earendil-works/pi-ai";

export type Gear = "light" | "standard" | "heavy";
export type RoutingPhase = "plan" | "implement";
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export interface GearTarget { provider: string; model: string; thinkingLevel: ModelThinkingLevel }
export interface GearSettings { enabled: boolean; gears: Record<Gear, GearTarget>; judgeTimeoutMs: number }
export interface GearJudgment { score: number; confidence: number; inputTokens: number }
export type JudgeOutcome = { judgment: GearJudgment } | { failure: string };
export interface RouterState {
	version: 2;
	phase: RoutingPhase;
	planGear: Gear;
	implementGear?: Gear;
	/** Actual fallback gear; phase gears retain the requested capability. */
	gear: Gear;
	dispatch?: GearTarget;
	fallback: boolean;
	configKey?: string;
	turnKey?: string;
	phaseEntryId?: string;
	judgment?: GearJudgment;
	judgeFailed?: boolean;
}
