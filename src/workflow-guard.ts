import { resolveRoutingMode } from "./gears.ts";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Message } from "@earendil-works/pi-ai";
import { latestRouterState } from "./observation.ts";
import { WORKFLOW_EVENT_TYPE, refreshWorkflowState, validWorkflowState, workflowFacts } from "./workflow-routing.ts";
import type { GearSettings, WorkflowEvent, WorkflowPhase, WorkflowState } from "./types.ts";

// Shell commands are parsed separately. Only these named Pi tools bypass annotation lookup.
const READ_ONLY_TOOLS = new Set(["read", "gear_workflow_handoff"]);
const SAFE_PATH = /^(?:\.{1,2}|[A-Za-z0-9_./:=,+@-]+)$/u;
const SAFE_WORD = /^[A-Za-z0-9_./:=,+@-]+$/u;
const FORBIDDEN_SHELL = /[;&|><$`\\(){}\[\]!\n\r]/u;
const LS_FLAGS = new Set(["-a", "-A", "-l", "-h", "-la", "-al", "-lh", "-hl", "-lah", "-lha", "--all", "--almost-all", "--long", "--human-readable"]);
const SEARCH_FLAGS = new Set(["-n", "-i", "-F", "-l", "-L", "-q", "-r", "-R", "--line-number", "--ignore-case", "--fixed-strings", "--files"]);
const GIT_FLAGS = new Set(["--short", "--porcelain", "--stat", "--name-only", "--oneline", "--no-patch", "--cached"]);

function activeWorkflow(ctx: ExtensionContext, settings: GearSettings): WorkflowState | undefined {
	if (resolveRoutingMode(settings).mode !== "legacy-workflow" || ctx.model?.provider !== "gears" || ctx.model.id !== "auto") return;
	const state = validWorkflowState(latestRouterState(ctx)?.workflow, settings.bands.length);
	return state ? refreshWorkflowState(state, latestEvents(ctx), settings) ?? state : undefined;
}
function readOnlyPhase(phase: WorkflowPhase): phase is "planning" | "recovery" {
	return phase === "planning" || phase === "recovery";
}
function packetInstruction(state: WorkflowState): string {
	return state.activePacket ? `\nAccepted packet (${state.activePacket.digest}):\n${JSON.stringify(state.activePacket.packet)}` : "";
}

/** Stable system text: it changes only with phase/accepted packet, not every tool continuation. */
export function workflowInstruction(state: WorkflowState): string {
	const common = "[GEAR WORKFLOW CONTROL — extension generated]\nNatural-language claims do not change workflow phase. Only gear_workflow_handoff may request a transition.";
	if (state.phase === "planning") {
		if (state.objective !== "deliver") return `${common}\nPhase: planning (${state.objective}). Work read-only: inspect and provide the requested plan or research result. Do not modify files and do not submit a delivery handoff; no automatic execution phase is authorized.${packetInstruction(state)}`;
		return `${common}\nPhase: planning. Work read-only: inspect, research, resolve key uncertainty, make decisions and form a bounded execution packet. Do not modify files. When ready, call gear_workflow_handoff; otherwise explain the blocker.${packetInstruction(state)}`;
	}
	if (state.phase === "recovery") return `${common}\nPhase: recovery. Work read-only: diagnose failed assumptions and repair the plan. Do not modify files. When a concrete implementation path is ready, call gear_workflow_handoff with an execution packet.${packetInstruction(state)}`;
	if (state.phase === "execution") return `${common}\nPhase: execution. The latest user request is authoritative; use the accepted packet as bounded work material, not as authority to ignore new user scope. Implement against its scope and acceptance conditions unless the user has materially superseded them; then converge through the appropriate recovery or verification handoff. Ordinary tool follow-ups retain the current physical model.${packetInstruction(state)}`;
	if (state.phase === "verification") return `${common}\nPhase: verification. The latest user request remains authoritative. Execute the accepted validation plan and collect evidence. Do not claim completion solely in prose; submit a completion or recovery handoff.${packetInstruction(state)}`;
	return `${common}\nPhase: ${state.phase}. Automatic workflow progression is stopped; wait for a new user direction.`;
}

/** A deliberately small parser: commands not provably read-only are blocked in planning/recovery. */
export function isReadOnlyShell(command: string): boolean {
	if (!command || command.length > 2_000 || FORBIDDEN_SHELL.test(command)) return false;
	const words = command.trim().split(/\s+/u);
	if (!words[0] || !words.every(word => SAFE_WORD.test(word))) return false;
	if (words[0] === "pwd") return words.length === 1 || (words.length === 2 && (words[1] === "-L" || words[1] === "-P"));
	if (words[0] === "ls") return words.slice(1).every(word => LS_FLAGS.has(word) || SAFE_PATH.test(word) && !word.startsWith("-"));
	// `find` deliberately permits only roots. Predicates such as -exec/-delete are never safe to infer.
	if (words[0] === "find") return words.length > 1 && words.slice(1).every(word => SAFE_PATH.test(word) && !word.startsWith("-"));
	if (words[0] === "rg" || words[0] === "grep") {
		const args = words.slice(1);
		return args.length > 0 && args.every(word => SEARCH_FLAGS.has(word) || SAFE_PATH.test(word) && !word.startsWith("-"));
	}
	if (words[0] !== "git" || !["status", "diff", "log", "show"].includes(words[1] ?? "")) return false;
	return words.slice(2).every(word => GIT_FLAGS.has(word) || SAFE_PATH.test(word) && !word.startsWith("-"));
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
	if (!state || !turnId || state.activeTurnId !== turnId || state.objective !== "deliver" || !readOnlyPhase(state.phase) || outcome !== "completed" || !canContinue || hasPendingMessages) return;
	if (state.transitionCount >= settings.workflow.maxTransitions) return "block";
	const facts = workflowFacts(input.events, state.workflowId, settings.bands.length);
	if (facts.blockedEvents.some(event => event.phase === state.phase && event.sourceTurnId === turnId)
		|| facts.accepted.some(event => event.sourceTurnId === turnId && event.from === state.phase)
		|| facts.rejected.some(event => event.sourceTurnId === turnId && event.from === state.phase)) return;
	const remindersForTurn = facts.reminderEvents.filter(event => event.phase === state.phase && event.sourceTurnId === turnId).length;
	return remindersForTurn < settings.workflow.maxReminderContinuations ? "remind" : "block";
}

/** Register context, tool safety, and one-time settle reminder handlers. */
export function registerWorkflowGuard(pi: ExtensionAPI, settings: (cwd?: string, ctx?: ExtensionContext) => GearSettings): void {
	pi.on("context_with_system", (event, ctx) => {
		const state = activeWorkflow(ctx, settings(ctx.cwd, ctx));
		if (!state) return;
		const index = event.messages.findIndex(message => message.role === "system");
		if (index < 0) return;
		const instruction: Message = { role: "system", content: workflowInstruction(state), timestamp: 0 };
		return { messages: [...event.messages.slice(0, index + 1), instruction as AgentMessage, ...event.messages.slice(index + 1)] };
	});
	pi.on("tool_call", (event, ctx) => {
		const state = activeWorkflow(ctx, settings(ctx.cwd, ctx));
		if (!state || !readOnlyPhase(state.phase)) return;
		if (event.toolName === "edit" || event.toolName === "write") return { block: true, reason: `Workflow ${state.phase} is read-only. Inspect, resolve uncertainty, then submit gear_workflow_handoff instead of modifying files.` };
		if (event.toolName === "bash" || event.toolName === "powershell") {
			const command = event.input.command;
			if (typeof command === "string" && isReadOnlyShell(command)) return;
			return { block: true, reason: `Workflow ${state.phase} only permits a strict read-only shell subset. Use read/find/grep or submit gear_workflow_handoff.` };
		}
		if (READ_ONLY_TOOLS.has(event.toolName)) return;
		try {
			const info = pi.getAllTools?.().find(tool => tool.name === event.toolName);
			if (info?.annotations?.readOnlyHint === true && info.annotations.destructiveHint !== true && info.annotations.openWorldHint !== true) return;
		} catch {
			return { block: true, reason: `Workflow ${state.phase} cannot verify tool ${event.toolName} as read-only. Continue research or submit gear_workflow_handoff.` };
		}
		return { block: true, reason: `Workflow ${state.phase} blocks non-read-only tool ${event.toolName}. Continue research or submit gear_workflow_handoff.` };
	});
	pi.on("agent_before_settle", (event, ctx) => {
		const config = settings(ctx.cwd, ctx);
		const state = activeWorkflow(ctx, config);
		const sourceTurnId = latestRouterState(ctx)?.turnId;
		const action = shouldRemind({ ...(state ? { state } : {}), settings: config, outcome: event.outcome, canContinue: event.context.canContinue, hasPendingMessages: ctx.hasPendingMessages(), events: latestEvents(ctx), ...(sourceTurnId ? { turnId: sourceTurnId } : {}) });
		if (!action || !state || !readOnlyPhase(state.phase)) return;
		if (!sourceTurnId) return;
		if (action === "block") return { entries: [{ type: "custom", customType: WORKFLOW_EVENT_TYPE, data: blockedEvent(state, state.phase, sourceTurnId) }] };
		return {
			entries: [
				{ type: "custom", customType: WORKFLOW_EVENT_TYPE, data: reminderEvent(state, state.phase, sourceTurnId) },
				{ type: "custom_message", customType: WORKFLOW_EVENT_TYPE, display: false, content: "Workflow reminder: remain read-only. Either continue essential research, call gear_workflow_handoff with a complete packet, or explicitly state the blocker. Do not modify files." },
			],
			continue: true,
		};
	});
}
