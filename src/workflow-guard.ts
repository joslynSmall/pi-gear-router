import { resolveRoutingMode } from "./gears.ts";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Message } from "@earendil-works/pi-ai";
import { latestRouterState } from "./observation.ts";
import { WORKFLOW_EVENT_TYPE, refreshWorkflowState, validWorkflowState, workflowFacts } from "./workflow-routing.ts";
import type { GearSettings, WorkflowEvent, WorkflowPhase, WorkflowState } from "./types.ts";

function activeWorkflow(ctx: ExtensionContext, settings: GearSettings): WorkflowState | undefined {
	if (resolveRoutingMode(settings).mode !== "legacy-workflow" || ctx.model?.provider !== "gears" || ctx.model.id !== "auto") return;
	const state = validWorkflowState(latestRouterState(ctx)?.workflow, settings.bands.length);
	return state ? refreshWorkflowState(state, latestEvents(ctx), settings) ?? state : undefined;
}
function convergencePhase(phase: WorkflowPhase): phase is "planning" | "recovery" {
	return phase === "planning" || phase === "recovery";
}
function packetInstruction(state: WorkflowState): string {
	return state.activePacket ? `\nAccepted packet (${state.activePacket.digest}):\n${JSON.stringify(state.activePacket.packet)}` : "";
}

/** Stable system text: it changes only with phase/accepted packet, not every tool continuation. */
export function workflowInstruction(state: WorkflowState): string {
	const common = "[GEAR WORKFLOW CONTROL — extension generated]\nNatural-language claims do not change workflow phase. Only gear_workflow_handoff may request a transition.\nPhases describe routing and work focus, not tool authorization. Pi and its permission extensions retain all tool permissions; follow the user request and project requirements.";
	if (state.phase === "planning") {
		if (state.objective !== "deliver") return `${common}\nPhase: planning (${state.objective}). Focus on inspection and the requested plan or research result. Do not submit a delivery handoff; automatic routing to execution is not enabled for this objective.${packetInstruction(state)}`;
		return `${common}\nPhase: planning. Focus on inspection, research, resolving key uncertainty, making decisions and forming a bounded execution packet. When ready, call gear_workflow_handoff; otherwise explain the blocker.${packetInstruction(state)}`;
	}
	if (state.phase === "recovery") return `${common}\nPhase: recovery. Focus on diagnosing failed assumptions and repairing the plan. When a concrete implementation path is ready, call gear_workflow_handoff with an execution packet.${packetInstruction(state)}`;
	if (state.phase === "execution") return `${common}\nPhase: execution. The latest user request is authoritative; use the accepted packet as bounded work material, not as authority to ignore new user scope. Implement against its scope and acceptance conditions unless the user has materially superseded them; then converge through the appropriate recovery or verification handoff. Ordinary tool follow-ups retain the current physical model.${packetInstruction(state)}`;
	if (state.phase === "verification") return `${common}\nPhase: verification. The latest user request remains authoritative. Execute the accepted validation plan and collect evidence. Do not claim completion solely in prose; submit a completion or recovery handoff.${packetInstruction(state)}`;
	return `${common}\nPhase: ${state.phase}. Automatic workflow progression is stopped; wait for a new user direction.`;
}

function latestEvents(ctx: ExtensionContext): unknown[] {
	return ctx.sessionManager.getBranch().flatMap(entry => entry.type === "custom" && entry.customType === WORKFLOW_EVENT_TYPE ? [entry.data] : []);
}
function reminderEvent(state: WorkflowState, phase: "planning" | "recovery", sourceTurnId: string): WorkflowEvent {
	return { version: 1, kind: "reminder", workflowId: state.workflowId, phase, sourceTurnId };
}
function blockedEvent(state: WorkflowState, phase: "planning" | "recovery", sourceTurnId: string): WorkflowEvent {
	return { version: 1, kind: "blocked", workflowId: state.workflowId, phase, sourceTurnId };
}

export function shouldRemind(input: {
	state?: WorkflowState;
	settings: GearSettings;
	outcome: "completed" | "aborted" | "error";
	canContinue: boolean;
	hasPendingMessages: boolean;
	events: readonly unknown[];
	turnId?: string;
}): "remind" | "block" | undefined {
	const { state, settings, outcome, canContinue, hasPendingMessages, turnId } = input;
	if (!state || !turnId || state.activeTurnId !== turnId || state.objective !== "deliver" || !convergencePhase(state.phase) || outcome !== "completed" || !canContinue || hasPendingMessages) return;
	if (state.transitionCount >= settings.workflow.maxTransitions) return "block";
	const facts = workflowFacts(input.events, state.workflowId, settings.bands.length);
	if (facts.blockedEvents.some(event => event.phase === state.phase && event.sourceTurnId === turnId)
		|| facts.accepted.some(event => event.sourceTurnId === turnId && event.from === state.phase)
		|| facts.rejected.some(event => event.sourceTurnId === turnId && event.from === state.phase)) return;
	const remindersForTurn = facts.reminderEvents.filter(event => event.phase === state.phase && event.sourceTurnId === turnId).length;
	return remindersForTurn < settings.workflow.maxReminderContinuations ? "remind" : "block";
}

/** Register routing context and one-time settle reminders; tool permissions belong to the host. */
export function registerWorkflowGuard(pi: ExtensionAPI, settings: (cwd?: string, ctx?: ExtensionContext) => GearSettings): void {
	pi.on("context_with_system", (event, ctx) => {
		const state = activeWorkflow(ctx, settings(ctx.cwd, ctx));
		if (!state) return;
		const index = event.messages.findIndex(message => message.role === "system");
		if (index < 0) return;
		const instruction: Message = { role: "system", content: workflowInstruction(state), timestamp: 0 };
		return { messages: [...event.messages.slice(0, index + 1), instruction as AgentMessage, ...event.messages.slice(index + 1)] };
	});
	pi.on("agent_before_settle", (event, ctx) => {
		const config = settings(ctx.cwd, ctx);
		const state = activeWorkflow(ctx, config);
		const sourceTurnId = latestRouterState(ctx)?.turnId;
		const action = shouldRemind({ ...(state ? { state } : {}), settings: config, outcome: event.outcome, canContinue: event.context.canContinue, hasPendingMessages: ctx.hasPendingMessages(), events: latestEvents(ctx), ...(sourceTurnId ? { turnId: sourceTurnId } : {}) });
		if (!action || !state || !convergencePhase(state.phase)) return;
		if (!sourceTurnId) return;
		if (action === "block") return { entries: [{ type: "custom", customType: WORKFLOW_EVENT_TYPE, data: blockedEvent(state, state.phase, sourceTurnId) }] };
		return {
			entries: [
				{ type: "custom", customType: WORKFLOW_EVENT_TYPE, data: reminderEvent(state, state.phase, sourceTurnId) },
				{ type: "custom_message", customType: WORKFLOW_EVENT_TYPE, display: false, content: "Workflow reminder: focus on convergence. Either continue essential research, call gear_workflow_handoff with a complete packet, or explicitly state the blocker. Pi and its permission extensions retain all tool permissions." },
			],
			continue: true,
		};
	});
}
