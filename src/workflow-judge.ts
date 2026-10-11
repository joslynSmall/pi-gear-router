import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resilientFetch } from "./judge.ts";
import type {
	GearJudgment,
	JudgeInput,
	TaskRelation,
	WorkflowHandoffOutcome,
	WorkflowPacket,
	WorkflowPhase,
	WorkflowTurnOutcome,
} from "./types.ts";

const JEV_PROVIDER = "typesafe";
const JEV_MODEL = "jev-latest";
const RELATION_LABELS = ["same_task", "new_task", "uncertain"] as const satisfies readonly TaskRelation[];
const OBJECTIVE_LABELS = ["deliver", "plan_only", "research_only", "review", "question"] as const;
const START_LABELS = ["planning", "execution", "none"] as const;
const CLARITY_LABELS = ["low", "medium", "high"] as const;
const RISK_LABELS = ["low", "medium", "high"] as const;
const DELIVERY_LABELS = ["deliver", "not_deliver"] as const;
const READINESS_LABELS = ["ready", "needs_convergence", "blocked"] as const;

const validNumber = (value: unknown, min: number, max: number): value is number => typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
const failureText = (value: unknown): string => {
	const text = value instanceof Error ? value.message : typeof value === "string" ? value : "unknown-error";
	return (text.replace(/\s+/gu, " ").trim() || "unknown-error").slice(0, 200);
};
const describeFailure = (stopReason: string, errorMessage?: string): string => failureText(errorMessage ? `classify-${stopReason}: ${errorMessage}` : `classify-${stopReason}`);

function choice<T extends string>(answer: unknown, labels: readonly T[]): { choice: T; confidence: number; probability: number } | undefined {
	if (!answer || typeof answer !== "object") return;
	const a = answer as { type?: unknown; choice?: unknown; confidence?: unknown; probabilities?: unknown };
	if (a.type !== "choice" || typeof a.choice !== "string" || !labels.includes(a.choice as T) || !validNumber(a.confidence, 0, 1)
		|| !a.probabilities || typeof a.probabilities !== "object") return;
	const probabilities = a.probabilities as Record<string, unknown>;
	if (!labels.every(label => validNumber(probabilities[label], 0, 1))) return;
	const values = labels.map(label => probabilities[label] as number);
	const probability = probabilities[a.choice] as number;
	if (Math.abs(values.reduce((sum, value) => sum + value, 0) - 1) > .001 || probability < Math.max(...values)) return;
	return { choice: a.choice as T, confidence: a.confidence, probability };
}
function score(answer: unknown): GearJudgment | undefined {
	if (!answer || typeof answer !== "object") return;
	const a = answer as { type?: unknown; score?: unknown; confidence?: unknown };
	return a.type === "score" && validNumber(a.score, 0, 2) && validNumber(a.confidence, 0, 1)
		? { score: a.score, confidence: a.confidence, inputTokens: 0 } : undefined;
}
function usage(result: { usage?: { input?: unknown } }): { inputTokens: number; usageReported: boolean } {
	return validNumber(result.usage?.input, 0, Number.MAX_SAFE_INTEGER)
		? { inputTokens: result.usage!.input, usageReported: true }
		: { inputTokens: 0, usageReported: false };
}
function baseInput(input: JudgeInput): Record<string, unknown> {
	return {
		request: input.request,
		...(input.task ? { task: input.task } : {}),
		recent: input.recent,
		observations: input.observations,
		nonTextInput: input.nonTextInput,
	};
}

/** Classify a new user turn when opt-in workflow orchestration is active. */
export async function judgeWorkflowTurn(ctx: ExtensionContext, input: JudgeInput, timeoutMs: number, signal?: AbortSignal): Promise<WorkflowTurnOutcome> {
	const model = ctx.modelRegistry.getModelOfType("classifier", JEV_PROVIDER, JEV_MODEL);
	if (!model) return { kind: "unavailable", attempted: false, failure: "classifier-model-missing" };
	if (!input.request.trim()) return { kind: "unavailable", attempted: false, failure: "empty-request" };
	try {
		const result = await ctx.modelRegistry.classify(model, {
			state: baseInput(input) as unknown as import("@earendil-works/pi-ai").JsonObject,
			questions: {
				gear: { type: "score", instructions: "Rate the lowest model capability needed for the next coding-agent action. Consider the current request authoritative and use task/recent only for references.", criteria: [
					"Light: mechanical, low-risk and obvious work.", "Standard: typical coding-agent work with moderate uncertainty.", "Heavy: research, broad design, subtle debugging, high ambiguity or high-cost failure.",
				] },
				objective: { type: "choice", instructions: "What result does the user actually seek from this request?", criteria: {
					deliver: "Wants a completed change or verified result", plan_only: "Wants a plan/spec/design but not implementation", research_only: "Wants investigation or open-ended exploration only", review: "Wants review/evaluation of existing work", question: "Wants an answer without a deliverable workflow",
				} },
				start: { type: "choice", instructions: "Which workflow phase should start now? Use execution only if the request is already specific, low-risk enough, and needs no meaningful planning. Use none when no delivery workflow should start.", criteria: {
					planning: "Research, specification, design, task decomposition, or key uncertainty remains", execution: "A delivery task is clear enough for direct implementation", none: "No implementation workflow should start",
				} },
				clarity: { type: "choice", instructions: "How explicit are the implementation scope, constraints, and acceptance conditions for the immediate work?", criteria: {
					low: "Key scope or acceptance details are unknown", medium: "Some details are known but meaningful decisions remain", high: "Scope, approach and acceptance are sufficiently explicit",
				} },
				risk: { type: "choice", instructions: "What is the consequence of an incorrect next action?", criteria: {
					low: "Easy to review or revert; no material safety/data/compatibility concern", medium: "Normal implementation or compatibility risk", high: "Security, data loss, migration, release, permission or expensive failure risk",
				} },
				...(input.task ? { relation: { type: "choice", instructions: "How does the current authoritative request relate to the existing task?", criteria: {
					same_task: "Continues or changes the ongoing goal", new_task: "Introduces an independent goal", uncertain: "Context is insufficient to tell reliably",
				} } } : {}),
			},
		}, { ...(signal ? { signal } : {}), timeoutMs, fetch: resilientFetch(timeoutMs, signal) });
		if (result.stopReason !== "stop") return { kind: "unavailable", attempted: true, failure: describeFailure(result.stopReason, result.errorMessage) };
		const gear = score(result.answers.gear);
		const objective = choice(result.answers.objective, OBJECTIVE_LABELS);
		const start = choice(result.answers.start, START_LABELS);
		const clarity = choice(result.answers.clarity, CLARITY_LABELS);
		const risk = choice(result.answers.risk, RISK_LABELS);
		const u = usage(result);
		if (!gear) return { kind: "unavailable", attempted: true, failure: "invalid-answer" };
		gear.inputTokens = u.inputTokens;
		if (!objective || !start || !clarity || !risk) return { kind: "partial", fallbackJudgment: gear, usageReported: u.usageReported, attempted: true, failure: "invalid-workflow-answer" };
		const relation = input.task ? choice(result.answers.relation, RELATION_LABELS) : undefined;
		// Capability-score calibration selects a band, while workflow authorization is
		// about the independently selected intent/phase semantics. A low-confidence
		// score must not erase an otherwise high-confidence deliver/planning verdict.
		const judgment = {
			gear,
			confidence: Math.min(objective.confidence, objective.probability, start.confidence, start.probability, clarity.confidence, clarity.probability, risk.confidence, risk.probability),
			objective: objective.choice, start: start.choice, clarity: clarity.choice, risk: risk.choice,
		};
		if (!input.task) return { kind: "valid", judgment, usageReported: u.usageReported, attempted: true };
		if (!relation) return { kind: "partial", judgment, usageReported: u.usageReported, attempted: true };
		return {
			kind: "valid", judgment, relation: relation.choice, relationConfidence: relation.confidence,
			relationProbability: relation.probability, usageReported: u.usageReported, attempted: true,
		};
	} catch (error) { return { kind: "unavailable", attempted: true, failure: failureText(error) }; }
}

/** Independently validate whether a bounded packet can advance the current workflow phase. */
export async function judgeWorkflowHandoff(ctx: ExtensionContext, input: {
	objective: string;
	phase: WorkflowPhase;
	packet: WorkflowPacket;
	task?: { anchor: string; userChanges: string[] };
	validation: string[];
}, timeoutMs: number, signal?: AbortSignal): Promise<WorkflowHandoffOutcome> {
	const model = ctx.modelRegistry.getModelOfType("classifier", JEV_PROVIDER, JEV_MODEL);
	if (!model) return { kind: "unavailable", attempted: false, failure: "classifier-model-missing" };
	try {
		const result = await ctx.modelRegistry.classify(model, {
			state: {
				objective: input.objective, phase: input.phase, packet: input.packet,
				...(input.task ? { task: input.task } : {}), validation: input.validation,
			} as unknown as import("@earendil-works/pi-ai").JsonObject,
			questions: {
				delivery: { type: "choice", instructions: "Does the workflow objective and packet represent an implementation delivery rather than plan-only/research-only work?", criteria: {
					deliver: "A completed change or verified deliverable is intended", not_deliver: "The user only seeks planning, research, review or an answer",
				} },
				readiness: { type: "choice", instructions: "Is the packet sufficiently concrete and internally consistent to enter the requested next phase? Treat unresolved critical unknowns as blocked.", criteria: {
					ready: "The next phase can proceed from this packet", needs_convergence: "More planning or clarification is needed", blocked: "A critical unknown or contradiction prevents safe progress",
				} },
				risk: { type: "choice", instructions: "What risk level does the requested next phase have?", criteria: {
					low: "Easy to review or revert", medium: "Normal implementation risk", high: "Safety, data, security, release or high-cost risk",
				} },
				capability: { type: "score", instructions: "Rate the lowest model capability needed for the requested next phase based only on this bounded packet and context.", criteria: [
					"Light: atomic and mechanical.", "Standard: typical execution or verification.", "Heavy: deep recovery, subtle design or high risk.",
				] },
			},
		}, { ...(signal ? { signal } : {}), timeoutMs, fetch: resilientFetch(timeoutMs, signal) });
		if (result.stopReason !== "stop") return { kind: "unavailable", attempted: true, failure: describeFailure(result.stopReason, result.errorMessage) };
		const delivery = choice(result.answers.delivery, DELIVERY_LABELS);
		const readiness = choice(result.answers.readiness, READINESS_LABELS);
		const risk = choice(result.answers.risk, RISK_LABELS);
		const capability = score(result.answers.capability);
		if (!delivery || !readiness || !risk || !capability) return { kind: "unavailable", attempted: true, failure: "invalid-answer" };
		const u = usage(result);
		capability.inputTokens = u.inputTokens;
		// The handoff authorization gate is about the selected semantic choices.
		// Capability-score calibration chooses the requested execution band only.
		const confidence = Math.min(delivery.confidence, delivery.probability, readiness.confidence, readiness.probability, risk.confidence, risk.probability);
		return {
			kind: "valid",
			judgment: { delivery: delivery.choice, readiness: readiness.choice, risk: risk.choice, capability, confidence },
			usageReported: u.usageReported, attempted: true,
		};
	} catch (error) { return { kind: "unavailable", attempted: true, failure: failureText(error) }; }
}
