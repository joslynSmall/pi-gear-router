import { createHash } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveRoutingMode } from "./gears.ts";
import { loadSettings } from "./settings.ts";
import { normalized, textOf } from "./task-context.ts";
import { observerDigest, parseObserverEvent } from "./observer-routing.ts";
import type { BranchFacts, ExecutionFact, GearState, ObserverCoverage, RequestIdentity, TaskBudget, TaskState, WorkflowEvent } from "./types.ts";
import { WORKFLOW_EVENT_TYPE, validWorkflowEvent, validWorkflowState } from "./workflow-routing.ts";
export interface ObserverIdentitySnapshot {
	identity: RequestIdentity;
	/** Projected public source, never raw abandoned text; kept local until input builder. */
	projectedMessage: AgentMessage;
	projectionDigest: string;
}
export interface ObserverIdentityPolicy {
	mode: string;
	policyFingerprint: string;
	catalogVersion?: string;
}
export type ObserverIdentityFailure = "aborted" | "coverage-unknown" | "mode-disabled" | "model-changed" | "pending-input"
	| "input-changed" | "runtime-changed" | "session-changed" | "source-off-branch" | "source-superseded"
	| "source-changed" | "source-not-visible" | "projection-changed" | "policy-changed" | "catalog-changed";

/** Full local SDK content digest has no classifier-input truncation or external byte cap. */
function sourceDigest(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/** Registers invalidation only. Raw input is never interpreted as approval or scope. */
export function createObserverIdentityTracker(pi: Pick<ExtensionAPI, "on">) {
	let inputEpoch = 0, branchEpoch = 0;
	pi.on("input", () => { inputEpoch++; });
	const invalidate = () => { branchEpoch++; };
	pi.on("session_start", invalidate);
	pi.on("session_shutdown", invalidate);
	pi.on("session_tree", invalidate);
	pi.on("model_select", invalidate);
	const available = (ctx: ExtensionContext) => typeof ctx.sessionManager?.getBranch === "function"
		&& typeof ctx.sessionManager.getSessionId === "function" && typeof ctx.sessionManager.buildSessionProjection === "function"
		&& typeof ctx.hasPendingMessages === "function";
	const selected = (ctx: ExtensionContext) => ctx.model?.provider === "gears" && ctx.model.id === "auto";
	const source = (ctx: ExtensionContext) => ctx.sessionManager.getBranch().findLast(e => e.type === "message" && e.message.role === "user");
	const projected = (ctx: ExtensionContext, userId: string) => {
		const contribution = ctx.sessionManager.buildSessionProjection().entries.find(e => e.sourceEntry.id === userId);
		if (!contribution || contribution.messages.length !== 1 || contribution.messages[0]?.role !== "user") return undefined;
		return contribution.messages[0];
	};
	return {
		capture(ctx: ExtensionContext, policy: ObserverIdentityPolicy): ObserverIdentitySnapshot | undefined {
			try {
				if (!available(ctx) || !selected(ctx) || policy.mode !== "observer" || ctx.signal?.aborted || ctx.hasPendingMessages()
					|| !/^[a-f0-9]{64}$/.test(policy.policyFingerprint)
					|| (policy.catalogVersion !== undefined && !/^[a-f0-9]{64}$/.test(policy.catalogVersion))) return;
				const entry = source(ctx);
				if (entry?.type !== "message" || entry.message.role !== "user") return;
				const message = projected(ctx, entry.id);
				if (!message) return;
				return {
					identity: Object.freeze({ sessionId: ctx.sessionManager.getSessionId(), userEntryId: entry.id,
						userContentDigest: sourceDigest(entry.message.content), inputEpoch, branchEpoch,
						policyFingerprint: policy.policyFingerprint, ...(policy.catalogVersion ? { catalogVersion: policy.catalogVersion } : {}) }),
					projectedMessage: structuredClone(message), projectionDigest: sourceDigest(message.content),
				};
			} catch { return undefined; }
		},
		canAccount(snapshot: ObserverIdentitySnapshot, ctx: ExtensionContext): boolean {
			try { return snapshot.identity.branchEpoch === branchEpoch && snapshot.identity.sessionId === ctx.sessionManager.getSessionId()
				&& ctx.sessionManager.getBranch().some(e => e.id === snapshot.identity.userEntryId && e.type === "message" && e.message.role === "user"); }
			catch { return false; }
		},
		check(snapshot: ObserverIdentitySnapshot | undefined, ctx: ExtensionContext, policy: ObserverIdentityPolicy, signal?: AbortSignal):
			{ valid: true } | { valid: false; reason: ObserverIdentityFailure } {
			const invalid = (reason: ObserverIdentityFailure) => ({ valid: false as const, reason });
			try {
				if (signal?.aborted || ctx.signal?.aborted) return invalid("aborted");
				if (!snapshot || !available(ctx)) return invalid("coverage-unknown");
				if (policy.mode !== "observer") return invalid("mode-disabled");
				if (!selected(ctx)) return invalid("model-changed");
				if (ctx.hasPendingMessages()) return invalid("pending-input");
				const identity = snapshot.identity;
				if (identity.inputEpoch !== inputEpoch) return invalid("input-changed");
				if (identity.branchEpoch !== branchEpoch) return invalid("runtime-changed");
				if (identity.sessionId !== ctx.sessionManager.getSessionId()) return invalid("session-changed");
				const branch = ctx.sessionManager.getBranch();
				const entry = branch.find(e => e.id === identity.userEntryId);
				if (entry?.type !== "message" || entry.message.role !== "user") return invalid("source-off-branch");
				if (source(ctx)?.id !== entry.id) return invalid("source-superseded");
				if (sourceDigest(entry.message.content) !== identity.userContentDigest) return invalid("source-changed");
				const visible = projected(ctx, entry.id);
				if (!visible) return invalid("source-not-visible");
				if (sourceDigest(visible.content) !== snapshot.projectionDigest) return invalid("projection-changed");
				if (identity.policyFingerprint !== policy.policyFingerprint) return invalid("policy-changed");
				if (identity.catalogVersion !== policy.catalogVersion) return invalid("catalog-changed");
				return { valid: true };
			} catch { return invalid("coverage-unknown"); }
		},
	};
}

/** Recover only current-branch reservations/results; a ledger never forgets failed attempts. */
export function recoverObserverBudget(ctx: ExtensionContext, previous: TaskBudget): TaskBudget | undefined {
	try {
		const recovered = structuredClone(previous);
		for (const entry of ctx.sessionManager.getBranch()) {
			const envelope = parseObserverEvent(entry);
			if (envelope?.customType !== "pi-gear-router.observer.v1" || !envelope.data.call) continue;
			const data = envelope.data;
			if (data.budgetOwnerId !== recovered.ownerId
				|| (data.identity.sessionId !== ctx.sessionManager.getSessionId()
					&& !ctx.sessionManager.getBranch().some(e => e.id === data.identity.userEntryId && e.type === "message" && e.message.role === "user"))) continue;
			const call = data.call!;
			const index = recovered.calls.findIndex(c => c.callId === call.callId);
			if (index >= 0) recovered.calls[index] = { ...call, attempts: Math.max(recovered.calls[index]!.attempts, call.attempts) };
			else if (data.kind === "reservation" && recovered.calls.length < 64 && !recovered.calls.some(c => c.evidenceKey === call.evidenceKey)) recovered.calls.push(call);
		}
		recovered.logicalCalls = Math.max(previous.logicalCalls, recovered.calls.length);
		recovered.transportAttempts = recovered.calls.reduce((sum, c) => sum + c.attempts, 0);
		return recovered;
	} catch { return undefined; }
}

export interface ObserverFactsOptions {
	enabled(ctx: ExtensionContext): boolean;
	identity(ctx: ExtensionContext): RequestIdentity | undefined;
	skillForPath(path: string, ctx: ExtensionContext): { identity: string; catalogVersion: string } | undefined;
}
export function observerBranchFacts(ctx: ExtensionContext, identity: RequestIdentity, coverage: ObserverCoverage) {
	try {
		const branch = ctx.sessionManager.getBranch(), source = branch.findIndex(e => e.id === identity.userEntryId);
		if (source < 0 || ctx.sessionManager.getSessionId() !== identity.sessionId) return { coverage: "unknown" as const, dirty: false, executionFacts: [] as ExecutionFact[] };
		const executionFacts = branch.slice(source + 1).flatMap(e => {
			const event = parseObserverEvent(e);
			if (!event || event.customType !== "pi-gear-router.observer.v1" || event.data.kind !== "execution-fact"
				|| event.data.identity.sessionId !== identity.sessionId || event.data.identity.userEntryId !== identity.userEntryId || !event.data.fact) return [];
			return [event.data.fact];
		}).slice(-16);
		return { coverage, dirty: executionFacts.some(f => f.kind === "verification-failed"), executionFacts };
	} catch { return { coverage: "unknown" as const, dirty: false, executionFacts: [] as ExecutionFact[] }; }
}
/** Public tool facts only. Never invokes a classifier, changes dispatch or declares completion. */
export function registerObserverFacts(pi: ExtensionAPI, options: ObserverFactsOptions) {
	const gaps = new WeakSet<object>();
	const coverage = (ctx: ExtensionContext): ObserverCoverage => gaps.has(ctx.sessionManager) ? "unknown" : "known";
	pi.on("tool_result", (event, ctx) => {
		try {
			if (!options.enabled(ctx) || ctx.signal?.aborted || ctx.hasPendingMessages()) return;
			const identity = options.identity(ctx);
			if (!identity) return;
			const current = ctx.sessionManager.getBranch().findLast(e => e.type === "message" && e.message.role === "user");
			if (current?.id !== identity.userEntryId || ctx.sessionManager.getSessionId() !== identity.sessionId) return;
			const metadata = (event as unknown as { nestedCalls?: { complete?: boolean } }).nestedCalls;
			if (metadata && metadata.complete !== true) gaps.add(ctx.sessionManager);
			let fact: ExecutionFact | undefined;
			if (event.toolName === "bash" && typeof event.input.command === "string") {
				const commandKind = verificationCommandKind(event.input.command);
				const result = event.structuredContent as { exit_code?: unknown } | undefined;
				if (commandKind && Number.isInteger(result?.exit_code)) {
					if (result!.exit_code === 0 && !event.isError) fact = { kind: "verification-passed", commandKind, sourceEntryId: identity.userEntryId };
					else if (result!.exit_code !== 0 && event.isError) fact = { kind: "verification-failed", commandKind, sourceEntryId: identity.userEntryId };
				}
			} else if (event.toolName === "read" && !event.isError && typeof event.input.path === "string") {
				const skill = options.skillForPath(event.input.path, ctx);
				if (skill) fact = { kind: "body-read-observed", sourceEntryId: identity.userEntryId, skillIdentity: skill.identity, catalogVersion: skill.catalogVersion };
			}
			if (!fact) return;
			const prior = observerBranchFacts(ctx, identity, coverage(ctx)).executionFacts;
			if (prior.length >= 16 || (fact.kind.startsWith("verification-") ? observerDigest(prior.at(-1)) === observerDigest(fact)
				: prior.some(f => observerDigest(f) === observerDigest(fact)))) return;
			const envelope = parseObserverEvent({ customType: "pi-gear-router.observer.v1", data: { version: 1, kind: "execution-fact", identity, fact } });
			if (!envelope) { gaps.add(ctx.sessionManager); return; }
			pi.appendEntry(envelope.customType, envelope.data);
		} catch { gaps.add(ctx.sessionManager); }
	});
	pi.on("message_end", (event, ctx) => {
		if (options.enabled(ctx) && event.message.role === "toolResult" && event.message.nestedCalls?.complete === false) gaps.add(ctx.sessionManager);
	});
	return { coverage,
		recordExplicit(ctx: ExtensionContext, identity: RequestIdentity, skill: { identity: string; catalogVersion: string }): boolean {
			try {
				if (!options.enabled(ctx) || ctx.signal?.aborted || ctx.hasPendingMessages()
					|| ctx.sessionManager.getSessionId() !== identity.sessionId
					|| ctx.sessionManager.getBranch().findLast(e => e.type === "message" && e.message.role === "user")?.id !== identity.userEntryId) return false;
				const fact: ExecutionFact = { kind: "explicit-expansion-observed", sourceEntryId: identity.userEntryId, skillIdentity: skill.identity, catalogVersion: skill.catalogVersion };
				if (observerBranchFacts(ctx, identity, coverage(ctx)).executionFacts.some(f => observerDigest(f) === observerDigest(fact))) return true;
				const event = parseObserverEvent({ customType: "pi-gear-router.observer.v1", data: { version: 1, kind: "execution-fact", identity, fact } });
				if (!event) return false;
				pi.appendEntry(event.customType, event.data); return true;
			} catch { gaps.add(ctx.sessionManager); return false; }
		},
	};
}

export const OBSERVATION_TYPE = "pi-gear-router.observation";
const failedObservation = new WeakSet<object>();
const MAX_WORKFLOW_VALIDATION_FACTS_PER_TURN = 8;
export function clearObservationCoverage(ctx: ExtensionContext): void {
	failedObservation.delete(ctx.sessionManager);
}
interface FailureMarker { version: 1; taskId: string; turnId: string; kind: "verification-failed" }
function failureMarker(value: unknown): FailureMarker | undefined {
	if (!value || typeof value !== "object") return;
	const m = value as FailureMarker;
	if (m.version === 1 && m.kind === "verification-failed" && typeof m.taskId === "string" && m.taskId.length > 0 && m.taskId.length <= 300
		&& typeof m.turnId === "string" && m.turnId.length > 0 && m.turnId.length <= 256) return m;
	return;
}
export function latestRouterState(ctx: ExtensionContext): GearState | undefined {
	const entry = ctx.sessionManager.getBranch().findLast(e => e.type === "custom" && e.customType === "pi.virtual-model-state"
		&& (e.data as { provider?: string; modelId?: string } | undefined)?.provider === "gears"
		&& (e.data as { modelId?: string }).modelId === "auto");
	return entry?.type === "custom" ? (entry.data as { state?: GearState }).state : undefined;
}
export function verificationCommandKind(command: string): string | undefined {
	if (!isVerificationCommand(command)) return;
	const first = command.split("&&", 1)[0]!.trim().split(/ +/)[0];
	return first === "npm" || first === "pnpm" || first === "yarn" || first === "npx" ? first : undefined;
}
export function isVerificationCommand(command: string): boolean {
	if (!command || /[\t\r\n]/.test(command)) return false;
	return command.split("&&").every(part => {
		if (!part.trim() || !/^[A-Za-z0-9_./:=,+ -]+$/.test(part)) return false;
		const words = part.trim().split(/ +/);
		const scripts = /^(test|lint|typecheck|check|build|compile|validate|verify)$/;
		const engine = words[0];
		let args: string[];
		if (engine === "npm" && words[1] === "test") args = words.slice(2);
		else if (engine === "npm" && words[1] === "run" && scripts.test(words[2] ?? "")) args = words.slice(3);
		else if ((engine === "pnpm" || engine === "yarn") && scripts.test(words[words[1] === "run" ? 2 : 1] ?? "")) args = words.slice(words[1] === "run" ? 3 : 2);
		else if (engine === "npx" && words[1] === "tsc" && words[2] === "--noEmit") args = words.slice(3);
		else return false;
		return args.every(w => !["npm", "pnpm", "yarn", "npx"].includes(w));
	});
}
function completionText(text: string): boolean {
	let inFence = false;
	return text.split("\n").some(line => {
		if (/^\s*(```|~~~)/.test(line)) { inFence = !inFence; return false; }
		return !inFence && ["任务已完成", "全部完成", "已完成", "task complete", "all done"].includes(normalized(line));
	});
}
export function branchFacts(ctx: ExtensionContext, task: TaskState | undefined, messages: readonly Message[], supported: boolean): BranchFacts {
	const entries = ctx.sessionManager.getBranch();
	const index = task?.observationCursor ? entries.findIndex(e => e.id === task.observationCursor) : -1;
	const missing = !!task && (index < 0 || !task.observationCursor);
	const recent = missing ? [] : entries.slice(index + 1);
	const current = messages.findLastIndex(m => m.role === "user");
	// Detect removed public work without substituting raw session text into classifier input.
	const visibleAssistants = new Set(messages.slice(0, current).filter(m => m.role === "assistant").map(m => m.timestamp));
	const publicContextMissing = !!task && recent.some(e => e.type === "message" && e.message.role === "assistant"
		&& textOf(e.message).trim() && !visibleAssistants.has(e.message.timestamp));
	// Inspect only newly visible messages; branch is used for identity, never for source text.
	const freshTimestamps = new Set(recent.flatMap(e => e.type === "message" ? [e.message.timestamp] : []));
	const completionHint = messages.slice(0, current).some(m => freshTimestamps.has(m.timestamp)
		&& (m.role === "assistant" ? completionText(textOf(m)) : m.role === "user" && ["这个任务结束", "不用继续了", "结束这个任务", "stop this task"].includes(normalized(textOf(m)))));
	return {
		coverage: supported && !failedObservation.has(ctx.sessionManager) ? "known" : "unknown", ...(entries.at(-1)?.id ? { nextCursor: entries.at(-1)!.id } : {}),
		contextMissing: missing || publicContextMissing,
		verificationFailed: !!task && recent.some(e => e.type === "custom" && e.customType === OBSERVATION_TYPE && failureMarker(e.data)?.taskId === task.taskId),
		manualModelGap: recent.some(e => e.type === "model_change" && (e.provider !== "gears" || e.modelId !== "auto")),
		completionHint,
	};
}
/** Event observation is structural and read-only. No command/output is persisted. */
export function registerObservations(pi: ExtensionAPI): void {
	pi.on("tool_result", (event, ctx) => {
		try {
			if (ctx.signal?.aborted || ctx.model?.provider !== "gears" || ctx.model.id !== "auto" || event.toolName !== "bash"
				|| typeof event.input.command !== "string" || !isVerificationCommand(event.input.command)) return;
			const result = event.structuredContent as { exit_code?: unknown } | undefined;
			if (!result || !Number.isInteger(result.exit_code)) return;
			const state = latestRouterState(ctx);
			if (!state?.turnId) return;
			const mode = resolveRoutingMode(loadSettings(ctx.cwd, { projectTrusted: typeof ctx.isProjectTrusted === "function" && ctx.isProjectTrusted() })).mode;
			if (mode === "observer" || mode === "disabled") return;
			const workflow = mode === "legacy-workflow" ? validWorkflowState(state.workflow, 16) : undefined;
			const commandKind = verificationCommandKind(event.input.command);
			if (workflow && commandKind && !ctx.signal?.aborted) {
				const outcome = result.exit_code === 0 && !event.isError ? "passed" : result.exit_code !== 0 && event.isError ? "failed" : undefined;
				const prior = ctx.sessionManager.getBranch().flatMap(e => {
					if (e.type !== "custom" || e.customType !== WORKFLOW_EVENT_TYPE) return [];
					const entry = validWorkflowEvent(e.data, 16);
					return entry?.kind === "validation" && entry.workflowId === workflow.workflowId && entry.sourceTurnId === state.turnId && entry.commandKind === commandKind ? [entry] : [];
				});
				const repeatedLatestOutcome = prior.at(-1)?.outcome === outcome;
				if (outcome && !repeatedLatestOutcome && prior.length < MAX_WORKFLOW_VALIDATION_FACTS_PER_TURN) {
					pi.appendEntry(WORKFLOW_EVENT_TYPE, { version: 1, kind: "validation", workflowId: workflow.workflowId, sourceTurnId: state.turnId, outcome, commandKind } satisfies WorkflowEvent);
				}
			}
			if (result.exit_code === 0 || !event.isError || !state.task?.taskId) return;
			const duplicate = ctx.sessionManager.getBranch().some(e => e.type === "custom" && e.customType === OBSERVATION_TYPE
				&& failureMarker(e.data)?.taskId === state.task!.taskId && failureMarker(e.data)?.turnId === state.turnId);
			if (!duplicate && !ctx.signal?.aborted) pi.appendEntry(OBSERVATION_TYPE, { version: 1, taskId: state.task.taskId, turnId: state.turnId, kind: "verification-failed" });
		} catch {
			failedObservation.add(ctx.sessionManager);
			// A failed append makes coverage unknown; never change tool results or block execution.
		}
	});
}
