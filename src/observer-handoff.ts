import { defineTool, type ExtensionAPI, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Type, type JsonValue } from '@earendil-works/pi-ai';
import { bandForScore, resolveObserverPolicy, resolveRoutingMode } from './gears.ts';
import { observerDigest, observerTrustedChoice, parseCapabilityPacket, parseObserverEvent } from './observer-routing.ts';
import type { CapabilityPacketV1, AcceptedCapabilityHandoff, GearSettings, ObserverInput, ObserverStateV1 } from './types.ts';
import type { CapabilityReadiness } from './observer-judge.ts';
export const CAPABILITY_HANDOFF_TOOL = 'gear_capability_handoff';
const text = Type.String({ minLength: 1, maxLength: 1000 }), list = Type.Array(text, { maxItems: 8 });
export const capabilityPacketSchema = Type.Object({ version: Type.Literal(1), taskId: Type.String({ minLength: 1, maxLength: 256 }), sourceUserEntryId: Type.String({ minLength: 1, maxLength: 256 }),
	nextWork: Type.Union([Type.Literal('converge'), Type.Literal('implement'), Type.Literal('verify')]), goal: text, scope: list, nonGoals: list,
	decisions: Type.Array(Type.Object({ decision: text, rationale: text }), { maxItems: 8 }), steps: Type.Array(Type.Object({ change: text, acceptance: Type.Array(text, { maxItems: 4 }) }), { maxItems: 8 }),
	constraints: list, validation: list, risks: list, blockingUnknowns: list, methodGate: Type.Union([Type.Literal('none_reported'), Type.Literal('waiting'), Type.Literal('unknown')]),
	permissionEvidence: Type.Array(Type.Object({ userEntryId: Type.String({ minLength: 1, maxLength: 256 }), summary: text }), { maxItems: 8 }),
	reason: Type.Union([Type.Literal('work-converged'), Type.Literal('complexity-increased'), Type.Literal('verification-work')]) });
export interface HandoffHost {
	settings(ctx: ExtensionContext): GearSettings;
	current(ctx: ExtensionContext): {
		state: ObserverStateV1;
		input: ObserverInput;
	} | undefined;
	valid(ctx: ExtensionContext, state: ObserverStateV1, signal?: AbortSignal): boolean;
	readiness(ctx: ExtensionContext, state: ObserverStateV1, packet: CapabilityPacketV1, toolCallId: string, signal?: AbortSignal): Promise<CapabilityReadiness | undefined>;
	accepted(ctx: ExtensionContext, handoff: AcceptedCapabilityHandoff, toolCallId: string): void;
	statusChanged?(ctx: ExtensionContext): void;
}
export function localCapabilityGate(ctx: ExtensionContext, state: ObserverStateV1 | undefined, value: unknown, settings: GearSettings): {
	packet?: CapabilityPacketV1;
	reason: string;
} {
	if (resolveRoutingMode(settings).mode !== 'observer' || !settings.observer.stageAware || ctx.model?.provider !== 'gears' || ctx.model.id !== 'auto')
		return { reason: 'inactive' };
	if (!state?.task?.active || ctx.hasPendingMessages() || ctx.signal?.aborted)
		return { reason: 'source-inactive' };
	if (state.budget.exhausted || state.budget.logicalCalls >= settings.observer.maxCallsPerTask || state.budget.transitions >= settings.observer.maxTransitions)
		return { reason: 'budget-exhausted' };
	const history = ctx.sessionManager.getBranch().flatMap(e => { const p = parseObserverEvent(e); return p?.customType === 'pi-gear-router.capability.v1' && p.data.identity.userEntryId === state.turn.userEntryId && p.data.identity.userContentDigest === state.turn.userContentDigest ? [p.data] : []; });
	if (history.some(e => e.kind === 'accepted' || e.kind === 'consumed'))
		return { reason: 'revision-already-accepted' };
	const packet = parseCapabilityPacket(value);
	if (!packet)
		return { reason: 'invalid-packet' };
	if (packet.taskId !== state.task.id || packet.sourceUserEntryId !== state.turn.userEntryId)
		return { reason: 'wrong-source' };
	if (state.task.methodObservations.some(f => f.waitingFor) || state.task.controlFacts.length || packet.methodGate !== 'none_reported')
		return { reason: 'method-or-control-wait' };
	if (packet.nextWork === 'implement' && (!packet.scope.length || !packet.steps.length || packet.steps.some(s => !s.acceptance.length) || !packet.validation.length || packet.blockingUnknowns.length))
		return { reason: 'implementation-not-converged' };
	const branch = ctx.sessionManager.getBranch(), anchor = branch.findIndex(e => e.id === state.task!.anchorUserEntryId), source = branch.findIndex(e => e.id === state.turn.userEntryId);
	if (anchor < 0 || source < anchor || ctx.sessionManager.getSessionId() !== state.turn.sessionId || branch.findLast(e => e.type === 'message' && e.message.role === 'user')?.id !== state.turn.userEntryId)
		return { reason: 'source-off-branch' };
	if (packet.permissionEvidence.some(p => !branch.slice(anchor, source + 1).some(e => e.id === p.userEntryId && e.type === 'message' && e.message.role === 'user')))
		return { reason: 'permission-reference-invalid' };
	return { packet, reason: 'candidate' };
}
export function readinessCapability(state: ObserverStateV1, packet: CapabilityPacketV1, readiness: CapabilityReadiness, settings: GearSettings): {
	requestedBand: number;
	protectedBand: number;
} | undefined {
	const f = readiness.fields, score = f.capability;
	if (readiness.failure || observerTrustedChoice(f.readiness) !== 'ready' || observerTrustedChoice(f.scope) !== 'relevant' || observerTrustedChoice(f.clarity) !== 'clear' || observerTrustedChoice(f.methodGate) !== 'none_observed'
		|| score?.status !== 'valid' || score.type !== 'score' || score.confidence < .8)
		return;
	const policy = resolveObserverPolicy(settings), requestedBand = bandForScore(score.score, settings.gearBias, settings.bands), floor = policy.minBands[packet.nextWork];
	const low = observerTrustedChoice(f.risk) === 'low', current = state.capability.taskBand;
	if (packet.nextWork === 'implement' && packet.blockingUnknowns.length)
		return;
	const wantsLower = Math.max(requestedBand, floor) < current;
	if (wantsLower && (!low || state.task?.cooldown || state.task?.dirty))
		return;
	// Capability approval is not a permission proof. Conservative floor remains on uncertain/high risk.
	const protectedBand = Math.max(requestedBand, floor, wantsLower ? current - 1 : current,
		observerTrustedChoice(f.risk) === 'high' ? policy.minBands.converge : 0);
	return { requestedBand, protectedBand };
}
const result = (accepted: boolean, reason: string, extra: Record<string, JsonValue> = {}) => ({ content: [{ type: 'text' as const, text: accepted ? '能力交接已接受；仅下一合法续接可改变能力，不批准实施、权限或方法阶段。' : `能力交接未接受：${reason}；保持当前能力。` }], details: { accepted, reason, ...extra }, structuredContent: { accepted, reason, ...extra }, ...(!accepted ? { isError: true } : {}) });
export function registerCapabilityHandoff(pi: ExtensionAPI, host: HandoffHost): void {
	pi.registerTool(defineTool({ name: CAPABILITY_HANDOFF_TOOL, label: 'Capability Handoff', description: 'Submit bounded next-work capability material. Not project approval or completion; does not create a continuation.',
		parameters: Type.Object({ packet: capabilityPacketSchema }), outputSchema: Type.Object({ accepted: Type.Boolean(), reason: Type.String(), handoffId: Type.Optional(Type.String()), packetDigest: Type.Optional(Type.String()), targetProfile: Type.Optional(Type.String()), requestedBand: Type.Optional(Type.Number()), protectedBand: Type.Optional(Type.Number()), packet: Type.Optional(capabilityPacketSchema) }), defaultActive: false, executionMode: 'sequential', annotations: { readOnlyHint: true, idempotentHint: false },
		async execute(toolCallId, params, signal, _update, ctx) {
			const changed = () => { try { host.statusChanged?.(ctx); } catch { /* UI has no acceptance authority */ } };
			signal?.throwIfAborted();
			const settings = host.settings(ctx), current = host.current(ctx), state = current?.state;
			const local = localCapabilityGate(ctx, state, params.packet, settings);
			if (!local.packet || !state)
				return result(false, local.reason);
			if (!host.valid(ctx, state, signal))
				return result(false, 'source-invalidated');
			const packet = local.packet, digest = observerDigest(packet)!, id = observerDigest({ identity: state.turn, packetDigest: digest, toolCallId })!;
			const proposed = parseObserverEvent({ customType: 'pi-gear-router.capability.v1', data: { version: 1, kind: 'proposed', id, packetDigest: digest, identity: state.turn } });
			try {
				if (!proposed)
					throw Error('invalid');
				pi.appendEntry(proposed.customType, proposed.data);
				changed();
			}
			catch {
				return result(false, 'event-append-failed');
			}
			const readiness = await host.readiness(ctx, state, packet, toolCallId, signal);
			signal?.throwIfAborted();
			const reject = (reason: string) => {
				try {
					if (host.valid(ctx, state, signal)) {
						const event = parseObserverEvent({ customType: 'pi-gear-router.capability.v1', data: { version: 1, kind: 'invalidated', id, packetDigest: digest, identity: state.turn, reason } });
						if (event)
							pi.appendEntry(event.customType, event.data);
					}
				}
				catch { /* rejection remains safe */ }
				changed();
				return result(false, reason);
			};
			if (!readiness || !host.valid(ctx, state, signal))
				return reject('readiness-unavailable-or-stale');
			const fresh = host.current(ctx)?.state;
			if (!fresh || localCapabilityGate(ctx, fresh, packet, host.settings(ctx)).packet === undefined)
				return reject('candidate-invalidated');
			const bands = readinessCapability(fresh, packet, readiness, host.settings(ctx));
			if (!bands)
				return reject('readiness-not-accepted');
			const handoff: AcceptedCapabilityHandoff = { id, packetDigest: digest, identity: state.turn, packet, targetProfile: packet.nextWork, ...bands };
			const accepted = parseObserverEvent({ customType: 'pi-gear-router.capability.v1', data: { version: 1, kind: 'accepted', id, packetDigest: digest, identity: state.turn, handoff } });
			try {
				if (!accepted)
					throw Error('invalid');
				pi.appendEntry(accepted.customType, accepted.data);
				host.accepted(ctx, handoff, toolCallId);
				changed();
			}
			catch {
				return result(false, 'event-append-failed');
			}
			return result(true, 'accepted', { handoffId: id, packetDigest: digest, targetProfile: packet.nextWork, ...bands, packet: packet as unknown as JsonValue });
		} }));
}
