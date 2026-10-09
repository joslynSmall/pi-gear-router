import type { Message } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionContext,
	ModelRoute,
	ModelRouteRequest,
} from "@earendil-works/pi-coding-agent";
import { describeGear, gearForScore, gearTarget } from "./gears.ts";
import { judgeGear } from "./judge.ts";
import type { Gear, GearState } from "./types.ts";
import { loadSettings } from "./settings.ts";

/**
 * pi-gear-router — per-turn three-gear model routing, judged by TypeSafe Jev.
 *
 * Registers the virtual model `gears/auto`. Before each turn Jev scores the request 0..2 and
 * the score picks light / standard / heavy; each gear names its own model and thinking level.
 *
 * Why a virtual model rather than gearshift's `before_agent_start` + `pi.setModel()`:
 * a virtual model is a first-class catalog entry. The selection survives resume (restored from
 * the last `model_change` entry), it needs no global mutation of pi's current model, and the
 * footer already shows both the selection and the dispatched physical model.
 *
 * The judge runs once per turn, not once per request. Its verdict is stored as router state on
 * the session branch, so tool follow-ups and retries reuse it and never pay the classification
 * twice. Within a turn the router is sticky: `continuation` returns the model that just
 * answered and `retry` returns the model that failed, which keeps prompt caches and thinking
 * signatures valid. Switching only happens between turns, where the cache is already cold.
 *
 * Every failure path keeps the current model. A classifier outage must not break the agent.
 *
 * Usage: pi -e ./src/index.ts --model gears/auto
 */

const PROVIDER = "gears";
const ID = "auto";

/** Gear to use when the classifier is unavailable or unconfigured. */
const FALLBACK_GEAR: Gear = "standard";

type GearRequest = ModelRouteRequest<GearState>;

function physicalFor(state: GearState, settings: ReturnType<typeof loadSettings>) {
	const target = gearTarget(settings, state.gear);
	return target;
}

export default function (pi: ExtensionAPI) {
	pi.registerVirtualModel<GearState>({
		provider: PROVIDER,
		id: ID,
		name: "Auto (gears)",
		thinkingLevels: ["off", "low", "medium", "high", "xhigh", "max"],
		// Shown before the first response; afterwards pi uses the physical model's real limits.
		contextWindow: 1_000_000,
		maxTokens: 131_072,
		async route(request: GearRequest, ctx: ExtensionContext) {
			const settings = loadSettings();
			const to = (gear: Gear, thinkingOverride?: string): ModelRoute<GearState> => {
				const target = physicalFor({ gear, score: 0, adjustedScore: 0, confidence: 0 }, settings);
				const model = ctx.modelRegistry.find(target.provider, target.model);
				if (!model) {
					// Unknown target: keep whatever pi already had. Throwing here fails the turn.
					throw new Error(
						`pi-gear-router: ${target.provider}/${target.model} is not in pi's model catalog. Check gears in ~/.pi/agent/pi-gear-router.json.`,
					);
				}
				return {
					model,
					thinkingLevel: (thinkingOverride ?? target.thinkingLevel) as ModelRoute<GearState>["thinkingLevel"],
				};
			};

			// Outside the agent loop (compaction summaries, extension calls): cheap gear, no judge.
			if (request.reason === "direct") return to("light");

			// Keep this turn's gear across tool follow-ups and retries. Caches survive.
			const sticky = request.reason === "retry" ? request.failed : request.previous;
			if (request.reason !== "user" && sticky && request.state) {
				return to(request.state.gear);
			}

			// Reuse the stored verdict if this branch already has one.
			if (request.state) {
				return to(request.state.gear, request.state.gear === "heavy" ? request.thinkingLevel : undefined);
			}

			// Fresh turn: one judge call. On any failure fall back and remember that choice.
			const judgment = await judgeGear(ctx, settings.judgeTimeoutMs, request.signal);
			if (!judgment) {
				return to(FALLBACK_GEAR);
			}
			const { gear, adjustedScore } = gearForScore(judgment.score, settings.gearBias);
			const target = gearTarget(settings, gear);
			const model = ctx.modelRegistry.find(target.provider, target.model);
			if (!model) {
				throw new Error(
					`pi-gear-router: ${target.provider}/${target.model} is not in pi's model catalog. Check gears in ~/.pi/agent/pi-gear-router.json.`,
				);
			}
			const thinkingLevel = (
				gear === "heavy" ? request.thinkingLevel : target.thinkingLevel
			) as ModelRoute<GearState>["thinkingLevel"];
			return {
				model,
				thinkingLevel,
				state: { gear, score: judgment.score, adjustedScore, confidence: judgment.confidence },
			};
		},
	});
}