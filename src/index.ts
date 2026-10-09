import { createHash } from "node:crypto";
import { clampThinkingLevel, type Message } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionContext,
	ModelRoute,
	ModelRouteRequest,
} from "@earendil-works/pi-coding-agent";
import { bandForScore, clampScore, gearTarget, targetForBand } from "./gears.ts";
import { judgeTask } from "./judge.ts";
import { decideTask, policyFingerprint, validTask } from "./task-routing.ts";
import { branchFacts, clearObservationCoverage, registerObservations } from "./observation.ts";
import { loadSettings, SETTINGS_PATH } from "./settings.ts";
import type { Gear, GearSettings, GearState, GearTarget } from "./types.ts";

const PROVIDER = "gears";
const ID = "auto";
const FALLBACK_GEAR: Gear = "standard";
const STATUS_KEY = "pi-gear-router";
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

function showStatus(ctx: ExtensionContext, state?: GearState, pending = false, trigger?: string): void {
	if (ctx.mode !== "tui") return;
	const theme = ctx.ui.theme;
	if (pending) {
		ctx.ui.setStatus(STATUS_KEY, theme.fg("accent", trigger === "periodic" ? "Jev 评估中…（周期）" : trigger === "downgrade-review" ? "Jev 评估中…（降档复核）" : "Jev 评估中…"));
		return;
	}
	if (!state?.dispatch) {
		ctx.ui.setStatus(STATUS_KEY, undefined);
		return;
	}
	const result = state.decision?.source === "inherited"
		? `沿用 Jev ${state.score.toFixed(2)} · 续接 ${state.task?.inheritedTurns ?? 0}/${loadSettings().taskRouting.maxInheritedTurns}`
		: state.score >= 0 ? `Jev ${state.score.toFixed(2)}${state.decision?.action === "uncertain" ? " · 关系不明" : state.task?.review || (state.decision?.action === "hold" && (state.decision.requestedBand ?? 0) > bandForScore(state.adjustedScore)) ? " · 降档保护" : ""}` : "Jev 不可用";
	const fallback = state.fallback ? " fallback" : "";
	const label = `${result} → ${state.gear}/${state.dispatch.thinkingLevel}${fallback} → ${state.dispatch.provider}/${state.dispatch.model}`;
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

/** Adapt capability between user turns; freeze each turn's physical pair, including fallbacks. */
export default function (pi: ExtensionAPI) {
	const observationSupported = typeof pi.appendEntry === "function";
	if (observationSupported) registerObservations(pi);
	pi.on("session_start", (_event, ctx) => showStatus(ctx, latestState(ctx)));
	pi.on("session_tree", (_event, ctx) => showStatus(ctx, latestState(ctx)));
	pi.on("session_shutdown", (_event, ctx) => {
		clearObservationCoverage(ctx);
		showStatus(ctx);
	});
	pi.registerVirtualModel<GearState>({
		provider: PROVIDER,
		id: ID,
		name: "Auto (gears)",
		thinkingLevels: ["off", "low", "medium", "high", "xhigh", "max"],
		contextWindow: 1_000_000,
		maxTokens: 131_072,
		async route(request: GearRequest, ctx: ExtensionContext): Promise<ModelRoute<GearState>> {
			request.signal?.throwIfAborted();
			const settings = loadSettings();
			const old = request.state;
			if (request.reason === "direct") {
				const pair = !settings.enabled ? previousPair(request, ctx)
					?? resolveGear(FALLBACK_GEAR, request, ctx, settings)
					: resolveGear("light", request, ctx, settings);
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

			if (request.reason !== "user") {
				// Preserve the actual dispatched pair, even if gear settings changed mid-turn.
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

			// Only new user turns reach task adaptation; within-turn routing above remains sticky.
			const saved = savedPair(old, ctx);
			let decision;
			try {
				decision = await decideTask({
					...(id ? { turnId: id } : {}), messages: request.messages, ...(old ? { previous: old } : {}), settings,
					policyFingerprint: policyFingerprint(settings),
					facts: branchFacts(ctx, validTask(old?.task), request.messages, observationSupported),
					savedDispatchUsable: !!saved && saved.thinkingLevel === old?.dispatch?.thinkingLevel,
				}, (context, signal, trigger) => {
					showStatus(ctx, undefined, true, trigger);
					return judgeTask(ctx, context, settings.judgeTimeoutMs, signal);
				}, request.signal);
				request.signal?.throwIfAborted();
			} catch (error) {
				showStatus(ctx, old ?? latestState(ctx));
				throw error;
			}
			const judgment = decision.judgment;
			const desired = decision.requestedBand !== undefined ? targetForBand(decision.requestedBand) : undefined;
			const wanted = desired?.gear ?? old?.gear ?? FALLBACK_GEAR;
			const thinkingLevel = desired?.thinkingLevel ?? old?.dispatch?.thinkingLevel;
			const retained = decision.retainSavedDispatch && old ? saved ?? previousPair(request, ctx) : undefined;
			const resolved = retained && old ? { ...retained, gear: old.gear, degraded: !!old.fallback && !!judgment }
				: resolveGear(wanted, request, ctx, settings, thinkingLevel);
			const fallback = (decision.trace.source !== "inherited" && !judgment) || resolved.degraded;
			const state: GearState = {
				gear: resolved.gear,
				score: decision.trace.source === "inherited" ? old?.score ?? -1 : judgment?.score ?? -1,
				adjustedScore: decision.trace.source === "inherited" ? old?.adjustedScore ?? -1 : judgment ? clampScore(judgment.score + settings.gearBias * .4) : -1,
				confidence: decision.trace.source === "inherited" ? old?.confidence ?? 0 : judgment?.confidence ?? 0,
				inputTokens: judgment?.inputTokens ?? 0,
				...(decision.task ? { task: decision.task } : {}),
				decision: decision.trace,
				fallback,
				...(fallback ? { fallbackReason: judgment ? "target-unavailable" as const : "judge-unavailable" as const } : {}),
				dispatch: dispatch(resolved),
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
