import { createHash } from "node:crypto";
import { clampThinkingLevel, type Message } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionContext,
	ModelRoute,
	ModelRouteRequest,
} from "@earendil-works/pi-coding-agent";
import { bandForScore, clampScore, gearTarget, targetForBand, resolveRoutingMode } from "./gears.ts";
import { activeGear, explicitPhaseIntent, implementationGear, initialPlanGear, phaseChoiceIntent, PHASE_CHOICES, validPhaseState, type PhaseRouteState } from "./phase-routing.ts";
import { judgeTask } from "./judge.ts";
import { buildTaskContext } from "./task-context.ts";
import { decideTask, policyFingerprint, validTask } from "./task-routing.ts";
import { branchFacts, clearObservationCoverage, registerObservations, recoverObserverBudget } from "./observation.ts";
import { registerWorkflowGuard } from "./workflow-guard.ts";
import { registerWorkflowHandoff, WORKFLOW_HANDOFF_TOOL } from "./workflow-handoff.ts";
import { judgeWorkflowTurn } from "./workflow-judge.ts";
import { consumeHandoff, newWorkflowState, refreshWorkflowState, steerWorkflow, validWorkflowState, workflowBand, WORKFLOW_EVENT_TYPE } from "./workflow-routing.ts";
import { loadSettings, SETTINGS_PATH } from "./settings.ts";
import { createObserverRuntime, runtimeSettings } from "./observer-runtime.ts";
import { observerDigest, parseObserverState } from "./observer-routing.ts";
import type { ObserverStateV1 } from "./types.ts";
import { observerStatus, type ObserverStatusActivity } from "./observer-status.ts";
import { CAPABILITY_HANDOFF_TOOL } from "./observer-handoff.ts";
import type { Gear, GearSettings, GearState, GearTarget, JudgeOutcome, WorkflowDiagnostic, WorkflowProfile, WorkflowState, WorkflowTurnOutcome } from "./types.ts";

const PROVIDER = "gears";
const ID = "auto";
const FALLBACK_GEAR: Gear = "standard";
const STATUS_KEY = "pi-gear-router";
const observerActivity = new WeakMap<object, ObserverStatusActivity>();
/** Request-local dispatch evidence only; never returned to the routing reducer or persisted. */
const observerDispatch = new WeakMap<object, { identity: string; pair: GearTarget }>();
function observerViewState(ctx: ExtensionContext, state: ObserverStateV1): ObserverStateV1 {
	const live = observerDispatch.get(ctx.sessionManager);
	return live && live.identity === observerDigest(state.turn) ? { ...state, dispatch: live.pair } : state;
}
type GearRequest = ModelRouteRequest<GearState>;
type PhysicalRoute = Omit<ModelRoute<GearState>, "state">;

/** Entry IDs survive compaction/tree navigation; message count does not. */
function turnId(messages: readonly Message[], ctx: ExtensionContext): string | undefined {
	const user = messages.findLast((message) => message.role === "user");
	if (!user) return undefined;
	const digest = createHash("sha256").update(JSON.stringify(user.content)).digest("hex");
	const entry = ctx.sessionManager.getBranch().findLast(
		(candidate) => candidate.type === "message" && candidate.message.role === "user"
			&& candidate.message.timestamp === user.timestamp,
	);
	// SDK callers may supply messages that are not yet session entries.
	return `${entry?.id ?? `message:${user.timestamp}`}:${digest}`;
}

function usable(model: PhysicalRoute["model"] | undefined, ctx: ExtensionContext): model is PhysicalRoute["model"] {
	return !!model && model.api !== "pi-virtual" && ctx.modelRegistry.hasConfiguredAuth(model);
}

function fromTarget(target: GearTarget, ctx: ExtensionContext): PhysicalRoute | undefined {
	const model = ctx.modelRegistry.find(target.provider, target.model);
	if (!usable(model, ctx)) return undefined;
	return { model, thinkingLevel: clampThinkingLevel(model, target.thinkingLevel) };
}

function previousPair(request: GearRequest, ctx: ExtensionContext): PhysicalRoute | undefined {
	const pair = request.reason === "retry" ? request.failed ?? request.previous : request.previous;
	if (!pair || !usable(pair.model, ctx)) return undefined;
	return { model: pair.model, thinkingLevel: pair.thinkingLevel ?? request.thinkingLevel };
}

function savedPair(state: GearState | undefined, ctx: ExtensionContext): PhysicalRoute | undefined {
	return state?.dispatch ? fromTarget(state.dispatch, ctx) : undefined;
}

function stickyPair(request: GearRequest, ctx: ExtensionContext): PhysicalRoute | undefined {
	// A router failure has no `failed` physical response. Prefer the saved current-turn
	// dispatch over `previous`, which may belong to an earlier user task.
	if (request.reason === "retry" && !request.failed) {
		return savedPair(request.state, ctx) ?? previousPair(request, ctx);
	}
	return previousPair(request, ctx) ?? savedPair(request.state, ctx);
}

/** Only try configured gears, then the previous physical model; never an arbitrary provider. */
function resolveGear(
	wanted: Gear,
	request: GearRequest,
	ctx: ExtensionContext,
	settings: GearSettings,
	thinkingLevel?: GearTarget["thinkingLevel"],
) {
	for (const gear of new Set<Gear>([wanted, "standard", "light", "heavy"])) {
		const target = gearTarget(settings, gear);
		const pair = fromTarget({
			...target,
			thinkingLevel: thinkingLevel ?? target.thinkingLevel,
		}, ctx);
		if (pair) return { ...pair, gear, degraded: gear !== wanted };
	}
	const previous = previousPair(request, ctx);
	if (previous) return { ...previous, gear: request.state?.gear ?? FALLBACK_GEAR, degraded: true };
	if (ctx.mode === "tui") ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("error", "Jev 失败 → 无可用模型"));
	throw new Error(`pi-gear-router: no configured gear has an available physical model with credentials. Check ${SETTINGS_PATH} and Pi authentication.`);
}

function dispatch(pair: PhysicalRoute): GearTarget {
	return { provider: pair.model.provider, model: pair.model.id, thinkingLevel: pair.thinkingLevel };
}

/** Footer budget is tight; keep only the head of a diagnostic reason. */
function shortReason(text: string): string {
	return text.length > 80 ? `${text.slice(0, 77)}...` : text;
}

/** Fixed labels only: persisted diagnostic text must never become footer content. */
function explicitRevisionRequest(text: string): "revise" | undefined {
	return explicitPhaseIntent(text) === "revise" ? "revise" : undefined;
}

function workflowDiagnosticStatus(value: WorkflowDiagnostic | undefined): string {
	if (!value || value.version !== 1) return "工作流待评估：新请求生效";
	const labels: Record<WorkflowDiagnostic["reason"], string> = {
		"low-confidence": "工作流未启动：置信度不足",
		"classifier-unavailable": "工作流未启动：分类不可用",
		"invalid-classification": "工作流未启动：分类不完整",
		"non-text-input": "工作流不适用：非文本输入",
		review: "工作流不适用：审查请求",
		question: "工作流不适用：问答请求",
		"no-phase": "工作流不适用：无需阶段编排",
		"execution-not-ready": "工作流未启动：直接执行条件不足",
		"missing-turn": "工作流未启动：缺少回合标识",
	};
	const label = Object.hasOwn(labels, value.reason) ? labels[value.reason] : "工作流待评估：新请求生效";
	if (value.reason === "low-confidence" && typeof value.confidence === "number" && Number.isFinite(value.confidence)
		&& value.confidence >= 0 && value.confidence <= 1 && typeof value.minConfidence === "number"
		&& Number.isFinite(value.minConfidence) && value.minConfidence >= .5 && value.minConfidence <= 1) {
		return `${label}（${value.confidence.toFixed(2)}<${value.minConfidence.toFixed(2)}）`;
	}
	return label;
}

/** Observe the existing routing decision; diagnostics have no routing authority. */
function workflowNonStart(outcome: WorkflowTurnOutcome | undefined, nonText: boolean, id: string | undefined, minConfidence: number): WorkflowDiagnostic {
	let reason: WorkflowDiagnostic["reason"];
	if (nonText) reason = "non-text-input";
	else if (!id) reason = "missing-turn";
	else if (!outcome || outcome.kind === "unavailable") reason = "classifier-unavailable";
	else if (outcome.kind !== "valid" || !outcome.judgment) reason = "invalid-classification";
	else if (outcome.judgment.confidence < minConfidence) return { version: 1, reason: "low-confidence", confidence: outcome.judgment.confidence, minConfidence };
	else if (outcome.judgment.objective === "review" || outcome.judgment.objective === "question") reason = outcome.judgment.objective;
	else if (outcome.judgment.start === "none") reason = "no-phase";
	else reason = "execution-not-ready";
	return { version: 1, reason };
}

function showStatus(ctx: ExtensionContext, state?: GearState, pending = false, trigger?: string): void {
	if (ctx.mode !== "tui") return;
	const theme = ctx.ui.theme;
	if (pending) {
		ctx.ui.setStatus(STATUS_KEY, theme.fg("accent", trigger === "periodic" ? "Jev 评估中…（周期）" : trigger === "downgrade-review" ? "Jev 评估中…（降档复核）" : "Jev 评估中…"));
		return;
	}
	const observer = parseObserverState(state);
	if (observer) {
		const mode = resolveRoutingMode(runtimeSettings(ctx));
		if (mode.mode !== "observer") { ctx.ui.setStatus(STATUS_KEY, undefined); return; }
		if (ctx.model?.provider !== PROVIDER || ctx.model.id !== ID) { ctx.ui.setStatus(STATUS_KEY, undefined); return; }
		const budget = recoverObserverBudget(ctx, observer.budget);
		const view = observerStatus({ ...observerViewState(ctx, observer), budget: budget ?? observer.budget }, ctx.sessionManager.getBranch(), runtimeSettings(ctx),
			{ ...observerActivity.get(ctx.sessionManager), ...(!budget ? { accountingUnknown: true } : {}) });
		ctx.ui.setStatus(STATUS_KEY, theme.fg(view.tone, view.text)); return;
	}
	if (!state?.dispatch) {
		ctx.ui.setStatus(STATUS_KEY, undefined);
		return;
	}
	const settings = runtimeSettings(ctx);
	const workflow = resolveRoutingMode(settings).mode === "legacy-workflow" ? workflowUsable(state, settings) : undefined;
	const phase = workflow?.phase;
	const sessionLocked = !phase && !!state.sessionLock;
	const result = phase
		? `工作流 ${phase}${workflow?.lastTransition?.reason === "accepted-handoff" ? " · 已接受交接" : workflow?.lastTransition?.reason === "blocked" ? " · 已阻塞" : workflow?.lastTransition?.reason === "budget-exhausted" ? " · 转换预算耗尽" : ""}`
		: state.phaseRoute
			? `路由 ${state.phaseRoute.phase === "plan" ? "计划" : state.phaseRoute.revising ? "计划修订" : "实现"} · ${activeGear(state.phaseRoute)}${state.score >= 0 ? ` · Jev ${state.score.toFixed(2)}` : state.decision?.judgeFailure ? " · Jev 不可用" : ""}`
		: sessionLocked
			? `会话锁定 ${state.sessionLock!.gear}${state.decision?.source === "inherited" ? "" : state.score >= 0 ? ` · Jev ${state.score.toFixed(2)}` : state.decision?.judgeFailure ? ` · Jev 不可用 · ${shortReason(state.decision.judgeFailure)}` : " · Jev 不可用"}`
		: state.decision?.source === "inherited"
			? `沿用 Jev ${state.score.toFixed(2)} · 续接 ${state.task?.inheritedTurns ?? 0}/${loadSettings(ctx.cwd).taskRouting.maxInheritedTurns}`
			: state.score >= 0 ? `Jev ${state.score.toFixed(2)}${state.decision?.action === "uncertain" ? " · 关系不明" : state.task?.review || (state.decision?.action === "hold" && (state.decision.requestedBand ?? 0) > bandForScore(state.adjustedScore, 0, loadSettings(ctx.cwd).bands)) ? " · 降档保护" : ""}` : state.decision?.judgeFailure ? `Jev 不可用 · ${shortReason(state.decision.judgeFailure)}` : "Jev 不可用";
	const fallback = state.fallback ? " fallback" : "";
	const workflowStatus = !phase && resolveRoutingMode(settings).mode === "legacy-workflow"
		? ` · ${workflowDiagnosticStatus(state.workflowDiagnostic)}` : "";
	const modeDiagnostic = resolveRoutingMode(settings).diagnostic;
	const label = `${result}${workflowStatus}${modeDiagnostic ? ` · ${modeDiagnostic}` : ""} → ${state.gear}/${state.dispatch.thinkingLevel}${fallback} → ${state.dispatch.provider}/${state.dispatch.model}`;
	ctx.ui.setStatus(STATUS_KEY, theme.fg(state.fallback ? "warning" : "success", label));
}

function latestState(ctx: ExtensionContext): GearState | undefined {
	const entry = ctx.sessionManager.getBranch().findLast((candidate) => {
		if (candidate.type !== "custom" || candidate.customType !== "pi.virtual-model-state") return false;
		const data = candidate.data as { provider?: unknown; modelId?: unknown } | undefined;
		return data?.provider === PROVIDER && data.modelId === ID;
	});
	if (entry?.type !== "custom") return undefined;
	return (entry.data as { state?: GearState }).state;
}

function workflowEvents(ctx: ExtensionContext): unknown[] {
	return ctx.sessionManager.getBranch().flatMap(entry => entry.type === "custom" && entry.customType === WORKFLOW_EVENT_TYPE ? [entry.data] : []);
}
/** A hand-selected model after this phase's user turn invalidates unconsumed automatic handoffs. */
function hasManualModelGap(ctx: ExtensionContext, workflow: WorkflowState): boolean {
	const branch = ctx.sessionManager.getBranch();
	const index = branch.findLastIndex(entry => entry.type === "message" && entry.message.role === "user"
		&& workflow.activeTurnId.startsWith(`${entry.id}:`));
	return index >= 0 && branch.slice(index + 1).some(entry => entry.type === "model_change"
		&& (entry.provider !== PROVIDER || entry.modelId !== ID));
}
/** Status must include append-only lifecycle events written after the last virtual route state. */
function effectiveState(ctx: ExtensionContext): GearState | undefined {
	const state = latestState(ctx);
	if (!state) return;
	if (parseObserverState(state)) return state;
	const settings = runtimeSettings(ctx);
	const workflow = resolveRoutingMode(settings).mode === "legacy-workflow" ? workflowUsable(state, settings) : undefined;
	if (!workflow) return state;
	const refreshed = refreshWorkflowState(workflow, workflowEvents(ctx), settings);
	return refreshed ? { ...state, workflow: refreshed } : state;
}
function workflowProfileBand(settings: GearSettings, profile: WorkflowProfile, outcome: WorkflowTurnOutcome, state?: WorkflowState): number {
	const judgment = outcome.judgment!;
	return workflowBand(settings, { profile, score: judgment.gear.score, risk: judgment.risk, clarity: judgment.clarity,
		...(state?.activePacket ? { packet: state.activePacket.packet } : {}) });
}
function workflowUsable(state: GearState | undefined, settings: GearSettings): WorkflowState | undefined {
	return validWorkflowState(state?.workflow, settings.bands.length);
}
function taskOutcome(outcome: WorkflowTurnOutcome): JudgeOutcome {
	return {
		kind: outcome.kind,
		...(outcome.judgment ? { judgment: outcome.judgment.gear } : outcome.fallbackJudgment ? { judgment: outcome.fallbackJudgment } : {}),
		...(outcome.relation ? { relation: outcome.relation } : {}),
		...(outcome.relationConfidence !== undefined ? { relationConfidence: outcome.relationConfidence } : {}),
		...(outcome.relationProbability !== undefined ? { relationProbability: outcome.relationProbability } : {}),
		...(outcome.usageReported !== undefined ? { usageReported: outcome.usageReported } : {}),
		...(outcome.attempted !== undefined ? { attempted: outcome.attempted } : {}),
		...(outcome.failure !== undefined ? { failure: outcome.failure } : {}),
	};
}

/** Adapt capability between user turns; freeze each turn's physical pair, including fallbacks. */
export default function (pi: ExtensionAPI) {
	const observationSupported = typeof pi.appendEntry === "function";
	if (observationSupported) registerObservations(pi);
	const observer = createObserverRuntime(pi, {
		fromTarget,
		previous: (request, ctx) => previousPair(request as GearRequest, ctx),
		resolve: (band, request, ctx, settings) => {
			const target = targetForBand(settings, band);
			return resolveGear(target.gear, request as GearRequest, ctx, settings, target.thinkingLevel);
		},
	}, (ctx, activity) => {
		observerActivity.set(ctx.sessionManager, activity);
		if (ctx.mode !== "tui") return;
		if (resolveRoutingMode(runtimeSettings(ctx)).mode !== "observer" || ctx.model?.provider !== PROVIDER || ctx.model.id !== ID) {
			ctx.ui.setStatus(STATUS_KEY, undefined); return;
		}
		const state = effectiveState(ctx);
		if (state) showStatus(ctx, state);
		else if (activity.pending) ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("accent", "路由 Jev 观察中…"));
	});
	if (typeof pi.registerTool === "function") registerWorkflowHandoff(pi, (cwd, ctx) => ctx ? runtimeSettings(ctx) : loadSettings(cwd));
	registerWorkflowGuard(pi, (cwd, ctx) => ctx ? runtimeSettings(ctx) : loadSettings(cwd));
	pi.on("before_agent_start", (_event, ctx) => {
		if (typeof pi.getActiveTools !== "function" || typeof pi.setActiveTools !== "function") return;
		const active = pi.getActiveTools();
		const settings = runtimeSettings(ctx), mode = resolveRoutingMode(settings).mode;
		const owned = mode === "legacy-workflow" ? WORKFLOW_HANDOFF_TOOL : mode === "observer" && settings.observer.stageAware
			&& ctx.model?.provider === PROVIDER && ctx.model.id === ID ? CAPABILITY_HANDOFF_TOOL : undefined;
		const next = [...active.filter(name => name !== WORKFLOW_HANDOFF_TOOL && name !== CAPABILITY_HANDOFF_TOOL), ...(owned ? [owned] : [])];
		if (next.length !== active.length || next.some((name, index) => name !== active[index])) pi.setActiveTools(next);
	});
	if (typeof pi.registerCommand === "function") pi.registerCommand("gear-status", {
		description: "只读查看能力路由、交接与用量；不触发观察或修改设置",
		handler: async (_args, ctx) => {
			// Print/JSON have no UI. RPC notifications are supported, terminal status is not.
			if (ctx.mode !== "tui" && ctx.mode !== "rpc") return;
			const settings = runtimeSettings(ctx), mode = resolveRoutingMode(settings), state = effectiveState(ctx), parsed = parseObserverState(state);
			if (mode.mode === "observer" && parsed && ctx.model?.provider === PROVIDER && ctx.model.id === ID) {
				const budget = recoverObserverBudget(ctx, parsed.budget);
				ctx.ui.notify(observerStatus({ ...observerViewState(ctx, parsed), budget: budget ?? parsed.budget }, ctx.sessionManager.getBranch(), settings,
					{ ...observerActivity.get(ctx.sessionManager), ...(!budget ? { accountingUnknown: true } : {}) }).details, "info");
			} else {
				ctx.ui.notify(`路由模式：${mode.mode}${mode.diagnostic ? `（${mode.diagnostic}）` : ""}\n${ctx.model?.provider !== PROVIDER || ctx.model.id !== ID ? "手选物理模型；观察路由未运行。" : mode.mode === "observer" ? "尚无当前观察状态。" : "task／legacy 保留原状态展示，未启用观察交接。"}`, "info");
			}
		},
	});
	pi.on("input", (_event, ctx) => { observerDispatch.delete(ctx.sessionManager); });
	pi.on("session_start", (_event, ctx) => { observerDispatch.delete(ctx.sessionManager); observerActivity.delete(ctx.sessionManager); showStatus(ctx, effectiveState(ctx)); });
	pi.on("session_tree", (_event, ctx) => { observerDispatch.delete(ctx.sessionManager); observerActivity.delete(ctx.sessionManager); showStatus(ctx, effectiveState(ctx)); });
	pi.on("model_select", (_event, ctx) => { observerDispatch.delete(ctx.sessionManager); observerActivity.delete(ctx.sessionManager); showStatus(ctx, ctx.model?.provider === PROVIDER && ctx.model.id === ID ? effectiveState(ctx) : undefined); });
	pi.on("message_end", (_event, ctx) => { if (resolveRoutingMode(runtimeSettings(ctx)).mode === "observer") showStatus(ctx, effectiveState(ctx)); });
	pi.on("tool_result", (_event, ctx) => { if (resolveRoutingMode(runtimeSettings(ctx)).mode === "observer") showStatus(ctx, effectiveState(ctx)); });
	pi.on("session_shutdown", (_event, ctx) => {
		clearObservationCoverage(ctx);
		observerActivity.delete(ctx.sessionManager);
		observerDispatch.delete(ctx.sessionManager);
		showStatus(ctx);
	});
	pi.registerVirtualModel<GearState | ObserverStateV1>({
		provider: PROVIDER,
		id: ID,
		name: "Auto (gears)",
		thinkingLevels: ["off", "low", "medium", "high", "xhigh", "max"],
		contextWindow: 1_000_000,
		maxTokens: 131_072,
		async route(incoming: ModelRouteRequest<GearState | ObserverStateV1>, ctx: ExtensionContext): Promise<ModelRoute<GearState | ObserverStateV1>> {
			incoming.signal?.throwIfAborted();
			const config = runtimeSettings(ctx), mode = resolveRoutingMode(config);
			if (mode.mode === "observer" && incoming.reason !== "direct") {
				const result = await observer.route(incoming, ctx);
				const state = parseObserverState(result.state ?? incoming.state);
				if (state) observerDispatch.set(ctx.sessionManager, { identity: observerDigest(state.turn)!, pair: { provider: result.model.provider, model: result.model.id, thinkingLevel: result.thinkingLevel } });
				showStatus(ctx, (result.state ?? incoming.state) as GearState | undefined); return result;
			}
			// Preserve only a proven dispatch across mode changes, never reinterpret observer task/profile.
			const observerState = parseObserverState(incoming.state);
			if (mode.mode !== "observer") { observer.invalidate(ctx, "mode-changed"); observerDispatch.delete(ctx.sessionManager); }
			const compatible = observerState ? { gear: FALLBACK_GEAR, score: -1, adjustedScore: -1, confidence: 0, inputTokens: 0, fallback: false,
				dispatch: observerState.dispatch, turnId: `${observerState.turn.userEntryId}:${observerState.turn.userContentDigest}` } satisfies GearState : undefined;
			const request = { ...incoming, state: observerState ? compatible : incoming.state } as GearRequest;
			const settings = { ...config, enabled: mode.mode !== "disabled", workflow: { ...config.workflow, enabled: mode.mode === "legacy-workflow" } };
			const old = request.state;
			if (request.reason === "direct") {
				if (mode.mode === "observer") { observerDispatch.delete(ctx.sessionManager); showStatus(ctx); }
				const pair = !settings.enabled || mode.mode !== "task" ? previousPair(request, ctx)
					?? resolveGear(mode.mode === "task" ? FALLBACK_GEAR : "light", request, ctx, settings)
					: resolveGear(old?.sessionLock?.gear ?? FALLBACK_GEAR, request, ctx, settings,
						gearTarget(settings, old?.sessionLock?.gear ?? FALLBACK_GEAR).thinkingLevel);
				request.signal?.throwIfAborted();
				return { model: pair.model, thinkingLevel: pair.thinkingLevel };
			}
			const id = turnId(request.messages, ctx);

			if (!settings.enabled) {
				const retained = (id && old?.turnId === id ? savedPair(old, ctx) : undefined) ?? stickyPair(request, ctx);
				const selected = retained ? { ...retained, gear: old?.gear ?? FALLBACK_GEAR }
					: resolveGear(FALLBACK_GEAR, request, ctx, settings);
				const pair = { model: selected.model, thinkingLevel: selected.thinkingLevel };
				const state: GearState = {
					gear: selected.gear, score: -1, adjustedScore: -1, confidence: 0,
					inputTokens: 0, fallback: true, fallbackReason: "disabled", dispatch: dispatch(pair),
					...(id ? { turnId: id } : {}),
				};
				request.signal?.throwIfAborted();
				showStatus(ctx, state);
				if (old?.fallbackReason === "disabled" && old.turnId === id) return pair;
				return {
					...pair,
					state,
				};
			}

			const priorWorkflow = settings.workflow.enabled ? workflowUsable(old, settings) : undefined;
			if (request.reason === "continuation" && old && priorWorkflow) {
				const events = workflowEvents(ctx);
				const refreshed = refreshWorkflowState(priorWorkflow, events, settings);
				const handoff = refreshed && !hasManualModelGap(ctx, refreshed) ? consumeHandoff(refreshed, events, settings) : undefined;
				const nextWorkflow = handoff?.state ?? refreshed;
				if (nextWorkflow && handoff) {
					const activeProfile = nextWorkflow.activeProfile;
					const selected = activeProfile
						? resolveGear(targetForBand(settings, handoff.requestedBand).gear, request, ctx, settings, targetForBand(settings, handoff.requestedBand).thinkingLevel)
						: (() => {
							const sticky = stickyPair(request, ctx);
							return sticky ? { ...sticky, gear: old.gear, degraded: !!old.fallback } : resolveGear(old.gear, request, ctx, settings, old.dispatch?.thinkingLevel);
						})();
					const state: GearState = {
						...old, gear: selected.gear, dispatch: dispatch(selected), workflow: nextWorkflow,
						fallback: selected.degraded,
						...(selected.degraded ? { fallbackReason: "target-unavailable" as const } : {}),
					};
					request.signal?.throwIfAborted();
					showStatus(ctx, state);
					return { model: selected.model, thinkingLevel: selected.thinkingLevel, state };
				}
				if (nextWorkflow && JSON.stringify(nextWorkflow) !== JSON.stringify(priorWorkflow)) {
					const sticky = stickyPair(request, ctx);
					if (sticky) {
						const state: GearState = { ...old, workflow: nextWorkflow, gear: old.gear, dispatch: dispatch(sticky) };
						request.signal?.throwIfAborted();
						showStatus(ctx, state);
						return { model: sticky.model, thinkingLevel: sticky.thinkingLevel, state };
					}
				}
			}

			if (request.reason !== "user") {
				// Ordinary continuations and every retry preserve the actual dispatched pair.
				const sticky = stickyPair(request, ctx);
				if (sticky) {
					request.signal?.throwIfAborted();
					showStatus(ctx, old);
					return sticky;
				}
				if (old) {
					const pair = resolveGear(old.gear, request, ctx, settings, old.dispatch?.thinkingLevel);
					const state = { ...old, gear: pair.gear, dispatch: dispatch(pair),
						...(pair.degraded ? { fallback: true, fallbackReason: "target-unavailable" as const } : {}) };
					request.signal?.throwIfAborted();
					showStatus(ctx, state);
					return { model: pair.model, thinkingLevel: pair.thinkingLevel, state };
				}
			} else if (id && old?.turnId === id && old.fallbackReason !== "disabled") {
				const pair = savedPair(old, ctx);
				if (pair) {
					request.signal?.throwIfAborted();
					showStatus(ctx, old);
					return pair;
				}
				const replacement = resolveGear(old.gear, request, ctx, settings, old.dispatch?.thinkingLevel);
				const state = { ...old, gear: replacement.gear, dispatch: dispatch(replacement),
					fallback: true, fallbackReason: "target-unavailable" as const };
				request.signal?.throwIfAborted();
				showStatus(ctx, state);
				return { model: replacement.model, thinkingLevel: replacement.thinkingLevel, state };
			}

			// Only a real user turn can establish, steer, replace, or leave a workflow.
			const saved = savedPair(old, ctx);
			const fingerprint = policyFingerprint(settings);
			let workflowOutcome: WorkflowTurnOutcome | undefined;
			const task = validTask(old?.task, settings.bands.length);
			const facts = branchFacts(ctx, task, request.messages, observationSupported);
			const currentHasNonTextInput = buildTaskContext(request.messages, task, facts).nonTextInput;
			let decision;
			try {
				decision = await decideTask({
					...(id ? { turnId: id } : {}), messages: request.messages, ...(old ? { previous: old } : {}), settings,
					policyFingerprint: fingerprint,
					facts,
					savedDispatchUsable: !!saved && saved.thinkingLevel === old?.dispatch?.thinkingLevel,
					...(settings.workflow.enabled ? { forceRejudge: true } : {}),
				}, async (context, signal, trigger) => {
					showStatus(ctx, undefined, true, trigger);
					if (!settings.workflow.enabled) return judgeTask(ctx, context, settings.judgeTimeoutMs, signal);
					workflowOutcome = await judgeWorkflowTurn(ctx, context, settings.judgeTimeoutMs, signal);
					return taskOutcome(workflowOutcome);
				}, request.signal);
				request.signal?.throwIfAborted();
			} catch (error) {
				showStatus(ctx, old ?? latestState(ctx));
				throw error;
			}
			const judgment = decision.judgment;
			let workflow: WorkflowState | undefined;
			let workflowRequestedBand: number | undefined;
			const outcome = workflowOutcome;
			const workflowTrusted = !!outcome?.judgment && outcome.kind === "valid"
				&& outcome.judgment.confidence >= settings.workflow.handoffMinConfidence;
			if (settings.workflow.enabled && id && workflowTrusted && !currentHasNonTextInput) {
				const turn = outcome.judgment!;
				const prior = priorWorkflow && refreshWorkflowState(priorWorkflow, workflowEvents(ctx), settings);
				const sameWorkflow = prior && prior.objective === "deliver" && prior.phase !== "complete" && prior.phase !== "blocked"
					&& turn.objective === "deliver" && outcome.relation === "same_task"
					// A new planning request supersedes execution/verification rather than inheriting an old packet.
					&& (turn.start !== "planning" || prior.phase === "planning" || prior.phase === "recovery")
					&& (outcome.relationConfidence ?? 0) >= settings.taskRouting.minConfidence
					&& (outcome.relationProbability ?? 0) >= settings.taskRouting.minConfidence;
				if (sameWorkflow && prior.activeProfile) {
					workflow = steerWorkflow(prior, id);
					if (workflow) {
						workflow.policyFingerprint = fingerprint;
						workflowRequestedBand = workflowProfileBand(settings, workflow.activeProfile!, outcome, workflow);
					}
				} else if ((turn.objective === "deliver" && (turn.start === "planning" || (turn.start === "execution" && turn.clarity === "high" && turn.risk === "low")))
					|| ((turn.objective === "plan_only" || turn.objective === "research_only") && turn.start === "planning")) {
					const phase = turn.objective === "deliver" && turn.start === "execution" ? "execution" : "planning";
					workflowRequestedBand = workflowProfileBand(settings, phase, outcome);
					workflow = newWorkflowState({
						workflowId: `workflow:${createHash("sha256").update(id).digest("hex")}`,
						initialTurnId: id,
						objective: turn.objective,
						phase,
						policyFingerprint: fingerprint,
						requestedBand: workflowRequestedBand,
					});
					if (prior) workflow.lastTransition = { from: prior.phase, to: phase, reason: "user-superseded", requestedBand: workflowRequestedBand };
				}
			}
			const workflowDiagnostic = settings.workflow.enabled && !workflow
				? workflowNonStart(outcome, currentHasNonTextInput, id, settings.workflow.handoffMinConfidence) : undefined;
			const requestedBand = workflowRequestedBand ?? decision.requestedBand;
			const desired = requestedBand !== undefined ? targetForBand(settings, requestedBand) : undefined;
			// Task mode locks the first physical gear for the whole session branch. Later scores stay
			// diagnostic: switching model or thinking level would rebuild the provider prompt cache.
			// Legacy workflow remains the only owner allowed to change the physical pair.
			const reusable = old?.fallbackReason === "disabled" ? undefined : old;
			const existingPhase = !settings.workflow.enabled ? validPhaseState(reusable?.phaseRoute) : undefined;
			let phaseIntent: ReturnType<typeof phaseChoiceIntent>;
			if (existingPhase && request.reason === "user") {
				const latest = request.messages.findLast(message => message.role === "user");
				const text = !latest ? "" : typeof latest.content === "string" ? latest.content : latest.content.flatMap(block => block.type === "text" ? [block.text] : []).join("\n");
				const requestedIntent = explicitPhaseIntent(text);
				if (!ctx.hasUI) phaseIntent = requestedIntent;
				// A plan hint is not evidence that a plan is ready. Ordinary questions must not
				// trigger a transition dialog merely because the branch is still in plan.
				else if (requestedIntent && (existingPhase.phase === "plan" || existingPhase.revising || requestedIntent === "revise")) {
					const choice = await ctx.ui.select(requestedIntent === "implement" ? "确认开始实现？" : "发现计划偏差，如何继续？", [...PHASE_CHOICES]);
					const freeText = choice === "自己补充" ? await ctx.ui.input("补充你的决定", "开始实现、继续计划，或其他具体要求") : undefined;
					phaseIntent = phaseChoiceIntent(choice, freeText) ?? explicitRevisionRequest(text);
				}
			}
			const phaseRoute: PhaseRouteState | undefined = existingPhase ?? (!settings.workflow.enabled ? {
				version: 1, phase: "plan", revising: false, planGear: initialPlanGear(judgment),
			} : undefined);
			if (phaseRoute && !existingPhase && !ctx.hasUI) {
				const content = request.messages.findLast(message => message.role === "user")?.content;
				const text = typeof content === "string" ? content : Array.isArray(content) ? content.flatMap(block => block.type === "text" ? [block.text] : []).join("\n") : "";
				const intent = explicitPhaseIntent(text);
				if (intent === "implement") { phaseRoute.phase = "implement"; phaseRoute.implementGear = implementationGear(judgment, phaseRoute.planGear); }
			}
			const lockGear: Gear | undefined = !settings.workflow.enabled
				? phaseRoute ? activeGear(phaseRoute) : reusable?.sessionLock?.gear ?? (reusable?.dispatch ? reusable.gear : undefined)
				: undefined;
			const selectedGear = lockGear ?? desired?.gear ?? old?.gear ?? FALLBACK_GEAR;
			const wanted = selectedGear;
			// A task-mode phase uses the active gear's configured thinking level, never the score band's level.
			const thinkingLevel = !settings.workflow.enabled
				? gearTarget(settings, selectedGear).thinkingLevel
				: desired?.thinkingLevel ?? old?.dispatch?.thinkingLevel;
			const retained = !lockGear && !workflow && decision.retainSavedDispatch && old ? saved ?? previousPair(request, ctx) : undefined;
			const resolved = retained && old ? { ...retained, gear: old.gear, degraded: !!old.fallback && !!judgment }
				: resolveGear(wanted, request, ctx, settings, thinkingLevel);
			if (phaseRoute && !existingPhase) phaseRoute.planGear = resolved.gear;
			if (phaseRoute && phaseIntent === "implement" && phaseRoute.phase === "plan") {
				phaseRoute.phase = "implement"; phaseRoute.revising = false;
				phaseRoute.implementGear = implementationGear(judgment, phaseRoute.planGear);
			} else if (phaseRoute && phaseIntent === "revise" && phaseRoute.phase === "implement") phaseRoute.revising = true;
			else if (phaseRoute && phaseIntent === "implement" && phaseRoute.revising) phaseRoute.revising = false;
			const phaseGear = phaseRoute ? activeGear(phaseRoute) : undefined;
			if (phaseGear && phaseGear !== resolved.gear) {
				const phaseResolved = resolveGear(phaseGear, request, ctx, settings, gearTarget(settings, phaseGear).thinkingLevel);
				resolved.model = phaseResolved.model; resolved.thinkingLevel = phaseResolved.thinkingLevel;
				resolved.gear = phaseResolved.gear; resolved.degraded = phaseResolved.degraded;
			}
			const sessionLock = !settings.workflow.enabled ? { version: 1 as const, gear: resolved.gear } : undefined;
			const fallback = (decision.trace.source !== "inherited" && !judgment) || resolved.degraded;
			const state: GearState = {
				gear: resolved.gear,
				score: decision.trace.source === "inherited" ? old?.score ?? -1 : judgment?.score ?? -1,
				adjustedScore: decision.trace.source === "inherited" ? old?.adjustedScore ?? -1 : judgment ? clampScore(judgment.score + settings.gearBias * .4) : -1,
				confidence: decision.trace.source === "inherited" ? old?.confidence ?? 0 : judgment?.confidence ?? 0,
				inputTokens: judgment?.inputTokens ?? 0,
				...(decision.task ? { task: decision.task } : {}),
				...(workflow ? { workflow } : {}),
				...(workflowDiagnostic ? { workflowDiagnostic } : {}),
				decision: { ...decision.trace, ...(workflowRequestedBand !== undefined ? { requestedBand: workflowRequestedBand } : {}) },
				fallback,
				...(fallback ? { fallbackReason: judgment ? "target-unavailable" as const : "judge-unavailable" as const } : {}),
				dispatch: dispatch(resolved),
				...(sessionLock ? { sessionLock } : {}),
				...(phaseRoute ? { phaseRoute } : {}),
				...(id ? { turnId: id } : {}),
			};
			if (request.signal?.aborted) {
				showStatus(ctx, old ?? latestState(ctx));
				request.signal.throwIfAborted();
			}
			showStatus(ctx, state);
			return {
				model: resolved.model,
				thinkingLevel: resolved.thinkingLevel,
				state,
			};
		},
	});
}
