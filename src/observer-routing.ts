import { createHash } from "node:crypto";
import { bandForScore, resolveObserverPolicy, resolveRoutingMode } from "./gears.ts";
import type { CapabilityPacketV1, GearSettings, GearTarget, ObserverCallRecord, ObserverEventEnvelope, ObserverInput, ObserverStateV1, RequestIdentity, TaskBudget, ValidatedObservationSummary, ObserverFieldResult, ExecutionFact, CapabilityProfile, ObserverTask } from "./types.ts";

export const OBSERVER_STATE_MAX_BYTES = 64 * 1024;
export const OBSERVER_EVENT_MAX_BYTES = 16 * 1024;
export const OBSERVER_EVENT_TYPE = "pi-gear-router.observer.v1";
export const CAPABILITY_EVENT_TYPE = "pi-gear-router.capability.v1";
export const OBSERVER_CONTRACT_VERSION = "observer-v1/strict-probabilities-v1/catalog-overlap-v1/handoff-anchors-v2";

/** Never invoke getters/toJSON, normalize numbers, or coerce non-JSON data. */
function jsonCopy(value: unknown, maxBytes: number): unknown {
	let nodes = 0, bytes = 0;
	const spend = (size: number) => { bytes += size; if (bytes > maxBytes) throw new Error("json-bytes"); };
	const ancestors = new Set<object>();
	const visit = (item: unknown, depth: number): unknown => {
		if (++nodes > 8192 || depth > 24) throw new Error("bounded-json");
		if (item === null || typeof item === "boolean" || (typeof item === "number" && Number.isFinite(item)) || typeof item === "string") {
			spend(Buffer.byteLength(JSON.stringify(item), "utf8"));
			return item;
		}
		if (typeof item !== "object" || item === null || ancestors.has(item)) throw new Error("non-json");
		const proto = Object.getPrototypeOf(item);
		if (Array.isArray(item) ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) throw new Error("non-json");
		ancestors.add(item);
		const descriptors = Object.getOwnPropertyDescriptors(item);
		if (Reflect.ownKeys(descriptors).some(key => typeof key !== "string")) throw new Error("non-json");
		let copy: unknown;
		if (Array.isArray(item)) {
			if (item.length > 8192 || Object.keys(descriptors).length !== item.length + 1) throw new Error("non-json-array");
			spend(2 + Math.max(0, item.length - 1));
			copy = Array.from({ length: item.length }, (_, index) => {
				const descriptor = descriptors[String(index)];
				if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) throw new Error("non-json-array");
				return visit(descriptor.value, depth + 1);
			});
		} else {
			const record: Record<string, unknown> = {};
			const keys = Object.keys(descriptors).sort();
			spend(2 + Math.max(0, keys.length - 1));
			for (const key of keys) {
				spend(Buffer.byteLength(JSON.stringify(key), "utf8") + 1);
				const descriptor = descriptors[key]!;
				if (!("value" in descriptor) || !descriptor.enumerable || ["__proto__", "prototype", "constructor"].includes(key)) throw new Error("non-json-object");
				Object.defineProperty(record, key, { value: visit(descriptor.value, depth + 1), enumerable: true, writable: true });
			}
			copy = record;
		}
		ancestors.delete(item);
		return copy;
	};
	const copy = visit(value, 0);
	if (Buffer.byteLength(JSON.stringify(copy), "utf8") > maxBytes) throw new Error("json-bytes");
	return copy;
}

/** Local deterministic hash; undefined for non-JSON or oversized data. */
export function observerDigest(value: unknown): string | undefined {
	try { return createHash("sha256").update(JSON.stringify(jsonCopy(value, OBSERVER_STATE_MAX_BYTES))).digest("hex"); }
	catch { return undefined; }
}

export function observerPolicyFingerprint(settings: GearSettings, contractVersion = OBSERVER_CONTRACT_VERSION): string {
	const digest = observerDigest({ contractVersion, mode: resolveRoutingMode(settings), observer: resolveObserverPolicy(settings),
		bands: settings.bands, gears: settings.gears, gearBias: settings.gearBias, taskRouting: settings.taskRouting, judgeTimeoutMs: settings.judgeTimeoutMs });
	if (!digest) throw new Error("Invalid observer policy");
	return digest;
}

export function newObserverBudget(ownerId: string): TaskBudget {
	return { ownerId, logicalCalls: 0, transportAttempts: 0, transitions: 0, guides: 0, exhausted: false, calls: [] };
}
export function reserveObserverCall(budget: TaskBudget, record: ObserverCallRecord, limit: number): {
	kind: "reserved" | "duplicate" | "exhausted"; budget: TaskBudget;
} {
	const copy = structuredClone(budget);
	if (copy.calls.some(c => c.evidenceKey === record.evidenceKey || c.callId === record.callId)) return { kind: "duplicate", budget: copy };
	if (copy.exhausted || copy.logicalCalls >= Math.min(64, limit)) { copy.exhausted = true; return { kind: "exhausted", budget: copy }; }
	copy.calls.push({ ...record, attempts: 0, status: "reserved" }); copy.logicalCalls++;
	return { kind: "reserved", budget: copy };
}
export function finishObserverCall(budget: TaskBudget, callId: string, status: ObserverCallRecord["status"], attempts: number): TaskBudget {
	const copy = structuredClone(budget), call = copy.calls.find(c => c.callId === callId);
	if (call) { call.status = status; call.attempts = Math.max(call.attempts, Math.min(2, Math.max(0, Math.floor(attempts)))); }
	copy.transportAttempts = copy.calls.reduce((sum, c) => sum + c.attempts, 0);
	return copy;
}
export function resetObserverBudget(budget: TaskBudget, ownerId: string, trustedNewTask: boolean, limit: number): TaskBudget {
	return trustedNewTask && !budget.exhausted && budget.logicalCalls < Math.min(64, limit) ? newObserverBudget(ownerId) : structuredClone(budget);
}

export interface ObserverRouteInput {
	reason: "user" | "continuation" | "retry";
	identity: RequestIdentity;
	context: ObserverInput;
	previous?: ObserverStateV1;
	settings: GearSettings;
	budget: TaskBudget;
	facts: { coverage: "known" | "partial" | "unknown"; dirty: boolean; executionFacts: ExecutionFact[] };
	dispatchUsable: boolean;
}
export interface ObserverRouteDecision {
	retainPhysicalPair: boolean;
	state?: ObserverStateV1;
	requestedBand?: number;
	protectedBand?: number;
	source: "observed" | "inherited" | "sticky" | "fallback";
}
/** Feasible labels used for conservative common actions, not calibrated probabilities. */
export function observerFeasibleChoices(field: ObserverFieldResult | undefined): string[] {
	if (field?.status !== "valid" || field.type !== "choice") return [];
	const sorted = Object.entries(field.probabilities).sort((a, b) => b[1] - a[1]);
	if (field.confidence < .5) return sorted.map(([label]) => label);
	const set = new Set(sorted.filter(([, p]) => p >= .15).map(([label]) => label));
	set.add(field.choice);
	let total = sorted.filter(([label]) => set.has(label)).reduce((sum, [, p]) => sum + p, 0);
	for (const [label, p] of sorted) { if (total >= .8) break; if (!set.has(label)) { set.add(label); total += p; } }
	return [...set];
}
export function observerTrustedChoice(field: ObserverFieldResult | undefined, threshold = .8): string | undefined {
	return field?.status === "valid" && field.type === "choice" && field.confidence >= threshold && field.probabilities[field.choice]! >= threshold ? field.choice : undefined;
}
const literalContinue = (text: string) => ["继续", "继续吧", "请继续", "continue", "go on", "proceed"].includes(text.trim().replace(/[。.!！]+$/gu, "").toLowerCase());
function profileFor(work: string, score: number, clarity: string | undefined): CapabilityProfile {
	if (["requirements", "design", "task_plan"].includes(work)) return "converge";
	if (["investigate", "diagnose"].includes(work)) return score >= 1 || clarity !== "clear" ? "converge" : "respond";
	return work === "implement" ? "implement" : work === "verify" ? "verify" : "respond";
}
/** Pure turn/task reducer; classifier callback owns reservations, transport and async identity. */
export async function decideObserverRoute(input: ObserverRouteInput,
	observe: (context: ObserverInput, signal?: AbortSignal) => Promise<ValidatedObservationSummary>, signal?: AbortSignal): Promise<ObserverRouteDecision> {
	signal?.throwIfAborted();
	const { settings, identity, facts } = input;
	const old = parseObserverState(input.previous), policy = resolveObserverPolicy(settings);
	if (input.reason !== "user") return { retainPhysicalPair: true, source: "sticky" };
	if (old && old.turn.userEntryId === identity.userEntryId && old.turn.userContentDigest === identity.userContentDigest
		&& old.turn.policyFingerprint === identity.policyFingerprint && old.turn.branchEpoch === identity.branchEpoch && input.dispatchUsable) {
		return { retainPhysicalPair: true, state: old, source: "sticky" };
	}
	const samePolicy = old?.turn.policyFingerprint === identity.policyFingerprint;
	const inherited = !!old?.task?.active && old.task.continuity === "confirmed" && samePolicy && input.dispatchUsable && facts.coverage === "known" && !facts.dirty && !old.task.dirty
		&& !input.context.nonTextInput && input.context.missing.length === 0
		&& !old.task.methodObservations.some(f => f.waitingFor) && !old.task.controlFacts.length
		&& old.task.inheritedTurns < Math.min(3, settings.taskRouting.maxInheritedTurns) && literalContinue(input.context.request);
	if (inherited && old) {
		const candidate = structuredClone(old); candidate.turn = identity; delete candidate.activeHandoff; delete candidate.guidance;
		candidate.budget = input.budget; candidate.task!.inheritedTurns++;
		candidate.capability.turnProfile = candidate.capability.persistentProfile;
		candidate.capability.requestedBand = candidate.capability.taskBand; candidate.capability.protectedBand = candidate.capability.taskBand;
		candidate.diagnostics = { coverage: facts.coverage, reasons: ["inherited"] };
		const parsed = parseObserverState(candidate);
		return parsed ? { retainPhysicalPair: false, state: parsed, requestedBand: candidate.capability.taskBand, protectedBand: candidate.capability.taskBand, source: "inherited" } : { retainPhysicalPair: true, source: "fallback" };
	}
	if (input.budget.exhausted || input.budget.logicalCalls >= policy.maxCallsPerTask) return { retainPhysicalPair: true, source: "fallback" };
	const observation = await observe(input.context, signal); signal?.throwIfAborted();
	const fields = observation.fields, relation = observerTrustedChoice(fields.relation), effect = observerTrustedChoice(fields.messageEffect);
	const clarity = observerTrustedChoice(fields.clarity), gate = observerTrustedChoice(fields.methodGate);
	const scoreField = fields.capability;
	const score = scoreField?.status === "valid" && scoreField.type === "score" ? scoreField.score : undefined;
	if (score === undefined && !observerFeasibleChoices(fields.work).some(w => ["requirements", "design", "task_plan"].includes(w))) return { retainPhysicalPair: true, source: "fallback" };
	const newTask = !old?.task || relation === "new_task";
	const sameTask = !old?.task || relation === "same_task";
	const priorTaskCompatible = samePolicy && old?.task?.active === true;
	const key = observerDigest({ source: identity.userEntryId, digest: identity.userContentDigest, projection: input.context })!;
	let task: ObserverTask = newTask ? {
		id: `task:${observerDigest({ session: identity.sessionId, user: identity.userEntryId })}`, anchor: [...input.context.request].slice(0, 4000).join(""), anchorUserEntryId: identity.userEntryId,
		userChanges: [], active: true, continuity: "confirmed", inheritedTurns: 0, dirty: false, methodObservations: [], controlFacts: [], samples: [], seenEvidenceKeys: [], cooldown: 0,
	} : structuredClone(old!.task!);
	task.inheritedTurns = 0;
	if (!sameTask && !newTask) task.continuity = "uncertain";
	else task.continuity = "confirmed";
	if (sameTask && !newTask && !literalContinue(input.context.request) && effect !== "explain") {
		task.userChanges = [...task.userChanges, [...input.context.request].slice(0, 1000).join("")].slice(-3);
	}
	if (facts.dirty || !samePolicy || effect === "change_scope") { task.samples = []; task.seenEvidenceKeys = []; task.dirty = true; }
	if (gate === "waiting" || gate === undefined || gate === "unknown") {
		const source = input.context.recentPublicAssistant.at(-1)?.sourceEntryId ?? identity.userEntryId;
		if (!task.methodObservations.some(f => f.sourceEntryId === source)) task.methodObservations = [...task.methodObservations,
			{ stageLabel: "external-method", waitingFor: gate === "waiting" ? "approval-reported" : "method-gate-unknown", sourceEntryId: source, provenance: "reported" as const }].slice(-8);
	}
	// none_observed is not proof that an earlier source wait was approved.
	if (effect === "pause" || effect === "cancel" || effect === "change_scope") {
		task.samples = []; task.seenEvidenceKeys = [];
		task.controlFacts = [...task.controlFacts, { kind: effect === "change_scope" ? "narrow_scope" as const : effect as "pause" | "cancel", sourceEntryId: identity.userEntryId, provenance: "reported" as const }].slice(-8);
		if (effect === "cancel") task.active = false;
	}
	const works = observerFeasibleChoices(fields.work), profiles = works.map(w => profileFor(w, score ?? 2, clarity));
	let turnProfile: CapabilityProfile = profiles.length && profiles.every(p => p === profiles[0]) ? profiles[0]! : old?.capability.persistentProfile ?? "converge";
	if (effect === "change_scope") turnProfile = "converge";
	const risks = observerFeasibleChoices(fields.risk), temporaryRespond = sameTask && (effect === "explain" || observerTrustedChoice(fields.work) === "answer")
		&& turnProfile === "respond" && clarity === "clear" && score !== undefined && score <= 1
		&& scoreField?.status === "valid" && scoreField.type === "score" && scoreField.confidence >= .8
		&& risks.length > 0 && risks.every(r => r === "low" || r === "medium") && !input.context.nonTextInput;
	const requestedBand = bandForScore(score ?? 2, settings.gearBias, settings.bands);
	const floor = policy.stageAware ? policy.minBands[turnProfile] : 0;
	let protectedBand = Math.max(requestedBand, floor);
	if (policy.stageAware && risks.includes("high")) protectedBand = Math.max(protectedBand, policy.minBands.converge);
	if (risks.includes("high") || risks.includes("unknown") || !risks.length || input.context.nonTextInput)
		protectedBand = Math.max(protectedBand, newTask ? settings.bands.length - 1 : old?.capability.taskBand ?? settings.bands.length - 1);
	let taskBand = old?.capability.taskBand ?? protectedBand;
	const safeDown = priorTaskCompatible && !facts.dirty && !old?.task?.dirty && effect !== "change_scope" && scoreField?.status === "valid" && scoreField.type === "score" && scoreField.confidence >= .8
		&& relation === "same_task" && observerTrustedChoice(fields.work) !== undefined && clarity === "clear"
		&& risks.length === 1 && risks[0] === "low" && observerTrustedChoice(fields.risk) === "low"
		&& gate === "none_observed" && !task.methodObservations.some(f => f.waitingFor) && !task.controlFacts.length
		&& !input.context.nonTextInput && input.context.missing.length === 0 && facts.coverage === "known" && task.cooldown === 0;
	if (!temporaryRespond) {
		if (newTask) taskBand = protectedBand;
		else if (sameTask && protectedBand >= taskBand) { taskBand = protectedBand; task.samples = []; }
		else if (sameTask && safeDown && score !== undefined) {
			if (!task.seenEvidenceKeys.includes(key)) {
				task.samples = [...task.samples, { evidenceKey: key, rawScore: score, confidence: scoreField!.status === "valid" && scoreField!.type === "score" ? scoreField!.confidence : 0 }].slice(-settings.taskRouting.downgradeWindow);
				task.seenEvidenceKeys = [...task.seenEvidenceKeys, key].slice(-64);
			}
			if (task.samples.length >= settings.taskRouting.downgradeWindow) {
				const max = Math.max(...task.samples.map(s => s.rawScore));
				const windowBand = bandForScore(max + settings.taskRouting.downgradeMargin, settings.gearBias, settings.bands);
				taskBand = Math.max(floor, Math.min(taskBand, windowBand));
			}
		} else if (sameTask) { task.samples = []; }
		protectedBand = Math.max(protectedBand, taskBand);
		if (task.cooldown > 0 && sameTask && effect !== "pause" && effect !== "cancel" && effect !== "clarify_reference"
			&& scoreField?.status === "valid" && scoreField.type === "score" && observerTrustedChoice(fields.work) !== undefined) task.cooldown--;
		if (sameTask || newTask) task.dirty = false;
	}
	const persistentProfile = temporaryRespond || !sameTask && !newTask ? old?.capability.persistentProfile ?? turnProfile : turnProfile;
	const dispatch = old?.dispatch ?? settings.gears.standard;
	const candidate: ObserverStateV1 = { schema: "observer-routing", version: 1, turn: identity, task,
		capability: { persistentProfile: policy.stageAware ? persistentProfile : old?.capability.persistentProfile ?? "respond", turnProfile: policy.stageAware ? turnProfile : old?.capability.turnProfile ?? "respond", requestedBand, protectedBand, taskBand },
		dispatch, budget: input.budget, observation, diagnostics: { coverage: facts.coverage, reasons: [temporaryRespond ? "temporary-respond" : newTask ? "new-task" : sameTask ? "same-task" : "relation-uncertain"] } };
	const parsed = parseObserverState(candidate);
	return parsed ? { retainPhysicalPair: false, state: parsed, requestedBand, protectedBand, source: "observed" } : { retainPhysicalPair: true, source: "fallback" };
}

type Reader = (value: unknown) => unknown;
const fail = (): never => { throw new Error("invalid-observer-data"); };
const record = (v: unknown): Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v) ? v as Record<string, unknown> : fail();
const text = (max: number, min = 0): Reader => v => typeof v === "string" && [...v].length >= min && [...v].length <= max ? v : fail();
const id = text(256, 1);
const number = (min: number, max: number, integer = false): Reader => v => typeof v === "number" && Number.isFinite(v) && v >= min && v <= max && (!integer || Number.isSafeInteger(v)) ? v : fail();
const count = (max: number) => number(0, max, true);
const probability = number(0, 1);
const band = count(15);
const bool: Reader = v => typeof v === "boolean" ? v : fail();
const oneOf = (...labels: (string | number)[]): Reader => v => labels.includes(v as string | number) ? v : fail();
const array = (read: Reader, max: number): Reader => v => Array.isArray(v) && v.length <= max ? v.map(read) : fail();
const object = (required: Record<string, Reader>, optional: Record<string, Reader> = {}): Reader => v => {
	const raw = record(v), out: Record<string, unknown> = {};
	for (const [key, read] of Object.entries(required)) out[key] = read(raw[key]);
	for (const [key, read] of Object.entries(optional)) if (Object.hasOwn(raw, key)) out[key] = read(raw[key]);
	return out;
};
const hash: Reader = v => typeof v === "string" && /^[a-f0-9]{64}$/.test(v) ? v : fail();
const profile = oneOf("converge", "implement", "verify", "respond");
const nextProfile = oneOf("converge", "implement", "verify");
const coverage = oneOf("known", "partial", "unknown");
const identity = object({ sessionId: id, userEntryId: id, userContentDigest: hash, inputEpoch: count(Number.MAX_SAFE_INTEGER),
	branchEpoch: count(Number.MAX_SAFE_INTEGER), policyFingerprint: hash }, { catalogVersion: hash });
const pair = object({ provider: id, model: id, thinkingLevel: oneOf("off", "minimal", "low", "medium", "high", "xhigh", "max") });
const method = object({ stageLabel: text(256), waitingFor: text(256), sourceEntryId: id, provenance: oneOf("reported", "observed") });
const control = object({ kind: oneOf("pause", "cancel", "narrow_scope"), sourceEntryId: id, provenance: oneOf("reported", "observed") });
const fact = object({ kind: oneOf("verification-passed", "verification-failed", "body-read-observed", "explicit-expansion-observed"), sourceEntryId: id },
	{ commandKind: text(80, 1), skillIdentity: hash, catalogVersion: hash });
const call = object({ callId: id, evidenceKey: id, kind: oneOf("turn", "handoff"), sourceUserEntryId: id,
	status: oneOf("reserved", "completed", "failed", "aborted", "stale"), attempts: count(2) });
const budget: Reader = v => {
	const out = record(object({ ownerId: id, logicalCalls: count(64), transportAttempts: count(128), transitions: count(8), guides: count(12), exhausted: bool, calls: array(call, 64) })(v));
	const calls = out.calls as { callId: string; evidenceKey: string; attempts: number }[];
	if (calls.length !== out.logicalCalls || new Set(calls.map(c => c.callId)).size !== calls.length
		|| new Set(calls.map(c => c.evidenceKey)).size !== calls.length
		|| calls.reduce((sum, c) => sum + c.attempts, 0) !== out.transportAttempts) fail();
	return out;
};
const guidance: Reader = v => {
	const out = record(object({ key: id, sourceUserEntryId: id, candidateIds: array(id, 2), text: text(800),
		status: oneOf("prepared", "projected", "response-observed") }, { catalogVersion: hash, visibilityFingerprint: hash })(v));
	if (Buffer.byteLength(out.text as string, "utf8") > 2048) fail();
	return out;
};
const strings = array(text(1000), 8);
const packet: Reader = v => {
	// Count the candidate before stripping unknown JSON fields, not only the result.
	if ([...JSON.stringify(v)].length > 8000) fail();
	const out = object({ version: oneOf(1), taskId: id, sourceUserEntryId: id, nextWork: nextProfile, goal: text(1000, 1), scope: strings,
		nonGoals: strings, decisions: array(object({ decision: text(1000, 1), rationale: text(1000, 1) }), 8),
		steps: array(object({ change: text(1000, 1), acceptance: array(text(1000, 1), 4) }), 8),
		constraints: strings, validation: strings, risks: strings, blockingUnknowns: strings,
		methodGate: oneOf("none_reported", "waiting", "unknown"), permissionEvidence: array(object({ userEntryId: id, summary: text(1000, 1) }), 8),
		reason: oneOf("work-converged", "complexity-increased", "verification-work") })(v);
	const serialized = JSON.stringify(out);
	if ([...serialized].length > 8000 || Buffer.byteLength(serialized, "utf8") > 16384) fail();
	return out;
};
const accepted: Reader = v => {
	const out = record(object({ id, packetDigest: hash, identity, packet, targetProfile: nextProfile, requestedBand: band, protectedBand: band })(v));
	const p = out.packet as CapabilityPacketV1, source = out.identity as RequestIdentity;
	if (observerDigest(p) !== out.packetDigest || p.nextWork !== out.targetProfile || p.sourceUserEntryId !== source.userEntryId) fail();
	return out;
};
const failure = oneOf("timeout", "transport", "invalid-shape", "invalid-probabilities", "missing-field", "service-or-adapter-error", "model-unavailable", "auth-unavailable", "aborted");
const labels = {
	relation: ["same_task", "new_task", "uncertain"],
	messageEffect: ["request_work", "continue", "explain", "change_scope", "pause", "cancel", "clarify_reference"],
	work: ["investigate", "requirements", "design", "task_plan", "implement", "verify", "diagnose", "answer", "unknown"],
	clarity: ["clear", "unresolved", "unknown"], risk: ["low", "medium", "high", "unknown"], methodGate: ["waiting", "none_observed", "unknown"],
};
function field(type: "choice" | "score" | "bool", choices: readonly string[] = []): Reader {
	return v => {
		const raw = record(v);
		if (raw.status === "invalid" || raw.status === "missing") return object({ status: oneOf("invalid", "missing"), reason: failure })(raw);
		if (raw.status !== "valid" || raw.type !== type) fail();
		if (type === "score") return object({ status: oneOf("valid"), type: oneOf("score"), score: number(0, 2), confidence: probability })(raw);
		if (type === "bool") return object({ status: oneOf("valid"), type: oneOf("bool"), probability })(raw);
		const probabilities = record(raw.probabilities);
		if (Object.keys(probabilities).length !== choices.length || choices.some(key => !Object.hasOwn(probabilities, key))) fail();
		const out = record(object({ status: oneOf("valid"), type: oneOf("choice"), choice: oneOf(...choices), confidence: probability,
			probabilities: object(Object.fromEntries(choices.map(key => [key, probability]))) })(raw));
		const values = Object.values(probabilities) as number[];
		if (Math.abs(values.reduce((sum, p) => sum + p, 0) - 1) > .001
			|| (probabilities[out.choice as string] as number) + Number.EPSILON < Math.max(...values)) fail();
		return out;
	};
}
const observation = object({ outcome: oneOf("valid", "partial", "invalid", "unavailable", "aborted"),
	fields: object({}, { ...Object.fromEntries(Object.entries(labels).map(([key, choices]) => [key, field("choice", choices)])),
		capability: field("score"), clarification: field("bool") }),
	skills: array(object({ candidateId: id, field: field("bool") }), 12) }, { failure });
const task: Reader = v => {
	const out = record(object({ id, anchor: text(4000), anchorUserEntryId: id, userChanges: array(text(3000), 3), active: bool,
		continuity: oneOf("confirmed", "uncertain"), inheritedTurns: count(10), dirty: bool, methodObservations: array(method, 8),
		controlFacts: array(control, 8), samples: array(object({ evidenceKey: id, rawScore: number(0, 2), confidence: probability }), 8),
		seenEvidenceKeys: array(id, 64), cooldown: count(2) }, { guideKeys: array(hash, 12) })(v));
	const samples = out.samples as { evidenceKey: string }[], seen = out.seenEvidenceKeys as string[];
	if ((out.userChanges as string[]).reduce((sum, s) => sum + [...s].length, 0) > 3000
		|| new Set(samples.map(s => s.evidenceKey)).size !== samples.length || new Set(seen).size !== seen.length
		|| samples.some(s => !seen.includes(s.evidenceKey))) fail();
	return out;
};
const stateReader = object({ schema: oneOf("observer-routing"), version: oneOf(1), turn: identity,
	capability: object({ persistentProfile: profile, turnProfile: profile, requestedBand: band, protectedBand: band, taskBand: band }),
	dispatch: pair, budget, diagnostics: object({ coverage, reasons: array(text(80, 1), 16) }) },
	{ task, observation, activeHandoff: accepted, guidance });

function freeze<T>(value: T): T {
	if (value && typeof value === "object") {
		for (const child of Object.values(value)) freeze(child);
		Object.freeze(value);
	}
	return value;
}
function parse<T>(value: unknown, reader: Reader, limit: number): T | undefined {
	try { return freeze(reader(jsonCopy(value, limit)) as T); } catch { return undefined; }
}

export function parseObserverState(value: unknown): ObserverStateV1 | undefined {
	return parse(value, v => {
		const out = stateReader(v) as ObserverStateV1;
		if (out.activeHandoff && (!out.task || out.activeHandoff.packet.taskId !== out.task.id
			|| observerDigest(out.activeHandoff.identity) !== observerDigest(out.turn))) fail();
		if (out.guidance && out.guidance.sourceUserEntryId !== out.turn.userEntryId) fail();
		return out;
	}, OBSERVER_STATE_MAX_BYTES);
}

export function parseCapabilityPacket(value: unknown): CapabilityPacketV1 | undefined {
	return parse(value, packet, OBSERVER_EVENT_MAX_BYTES);
}

const inputReader = object({ schema: oneOf("observer-input-v1"), request: text(16000), methodObservations: array(method, 8), controlFacts: array(control, 8),
	recentPublicAssistant: array(object({ sourceEntryId: id, text: text(1000) }), 2), executionFacts: array(fact, 16),
	skills: object({ candidates: array(object({ candidateId: id, name: text(64, 1), description: text(384) }), 12), total: count(Number.MAX_SAFE_INTEGER), coverage }),
	missing: array(text(80, 1), 16), nonTextInput: bool },
	{ task: object({ id, anchor: text(4000), userChanges: array(text(3000), 3) }), routing: object({ persistentProfile: profile, taskBand: band }),
		activeHandoff: object({ id, goal: text(1000), constraints: strings }), selectedSkill: object({ identity: hash, name: text(64, 1) }) });
export function parseObserverInput(value: unknown): ObserverInput | undefined {
	return parse(value, v => {
		if ([...JSON.stringify(v)].length > 32000) fail();
		const out = inputReader(v) as ObserverInput;
		const length = (value: unknown) => [...JSON.stringify(value)].length;
		if (length(out) > 32000 || (out.task?.userChanges.reduce((sum, s) => sum + [...s].length, 0) ?? 0) > 3000
			|| length(out.skills.candidates) > 6000
			|| length([out.methodObservations, out.controlFacts, out.executionFacts, out.activeHandoff ?? null]) > 4000
			|| out.skills.candidates.length > out.skills.total
			|| new Set(out.skills.candidates.map(c => c.candidateId)).size !== out.skills.candidates.length) fail();
		return out;
	}, OBSERVER_STATE_MAX_BYTES);
}

/** Compatibility is only for the same proven user source; no workflow/observer interpretation is restored. */
export function compatibleObserverDispatch(value: unknown, source: RequestIdentity): GearTarget | undefined {
	try {
		const expected = identity(jsonCopy(source, 4096)) as RequestIdentity;
		const raw = record(jsonCopy(value, OBSERVER_STATE_MAX_BYTES));
		if (raw.turn !== undefined) {
			const turn = identity(raw.turn) as RequestIdentity;
			if (turn.sessionId !== expected.sessionId || turn.userEntryId !== expected.userEntryId || turn.userContentDigest !== expected.userContentDigest) return undefined;
		} else if (raw.turnId !== `${expected.userEntryId}:${expected.userContentDigest}`) return undefined;
		return freeze(pair(raw.dispatch) as GearTarget);
	} catch { return undefined; }
}

const usage = object({ input: number(0, Number.MAX_SAFE_INTEGER), output: number(0, Number.MAX_SAFE_INTEGER), totalTokens: number(0, Number.MAX_SAFE_INTEGER) },
	{ cacheRead: number(0, Number.MAX_SAFE_INTEGER), cacheWrite: number(0, Number.MAX_SAFE_INTEGER),
		cacheWrite1h: number(0, Number.MAX_SAFE_INTEGER), reasoning: number(0, Number.MAX_SAFE_INTEGER),
		cost: object(Object.fromEntries(["input", "output", "cacheRead", "cacheWrite", "total"].map(key => [key, number(0, Number.MAX_SAFE_INTEGER)]))) });
const capabilityEvent: Reader = v => {
	const out = record(object({ version: oneOf(1), kind: oneOf("proposed", "accepted", "invalidated", "consumed", "physical-response-observed"),
		id, packetDigest: hash, identity }, { handoff: accepted, reason: text(80, 1) })(v));
	const h = out.handoff as ObserverStateV1["activeHandoff"];
	if ((out.kind === "accepted" && !h) || (h && (h.id !== out.id || h.packetDigest !== out.packetDigest
		|| observerDigest(h.identity) !== observerDigest(out.identity)))) fail();
	return out;
};
const observerEvent: Reader = v => {
	const out = record(object({ version: oneOf(1), kind: oneOf("reservation", "call-result", "guidance", "execution-fact", "diagnostic"), identity },
		{ call, budgetOwnerId: id, guidance, fact, reasons: array(text(80, 1), 16), elapsedMs: number(0, Number.MAX_SAFE_INTEGER), usage })(v));
	const source = out.identity as RequestIdentity;
	const c = out.call as { status: string; sourceUserEntryId: string } | undefined;
	const g = out.guidance as { sourceUserEntryId: string } | undefined;
	if ((out.kind === "reservation" && (!c || c.status !== "reserved"))
		|| (out.kind === "call-result" && (!c || c.status === "reserved"))
		|| (c && c.sourceUserEntryId !== source.userEntryId)
		|| (out.kind === "guidance" && !g) || (g && g.sourceUserEntryId !== source.userEntryId)
		|| (out.kind === "execution-fact" && !out.fact) || (out.kind === "diagnostic" && !out.reasons)) fail();
	return out;
};

/** Validate the full custom envelope, not just its data/packet body. */
export function parseObserverEvent(value: unknown): ObserverEventEnvelope | undefined {
	return parse(value, v => {
		const raw = record(v);
		if (raw.customType === CAPABILITY_EVENT_TYPE) return object({ customType: oneOf(CAPABILITY_EVENT_TYPE), data: capabilityEvent })(v);
		if (raw.customType === OBSERVER_EVENT_TYPE) return object({ customType: oneOf(OBSERVER_EVENT_TYPE), data: observerEvent })(v);
		return fail();
	}, OBSERVER_EVENT_MAX_BYTES);
}
