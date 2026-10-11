import { createHash } from "node:crypto";
import { clampThinkingLevel, type Message } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, ModelRoute, ModelRouteRequest } from "@earendil-works/pi-coding-agent";
import { activeGear, implementationHint, implementationGear, initialPlanGear, parseState } from "./phase-routing.ts";
import { judgeGear, textOf } from "./judge.ts";
import { loadSettings, SETTINGS_PATH } from "./settings.ts";
import type { Gear, GearSettings, GearTarget, JudgeOutcome, RouterState, RoutingPhase } from "./types.ts";

const PROVIDER = "gears", ID = "auto", STATUS = "pi-gear-router";
const PHASE_ENTRY = "pi-gear-router.phase.v2";
type Request = ModelRouteRequest<unknown>;
type Pair = Omit<ModelRoute<unknown>, "state">;
const phaseLabel = (phase: RoutingPhase) => phase === "plan" ? "计划" : "实现";
const selected = (ctx: ExtensionContext) => ctx.model?.provider === PROVIDER && ctx.model.id === ID;
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

function settingsFor(ctx: ExtensionContext): GearSettings {
	let projectTrusted = false;
	try { projectTrusted = ctx.isProjectTrusted?.() === true; } catch { /* Missing trust is not consent. */ }
	return loadSettings(ctx.cwd, { projectTrusted });
}
function latestState(ctx: ExtensionContext): RouterState | undefined {
	const entry = ctx.sessionManager.getBranch().findLast(e => e.type === "custom" && e.customType === "pi.virtual-model-state"
		&& (e.data as { provider?: unknown })?.provider === PROVIDER && (e.data as { modelId?: unknown })?.modelId === ID);
	return entry?.type === "custom" ? parseState((entry.data as { state?: unknown })?.state) : undefined;
}
function phaseRequest(ctx: ExtensionContext): { id: string; phase: RoutingPhase } | undefined {
	for (const entry of [...ctx.sessionManager.getBranch()].reverse()) {
		if (entry.type !== "custom" || entry.customType !== PHASE_ENTRY) continue;
		const data = entry.data as { version?: unknown; phase?: unknown } | undefined;
		if (data?.version === 2 && (data.phase === "plan" || data.phase === "implement")) return { id: entry.id, phase: data.phase };
	}
}
function pendingPhase(ctx: ExtensionContext, state?: RouterState) {
	const request = phaseRequest(ctx);
	return request?.id !== state?.phaseEntryId ? request : undefined;
}
function turnKey(messages: readonly Message[], ctx: ExtensionContext): string | undefined {
	const user = messages.findLast(m => m.role === "user");
	if (!user) return;
	const entry = ctx.sessionManager.getBranch().findLast(e => e.type === "message" && e.message.role === "user" && e.message.timestamp === user.timestamp);
	return `${entry?.id ?? user.timestamp}:${digest(user.content)}`;
}
function usable(model: Pair["model"] | undefined, ctx: ExtensionContext): model is Pair["model"] {
	return !!model && model.api !== "pi-virtual" && ctx.modelRegistry.hasConfiguredAuth(model);
}
function fromTarget(target: GearTarget | undefined, ctx: ExtensionContext): Pair | undefined {
	if (!target) return;
	const model = ctx.modelRegistry.find(target.provider, target.model);
	return usable(model, ctx) ? { model, thinkingLevel: clampThinkingLevel(model, target.thinkingLevel) } : undefined;
}
function previousPair(request: Request, ctx: ExtensionContext): Pair | undefined {
	const pair = request.reason === "retry" ? request.failed ?? request.previous : request.previous;
	return pair && usable(pair.model, ctx) ? { model: pair.model, thinkingLevel: pair.thinkingLevel ?? request.thinkingLevel } : undefined;
}
function sticky(request: Request, state: RouterState | undefined, ctx: ExtensionContext): Pair | undefined {
	const saved = fromTarget(state?.dispatch, ctx);
	return request.reason === "retry" && !request.failed ? saved ?? previousPair(request, ctx) : previousPair(request, ctx) ?? saved;
}
function resolveGear(wanted: Gear, request: Request, ctx: ExtensionContext, settings: GearSettings) {
	for (const gear of new Set<Gear>([wanted, "standard", "heavy", "light"])) {
		const pair = fromTarget(settings.gears[gear], ctx);
		if (pair) return { ...pair, gear, fallback: gear !== wanted };
	}
	const previous = previousPair(request, ctx);
	if (previous) return { ...previous, gear: parseState(request.state)?.gear ?? "standard" as Gear, fallback: true };
	if (ctx.mode === "tui") ctx.ui.setStatus(STATUS, ctx.ui.theme.fg("error", "路由：无可用模型"));
	throw new Error(`pi-gear-router: no authenticated physical model available; check ${SETTINGS_PATH} and Pi credentials.`);
}
const targetOf = (pair: Pair): GearTarget => ({ provider: pair.model.provider, model: pair.model.id, thinkingLevel: pair.thinkingLevel ?? "off" });
function statusText(state: RouterState): string {
	const model = state.dispatch ? `${state.dispatch.provider}/${state.dispatch.model} · ${state.dispatch.thinkingLevel}` : "待派发";
	return `路由 ${phaseLabel(state.phase)} → ${model}${state.fallback ? " ｜ 兜底" : ""}${state.judgeFailed ? " ｜ Jev 不可用" : ""}`;
}
function statusDetails(ctx: ExtensionContext): string {
	const state = latestState(ctx), phase = pendingPhase(ctx, state);
	const activity = !selected(ctx) ? "手选物理模型；路由未运行。\n" : !settingsFor(ctx).enabled ? "路由已关闭。\n" : "";
	return `${activity}${state ? statusText(state) : "默认计划阶段；尚无派发"}${phase ? `\n下一条消息切换到${phaseLabel(phase.phase)}` : ""}`;
}
function showStatus(ctx: ExtensionContext, state?: RouterState, pending = false): void {
	if (ctx.mode !== "tui") return;
	if (!selected(ctx)) { ctx.ui.setStatus(STATUS, undefined); return; }
	if (!settingsFor(ctx).enabled) { ctx.ui.setStatus(STATUS, ctx.ui.theme.fg("muted", "路由已关闭")); return; }
	if (pending) { ctx.ui.setStatus(STATUS, ctx.ui.theme.fg("accent", "路由 Jev 评估中…")); return; }
	const phase = pendingPhase(ctx, state);
	const label = state ? statusText(state) : "路由 计划 · 待首次评估";
	ctx.ui.setStatus(STATUS, ctx.ui.theme.fg(state?.fallback || state?.judgeFailed ? "warning" : "success",
		`${label}${phase ? ` ｜ 待切换${phaseLabel(phase.phase)}` : ""}`));
}

/** Model routing only. No Skill, tool-permission, context or agent-continuation hooks. */
export default function (pi: ExtensionAPI) {
	pi.registerCommand("gear-status", {
		description: "只读查看当前路由阶段、模型与 thinking",
		handler: async (_args, ctx) => { ctx.ui.notify(statusDetails(ctx), "info"); },
	});
	pi.registerCommand("gear-phase", {
		description: "查看或切换路由阶段：plan / implement；下一条用户消息生效",
		getArgumentCompletions: prefix => ["plan", "implement"].filter(p => p.startsWith(prefix)).map(p => ({ value: p, label: p })),
		handler: async (args, ctx) => {
			const phase = args.trim(), state = latestState(ctx), pending = pendingPhase(ctx, state);
			if (!phase) { ctx.ui.notify(`${statusDetails(ctx)}\n用 /gear-phase plan|implement 切换`, "info"); return; }
			if (phase !== "plan" && phase !== "implement") { ctx.ui.notify("用法：/gear-phase plan|implement", "warning"); return; }
			if (phase === (pending?.phase ?? state?.phase ?? "plan")) { ctx.ui.notify(`已处于${phaseLabel(phase)}阶段${pending ? "（待生效）" : ""}`, "info"); return; }
			pi.appendEntry(PHASE_ENTRY, { version: 2, phase });
			ctx.ui.notify(`下一条用户消息切换到${phaseLabel(phase)}阶段；仅控制模型路由，不代表实施批准。${selected(ctx) ? "" : "请选择 gears/auto 以使用路由。"}`, "info");
			showStatus(ctx, state);
		},
	});
	const refresh = (_event: unknown, ctx: ExtensionContext) => showStatus(ctx, latestState(ctx));
	pi.on("session_start", refresh);
	pi.on("session_tree", refresh);
	pi.on("model_select", refresh);
	pi.on("session_shutdown", (_event, ctx) => { if (ctx.mode === "tui") ctx.ui.setStatus(STATUS, undefined); });
	pi.registerVirtualModel<unknown>({
		provider: PROVIDER, id: ID, name: "Auto (gears)",
		thinkingLevels: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
		contextWindow: 1_000_000, maxTokens: 131_072,
		async route(request, ctx): Promise<ModelRoute<unknown>> {
			request.signal?.throwIfAborted();
			const settings = settingsFor(ctx), old = parseState(request.state);
			if (request.reason === "direct") return previousPair(request, ctx) ?? resolveGear("standard", request, ctx, settings);
			if (!settings.enabled) { showStatus(ctx, old); return sticky(request, old, ctx) ?? resolveGear("standard", request, ctx, settings); }
			if (request.reason !== "user") {
				const pair = sticky(request, old, ctx);
				if (pair) { showStatus(ctx, old ? { ...old, dispatch: targetOf(pair) } : undefined); return pair; }
				const pairFallback = resolveGear(old ? activeGear(old) : "heavy", request, ctx, settings);
				return { model: pairFallback.model, thinkingLevel: pairFallback.thinkingLevel,
					...(old ? { state: { ...old, dispatch: targetOf(pairFallback), gear: pairFallback.gear, fallback: pairFallback.fallback } } : {}) };
			}
			const key = turnKey(request.messages, ctx), command = pendingPhase(ctx, old);
			const configKey = digest(settings.gears);
			let phase = command?.phase ?? old?.phase ?? "plan";
			if (!command && phase === "plan" && key !== old?.turnKey && ctx.hasUI) {
				const user = request.messages.findLast(m => m.role === "user");
				if (user && implementationHint(textOf(user)) && await ctx.ui.confirm("切换到实现阶段？",
					"确认后按实现档位路由；取消则保持计划。切换模型可能重建 prompt cache，不替代项目或 Skill 的审批。",
					request.signal ? { signal: request.signal } : undefined)) phase = "implement";
				request.signal?.throwIfAborted();
			}
			let outcome: JudgeOutcome | undefined;
			if (!old || (phase === "implement" && old.phase !== "implement")) {
				showStatus(ctx, old, true);
				outcome = await judgeGear(ctx, request.messages, phase, settings.judgeTimeoutMs, request.signal);
				if (request.signal?.aborted) { showStatus(ctx, old); request.signal.throwIfAborted(); }
			}
			const judgment = outcome && "judgment" in outcome ? outcome.judgment : undefined;
			const planGear = old?.planGear ?? initialPlanGear(judgment);
			const implementGear = phase === "implement"
				? !old || old.phase !== "implement" ? implementationGear(judgment, planGear) : old.implementGear!
				: old?.implementGear;
			const wanted = phase === "implement" ? implementGear! : planGear;
			// Preserve even a fallback when the phase/config are unchanged; recovery does not silently change models.
			const retained = old && phase === old.phase && configKey === old.configKey ? fromTarget(old.dispatch, ctx) : undefined;
			const pair = retained && old ? { ...retained, gear: old.gear, fallback: old.fallback } : resolveGear(wanted, request, ctx, settings);
			const next: RouterState = {
				version: 2, phase, planGear, gear: pair.gear, fallback: pair.fallback, dispatch: targetOf(pair), configKey,
				...(implementGear ? { implementGear } : {}), ...(key ? { turnKey: key } : {}),
				...(command ? { phaseEntryId: command.id } : old?.phaseEntryId ? { phaseEntryId: old.phaseEntryId } : {}),
				...(outcome ? judgment ? { judgment } : { judgeFailed: true }
					: old?.judgment ? { judgment: old.judgment } : old?.judgeFailed ? { judgeFailed: true } : {}),
			};
			request.signal?.throwIfAborted();
			showStatus(ctx, next);
			return { model: pair.model, thinkingLevel: pair.thinkingLevel,
				...(JSON.stringify(parseState(next)) !== JSON.stringify(old) ? { state: next } : {}) };
		},
	});
}
