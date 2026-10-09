import type { Message } from "@earendil-works/pi-ai";
import type { BranchFacts, JudgeInput, TaskState } from "./types.ts";

export const CONTEXT_VERSION = "task-context-v1";
const CONTINUATIONS = new Set(["继续", "继续吧", "继续处理", "继续处理这个问题", "按刚才的方案继续", "按这个方案继续", "按方案继续", "continue", "please continue", "go on"]);
export function truncate(text: string, limit: number): string {
	const chars = Array.from(text);
	if (chars.length <= limit) return text;
	const left = Math.ceil((limit - 3) / 2);
	return chars.slice(0, left).join("") + "..." + chars.slice(-(limit - 3 - left)).join("");
}
export function textOf(message: Message): string {
	return typeof message.content === "string" ? message.content : message.content.flatMap(b => b.type === "text" ? [b.text] : []).join("\n");
}
export function normalized(text: string): string {
	return text.normalize("NFC").trim().toLowerCase().replace(/[。.!！]$/, "").trim();
}
export function isContinuation(text: string): boolean { return CONTINUATIONS.has(normalized(text)); }
export function hasNonText(message: Message | undefined): boolean {
	return !!message && typeof message.content !== "string" && message.content.some(b => b.type !== "text");
}
export function buildTaskContext(messages: readonly Message[], task: TaskState | undefined, facts: BranchFacts): JudgeInput {
	const index = messages.findLastIndex(m => m.role === "user");
	const current = messages[index];
	const recent = messages.slice(0, index).filter(m => m.role === "assistant" && textOf(m).trim()).slice(-3)
		.map(m => ({ role: "assistant" as const, text: truncate(textOf(m), 1000) }));
	return {
		request: truncate(current ? textOf(current) : "", 16_000),
		...(task ? { task: { anchor: task.anchor, userChanges: [...task.userChanges] } } : {}),
		recent,
		observations: [
			...(facts.verificationFailed ? ["verification-failed"] : []),
			...(facts.completionHint ? ["completion-hint-not-proof"] : []),
			...(facts.manualModelGap ? ["manual-model-gap"] : []),
			...(facts.contextMissing || facts.coverage === "unknown" ? ["observation-coverage-unknown"] : []),
		],
		nonTextInput: hasNonText(current),
	};
}
