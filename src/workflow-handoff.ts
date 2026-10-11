import { resolveRoutingMode } from "./gears.ts";
import { createHash } from "node:crypto";
import { defineTool, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type, type JsonValue, type Static } from "@earendil-works/pi-ai";
import { latestRouterState } from "./observation.ts";
import { judgeWorkflowHandoff } from "./workflow-judge.ts";
import { WORKFLOW_EVENT_TYPE, latestValidationOutcome, refreshWorkflowState, validWorkflowPacket, validWorkflowState, workflowBand, workflowPacketDigest, workflowFacts } from "./workflow-routing.ts";
import { validTask } from "./task-routing.ts";
import type { GearSettings, WorkflowEvent, WorkflowPacket } from "./types.ts";

export const WORKFLOW_HANDOFF_TOOL = "gear_workflow_handoff";
const STATUS_KEY = "pi-gear-router";
const item = Type.String({ minLength: 1, maxLength: 2_000 });
const textList = Type.Array(item, { maxItems: 12 });
const packetSchema = Type.Union([
	Type.Object({ kind: Type.Literal("execution"), goal: item, nonGoals: textList,
		decisions: Type.Array(Type.Object({ decision: item, rationale: item }), { minItems: 1, maxItems: 12 }),
		steps: Type.Array(Type.Object({ id: Type.String({ minLength: 1, maxLength: 128 }), scope: Type.Array(item, { minItems: 1, maxItems: 12 }), change: item, acceptance: Type.Array(item, { minItems: 1, maxItems: 12 }) }), { minItems: 1, maxItems: 12 }),
		constraints: textList, validation: textList, risks: textList, blockingUnknowns: textList }),
	Type.Object({ kind: Type.Literal("verification"), goal: item, implementedSteps: Type.Array(item, { minItems: 1, maxItems: 12 }), validationPlan: Type.Array(item, { minItems: 1, maxItems: 12 }), expectedEvidence: Type.Array(item, { minItems: 1, maxItems: 12 }), knownLimitations: textList, blockingUnknowns: textList }),
	Type.Object({ kind: Type.Literal("recovery"), goal: item, currentState: item, failedAssumptions: Type.Array(item, { minItems: 1, maxItems: 12 }), evidence: Type.Array(item, { minItems: 1, maxItems: 12 }), questionsToResolve: Type.Array(item, { minItems: 1, maxItems: 12 }), constraints: textList, blockingUnknowns: textList }),
	Type.Object({ kind: Type.Literal("complete"), goal: item, acceptanceEvidence: Type.Array(item, { minItems: 1, maxItems: 12 }), validationSummary: Type.Array(item, { minItems: 1, maxItems: 12 }), remainingIssues: textList }),
]);
export const workflowHandoffParameters = Type.Object({ packet: packetSchema });
type HandoffParameters = Static<typeof workflowHandoffParameters>;

function targetFor(current: string, packet: WorkflowPacket): "execution" | "verification" | "recovery" | "complete" | undefined {
	if ((current === "planning" || current === "recovery") && packet.kind === "execution") return "execution";
	if (current === "execution" && packet.kind === "verification") return "verification";
	if ((current === "execution" || current === "verification") && packet.kind === "recovery") return "recovery";
	if (current === "verification" && packet.kind === "complete") return "complete";
}
function events(ctx: ExtensionContext): unknown[] {
	return ctx.sessionManager.getBranch().flatMap(entry => entry.type === "custom" && entry.customType === WORKFLOW_EVENT_TYPE ? [entry.data] : []);
}
function short(text: string): string { return text.replace(/\s+/gu, " ").trim().slice(0, 200) || "invalid-handoff"; }
function result(content: string, data: JsonValue, isError = false) {
	return { content: [{ type: "text" as const, text: content }], details: data, structuredContent: data, ...(isError ? { isError: true } : {}) };
}
function createHandoffId(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function handoffStatus(ctx: ExtensionContext, phase: string, status: string, color: "accent" | "success" | "warning" = "accent"): void {
	if (ctx.mode !== "tui") return;
	ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg(color, `工作流 ${phase} · ${status}`));
}

/** Register the only model-authorized way to advance an opt-in workflow phase. */
export function registerWorkflowHandoff(pi: ExtensionAPI, settings: (cwd?: string, ctx?: ExtensionContext) => GearSettings): void {
	pi.registerTool(defineTool({
		name: WORKFLOW_HANDOFF_TOOL,
		label: "Workflow Handoff",
		description: "Submit a bounded structured handoff to advance the active gears workflow. Use it only after the current phase has enough concrete evidence. It validates the packet independently; natural-language claims never switch workflow phases.",
		parameters: workflowHandoffParameters,
		outputSchema: Type.Object({ accepted: Type.Boolean(), reason: Type.String(), handoffId: Type.Optional(Type.String()), targetPhase: Type.Optional(Type.String()), requestedBand: Type.Optional(Type.Number()), packetDigest: Type.Optional(Type.String()), packet: Type.Optional(packetSchema) }),
		executionMode: "sequential",
		defaultActive: false,
		annotations: { readOnlyHint: true, idempotentHint: false },
		async execute(toolCallId: string, params: HandoffParameters, signal, _onUpdate, ctx) {
			if (ctx.model?.provider !== "gears" || ctx.model.id !== "auto") return result("Workflow handoff is available only while gears/auto is selected.", { accepted: false, reason: "wrong-model" }, true);
			signal?.throwIfAborted();
			const config = settings(ctx.cwd, ctx);
			const state = latestRouterState(ctx);
			const branchEvents = events(ctx);
			const persisted = validWorkflowState(state?.workflow, config.bands.length);
			const workflow = persisted ? refreshWorkflowState(persisted, branchEvents, config) : undefined;
			if (resolveRoutingMode(config).mode !== "legacy-workflow" || !workflow || !state?.turnId || workflow.activeTurnId !== state.turnId) return result("No active opt-in workflow can accept a handoff.", { accepted: false, reason: "workflow-inactive" }, true);
			if (workflow.objective !== "deliver" || workflow.phase === "complete" || workflow.phase === "blocked") return result("The active workflow cannot advance from its current objective or phase.", { accepted: false, reason: "workflow-not-advanceable" }, true);
			if (workflow.transitionCount >= config.workflow.maxTransitions) {
				const blocked: WorkflowEvent = { version: 1, kind: "blocked", workflowId: workflow.workflowId, phase: workflow.activeProfile!, sourceTurnId: state.turnId };
				try { pi.appendEntry(WORKFLOW_EVENT_TYPE, blocked); } catch { /* refusal remains safe even if persistence fails */ }
				return result("Workflow transition budget is exhausted; report the blocker instead of changing phase again.", { accepted: false, reason: "transition-budget" }, true);
			}
			const packet = validWorkflowPacket(params.packet);
			const to = packet ? targetFor(workflow.phase, packet) : undefined;
			if (!packet || !to) return result("This packet is invalid or does not match a legal transition from the current workflow phase.", { accepted: false, reason: "invalid-packet-or-transition" }, true);
			if ((packet.kind === "execution" || packet.kind === "verification") && packet.blockingUnknowns.length > 0) return result("Resolve or explicitly keep researching the blocking unknowns before requesting this handoff.", { accepted: false, reason: "blocking-unknowns" }, true);
			const facts = workflowFacts(branchEvents, workflow.workflowId, config.bands.length);
			if (facts.accepted.some(event => event.sourceTurnId === state.turnId && event.from === workflow.phase)) return result("A handoff for this phase and user turn is already accepted; wait for its continuation instead of submitting another.", { accepted: false, reason: "handoff-already-accepted" }, true);
			const currentValidation = latestValidationOutcome(branchEvents, workflow.workflowId, state.turnId, config.bands.length);
			if (packet.kind === "complete" && (currentValidation !== "passed" || packet.remainingIssues.length > 0)) return result("Completion requires the latest validation fact for the active user turn to be passing and no remaining issues.", { accepted: false, reason: "completion-evidence-missing" }, true);
			const task = validTask(state.task, config.bands.length);
			handoffStatus(ctx, workflow.phase, "handoff 提交中");
			const verdict = await judgeWorkflowHandoff(ctx, {
				objective: workflow.objective, phase: workflow.phase, packet,
				...(task ? { task: { anchor: task.anchor.slice(0, 4_000), userChanges: task.userChanges.slice(-3) } } : {}),
				validation: currentValidation ? [`validation-${currentValidation}`] : [],
			}, config.judgeTimeoutMs, signal);
			signal?.throwIfAborted();
			if (verdict.kind !== "valid" || !verdict.judgment) {
				handoffStatus(ctx, workflow.phase, "handoff 未验证", "warning");
				return result("Handoff readiness could not be verified; keep the current phase and retry after new evidence.", { accepted: false, reason: short(verdict.failure ?? "classifier-unavailable") }, true);
			}
			const judgment = verdict.judgment;
			if (judgment.delivery !== "deliver" || judgment.readiness !== "ready" || judgment.confidence < config.workflow.handoffMinConfidence) {
				const rejected: WorkflowEvent = { version: 1, kind: "handoff-rejected", workflowId: workflow.workflowId, sourceTurnId: state.turnId, from: workflow.phase, to, reason: short(`${judgment.delivery}/${judgment.readiness} confidence=${judgment.confidence.toFixed(2)}`) };
				try { pi.appendEntry(WORKFLOW_EVENT_TYPE, rejected); }
				catch {
					handoffStatus(ctx, workflow.phase, "handoff 记录失败", "warning");
					return result("The rejected handoff could not be persisted, so no phase change was accepted.", { accepted: false, reason: "event-append-failed" }, true);
				}
				handoffStatus(ctx, workflow.phase, "handoff 已拒绝", "warning");
				return result("The independent readiness check rejected this handoff; continue convergence or report a blocker.", { accepted: false, reason: rejected.reason }, true);
			}
			const requestedBand = workflowBand(config, { profile: to === "complete" ? "verification" : to, score: judgment.capability.score, risk: judgment.risk, clarity: packet.kind === "execution" ? "high" : "medium", packet });
			const digest = workflowPacketDigest(packet);
			const handoffId = createHandoffId({ workflowId: workflow.workflowId, toolCallId, from: workflow.phase, to, digest });
			const accepted: WorkflowEvent = { version: 1, kind: "accepted-handoff", workflowId: workflow.workflowId, sourceTurnId: state.turnId, handoffId, from: workflow.phase, to, packet, packetDigest: digest, readinessConfidence: judgment.confidence, requestedBand };
			try { pi.appendEntry(WORKFLOW_EVENT_TYPE, accepted); }
			catch {
				handoffStatus(ctx, workflow.phase, "handoff 记录失败", "warning");
				return result("The handoff could not be persisted, so no phase switch was accepted.", { accepted: false, reason: "event-append-failed" }, true);
			}
			handoffStatus(ctx, workflow.phase, `已接受 → ${to}`, "success");
			return {
				...result(`Accepted ${workflow.phase} → ${to} handoff. The next workflow continuation may use the target phase profile.`, { accepted: true, reason: "accepted", handoffId, targetPhase: to, requestedBand, packetDigest: digest, packet: packet as unknown as JsonValue }),
				...(verdict.usageReported ? { usage: { input: judgment.capability.inputTokens } } : {}),
			};
		},
	}));
}
