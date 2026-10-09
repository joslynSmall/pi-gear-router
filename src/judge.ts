import type { JsonValue } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { GearJudgment, RecentMessage } from "./types.ts";

/**
 * Provider and model id of the TypeSafe Jev decision model.
 *
 * Pi ships no Jev provider by default; register `typesafe` in `~/.pi/agent/models.json`
 * with `TYPESAFE_API_KEY` set. See docs/models.md "Use classifier models".
 */
const JEV_PROVIDER = "typesafe";
const JEV_MODEL = "jev-latest";

/** Bounds on what we send, so one long transcript cannot inflate the verdict's cost. */
const MAX_PROMPT_CHARS = 16_000;
const MAX_RECENT_MESSAGES = 10;
const MAX_RECENT_CHARS = 256;

/**
 * The judge question.
 *
 * The wording is adapted from pi-gearshift, which drives Jev through the TypeSafe SDK's
 * `score()` helper and splits the prompt into `context`, `objective` and `guidance`.
 * Pi's built-in `classify()` exposes only `instructions` and `criteria`, so the three parts
 * are folded into one `instructions` string. The criteria anchors are unchanged.
 *
 * The load-bearing part is the objective: ask for the LOWEST capability tier that will
 * still finish the turn correctly. Asking "how hard is this?" instead biases every
 * ordinary request upward.
 */
const INSTRUCTIONS = [
	"This score selects the model and thinking level for the next turn of Pi, a coding agent that can inspect repositories, edit files, run commands, and use tools.",
	"The user has configured light, standard, and heavy in increasing capability order.",
	"Rate the LOWEST capability level likely to complete the request correctly and efficiently without avoidable retries or user correction.",
	"Judge the capability needed for the next turn, not the general importance of the topic.",
	"Treat `request` as authoritative. Use `recent` only to resolve references, omitted context, and follow-up intent.",
	"Do not inherit earlier difficulty when `request` is independent of the recent turns.",
	"Consider reasoning depth, ambiguity, repository scope, debugging subtlety, risk, and the cost of failure.",
].join(" ");

const CRITERIA = [
	"Light: straightforward, well-scoped work with an obvious approach, such as formatting, a simple lookup, a mechanical edit, or a small low-risk change.",
	"Standard: typical coding-agent work requiring repository inspection, implementation decisions, debugging, or coordinated changes with moderate uncertainty.",
	"Heavy: work requiring unusually deep reasoning or caution, such as subtle root-cause analysis, architecture decisions, broad refactors, security-sensitive changes, high ambiguity, or high-cost failure.",
];

/** Keep head and tail; the middle of a long message carries the least routing signal. */
function truncateMiddle(text: string, maxLength = MAX_RECENT_CHARS): string {
	const chars = Array.from(text);
	if (chars.length <= maxLength) return text;
	const available = maxLength - 3;
	const head = chars.slice(0, Math.ceil(available / 2)).join("");
	const tail = chars.slice(chars.length - Math.floor(available / 2)).join("");
	return `${head}...${tail}`;
}

function lastUserText(ctx: ExtensionContext, messages: readonly { role: string; content: unknown }[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (!message || message.role !== "user") continue;
		const content = message.content;
		if (typeof content === "string") return content;
		if (Array.isArray(content)) {
			return content
				.flatMap((block) => {
					const typed = block as { type?: string; text?: string };
					return typed.type === "text" && typeof typed.text === "string" ? [typed.text] : [];
				})
				.join("\n");
		}
	}
	return "";
}

function recentMessages(ctx: ExtensionContext): RecentMessage[] {
	return ctx.sessionManager
		.buildSessionProjection()
		.messages.flatMap((message) => {
			if (message.role !== "user" && message.role !== "assistant") return [];
			const content = message.content;
			const text =
				typeof content === "string"
					? content
					: content
							.flatMap((block) => (block.type === "text" ? [block.text] : []))
							.join("\n");
			if (!text.trim()) return [];
			return [{ role: message.role, text: truncateMiddle(text) }];
		})
		.slice(-MAX_RECENT_MESSAGES);
}

/**
 * Ask Jev which gear the next turn needs.
 *
 * Returns `null` when the classifier is unavailable or did not answer, so the caller can
 * keep the current model instead of failing the turn. `classify()` never rejects.
 */
export async function judgeGear(
	ctx: ExtensionContext,
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<GearJudgment | null> {
	const jev = ctx.modelRegistry.getModelOfType("classifier", JEV_PROVIDER, JEV_MODEL);
	if (!jev) return null;

	const request = lastUserText(ctx, ctx.sessionManager.buildSessionProjection().messages as never[]);
	if (!request.trim()) return null;

	try {
		const result = await ctx.modelRegistry.classify(
			jev,
			{
				state: {
					request: request.slice(0, MAX_PROMPT_CHARS),
					recent: recentMessages(ctx) as unknown as JsonValue,
				},
				questions: {
					gear: { type: "score", instructions: INSTRUCTIONS, criteria: CRITERIA },
				},
			},
			{ ...(signal ? { signal } : {}), timeoutMs },
		);

		if (result.stopReason !== "stop") return null;
		const answer = result.answers.gear;
		if (!answer || answer.type !== "score") return null;

		return {
			score: answer.score,
			confidence: answer.confidence,
			inputTokens: result.usage?.input ?? 0,
		};
	} catch {
		// The classifier is an optimisation. Never let it break the turn.
		return null;
	}
}