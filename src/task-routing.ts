import { createHash } from "node:crypto";
import type { Message } from "@earendil-works/pi-ai";
import { bandForScore, clampScore } from "./gears.ts";
import { buildTaskContext, CONTEXT_VERSION, isContinuation, truncate } from "./task-context.ts";
import type { Band, BranchFacts, DecisionTrace, GearJudgment, GearSettings, GearState, JudgeInput, JudgeOutcome, Sample, TaskState } from "./types.ts";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function policyFingerprint(settings: GearSettings): string {
	return hash({ version: `task-window-v1:${CONTEXT_VERSION}:judge-task-v1:verify-command-v1`, classifier: "typesafe/jev-latest", enabled: settings.enabled,
		bias: settings.gearBias, gears: [settings.gears.light, settings.gears.standard, settings.gears.heavy].map(t => [t.provider, t.model, t.thinkingLevel]), timeout: settings.judgeTimeoutMs,
		policy: [settings.taskRouting.maxInheritedTurns, settings.taskRouting.downgradeWindow, settings.taskRouting.downgradeMargin, settings.taskRouting.minConfidence] });
}
const finite = (v: unknown, min: number, max: number) => typeof v === "number" && Number.isFinite(v) && v >= min && v <= max;
const string = (v: unknown, max = 256) => typeof v === "string" && v.length > 0 && v.length <= max;
const digest = (v: unknown) => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
function sample(v: Sample): boolean {
	return !!v && string(v.turnId) && digest(v.evidenceKey) && finite(v.rawScore, 0, 2) && finite(v.confidence, 0, 1);
}
export function validTask(value: unknown): TaskState | undefined {
	try {
		if (!value || typeof value !== "object" || Buffer.byteLength(JSON.stringify(value)) > 65536) return;
		const t = value as TaskState;
		if (t.version !== 1 || !string(t.taskId, 300) || !string(t.anchor, 16000) || Array.from(t.anchor).length > 4000
			|| !["confirmed", "uncertain"].includes(t.continuity) || !Number.isInteger(t.committedBand) || !finite(t.committedBand, 0, 4)
			|| !finite(t.committedRawScore, 0, 2) || !finite(t.biasAtCommit, -1, 1) || !digest(t.policyFingerprint)
			|| !Number.isInteger(t.inheritedTurns) || !finite(t.inheritedTurns, 0, 10) || typeof t.requireRejudge !== "boolean"
			|| !Array.isArray(t.userChanges) || t.userChanges.length > 3 || t.userChanges.some(v => typeof v !== "string")
			|| t.userChanges.reduce((n, v) => n + Array.from(v).length, 0) > 3000
			|| !Array.isArray(t.samples) || t.samples.length > 8 || !t.samples.every(sample)
			|| new Set(t.samples.map(v => v.evidenceKey)).size !== t.samples.length
			|| !Array.isArray(t.seenEvidenceKeys) || t.seenEvidenceKeys.length > 32 || !t.seenEvidenceKeys.every(digest)
			|| !sample(t.lastJudgment) || (t.observationCursor !== undefined && !string(t.observationCursor))
			|| (t.review !== undefined && (!digest(t.review.evidenceKey) || typeof t.review.expedited !== "boolean"))) return;
		// Do not propagate unknown persisted fields into the next candidate state.
		const cleanSample = (s: Sample): Sample => ({ turnId: s.turnId, evidenceKey: s.evidenceKey, rawScore: s.rawScore, confidence: s.confidence });
		return structuredClone({
			version: t.version, taskId: t.taskId, anchor: t.anchor, userChanges: t.userChanges,
			continuity: t.continuity, committedBand: t.committedBand, committedRawScore: t.committedRawScore,
			biasAtCommit: t.biasAtCommit, samples: t.samples.map(cleanSample), seenEvidenceKeys: t.seenEvidenceKeys,
			lastJudgment: cleanSample(t.lastJudgment), inheritedTurns: t.inheritedTurns, requireRejudge: t.requireRejudge,
			policyFingerprint: t.policyFingerprint, ...(t.review ? { review: { evidenceKey: t.review.evidenceKey, expedited: t.review.expedited } } : {}),
			...(t.observationCursor ? { observationCursor: t.observationCursor } : {}),
		});
	} catch { return; }
}
export interface TaskDecisionInput {
	turnId?: string;
	messages: readonly Message[];
	previous?: GearState;
	settings: GearSettings;
	policyFingerprint: string;
	facts: BranchFacts;
	savedDispatchUsable: boolean;
}
export interface TaskDecision {
	task?: TaskState | undefined;
	requestedBand?: Band;
	retainSavedDispatch: boolean;
	judgment?: GearJudgment;
	trace: DecisionTrace;
}
function clearWindow(task: TaskState): void {
	task.samples = []; task.seenEvidenceKeys = []; delete task.review;
}
export async function decideTask(input: TaskDecisionInput, judge: (context: JudgeInput, signal?: AbortSignal, trigger?: string) => Promise<JudgeOutcome>, signal?: AbortSignal): Promise<TaskDecision> {
	signal?.throwIfAborted();
	const { settings, facts, previous, turnId } = input;
	const policy = settings.taskRouting;
	const task = validTask(previous?.task);
	const context = buildTaskContext(input.messages, task, facts);
	const continuation = isContinuation(context.request) && !context.nonTextInput;
	const key = hash({ version: CONTEXT_VERSION, scope: task?.taskId ?? "initial", ...context,
		request: continuation ? "CONTINUE" : context.request });
	const changed = !!task && task.policyFingerprint !== input.policyFingerprint;
	const unknown = facts.coverage === "unknown" || facts.contextMissing;
	const newReviewEvidence = !!task?.review && !task.seenEvidenceKeys.includes(key);
	const trigger = !task || !turnId ? "no-task" : changed ? "config-changed" : previous?.fallback ? "previous-fallback"
		: !input.savedDispatchUsable ? "target-changed" : facts.verificationFailed ? "verification-failed"
		: facts.manualModelGap ? "manual-model-gap" : unknown ? "context-missing" : facts.completionHint ? "completion-hint"
		: task.requireRejudge || task.continuity !== "confirmed" ? "uncertain" : !continuation ? "request-changed"
		: task.review?.expedited || newReviewEvidence ? "downgrade-review"
		: task.inheritedTurns >= policy.maxInheritedTurns ? "periodic" : "inherit";
	if (task && trigger === "inherit") {
		task.inheritedTurns++;
		if (facts.nextCursor) task.observationCursor = facts.nextCursor;
		signal?.throwIfAborted();
		return { task, requestedBand: task.committedBand, retainSavedDispatch: true,
			trace: { source: "inherited", action: "inherit", trigger, classifierAttempted: false, requestedBand: task.committedBand, scoreTurnId: task.lastJudgment.turnId } };
	}
	const outcome = await judge(context, signal, trigger);
	signal?.throwIfAborted();
	const trace: DecisionTrace = { source: outcome.judgment ? "judged" : "fallback", action: "hold", trigger,
		classifierAttempted: outcome.attempted !== false,
		...(outcome.usageReported !== undefined ? { usageReported: outcome.usageReported } : {}),
		...(outcome.relation ? { relation: outcome.relation } : {}),
		...(outcome.relationConfidence !== undefined ? { relationConfidence: outcome.relationConfidence } : {}),
		...(outcome.relationProbability !== undefined ? { relationProbability: outcome.relationProbability } : {}),
		...(turnId ? { scoreTurnId: turnId } : {}) };
	if (task) {
		task.inheritedTurns = 0;
		if (facts.nextCursor) task.observationCursor = facts.nextCursor;
		if (changed || unknown || facts.verificationFailed || facts.manualModelGap) clearWindow(task);
	}
	const judgment = outcome.judgment;
	if (!judgment || outcome.kind === "unavailable") {
		if (task) { clearWindow(task); task.requireRejudge = true; }
		trace.action = "fallback";
		return { task, retainSavedDispatch: true, trace };
	}
	const scoreBand = bandForScore(judgment.score, settings.gearBias);
	const trustedScore = judgment.confidence >= policy.minConfidence;
	const relationTrusted = outcome.kind === "valid" && outcome.relation !== "uncertain"
		&& (outcome.relationConfidence ?? 0) >= policy.minConfidence && (outcome.relationProbability ?? 0) >= policy.minConfidence;
	const entry: Sample = { turnId: turnId ?? "untracked", evidenceKey: key, rawScore: judgment.score, confidence: judgment.confidence };
	if (!task || (relationTrusted && outcome.relation === "new_task")) {
		const fresh: TaskState | undefined = turnId && context.request.trim() ? {
			version: 1, taskId: `task:${turnId}`, anchor: truncate(context.request, 4000), userChanges: [], continuity: "confirmed",
			committedBand: scoreBand, committedRawScore: judgment.score, biasAtCommit: settings.gearBias,
			samples: trustedScore ? [entry] : [], seenEvidenceKeys: trustedScore ? [key] : [], lastJudgment: entry,
			inheritedTurns: 0, requireRejudge: !trustedScore || context.nonTextInput || unknown,
			policyFingerprint: input.policyFingerprint, ...(facts.nextCursor ? { observationCursor: facts.nextCursor } : {}),
		} : undefined;
		trace.action = "new-task"; trace.requestedBand = scoreBand;
		return { task: fresh, requestedBand: scoreBand, retainSavedDispatch: false, judgment, trace };
	}
	task.lastJudgment = entry;
	if (!relationTrusted) {
		clearWindow(task); task.continuity = "uncertain"; task.requireRejudge = true;
		trace.action = "uncertain"; trace.requestedBand = Math.max(task.committedBand, scoreBand) as Band; trace.provisionalBand = trace.requestedBand;
		return { task, requestedBand: trace.requestedBand, retainSavedDispatch: false, judgment, trace };
	}
	task.continuity = "confirmed";
	if (changed && task.biasAtCommit !== settings.gearBias
		&& task.committedBand === bandForScore(task.committedRawScore, task.biasAtCommit)) {
		task.committedBand = bandForScore(task.committedRawScore, settings.gearBias);
		task.biasAtCommit = settings.gearBias;
		trace.action = "config-remap";
	}
	task.policyFingerprint = input.policyFingerprint;
	task.requireRejudge = !trustedScore || context.nonTextInput || unknown;
	const change = truncate(context.request, 1000);
	if (!continuation && !task.userChanges.includes(change)) task.userChanges = [...task.userChanges, change].slice(-3);
	if (!trustedScore) clearWindow(task);
	if (scoreBand > task.committedBand) {
		task.committedBand = scoreBand; task.committedRawScore = judgment.score; task.biasAtCommit = settings.gearBias;
		clearWindow(task);
		if (trustedScore) { task.samples = [entry]; task.seenEvidenceKeys = [key]; }
		trace.action = "upgrade";
	} else if (trustedScore && !unknown) {
		const seen = task.seenEvidenceKeys.includes(key);
		const matching = task.samples.find(s => s.evidenceKey === key);
		if (matching) matching.rawScore = Math.max(matching.rawScore, judgment.score);
		else if (!seen) task.samples = [...task.samples, entry].slice(-policy.downgradeWindow);
		if (!seen) task.seenEvidenceKeys = [...task.seenEvidenceKeys, key].slice(-32);
		if (task.samples.length >= policy.downgradeWindow) {
			const max = task.samples.reduce((a, b) => a.rawScore >= b.rawScore ? a : b);
			trace.windowMaxRaw = max.rawScore;
			trace.protectedScore = clampScore(clampScore(max.rawScore + settings.gearBias * 0.4) + policy.downgradeMargin);
			const candidate = bandForScore(trace.protectedScore);
			if (candidate < task.committedBand) { task.committedBand = candidate; task.committedRawScore = max.rawScore; task.biasAtCommit = settings.gearBias; trace.action = "downgrade"; }
		}
		if (bandForScore(clampScore(clampScore(judgment.score + settings.gearBias * .4) + policy.downgradeMargin)) < task.committedBand) {
			task.review = { evidenceKey: key, expedited: !seen };
		} else delete task.review;
	}
	trace.requestedBand = task.committedBand;
	const retain = trace.action === "hold" && !previous?.fallback && previous?.decision?.provisionalBand === undefined && !changed && input.savedDispatchUsable;
	return { task, requestedBand: task.committedBand, retainSavedDispatch: retain, judgment, trace };
}
