import { validTarget } from "./settings.ts";
import type { Gear, GearJudgment, RouterState } from "./types.ts";

export function initialPlanGear(judgment?: GearJudgment): Gear {
	return judgment && judgment.confidence >= 0.8 && judgment.score < 1.5 ? "standard" : "heavy";
}
export function implementationGear(judgment: GearJudgment | undefined, planGear: Gear): Gear {
	return judgment && judgment.confidence >= 0.8 && judgment.score >= 1.5 ? planGear : "standard";
}
export const activeGear = (state: RouterState): Gear => state.phase === "implement" ? state.implementGear! : state.planGear;

/** Only a dialog candidate, never approval. The UI still must confirm ambiguous phrases. */
export function implementationHint(text: string): boolean {
	const match = /(?:开始实现|确认需求|需求已确认|按(?:这个)?(?:计划|方案)(?:做|实现)|批准(?:当前)?计划|start implementing|go ahead and implement|approve(?: the)? plan)/iu.exec(text);
	if (!match) return false;
	const before = text.slice(Math.max(0, match.index - 24), match.index).split(/[，。；,.!?\n]/u).at(-1) ?? "";
	return !/(?:不|无需|别|don[’']t|do not|not yet|never)/iu.test(before);
}

const gear = (v: unknown): v is Gear => v === "light" || v === "standard" || v === "heavy";
const text = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const judgment = (v: unknown): v is GearJudgment => {
	if (!v || typeof v !== "object") return false;
	const j = v as GearJudgment;
	return Number.isFinite(j.score) && j.score >= 0 && j.score <= 2 && Number.isFinite(j.confidence) && j.confidence >= 0 && j.confidence <= 1
		&& Number.isFinite(j.inputTokens) && j.inputTokens >= 0;
};

/** Old task two-phase state can preserve its phase; observer/workflow cannot be reinterpreted. */
export function parseState(value: unknown): RouterState | undefined {
	if (!value || typeof value !== "object") return;
	const raw = value as Record<string, unknown>;
	if (raw.version !== undefined && raw.version !== 2) return;
	const p = raw.version === 2 ? raw : raw.phaseRoute as Record<string, unknown> | undefined;
	if (!p || (raw.version !== 2 && p.version !== 1) || (p.phase !== "plan" && p.phase !== "implement") || !gear(p.planGear)
		|| (p.implementGear !== undefined && !gear(p.implementGear)) || (p.phase === "implement" && !gear(p.implementGear))) return;
	if (!gear(raw.gear) || (raw.dispatch !== undefined && !validTarget(raw.dispatch))) return;
	return {
		version: 2, phase: p.phase, planGear: p.planGear, gear: raw.gear, fallback: raw.fallback === true,
		...(gear(p.implementGear) ? { implementGear: p.implementGear } : {}),
		...(validTarget(raw.dispatch) ? { dispatch: { provider: raw.dispatch.provider, model: raw.dispatch.model, thinkingLevel: raw.dispatch.thinkingLevel } } : {}),
		...(text(raw.configKey) ? { configKey: raw.configKey } : {}),
		...(text(raw.turnKey) ? { turnKey: raw.turnKey } : {}),
		...(text(raw.phaseEntryId) ? { phaseEntryId: raw.phaseEntryId } : {}),
		...(judgment(raw.judgment) ? { judgment: { score: raw.judgment.score, confidence: raw.judgment.confidence, inputTokens: raw.judgment.inputTokens } } : {}),
		...(raw.judgeFailed === true ? { judgeFailed: true } : {}),
	};
}
