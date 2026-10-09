import type { Message } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { normalized, textOf } from "./task-context.ts";
import type { BranchFacts, GearState, TaskState } from "./types.ts";
export const OBSERVATION_TYPE = "pi-gear-router.observation";
const failedObservation = new WeakSet<object>();
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
			if (!result || !Number.isInteger(result.exit_code) || result.exit_code === 0 || !event.isError) return;
			const state = latestRouterState(ctx);
			if (!state?.task?.taskId || !state.turnId) return;
			const duplicate = ctx.sessionManager.getBranch().some(e => e.type === "custom" && e.customType === OBSERVATION_TYPE
				&& failureMarker(e.data)?.taskId === state.task!.taskId && failureMarker(e.data)?.turnId === state.turnId);
			if (!duplicate && !ctx.signal?.aborted) pi.appendEntry(OBSERVATION_TYPE, { version: 1, taskId: state.task.taskId, turnId: state.turnId, kind: "verification-failed" });
		} catch {
			failedObservation.add(ctx.sessionManager);
			// A failed append makes coverage unknown; never change tool results or block execution.
		}
	});
}
