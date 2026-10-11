import type { ModelThinkingLevel } from "@earendil-works/pi-ai";

/** Capability tiers, in increasing order. Jev scores 0..2 and lands on one of these. */
export const GEARS = ["light", "standard", "heavy"] as const;
export type Gear = (typeof GEARS)[number];

/** A physical model plus the thinking level to run it at. */
export interface GearTarget {
	provider: string;
	model: string;
	thinkingLevel: ModelThinkingLevel;
}

/** Jev's verdict for one turn. */
export interface GearJudgment {
	/** 0..2 continuous complexity score. */
	score: number;
	/** 0..1 classifier confidence in that score. */
	confidence: number;
	/** Tokens Jev consumed for the verdict. */
	inputTokens: number;
}

/** Router state persisted on the session branch. */
export interface GearState {
	/** Gear chosen for the current turn. */
	gear: Gear;
	/** Raw Jev score before bias, for display. `-1` when the verdict fell back without a fresh score. */
	score: number;
	/** Score after bias, which is what the mapping actually used. */
	adjustedScore: number;
	/** Confidence reported by Jev. */
	confidence: number;
	/** Stable user entry identity plus content hash. Optional for legacy session states. */
	turnId?: string;
	/** Tokens Jev consumed for the verdict. Optional on legacy states. */
	inputTokens?: number;
	/** True when classification or target selection fell back. */
	fallback?: boolean;
	fallbackReason?: "judge-unavailable" | "target-unavailable" | "disabled";
	/** Actual physical pair, frozen for the turn even if configuration changes. */
	dispatch?: GearTarget;
	/** Task-mode session lock. Once present, later turns keep this gear and its configured thinking level. */
	sessionLock?: { version: 1; gear: Gear };
	/** Accepted two-phase route. It permits one plan-to-implement switch and never follows a later score. */
	phaseRoute?: import("./phase-routing.ts").PhaseRouteState;
	task?: TaskState;
	workflow?: WorkflowState;
	/** Display-only bounded explanation; never authorizes a phase transition. */
	workflowDiagnostic?: WorkflowDiagnostic;
	decision?: DecisionTrace;
}

/** Minimal recent message shape sent to the classifier. */
export interface RecentMessage {
	role: "user" | "assistant";
	text: string;
}

export interface GearSettings {
	/** False bypasses routing and passes the previously used model through. True by default. */
	enabled: boolean;
	/** -1..1 shifts scores by up to ±0.4. 0 is neutral. */
	gearBias: number;
	/** Ordered score bands; the last entry omits `max`. Overrides the built-in mapping when valid. */
	bands: BandSpec[];
	gears: Record<Gear, GearTarget>;
	/** Jev call timeout in milliseconds. Decision calls need more than the usual 5s. */
	judgeTimeoutMs: number;
	taskRouting: TaskRoutingSettings;
	workflow: WorkflowSettings;
	/** Absent retains legacy flag-based mode selection. Observer always requires explicit opt-in. */
	routingMode?: RoutingMode;
	/** Bounded parse diagnostic, not an alternative owner. */
	routingModeInvalid?: boolean;
	observer: ObserverSettings;
}

// Observer contracts are data, never permission grants or method approvals.
export type RoutingMode = "task" | "legacy-workflow" | "observer";
export type CapabilityProfile = "converge" | "implement" | "verify" | "respond";
export type ObserverWork = "investigate" | "requirements" | "design" | "task_plan" | "implement" | "verify" | "diagnose" | "answer" | "unknown";
export type MessageEffect = "request_work" | "continue" | "explain" | "change_scope" | "pause" | "cancel" | "clarify_reference";
export type ObserverCoverage = "known" | "partial" | "unknown";
export interface ObserverSettings {
	guidance: { enabled: boolean; maxCandidates: number; maxChars: number; maxPerTask: number };
	skills: { enabled: boolean };
	stageAware: boolean;
	minBands: Record<CapabilityProfile, number>;
	maxCallsPerTask: number;
	maxTransitions: number;
	maxTransportRetries: 0 | 1;
}
export interface RequestIdentity {
	sessionId: string;
	userEntryId: string;
	userContentDigest: string;
	inputEpoch: number;
	branchEpoch: number;
	policyFingerprint: string;
	catalogVersion?: string;
}
export interface ReportedMethodFact {
	stageLabel: string;
	waitingFor: string;
	sourceEntryId: string;
	provenance: "reported" | "observed";
}
export interface ControlFact {
	kind: "pause" | "cancel" | "narrow_scope";
	sourceEntryId: string;
	provenance: "reported" | "observed";
}
export interface ExecutionFact {
	kind: "verification-passed" | "verification-failed" | "body-read-observed" | "explicit-expansion-observed";
	sourceEntryId: string;
	commandKind?: string;
	skillIdentity?: string;
	catalogVersion?: string;
}
export interface ObserverInput {
	schema: "observer-input-v1";
	request: string;
	task?: { id: string; anchor: string; userChanges: string[] };
	routing?: { persistentProfile: CapabilityProfile; taskBand: number };
	methodObservations: ReportedMethodFact[];
	controlFacts: ControlFact[];
	activeHandoff?: { id: string; goal: string; constraints: string[] };
	recentPublicAssistant: { sourceEntryId: string; text: string }[];
	executionFacts: ExecutionFact[];
	skills: { candidates: { candidateId: string; name: string; description: string }[]; total: number; coverage: ObserverCoverage };
	selectedSkill?: { identity: string; name: string };
	missing: string[];
	nonTextInput: boolean;
}
export type ObserverFailure = "timeout" | "transport" | "invalid-shape" | "invalid-probabilities" | "missing-field"
	| "service-or-adapter-error" | "model-unavailable" | "auth-unavailable" | "aborted";
export type ObserverFieldResult =
	| { status: "valid"; type: "choice"; choice: string; confidence: number; probabilities: Record<string, number> }
	| { status: "valid"; type: "score"; score: number; confidence: number }
	| { status: "valid"; type: "bool"; probability: number }
	| { status: "invalid" | "missing"; reason: ObserverFailure };
export interface ValidatedObservationSummary {
	outcome: "valid" | "partial" | "invalid" | "unavailable" | "aborted";
	fields: Partial<Record<"relation" | "messageEffect" | "work" | "capability" | "clarity" | "risk" | "clarification" | "methodGate", ObserverFieldResult>>;
	skills: { candidateId: string; field: ObserverFieldResult }[];
	failure?: ObserverFailure;
}
export interface ObserverTask {
	id: string;
	anchor: string;
	anchorUserEntryId: string;
	userChanges: string[];
	active: boolean;
	continuity: "confirmed" | "uncertain";
	inheritedTurns: number;
	dirty: boolean;
	methodObservations: ReportedMethodFact[];
	controlFacts: ControlFact[];
	samples: { evidenceKey: string; rawScore: number; confidence: number }[];
	seenEvidenceKeys: string[];
	cooldown: number;
	guideKeys?: string[];
}
export interface ObserverCallRecord {
	callId: string;
	evidenceKey: string;
	kind: "turn" | "handoff";
	sourceUserEntryId: string;
	status: "reserved" | "completed" | "failed" | "aborted" | "stale";
	attempts: number;
}
export interface TaskBudget {
	ownerId: string;
	logicalCalls: number;
	transportAttempts: number;
	transitions: number;
	guides: number;
	exhausted: boolean;
	calls: ObserverCallRecord[];
}
export interface CapabilityPacketV1 {
	version: 1;
	taskId: string;
	sourceUserEntryId: string;
	nextWork: Exclude<CapabilityProfile, "respond">;
	goal: string;
	scope: string[];
	nonGoals: string[];
	decisions: { decision: string; rationale: string }[];
	steps: { change: string; acceptance: string[] }[];
	constraints: string[];
	validation: string[];
	risks: string[];
	blockingUnknowns: string[];
	methodGate: "none_reported" | "waiting" | "unknown";
	permissionEvidence: { userEntryId: string; summary: string }[];
	reason: "work-converged" | "complexity-increased" | "verification-work";
}
export interface AcceptedCapabilityHandoff {
	id: string;
	packetDigest: string;
	identity: RequestIdentity;
	packet: CapabilityPacketV1;
	targetProfile: Exclude<CapabilityProfile, "respond">;
	requestedBand: number;
	protectedBand: number;
}
export interface BoundedGuidanceRecord {
	key: string;
	sourceUserEntryId: string;
	catalogVersion?: string;
	candidateIds: string[];
	visibilityFingerprint?: string;
	text: string;
	status: "prepared" | "projected" | "response-observed";
}
export interface ObserverStateV1 {
	schema: "observer-routing";
	version: 1;
	turn: RequestIdentity;
	task?: ObserverTask;
	capability: { persistentProfile: CapabilityProfile; turnProfile: CapabilityProfile; requestedBand: number; protectedBand: number; taskBand: number };
	dispatch: GearTarget;
	observation?: ValidatedObservationSummary;
	activeHandoff?: AcceptedCapabilityHandoff;
	guidance?: BoundedGuidanceRecord;
	budget: TaskBudget;
	diagnostics: { coverage: ObserverCoverage; reasons: string[] };
}
export interface CapabilityEvent {
	version: 1;
	kind: "proposed" | "accepted" | "invalidated" | "consumed" | "physical-response-observed";
	id: string;
	packetDigest: string;
	identity: RequestIdentity;
	handoff?: AcceptedCapabilityHandoff;
	reason?: string;
}
export interface ObserverEvent {
	version: 1;
	kind: "reservation" | "call-result" | "guidance" | "execution-fact" | "diagnostic";
	identity: RequestIdentity;
	call?: ObserverCallRecord;
	budgetOwnerId?: string;
	guidance?: BoundedGuidanceRecord;
	fact?: ExecutionFact;
	reasons?: string[];
	elapsedMs?: number;
	usage?: { input: number; output: number; totalTokens: number; cacheRead?: number; cacheWrite?: number; cacheWrite1h?: number; reasoning?: number; cost?: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number } };
}
/** Complete custom-entry payload, including the type envelope, is bounded. */
export type ObserverEventEnvelope =
	| { customType: "pi-gear-router.capability.v1"; data: CapabilityEvent }
	| { customType: "pi-gear-router.observer.v1"; data: ObserverEvent };

export type Band = number;
export type TaskRelation = "same_task" | "new_task" | "uncertain";

/** User objective and lifecycle for the opt-in single-run workflow controller. */
export const WORKFLOW_OBJECTIVES = ["deliver", "plan_only", "research_only", "review", "question"] as const;
export type WorkflowObjective = (typeof WORKFLOW_OBJECTIVES)[number];
export const WORKFLOW_PHASES = ["planning", "execution", "verification", "recovery", "complete", "blocked"] as const;
export type WorkflowPhase = (typeof WORKFLOW_PHASES)[number];
export const WORKFLOW_PROFILES = ["planning", "execution", "verification", "recovery"] as const;
export type WorkflowProfile = (typeof WORKFLOW_PROFILES)[number];
export type WorkflowReadiness = "ready" | "needs_convergence" | "blocked";
export type WorkflowRisk = "low" | "medium" | "high";
export type WorkflowClarity = "low" | "medium" | "high";

export interface WorkflowDiagnostic {
	version: 1;
	reason: "low-confidence" | "classifier-unavailable" | "invalid-classification" | "non-text-input"
		| "review" | "question" | "no-phase" | "execution-not-ready" | "missing-turn";
	/** Semantic choice confidence and the threshold used for this turn, not gear confidence. */
	confidence?: number;
	minConfidence?: number;
}

export interface WorkflowSettings {
	enabled: boolean;
	planningMinBand: Band;
	executionMinBand: Band;
	atomicExecutionMinBand: Band;
	verificationMinBand: Band;
	recoveryMinBand: Band;
	handoffMinConfidence: number;
	maxTransitions: number;
	maxReminderContinuations: 0 | 1;
}

export interface ExecutionPacketStep {
	id: string;
	scope: string[];
	change: string;
	acceptance: string[];
}
export interface ExecutionPacket {
	kind: "execution";
	goal: string;
	nonGoals: string[];
	decisions: Array<{ decision: string; rationale: string }>;
	steps: ExecutionPacketStep[];
	constraints: string[];
	validation: string[];
	risks: string[];
	blockingUnknowns: string[];
}
export interface VerificationPacket {
	kind: "verification";
	goal: string;
	implementedSteps: string[];
	validationPlan: string[];
	expectedEvidence: string[];
	knownLimitations: string[];
	blockingUnknowns: string[];
}
export interface RecoveryPacket {
	kind: "recovery";
	goal: string;
	currentState: string;
	failedAssumptions: string[];
	evidence: string[];
	questionsToResolve: string[];
	constraints: string[];
	blockingUnknowns: string[];
}
export interface CompletionPacket {
	kind: "complete";
	goal: string;
	acceptanceEvidence: string[];
	validationSummary: string[];
	remainingIssues: string[];
}
export type WorkflowPacket = ExecutionPacket | VerificationPacket | RecoveryPacket | CompletionPacket;

export interface ActiveWorkflowPacket {
	handoffId: string;
	from: WorkflowPhase;
	to: WorkflowPhase;
	digest: string;
	packet: WorkflowPacket;
	readinessConfidence?: number;
}
export interface WorkflowTransitionTrace {
	handoffId?: string;
	from?: WorkflowPhase;
	to: WorkflowPhase;
	reason: "initial" | "accepted-handoff" | "user-superseded" | "budget-exhausted" | "blocked";
	requestedBand?: Band;
}
export interface WorkflowState {
	version: 1;
	workflowId: string;
	objective: WorkflowObjective;
	phase: WorkflowPhase;
	activeProfile?: WorkflowProfile;
	initialTurnId: string;
	/** User turn that owns the current phase and may submit its next handoff. */
	activeTurnId: string;
	transitionCount: number;
	reminderCount: number;
	consumedHandoffIds: string[];
	activePacket?: ActiveWorkflowPacket;
	lastTransition?: WorkflowTransitionTrace;
	policyFingerprint: string;
}

export interface WorkflowAcceptedHandoffEvent {
	version: 1;
	kind: "accepted-handoff";
	workflowId: string;
	sourceTurnId: string;
	handoffId: string;
	from: "planning" | "execution" | "verification" | "recovery";
	to: "execution" | "verification" | "recovery" | "complete";
	packet: WorkflowPacket;
	packetDigest: string;
	readinessConfidence: number;
	requestedBand: Band;
}
export interface WorkflowRejectedHandoffEvent {
	version: 1;
	kind: "handoff-rejected";
	workflowId: string;
	sourceTurnId: string;
	from: WorkflowPhase;
	to: WorkflowPhase;
	reason: string;
}
export interface WorkflowReminderEvent {
	version: 1;
	kind: "reminder";
	workflowId: string;
	phase: "planning" | "recovery";
	sourceTurnId: string;
}
export interface WorkflowBlockedEvent {
	version: 1;
	kind: "blocked";
	workflowId: string;
	phase: WorkflowProfile;
	sourceTurnId: string;
}
export interface WorkflowValidationEvent {
	version: 1;
	kind: "validation";
	workflowId: string;
	sourceTurnId: string;
	outcome: "passed" | "failed";
	commandKind: string;
}
export type WorkflowEvent = WorkflowAcceptedHandoffEvent | WorkflowRejectedHandoffEvent | WorkflowReminderEvent | WorkflowBlockedEvent | WorkflowValidationEvent;

export interface WorkflowTurnJudgment {
	gear: GearJudgment;
	/** Minimum selected-label confidence/probability across workflow semantic choices (not capability-score calibration). */
	confidence: number;
	objective: WorkflowObjective;
	start: "planning" | "execution" | "none";
	clarity: WorkflowClarity;
	risk: WorkflowRisk;
}
export interface WorkflowTurnOutcome {
	kind: "valid" | "partial" | "unavailable";
	/** A shape-valid gear score that legacy task routing may use when workflow choices are invalid. */
	fallbackJudgment?: GearJudgment;
	judgment?: WorkflowTurnJudgment;
	relation?: TaskRelation;
	relationConfidence?: number;
	relationProbability?: number;
	usageReported?: boolean;
	attempted?: boolean;
	failure?: string;
}
export interface WorkflowHandoffJudgment {
	delivery: "deliver" | "not_deliver";
	readiness: WorkflowReadiness;
	risk: WorkflowRisk;
	capability: GearJudgment;
	confidence: number;
}
export interface WorkflowHandoffOutcome {
	kind: "valid" | "partial" | "unavailable";
	judgment?: WorkflowHandoffJudgment;
	usageReported?: boolean;
	attempted?: boolean;
	failure?: string;
}

export interface TaskRoutingSettings {
	maxInheritedTurns: number;
	downgradeWindow: number;
	downgradeMargin: number;
	minConfidence: number;
}
export interface Sample {
	turnId: string;
	evidenceKey: string;
	rawScore: number;
	confidence: number;
}
export interface TaskState {
	version: 1;
	taskId: string;
	anchor: string;
	userChanges: string[];
	continuity: "confirmed" | "uncertain";
	committedBand: Band;
	committedRawScore: number;
	biasAtCommit: number;
	samples: Sample[];
	seenEvidenceKeys: string[];
	lastJudgment: Sample;
	inheritedTurns: number;
	review?: { evidenceKey: string; expedited: boolean };
	requireRejudge: boolean;
	policyFingerprint: string;
	observationCursor?: string;
}
export interface DecisionTrace {
	source: "judged" | "inherited" | "fallback";
	trigger: string;
	action: "new-task" | "upgrade" | "hold" | "downgrade" | "uncertain" | "inherit" | "fallback" | "config-remap";
	classifierAttempted: boolean;
	/** Why the classifier was unavailable, when it failed. */
	judgeFailure?: string;
	scoreTurnId?: string;
	requestedBand?: Band;
	windowMaxRaw?: number;
	protectedScore?: number;
	provisionalBand?: Band;
	relation?: TaskRelation;
	relationConfidence?: number;
	relationProbability?: number;
	usageReported?: boolean;
}
export interface BranchFacts {
	coverage: "known" | "unknown";
	nextCursor?: string;
	verificationFailed: boolean;
	completionHint: boolean;
	manualModelGap: boolean;
	contextMissing: boolean;
}
export interface JudgeInput {
	request: string;
	task?: { anchor: string; userChanges: string[] };
	recent: RecentMessage[];
	observations: string[];
	nonTextInput: boolean;
}
export interface JudgeOutcome {
	kind: "valid" | "partial" | "unavailable";
	judgment?: GearJudgment;
	relation?: TaskRelation;
	relationConfidence?: number;
	relationProbability?: number;
	usageReported?: boolean;
	attempted?: boolean;
	/** Bounded diagnostic reason when `kind` is `unavailable`, for the decision trace and footer. */
	failure?: string;
}

/** One score band: an exclusive upper bound plus the capability it maps to. The last band omits `max`. */
export interface BandSpec {
	max?: number;
	gear: Gear;
	thinkingLevel: ModelThinkingLevel;
}

/** Default bands; `max` is the exclusive upper bound of the adjusted score, and the last band covers up to 2. */
export const DEFAULT_BANDS: readonly BandSpec[] = [
	{ max: 0.5, gear: "light", thinkingLevel: "high" },
	{ max: 1, gear: "standard", thinkingLevel: "medium" },
	{ max: 1.5, gear: "standard", thinkingLevel: "high" },
	{ max: 1.8, gear: "heavy", thinkingLevel: "high" },
	{ gear: "heavy", thinkingLevel: "xhigh" },
];

/** Guard against a malformed config producing an unbounded band table. */
export const MAX_BANDS = 16;

/** Largest score shift `gearBias` of 1 can apply. */
export const MAX_BIAS_SHIFT = 0.4;