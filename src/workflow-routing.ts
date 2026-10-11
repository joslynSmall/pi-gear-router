import { createHash } from "node:crypto";
import { bandForScore } from "./gears.ts";
import type {
	ActiveWorkflowPacket,
	Band,
	GearSettings,
	WorkflowAcceptedHandoffEvent,
	WorkflowClarity,
	WorkflowEvent,
	WorkflowPacket,
	WorkflowPhase,
	WorkflowProfile,
	WorkflowRisk,
	WorkflowState,
} from "./types.ts";

export const WORKFLOW_EVENT_TYPE = "pi-gear-router.workflow";

const MAX_STATE_BYTES = 65_536;
const MAX_PACKET_BYTES = 24 * 1024;
const MAX_STRING_CHARS = 2_000;
const MAX_ARRAY_ITEMS = 12;
const MAX_STEPS = 12;
const MAX_CONSUMED_HANDOFFS = 8;
const MAX_ID_CHARS = 300;
const DIGEST = /^[a-f0-9]{64}$/u;
const PHASES = new Set<WorkflowPhase>(["planning", "execution", "verification", "recovery", "complete", "blocked"]);
const PROFILES = new Set<WorkflowProfile>(["planning", "execution", "verification", "recovery"]);
const OBJECTIVES = new Set(["deliver", "plan_only", "research_only", "review", "question"]);
const EVENT_KINDS = new Set(["accepted-handoff", "handoff-rejected", "reminder", "blocked", "validation"]);

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const finite = (value: unknown, min: number, max: number): value is number => typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
const integer = (value: unknown, min: number, max: number): value is number => Number.isInteger(value) && finite(value, min, max);
const string = (value: unknown, max = MAX_STRING_CHARS): value is string => typeof value === "string" && value.length > 0 && Array.from(value).length <= max;
const digest = (value: unknown): value is string => typeof value === "string" && DIGEST.test(value);
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const array = (value: unknown, max = MAX_ARRAY_ITEMS): value is unknown[] => Array.isArray(value) && value.length <= max;

function onlyKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
	const keys = Object.keys(value);
	return required.every(key => Object.hasOwn(value, key)) && keys.every(key => required.includes(key) || optional.includes(key));
}
function textArray(value: unknown, max = MAX_ARRAY_ITEMS, itemMax = MAX_STRING_CHARS): value is string[] {
	return array(value, max) && value.every(item => string(item, itemMax));
}
function serializableWithin(value: unknown, max: number): boolean {
	try { return Buffer.byteLength(JSON.stringify(value)) <= max; } catch { return false; }
}

function validDecision(value: unknown): value is { decision: string; rationale: string } {
	return record(value) && onlyKeys(value, ["decision", "rationale"])
		&& string(value.decision) && string(value.rationale);
}
function validStep(value: unknown): value is { id: string; scope: string[]; change: string; acceptance: string[] } {
	return record(value) && onlyKeys(value, ["id", "scope", "change", "acceptance"])
		&& string(value.id, 128) && textArray(value.scope) && value.scope.length > 0
		&& string(value.change) && textArray(value.acceptance) && value.acceptance.length > 0;
}

/** Strictly validate and clean a packet before it enters a workflow event or persisted state. */
export function validWorkflowPacket(value: unknown): WorkflowPacket | undefined {
	if (!record(value) || !string(value.kind, 32) || !serializableWithin(value, MAX_PACKET_BYTES)) return;
	if (value.kind === "execution") {
		if (!onlyKeys(value, ["kind", "goal", "nonGoals", "decisions", "steps", "constraints", "validation", "risks", "blockingUnknowns"])
			|| !string(value.goal) || !textArray(value.nonGoals) || !array(value.decisions) || value.decisions.length === 0 || !value.decisions.every(validDecision)
			|| !array(value.steps, MAX_STEPS) || value.steps.length === 0 || !value.steps.every(validStep)
			|| !textArray(value.constraints) || !textArray(value.validation) || !textArray(value.risks) || !textArray(value.blockingUnknowns)) return;
		return structuredClone(value) as unknown as WorkflowPacket;
	}
	if (value.kind === "verification") {
		if (!onlyKeys(value, ["kind", "goal", "implementedSteps", "validationPlan", "expectedEvidence", "knownLimitations", "blockingUnknowns"])
			|| !string(value.goal) || !textArray(value.implementedSteps) || value.implementedSteps.length === 0 || !textArray(value.validationPlan) || value.validationPlan.length === 0
			|| !textArray(value.expectedEvidence) || value.expectedEvidence.length === 0 || !textArray(value.knownLimitations) || !textArray(value.blockingUnknowns)) return;
		return structuredClone(value) as unknown as WorkflowPacket;
	}
	if (value.kind === "recovery") {
		if (!onlyKeys(value, ["kind", "goal", "currentState", "failedAssumptions", "evidence", "questionsToResolve", "constraints", "blockingUnknowns"])
			|| !string(value.goal) || !string(value.currentState) || !textArray(value.failedAssumptions) || value.failedAssumptions.length === 0
			|| !textArray(value.evidence) || value.evidence.length === 0 || !textArray(value.questionsToResolve) || value.questionsToResolve.length === 0 || !textArray(value.constraints) || !textArray(value.blockingUnknowns)) return;
		return structuredClone(value) as unknown as WorkflowPacket;
	}
	if (value.kind === "complete") {
		if (!onlyKeys(value, ["kind", "goal", "acceptanceEvidence", "validationSummary", "remainingIssues"])
			|| !string(value.goal) || !textArray(value.acceptanceEvidence) || value.acceptanceEvidence.length === 0 || !textArray(value.validationSummary) || value.validationSummary.length === 0 || !textArray(value.remainingIssues)) return;
		return structuredClone(value) as unknown as WorkflowPacket;
	}
}

export function workflowPacketDigest(packet: WorkflowPacket): string {
	return hash(packet);
}

export function profileForPhase(phase: WorkflowPhase): WorkflowProfile | undefined {
	return phase === "planning" || phase === "execution" || phase === "verification" || phase === "recovery" ? phase : undefined;
}

export function canTransition(from: WorkflowPhase, to: WorkflowPhase): boolean {
	return (from === "planning" && to === "execution")
		|| (from === "execution" && (to === "verification" || to === "recovery"))
		|| (from === "verification" && (to === "recovery" || to === "complete"))
		|| (from === "recovery" && to === "execution");
}

function packetFitsTransition(packet: WorkflowPacket, to: WorkflowPhase): boolean {
	return (to === "execution" && packet.kind === "execution")
		|| (to === "verification" && packet.kind === "verification")
		|| (to === "recovery" && packet.kind === "recovery")
		|| (to === "complete" && packet.kind === "complete");
}
/** Conditions enforced locally before a packet may become an accepted transition record. */
function packetEligibleForTransition(packet: WorkflowPacket, to: WorkflowPhase): boolean {
	if (!packetFitsTransition(packet, to)) return false;
	if ((packet.kind === "execution" || packet.kind === "verification") && packet.blockingUnknowns.length > 0) return false;
	return packet.kind !== "complete" || packet.remainingIssues.length === 0;
}

function validActivePacket(value: unknown): value is ActiveWorkflowPacket {
	if (!record(value) || !onlyKeys(value, ["handoffId", "from", "to", "digest", "packet"], ["readinessConfidence"])
		|| !string(value.handoffId, MAX_ID_CHARS) || !string(value.from, 32) || !PHASES.has(value.from as WorkflowPhase)
		|| !string(value.to, 32) || !PHASES.has(value.to as WorkflowPhase) || !digest(value.digest)) return false;
	const packet = validWorkflowPacket(value.packet);
	if (!packet || workflowPacketDigest(packet) !== value.digest || !canTransition(value.from as WorkflowPhase, value.to as WorkflowPhase)
		|| !packetEligibleForTransition(packet, value.to as WorkflowPhase)) return false;
	return value.readinessConfidence === undefined || finite(value.readinessConfidence, 0, 1);
}

/** Reject unknown persisted fields so a malformed branch cannot enable automatic phase changes. */
export function validWorkflowState(value: unknown, bandCount: number): WorkflowState | undefined {
	try {
		if (!record(value) || !serializableWithin(value, MAX_STATE_BYTES)
			|| !onlyKeys(value, ["version", "workflowId", "objective", "phase", "initialTurnId", "activeTurnId", "transitionCount", "reminderCount", "consumedHandoffIds", "policyFingerprint"], ["activeProfile", "activePacket", "lastTransition"])
			|| value.version !== 1 || !string(value.workflowId, MAX_ID_CHARS) || !string(value.initialTurnId, MAX_ID_CHARS) || !string(value.activeTurnId, MAX_ID_CHARS)
			|| !string(value.objective, 32) || !OBJECTIVES.has(value.objective) || !string(value.phase, 32) || !PHASES.has(value.phase as WorkflowPhase)
			|| !integer(value.transitionCount, 0, 8) || !integer(value.reminderCount, 0, 1) || !digest(value.policyFingerprint)
			|| !array(value.consumedHandoffIds, MAX_CONSUMED_HANDOFFS) || !value.consumedHandoffIds.every(id => string(id, MAX_ID_CHARS))) return;
		const profile = profileForPhase(value.phase as WorkflowPhase);
		if ((profile && value.activeProfile !== profile) || (!profile && value.activeProfile !== undefined)
			|| (value.activeProfile !== undefined && (!string(value.activeProfile, 32) || !PROFILES.has(value.activeProfile as WorkflowProfile)))) return;
		if (value.activePacket !== undefined && (!validActivePacket(value.activePacket) || (value.activePacket as ActiveWorkflowPacket).to !== value.phase)) return;
		if ((value.phase === "verification" || value.phase === "recovery") && value.activePacket === undefined) return;
		if ((value.phase === "complete" || value.phase === "blocked") && value.activePacket !== undefined) return;
		if (value.lastTransition !== undefined) {
			if (!record(value.lastTransition) || !onlyKeys(value.lastTransition, ["to", "reason"], ["handoffId", "from", "requestedBand"])
				|| !string(value.lastTransition.to, 32) || !PHASES.has(value.lastTransition.to as WorkflowPhase) || value.lastTransition.to !== value.phase
				|| !["initial", "accepted-handoff", "user-superseded", "budget-exhausted", "blocked"].includes(value.lastTransition.reason as string)
				|| (value.lastTransition.handoffId !== undefined && !string(value.lastTransition.handoffId, MAX_ID_CHARS))
				|| (value.lastTransition.from !== undefined && (!string(value.lastTransition.from, 32) || !PHASES.has(value.lastTransition.from as WorkflowPhase)))
				|| (value.lastTransition.requestedBand !== undefined && !integer(value.lastTransition.requestedBand, 0, bandCount - 1))) return;
		}
		if (value.activePacket !== undefined) {
			const active = value.activePacket as ActiveWorkflowPacket;
			const transition = value.lastTransition as Record<string, unknown> | undefined;
			if (!transition || transition.reason !== "accepted-handoff" || transition.handoffId !== active.handoffId
				|| transition.from !== active.from || transition.to !== active.to || !integer(transition.requestedBand, 0, bandCount - 1)) return;
		}
		return structuredClone(value) as unknown as WorkflowState;
	} catch { return; }
}

export function validWorkflowEvent(value: unknown, bandCount: number): WorkflowEvent | undefined {
	try {
		if (!record(value) || !serializableWithin(value, MAX_PACKET_BYTES + 4_096) || value.version !== 1 || !string(value.kind, 32) || !EVENT_KINDS.has(value.kind)
			|| !string(value.workflowId, MAX_ID_CHARS) || !string(value.sourceTurnId, MAX_ID_CHARS)) return;
		if (value.kind === "accepted-handoff") {
			if (!onlyKeys(value, ["version", "kind", "workflowId", "sourceTurnId", "handoffId", "from", "to", "packet", "packetDigest", "readinessConfidence", "requestedBand"])
				|| !string(value.handoffId, MAX_ID_CHARS) || !string(value.from, 32) || !["planning", "execution", "verification", "recovery"].includes(value.from)
				|| !string(value.to, 32) || !["execution", "verification", "recovery", "complete"].includes(value.to)
				|| !digest(value.packetDigest) || !finite(value.readinessConfidence, 0, 1) || !integer(value.requestedBand, 0, bandCount - 1)) return;
			const packet = validWorkflowPacket(value.packet);
			if (!packet || workflowPacketDigest(packet) !== value.packetDigest || !canTransition(value.from as WorkflowPhase, value.to as WorkflowPhase) || !packetEligibleForTransition(packet, value.to as WorkflowPhase)) return;
			return structuredClone(value) as unknown as WorkflowAcceptedHandoffEvent;
		}
		if (value.kind === "handoff-rejected") {
			if (!onlyKeys(value, ["version", "kind", "workflowId", "sourceTurnId", "from", "to", "reason"])
				|| !string(value.from, 32) || !PHASES.has(value.from as WorkflowPhase) || !string(value.to, 32) || !PHASES.has(value.to as WorkflowPhase) || !string(value.reason, 200)) return;
			return structuredClone(value) as unknown as WorkflowEvent;
		}
		if (value.kind === "reminder") {
			if (!onlyKeys(value, ["version", "kind", "workflowId", "phase", "sourceTurnId"])
				|| !string(value.phase, 32) || !["planning", "recovery"].includes(value.phase)) return;
			return structuredClone(value) as unknown as WorkflowEvent;
		}
		if (value.kind === "blocked") {
			if (!onlyKeys(value, ["version", "kind", "workflowId", "phase", "sourceTurnId"])
				|| !string(value.phase, 32) || !PROFILES.has(value.phase as WorkflowProfile)) return;
			return structuredClone(value) as unknown as WorkflowEvent;
		}
		if (!onlyKeys(value, ["version", "kind", "workflowId", "sourceTurnId", "outcome", "commandKind"])
			|| !["passed", "failed"].includes(value.outcome as string) || !string(value.commandKind, 100)) return;
		return structuredClone(value) as unknown as WorkflowEvent;
	} catch { return; }
}

export interface WorkflowFacts {
	accepted: WorkflowAcceptedHandoffEvent[];
	rejected: Array<{ from: WorkflowPhase; to: WorkflowPhase; sourceTurnId: string }>;
	/** Total unique reminders retained for diagnostics; routing uses phase-scoped counters. */
	reminderCount: number;
	reminderCounts: { planning: number; recovery: number };
	reminderEvents: Array<{ phase: "planning" | "recovery"; sourceTurnId: string }>;
	blocked: boolean;
	blockedEvents: Array<{ phase: WorkflowProfile; sourceTurnId: string }>;
	validationPassed: boolean;
	validationFailed: boolean;
	/** The last valid workflow-scoped validation fact; a later failure revokes completion eligibility until a later pass. */
	latestValidationOutcome?: "passed" | "failed";
}

/** Most recent valid validation outcome for one workflow/user-turn pair. */
export function latestValidationOutcome(events: readonly unknown[], workflowId: string, sourceTurnId: string, bandCount: number): "passed" | "failed" | undefined {
	let outcome: "passed" | "failed" | undefined;
	for (const raw of events) {
		const event = validWorkflowEvent(raw, bandCount);
		if (event?.kind === "validation" && event.workflowId === workflowId && event.sourceTurnId === sourceTurnId) outcome = event.outcome;
	}
	return outcome;
}

/** Fold already validated events from one active branch. Invalid/other-workflow events are ignored. */
export function workflowFacts(events: readonly unknown[], workflowId: string, bandCount: number): WorkflowFacts {
	const accepted: WorkflowAcceptedHandoffEvent[] = [];
	const rejected: Array<{ from: WorkflowPhase; to: WorkflowPhase; sourceTurnId: string }> = [];
	const acceptedIdentities = new Set<string>();
	const reminderKeys = new Set<string>();
	const reminderCounts = { planning: 0, recovery: 0 };
	const reminderEvents: Array<{ phase: "planning" | "recovery"; sourceTurnId: string }> = [];
	const blockedKeys = new Set<string>();
	const blockedEvents: Array<{ phase: WorkflowProfile; sourceTurnId: string }> = [];
	let validationPassed = false;
	let validationFailed = false;
	let latestValidationOutcome: "passed" | "failed" | undefined;
	for (const raw of events) {
		const event = validWorkflowEvent(raw, bandCount);
		if (!event || event.workflowId !== workflowId) continue;
		if (event.kind === "accepted-handoff") {
			// A malformed/stale event must not hide a later valid event merely by reusing its ID.
			// Exact branch duplicates still fold to one candidate; consumption also records handoffId.
			const identity = `${event.handoffId}:${event.sourceTurnId}:${event.from}:${event.to}:${event.packetDigest}`;
			if (!acceptedIdentities.has(identity)) { acceptedIdentities.add(identity); accepted.push(event); }
		} else if (event.kind === "handoff-rejected") {
			rejected.push({ from: event.from, to: event.to, sourceTurnId: event.sourceTurnId });
		} else if (event.kind === "reminder") {
			const key = `${event.phase}:${event.sourceTurnId}`;
			if (!reminderKeys.has(key)) {
				reminderKeys.add(key);
				reminderCounts[event.phase] = Math.min(1, reminderCounts[event.phase] + 1);
				reminderEvents.push({ phase: event.phase, sourceTurnId: event.sourceTurnId });
			}
		} else if (event.kind === "blocked") {
			const key = `${event.phase}:${event.sourceTurnId}`;
			if (!blockedKeys.has(key)) { blockedKeys.add(key); blockedEvents.push({ phase: event.phase, sourceTurnId: event.sourceTurnId }); }
		} else if (event.kind === "validation") {
			validationPassed ||= event.outcome === "passed";
			validationFailed ||= event.outcome === "failed";
			latestValidationOutcome = event.outcome;
		}
	}
	return { accepted, rejected, reminderCount: reminderKeys.size, reminderCounts, reminderEvents, blocked: blockedEvents.length > 0, blockedEvents, validationPassed, validationFailed, ...(latestValidationOutcome ? { latestValidationOutcome } : {}) };
}

export function profileFloor(settings: GearSettings, profile: WorkflowProfile): Band {
	return profile === "planning" ? settings.workflow.planningMinBand
		: profile === "execution" ? settings.workflow.executionMinBand
			: profile === "verification" ? settings.workflow.verificationMinBand
				: settings.workflow.recoveryMinBand;
}

export interface WorkflowBandInput {
	profile: WorkflowProfile;
	score: number;
	risk: WorkflowRisk;
	clarity: WorkflowClarity;
	packet?: WorkflowPacket;
}

/** Capability requirement; it never describes a physical fallback chosen later by the router. */
export function workflowBand(settings: GearSettings, input: WorkflowBandInput): Band {
	const scoreBand = bandForScore(input.score, settings.gearBias, settings.bands);
	let floor = profileFloor(settings, input.profile);
	if (input.risk === "high") floor = Math.max(floor, settings.workflow.planningMinBand);
	const atomic = input.profile === "execution" && input.risk === "low" && input.clarity === "high"
		&& input.packet?.kind === "execution" && input.packet.steps.length > 0
		&& input.packet.steps.every(step => step.scope.length > 0 && step.acceptance.length > 0);
	if (atomic) floor = settings.workflow.atomicExecutionMinBand;
	return Math.max(scoreBand, floor) as Band;
}

export function newWorkflowState(input: {
	workflowId: string;
	initialTurnId: string;
	activeTurnId?: string;
	objective: WorkflowState["objective"];
	phase: "planning" | "execution";
	policyFingerprint: string;
	requestedBand: Band;
}): WorkflowState {
	return {
		version: 1,
		workflowId: input.workflowId,
		objective: input.objective,
		phase: input.phase,
		activeProfile: input.phase,
		initialTurnId: input.initialTurnId,
		activeTurnId: input.activeTurnId ?? input.initialTurnId,
		transitionCount: 0,
		reminderCount: 0,
		consumedHandoffIds: [],
		lastTransition: { to: input.phase, reason: "initial", requestedBand: input.requestedBand },
		policyFingerprint: input.policyFingerprint,
	};
}

export interface ConsumedHandoff {
	state: WorkflowState;
	event: WorkflowAcceptedHandoffEvent;
	requestedBand: Band;
}

/** Accept an event only once and only when it advances the active workflow's current phase. */
export function consumeHandoff(state: WorkflowState, events: readonly unknown[], settings: GearSettings): ConsumedHandoff | undefined {
	const valid = validWorkflowState(state, settings.bands.length);
	if (!valid || valid.phase === "complete" || valid.phase === "blocked" || valid.transitionCount >= settings.workflow.maxTransitions) return;
	const facts = workflowFacts(events, valid.workflowId, settings.bands.length);
	for (const event of facts.accepted) {
		if (valid.consumedHandoffIds.includes(event.handoffId) || event.sourceTurnId !== valid.activeTurnId || event.from !== valid.phase) continue;
		if (!canTransition(valid.phase, event.to) || event.readinessConfidence < settings.workflow.handoffMinConfidence || valid.transitionCount + 1 > settings.workflow.maxTransitions) continue;
		if (event.to === "complete" && latestValidationOutcome(events, valid.workflowId, valid.activeTurnId, settings.bands.length) !== "passed") continue;
		const packet = validWorkflowPacket(event.packet);
		if (!packet || !packetEligibleForTransition(packet, event.to)) continue;
		const next = structuredClone(valid);
		next.phase = event.to;
		const profile = profileForPhase(event.to);
		if (profile) next.activeProfile = profile;
		else delete next.activeProfile;
		next.transitionCount++;
		next.reminderCount = event.to === "recovery" ? facts.reminderCounts.recovery : 0;
		next.consumedHandoffIds = [...next.consumedHandoffIds, event.handoffId].slice(-MAX_CONSUMED_HANDOFFS);
		if (event.to === "complete") delete next.activePacket;
		else next.activePacket = {
			handoffId: event.handoffId, from: event.from, to: event.to, digest: event.packetDigest, packet,
			readinessConfidence: event.readinessConfidence,
		};
		next.lastTransition = { handoffId: event.handoffId, from: event.from, to: event.to, reason: "accepted-handoff", requestedBand: event.requestedBand };
		return { state: next, event, requestedBand: event.requestedBand };
	}
}

/** Rebuild reminder/block lifecycle facts without granting a model switch. */
export function refreshWorkflowState(state: WorkflowState, events: readonly unknown[], settings: GearSettings): WorkflowState | undefined {
	const valid = validWorkflowState(state, settings.bands.length);
	if (!valid) return;
	const facts = workflowFacts(events, valid.workflowId, settings.bands.length);
	const next = structuredClone(valid);
	next.reminderCount = next.phase === "planning" || next.phase === "recovery"
		? Math.min(1, facts.reminderEvents.filter(event => event.phase === next.phase && event.sourceTurnId === next.activeTurnId).length)
		: 0;
	const phaseBlocked = next.activeProfile && facts.blockedEvents.some(event => event.phase === next.activeProfile && event.sourceTurnId === next.activeTurnId);
	const budgetExhausted = next.activeProfile && next.transitionCount >= settings.workflow.maxTransitions
		&& facts.accepted.some(event => event.sourceTurnId === next.activeTurnId && event.from === next.phase);
	if (phaseBlocked || budgetExhausted) {
		next.phase = "blocked";
		delete next.activeProfile;
		delete next.activePacket;
		next.lastTransition = { from: valid.phase, to: "blocked", reason: budgetExhausted ? "budget-exhausted" : "blocked" };
	}
	return next;
}

/** Bind a preserved workflow phase to a new real user steering turn; older handoffs can no longer apply. */
export function steerWorkflow(state: WorkflowState, turnId: string): WorkflowState | undefined {
	const valid = validWorkflowState(state, Number.MAX_SAFE_INTEGER);
	if (!valid || !string(turnId, MAX_ID_CHARS)) return;
	const next = structuredClone(valid);
	next.activeTurnId = turnId;
	return next;
}
