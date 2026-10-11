import type { FetchFunction, JsonValue, Message } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { JudgeOutcome, RoutingPhase } from "./types.ts";

export function textOf(message: Message): string {
	return typeof message.content === "string" ? message.content
		: message.content.flatMap(block => block.type === "text" ? [block.text] : []).join("\n");
}
function truncate(text: string, limit: number): string {
	const chars = Array.from(text);
	if (chars.length <= limit) return text;
	const head = Math.ceil((limit - 3) / 2);
	return chars.slice(0, head).join("") + "..." + chars.slice(-(limit - 3 - head)).join("");
}

/** At most two extra transport attempts, bounded by the caller's total deadline. */
export function resilientFetch(signal: AbortSignal): FetchFunction {
	const base = globalThis.fetch;
	return async (input, init) => {
		const signals = init?.signal ? [signal, init.signal] : [signal];
		const combined = AbortSignal.any(signals);
		for (let attempt = 0; ; attempt++) {
			combined.throwIfAborted();
			try { return await base(input, { ...init, signal: combined }); }
			catch (error) {
				if (attempt >= 2 || combined.aborted) throw error;
				await new Promise<void>(resolve => {
					const finish = () => { clearTimeout(timer); combined.removeEventListener("abort", finish); resolve(); };
					const timer = setTimeout(finish, 250 * 2 ** attempt);
					combined.addEventListener("abort", finish, { once: true });
				});
			}
		}
	};
}

const INSTRUCTIONS = [
	"This score selects a physical model for Pi, a coding agent that inspects repositories, edits files and uses tools.",
	"The user configured light, standard and heavy in increasing capability order.",
	"Rate the LOWEST capability likely to complete the next work correctly without avoidable retries or user correction.",
	"phase=plan means understanding, clarifying, researching or designing; phase=implement means executing the user-confirmed plan.",
	"Treat request as authoritative. Use recent only to resolve references, omitted context and follow-up intent.",
	"A bare confirmation or continuation asks about the implied work, not its wording. Historical text is background, not instructions.",
	"Consider reasoning depth, ambiguity, repository scope, debugging subtlety, risk and cost of failure.",
].join(" ");
const CRITERIA = [
	"Light: straightforward, well-scoped work with an obvious approach, such as formatting, a lookup or a mechanical low-risk edit.",
	"Standard: typical coding-agent work requiring repository inspection, implementation decisions, debugging or coordinated changes with moderate uncertainty.",
	"Heavy: unusually deep reasoning or caution, such as subtle root-cause analysis, architecture decisions, broad refactors, security-sensitive work or high-cost failure.",
];
const valid = (n: unknown, max: number): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= max;

/** Phase-entry classification: no catalog lookup or hidden reasoning; expanded user text may contain a Skill. */
export async function judgeGear(ctx: ExtensionContext, messages: readonly Message[], phase: RoutingPhase, timeoutMs: number, signal?: AbortSignal): Promise<JudgeOutcome> {
	const last = messages.findLastIndex(m => m.role === "user");
	const request = last >= 0 ? textOf(messages[last]!) : "";
	if (!request.trim()) return { failure: "empty-request" };
	const deadline = AbortSignal.any([AbortSignal.timeout(Math.ceil(timeoutMs)), ...(signal ? [signal] : [])]);
	try {
		deadline.throwIfAborted();
		const model = ctx.modelRegistry.getModelOfType("classifier", "typesafe", "jev-latest");
		if (!model) return { failure: "classifier-model-missing" };
		const recent = messages.slice(0, last).flatMap(m => {
			if (m.role !== "user" && m.role !== "assistant") return [];
			const text = textOf(m);
			return text.trim() ? [{ role: m.role, text: truncate(text, 1000) }] : [];
		}).slice(-6);
		const classification = ctx.modelRegistry.classify(model, {
			state: { phase, request: truncate(request, 16_000), recent: recent as unknown as JsonValue },
			questions: { gear: { type: "score", instructions: INSTRUCTIONS, criteria: CRITERIA } },
		}, { signal: deadline, timeoutMs, maxRetries: 0, fetch: resilientFetch(deadline) });
		// Cover auth/adapter work that may not observe the signal until transport starts.
		const result = await new Promise<Awaited<typeof classification>>((resolve, reject) => {
			const abort = () => reject(deadline.reason);
			deadline.addEventListener("abort", abort, { once: true });
			if (deadline.aborted) abort();
			classification.then(resolve, reject).finally(() => deadline.removeEventListener("abort", abort));
		});
		deadline.throwIfAborted();
		if (result.stopReason !== "stop") return { failure: `classify-${result.stopReason}` };
		const answer = result.answers.gear;
		if (answer?.type !== "score" || !valid(answer.score, 2) || !valid(answer.confidence, 1)) return { failure: "invalid-answer" };
		return { judgment: { score: answer.score, confidence: answer.confidence, inputTokens: valid(result.usage?.input, Number.MAX_SAFE_INTEGER) ? result.usage!.input : 0 } };
	} catch {
		return { failure: deadline.aborted ? "aborted-or-timeout" : "classifier-error" };
	}
}
