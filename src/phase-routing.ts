import type { Gear, GearJudgment } from "./types.ts";

export type RoutingPhase = "plan" | "implement";
export interface PhaseRouteState {
	version: 1;
	phase: RoutingPhase;
	revising: boolean;
	/** The model/thinking pair selected for plan and kept until the one allowed switch. */
	planGear: Gear;
	/** The model/thinking pair selected once for implementation. */
	implementGear?: Gear;
}

const EXPLICIT_IMPLEMENT = /(?:开始实现|按这个(?:计划)?(?:做|实现)|批准(?:当前)?计划|implement(?: the)?|start implementing|approve(?: the)? plan)/iu;
const EXPLICIT_REVISION = /(?:先停|计划有(?:问题|遗漏|偏差)|stop and revise|plan is wrong)/iu;
const PLAN_SKILLS = /(?:requirement|spec|research|explor|plan|design|需求|调研|探索|计划|设计)/iu;
const IMPLEMENT_SKILLS = /(?:implement|verif|test|debug|执行|实现|验证|测试)/iu;

/** A bounded binary judgment. The caller supplies the classifier result; this never invents one. */
export type PhaseChoice = "开始实现" | "继续计划" | "自己补充";
export const PHASE_CHOICES = ["开始实现", "继续计划", "自己补充"] as const;

/** A clicked choice is explicit. Free text must itself contain an explicit intent; blank and cancellation do not. */
export function phaseChoiceIntent(choice: string | undefined, freeText?: string): "implement" | "revise" | "stay" | undefined {
	if (choice === "开始实现") return "implement";
	if (choice === "继续计划") return "stay";
	if (choice === "自己补充") return explicitPhaseIntent(freeText ?? "") ?? "stay";
	if (choice !== undefined) return;
	return explicitPhaseIntent(freeText ?? "");
}

export function explicitPhaseIntent(text: string): "implement" | "revise" | undefined {
	if (typeof text !== "string") return;
	const value = text.trim();
	if (!value || value.length > 500) return;
	if (EXPLICIT_IMPLEMENT.test(value)) return "implement";
	if (EXPLICIT_REVISION.test(value)) return "revise";
}

/** Plan starts on heavy unless the first verdict is confidently ordinary. */
export function initialPlanGear(judgment: GearJudgment | undefined): Gear {
	return judgment && judgment.confidence >= 0.8 && judgment.score < 1.5 ? "standard" : "heavy";
}

/** Implementation uses the lower-thinking gear unless the work remains confidently hard. */
export function implementationGear(judgment: GearJudgment | undefined, planGear: Gear): Gear {
	return judgment && judgment.confidence >= 0.8 && judgment.score >= 1.5 ? planGear : "standard";
}

export function activeGear(state: PhaseRouteState): Gear {
	return state.phase === "implement" && state.implementGear ? state.implementGear : state.planGear;
}

/** Recommendation category follows routing hints, not tool permissions or the model's prose. */
export function skillCategory(state: PhaseRouteState): "plan" | "implement" {
	return state.phase === "plan" || state.revising ? "plan" : "implement";
}

export function skillMatchesPhase(name: string, description: string, category: "plan" | "implement"): boolean {
	const text = `${name} ${description}`;
	return category === "plan" ? PLAN_SKILLS.test(text) && !IMPLEMENT_SKILLS.test(text) : IMPLEMENT_SKILLS.test(text);
}

export function validPhaseState(value: unknown): PhaseRouteState | undefined {
	if (!value || typeof value !== "object") return;
	const state = value as Partial<PhaseRouteState>;
	const gear = (item: unknown): item is Gear => item === "light" || item === "standard" || item === "heavy";
	if (state.version !== 1 || (state.phase !== "plan" && state.phase !== "implement") || typeof state.revising !== "boolean" || !gear(state.planGear)) return;
	if (state.implementGear !== undefined && !gear(state.implementGear)) return;
	if (state.phase === "implement" && !state.implementGear) return;
	if (state.phase === "plan" && state.revising) return;
	return { version: 1, phase: state.phase, revising: state.revising, planGear: state.planGear, ...(state.implementGear ? { implementGear: state.implementGear } : {}) };
}
