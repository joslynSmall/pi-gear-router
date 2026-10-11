import type { ExtensionAPI, ExtensionContext, ModelRouteRequest, ModelRoute } from '@earendil-works/pi-coding-agent';
import type { Message } from '@earendil-works/pi-ai';
import { resolve } from 'node:path';
import { createObserverIdentityTracker, registerObserverFacts, observerBranchFacts, recoverObserverBudget } from './observation.ts';
import { captureCatalog, catalogSkillForPath, selectCatalogCandidates, matchExplicitSkill, buildObserverInput, prepareGuidance, projectGuidance, projectCapabilityCarry, projectCapabilityContext, type ObserverCatalog } from './observer-guidance.ts';
import { createObserverCallOwner, observeTurn, checkCapabilityHandoff } from './observer-judge.ts';
import { resolveRoutingMode } from './gears.ts';
import { loadSettings } from './settings.ts';
import { parseObserverState, parseObserverEvent, compatibleObserverDispatch, observerDigest, observerPolicyFingerprint, newObserverBudget, resetObserverBudget, decideObserverRoute, observerTrustedChoice } from './observer-routing.ts';
import type { AcceptedCapabilityHandoff, GearSettings, GearTarget, ObserverInput, ObserverStateV1, ValidatedObservationSummary } from './types.ts';
import type { ObserverIdentitySnapshot } from './observation.ts';
import { CAPABILITY_HANDOFF_TOOL, registerCapabilityHandoff } from './observer-handoff.ts';
import type { ObserverStatusActivity } from './observer-status.ts';
/** All runtime consumers use this trust-aware, single-owner settings adapter. */
export function runtimeSettings(ctx: ExtensionContext): GearSettings {
	let projectTrusted = false;
	try {
		projectTrusted = typeof ctx.isProjectTrusted === 'function' && ctx.isProjectTrusted();
	}
	catch { /* absent trust is not consent */ }
	return loadSettings(ctx.cwd, { projectTrusted });
}
type Pair = Omit<ModelRoute<ObserverStateV1>, 'state'>;
export interface ObserverPhysicalAdapter {
	fromTarget(target: GearTarget, ctx: ExtensionContext): Pair | undefined;
	previous(request: ModelRouteRequest<unknown>, ctx: ExtensionContext): Pair | undefined;
	resolve(band: number, request: ModelRouteRequest<unknown>, ctx: ExtensionContext, settings: GearSettings): Pair;
}
export function latestObserverState(ctx: ExtensionContext): ObserverStateV1 | undefined {
	try {
		const entry = ctx.sessionManager.getBranch().findLast(e => e.type === 'custom' && e.customType === 'pi.virtual-model-state'
			&& (e.data as {
				provider?: string;
				modelId?: string;
			})?.provider === 'gears' && (e.data as {
			modelId?: string;
		})?.modelId === 'auto');
		return entry?.type === 'custom' ? parseObserverState((entry.data as {
			state?: unknown;
		}).state) : undefined;
	}
	catch {
		return;
	}
}
export function createObserverRuntime(pi: ExtensionAPI, physical: ObserverPhysicalAdapter, statusChanged?: (ctx: ExtensionContext, activity: ObserverStatusActivity) => void) {
	const activities = new WeakMap<object, ObserverStatusActivity>();
	const evaluations = new WeakMap<object, object>();
	const changed = (ctx: ExtensionContext, update: Partial<ObserverStatusActivity> = {}) => {
		const activity = { ...activities.get(ctx.sessionManager), ...update };
		activities.set(ctx.sessionManager, activity);
		try { statusChanged?.(ctx, activity); } catch { /* rendering never changes routing or persistence */ }
	};
	const evaluate = async <T>(ctx: ExtensionContext, kind: 'turn' | 'handoff', run: () => Promise<T>) => {
		const token = {}, sessionId = ctx.sessionManager.getSessionId();
		evaluations.set(ctx.sessionManager, token);
		changed(ctx, { pending: kind });
		try { return await run(); }
		finally {
			if (evaluations.get(ctx.sessionManager) === token && sessionId === ctx.sessionManager.getSessionId()) {
				evaluations.delete(ctx.sessionManager);
				changed(ctx, { pending: undefined });
			}
		}
	};
	const tracker = createObserverIdentityTracker(pi), owner = createObserverCallOwner();
	let catalog: ObserverCatalog | undefined, generation = 0;
	const raw = new WeakMap<object, string>(), snapshots = new WeakMap<object, ObserverIdentitySnapshot>();
	const routed = new WeakMap<object, {
		snapshot: ObserverIdentitySnapshot;
		system: Message[];
		state: ObserverStateV1;
	}>();
	const gaps = new WeakSet<object>();
	const inputs = new WeakMap<object, ObserverInput>();
	const pending = new WeakMap<object, {
		handoff: AcceptedCapabilityHandoff;
		toolCallId: string;
	}>();
	const observedResponses = new WeakMap<object, Set<string>>();
	const selected = (ctx: ExtensionContext) => resolveRoutingMode(runtimeSettings(ctx)).mode === 'observer' && ctx.model?.provider === 'gears' && ctx.model.id === 'auto';
	const policy = (ctx: ExtensionContext) => ({ mode: resolveRoutingMode(runtimeSettings(ctx)).mode, policyFingerprint: observerPolicyFingerprint(runtimeSettings(ctx)),
		...(catalog?.cwd === ctx.cwd ? { catalogVersion: catalog.version } : {}) });
	const facts = registerObserverFacts(pi, {
		enabled: selected,
		identity: ctx => { const snapshot = snapshots.get(ctx.sessionManager); return tracker.check(snapshot, ctx, policy(ctx)).valid ? snapshot?.identity : undefined; },
		skillForPath: (path, ctx) => catalogSkillForPath(catalog, resolve(ctx.cwd, path), ctx.cwd),
	});
	const invalidatePending = (ctx: ExtensionContext, reason: string) => {
		const candidate = pending.get(ctx.sessionManager);
		pending.delete(ctx.sessionManager);
		if (!candidate)
			return;
		try {
			if (candidate.handoff.identity.sessionId !== ctx.sessionManager.getSessionId()
				|| !ctx.sessionManager.getBranch().some(e => e.id === candidate.handoff.identity.userEntryId))
				return;
			const event = parseObserverEvent({ customType: 'pi-gear-router.capability.v1', data: { version: 1, kind: 'invalidated', id: candidate.handoff.id,
					packetDigest: candidate.handoff.packetDigest, identity: candidate.handoff.identity, reason } });
			if (event)
				pi.appendEntry(event.customType, event.data);
		}
		catch {
			gaps.add(ctx.sessionManager);
		}
		changed(ctx);
	};
	pi.on('input', (event, ctx) => { evaluations.delete(ctx.sessionManager); activities.set(ctx.sessionManager, { ...activities.get(ctx.sessionManager), pending: undefined }); raw.set(ctx.sessionManager, event.text); routed.delete(ctx.sessionManager); invalidatePending(ctx, 'new-input'); });
	pi.on('before_agent_start', (event, ctx) => {
		// Same metadata does not get a new generation on every prompt. Reload creates a new owner.
		const next = captureCatalog(event.systemPromptOptions.skills ?? [], ctx.cwd, generation);
		if (!catalog || catalog.version !== next.version || catalog.cwd !== next.cwd) {
			catalog = captureCatalog(event.systemPromptOptions.skills ?? [], ctx.cwd, ++generation);
			invalidatePending(ctx, 'catalog-changed');
			routed.delete(ctx.sessionManager);
		}
	});
	const invalidate = (_event: unknown, ctx: ExtensionContext) => { evaluations.delete(ctx.sessionManager); activities.set(ctx.sessionManager, { pending: undefined }); invalidatePending(ctx, 'runtime-changed'); routed.delete(ctx.sessionManager); snapshots.delete(ctx.sessionManager); raw.delete(ctx.sessionManager); pending.delete(ctx.sessionManager); inputs.delete(ctx.sessionManager); observedResponses.delete(ctx.sessionManager); owner.clear(); };
	pi.on('session_start', invalidate);
	pi.on('session_tree', invalidate);
	pi.on('session_shutdown', invalidate);
	pi.on('model_select', invalidate);
	pi.on('message_end', (event, ctx) => {
		if (!selected(ctx) || event.message.role !== 'assistant' || event.message.stopReason === 'error' || event.message.stopReason === 'aborted')
			return;
		const live = routed.get(ctx.sessionManager), state = latestObserverState(ctx);
		if (!live || !state || !tracker.check(live.snapshot, ctx, policy(ctx)).valid)
			return;
		const keys = observedResponses.get(ctx.sessionManager) ?? new Set<string>();
		observedResponses.set(ctx.sessionManager, keys);
		const responseKey = observerDigest({ turn: state.turn, dispatch: state.dispatch, handoff: state.activeHandoff?.id ?? 'none' })!;
		if (keys.has(responseKey))
			return;
		keys.add(responseKey);
		if (keys.size > 64)
			keys.delete(keys.values().next().value!);
		try {
			if (state.guidance && ctx.sessionManager.getBranch().some(entry => {
				const event = parseObserverEvent(entry);
				return event?.customType === 'pi-gear-router.observer.v1' && event.data.guidance?.key === state.guidance?.key
					&& event.data.guidance?.status === 'projected';
			})) {
				const e = parseObserverEvent({ customType: 'pi-gear-router.observer.v1', data: { version: 1, kind: 'guidance', identity: state.turn, guidance: { ...state.guidance, status: 'response-observed' } } });
				if (e)
					pi.appendEntry(e.customType, e.data);
			}
			const h = state.activeHandoff;
			if (h) {
				const e = parseObserverEvent({ customType: 'pi-gear-router.capability.v1', data: { version: 1, kind: 'physical-response-observed', identity: h.identity, id: h.id, packetDigest: h.packetDigest } });
				if (e)
					pi.appendEntry(e.customType, e.data);
			}
		}
		catch {
			gaps.add(ctx.sessionManager);
		}
	});
	pi.on('context', (event, ctx) => {
		if (!selected(ctx))
			return;
		const live = routed.get(ctx.sessionManager), state = latestObserverState(ctx);
		if (!live || !state || !tracker.check(live.snapshot, ctx, policy(ctx)).valid || state.turn.userEntryId !== live.state.turn.userEntryId)
			return;
		const sourceContext = runtimeSettings(ctx).observer.stageAware && pi.getActiveTools?.().includes(CAPABILITY_HANDOFF_TOOL)
			? projectCapabilityContext(event.messages, state) : undefined;
		const carried = runtimeSettings(ctx).observer.stageAware ? projectCapabilityCarry(sourceContext ?? event.messages, state) ?? sourceContext : undefined;
		const messages = runtimeSettings(ctx).observer.guidance.enabled ? projectGuidance(carried ?? event.messages, state, { ...(catalog ? { catalog } : {}), systemMessages: live.system, currentPrompt: ctx.getSystemPrompt(),
			source: { id: live.snapshot.identity.userEntryId, message: live.snapshot.projectedMessage } }) : undefined;
		if (!messages)
			return carried ? { messages: carried } : undefined;
		if (state.guidance?.status === 'prepared' && !ctx.sessionManager.getBranch().some(e => {
			const parsed = parseObserverEvent(e);
			return parsed?.customType === 'pi-gear-router.observer.v1' && parsed.data.guidance?.key === state.guidance?.key && parsed.data.guidance?.status === 'projected';
		})) {
			const data = { version: 1, kind: 'guidance', identity: state.turn, guidance: { ...state.guidance, status: 'projected' } };
			const envelope = parseObserverEvent({ customType: 'pi-gear-router.observer.v1', data });
			if (!envelope)
				return;
			try {
				pi.appendEntry(envelope.customType, envelope.data);
			}
			catch {
				gaps.add(ctx.sessionManager);
				return;
			}
		}
		return { messages };
	});
	const current = (ctx: ExtensionContext) => {
		const live = routed.get(ctx.sessionManager), state = latestObserverState(ctx), input = inputs.get(ctx.sessionManager);
		if (!live || !state || !input || input.missing.length || facts.coverage(ctx) !== 'known' || gaps.has(ctx.sessionManager) || !tracker.check(live.snapshot, ctx, policy(ctx)).valid)
			return;
		const budget = recoverObserverBudget(ctx, state.budget);
		if (!budget)
			return;
		const branchFacts = observerBranchFacts(ctx, state.turn, facts.coverage(ctx));
		return { state: { ...state, budget, ...(state.task ? { task: { ...state.task, dirty: state.task.dirty || branchFacts.dirty } } : {}) }, input: { ...input, executionFacts: branchFacts.executionFacts } };
	};
	if (typeof pi.registerTool === 'function')
		registerCapabilityHandoff(pi, {
			settings: runtimeSettings, current,
			valid: (ctx, state, signal) => {
				const live = routed.get(ctx.sessionManager);
				return !!live && tracker.check(live.snapshot, ctx, policy(ctx), signal).valid
					&& observerDigest(state.turn) === observerDigest(live.state.turn) && !gaps.has(ctx.sessionManager);
			},
			readiness: async (ctx, state, packet, toolCallId, signal) => {
				const live = routed.get(ctx.sessionManager), input = inputs.get(ctx.sessionManager);
				if (!live || !input)
					return;
				const evidenceKey = observerDigest({ source: state.turn.userEntryId, revision: state.turn.userContentDigest, packet: observerDigest(packet) })!;
				const outcome = await owner.run({ identity: state.turn, budget: state.budget, record: { callId: `handoff:${evidenceKey}`, evidenceKey, kind: 'handoff', sourceUserEntryId: state.turn.userEntryId, status: 'reserved', attempts: 0 },
					limit: runtimeSettings(ctx).observer.maxCallsPerTask, append: e => { pi.appendEntry(e.customType, e.data); changed(ctx); }, active: () => tracker.check(live.snapshot, ctx, policy(ctx), signal).valid,
					canAccount: () => tracker.canAccount(live.snapshot, ctx), notify: () => { gaps.add(ctx.sessionManager); if (tracker.canAccount(live.snapshot, ctx)) changed(ctx, { accountingUnknown: true }); },
					invoke: onLateAccounting => evaluate(ctx, 'handoff', () => checkCapabilityHandoff(ctx, { packet, context: current(ctx)?.input ?? input }, { onLateAccounting, timeoutMs: runtimeSettings(ctx).judgeTimeoutMs, maxTransportRetries: runtimeSettings(ctx).observer.maxTransportRetries, ...(signal ? { signal } : {}) })), ...(signal ? { signal } : {}) });
				return outcome.result;
			},
			statusChanged: changed,
			accepted: (ctx, handoff, toolCallId) => pending.set(ctx.sessionManager, { handoff, toolCallId }),
		});
	return {
		async route(request: ModelRouteRequest<unknown>, ctx: ExtensionContext): Promise<ModelRoute<ObserverStateV1>> {
			request.signal?.throwIfAborted();
			const settings = runtimeSettings(ctx), currentPolicy = policy(ctx), parsedOld = parseObserverState(request.state);
			const old = parsedOld && ctx.sessionManager.getBranch().some(e => e.id === parsedOld.turn.userEntryId && e.type === 'message' && e.message.role === 'user') ? parsedOld : undefined;
			const fallback = () => (request.reason === 'retry' && !request.failed && old ? physical.fromTarget(old.dispatch, ctx) : undefined)
				?? physical.previous(request, ctx) ?? (old ? physical.fromTarget(old.dispatch, ctx) : undefined) ?? physical.resolve(old?.capability.taskBand ?? 1, request, ctx, settings);
			if (request.reason !== 'user') {
				const candidate = pending.get(ctx.sessionManager), live = routed.get(ctx.sessionManager);
				if (request.reason === 'continuation' && candidate && live && old && tracker.check(live.snapshot, ctx, currentPolicy, request.signal).valid
					&& settings.observer.stageAware && old.budget.transitions < settings.observer.maxTransitions
					&& observerDigest(old.turn) === observerDigest(candidate.handoff.identity)
					&& old.task?.id === candidate.handoff.packet.taskId) {
					const branch = ctx.sessionManager.getBranch(), accepted = branch.some(e => { const p = parseObserverEvent(e); return p?.customType === 'pi-gear-router.capability.v1' && p.data.kind === 'accepted' && p.data.id === candidate.handoff.id; });
					const recovered = recoverObserverBudget(ctx, old.budget);
					if (!recovered || recovered.exhausted || recovered.transitions >= settings.observer.maxTransitions
						|| (candidate.handoff.protectedBand < old.capability.taskBand && observerBranchFacts(ctx, old.turn, facts.coverage(ctx)).dirty))
						return fallback();
					const tool = branch.findLast(e => e.type === 'message' && e.message.role === 'toolResult' && e.message.toolCallId === candidate.toolCallId);
					const toolMessage = tool?.type === 'message' && tool.message.role === 'toolResult' ? tool.message : undefined;
					const data = toolMessage?.details as {
						accepted?: boolean;
						handoffId?: string;
					} | undefined;
					if (accepted && toolMessage?.toolName === CAPABILITY_HANDOFF_TOOL && !toolMessage.isError && data?.accepted === true && data.handoffId === candidate.handoff.id) {
						const next = structuredClone(old), h = candidate.handoff;
						next.budget = recovered;
						next.budget.transitions++;
						next.activeHandoff = h;
						next.capability = { persistentProfile: h.targetProfile, turnProfile: h.targetProfile, requestedBand: h.requestedBand, protectedBand: h.protectedBand, taskBand: h.protectedBand };
						if (next.task) {
							next.task.cooldown = h.protectedBand < old.capability.taskBand ? 2 : next.task.cooldown;
							next.task.samples = [];
							next.task.seenEvidenceKeys = [];
						}
						const pair = physical.resolve(h.protectedBand, request, ctx, settings);
						next.dispatch = { provider: pair.model.provider, model: pair.model.id, thinkingLevel: pair.thinkingLevel };
						const state = parseObserverState(next), event = parseObserverEvent({ customType: 'pi-gear-router.capability.v1', data: { version: 1, kind: 'consumed', id: h.id, packetDigest: h.packetDigest, identity: h.identity } });
						if (state && event) {
							try {
								pi.appendEntry(event.customType, event.data);
								pending.delete(ctx.sessionManager);
								routed.set(ctx.sessionManager, { ...live, state });
								return { ...pair, state };
							}
							catch {
								gaps.add(ctx.sessionManager);
							}
						}
					}
				}
				return fallback();
			}
			const snapshot = tracker.capture(ctx, currentPolicy);
			if (!snapshot)
				return fallback();
			snapshots.set(ctx.sessionManager, snapshot);
			const identity = snapshot.identity;
			// Compatibility is physical only and restricted to the same proven source.
			const pair = compatibleObserverDispatch(request.state, identity);
			const saved = pair ? physical.fromTarget(pair, ctx) : undefined;
			if (old && old.turn.userEntryId === identity.userEntryId && old.turn.userContentDigest === identity.userContentDigest) {
				// Reload/tree may restore dispatch/budget, but cannot restore a pending advisory.
				const live = routed.get(ctx.sessionManager);
				if (live && old.turn.policyFingerprint === identity.policyFingerprint && old.turn.catalogVersion === identity.catalogVersion && tracker.check(live.snapshot, ctx, currentPolicy).valid)
					routed.set(ctx.sessionManager, { ...live, snapshot });
				if (saved)
					return saved;
				const replacement = physical.resolve(old.capability.protectedBand, request, ctx, settings);
				const state = parseObserverState({ ...old, dispatch: { provider: replacement.model.provider, model: replacement.model.id, thinkingLevel: replacement.thinkingLevel } });
				return { ...replacement, ...(state ? { state } : {}) };
			}
			if (!old && saved)
				return saved;
			const actualCatalog = catalog?.cwd === ctx.cwd ? catalog : undefined;
			const explicit = matchExplicitSkill(actualCatalog, raw.get(ctx.sessionManager), snapshot.projectedMessage);
			if (explicit && actualCatalog)
				facts.recordExplicit(ctx, identity, { identity: explicit.identity, catalogVersion: actualCatalog.version });
			const oldFacts = old ? observerBranchFacts(ctx, old.turn, facts.coverage(ctx)) : { coverage: facts.coverage(ctx), dirty: false, executionFacts: [] };
			const currentFacts = observerBranchFacts(ctx, identity, facts.coverage(ctx));
			const branch = ctx.sessionManager.getBranch(), anchor = old?.task ? branch.findIndex(e => e.id === old.task!.anchorUserEntryId) : -1;
			const excluded = branch.slice(Math.max(0, anchor)).flatMap(e => {
				const p = parseObserverEvent(e);
				return p?.customType === 'pi-gear-router.observer.v1' && p.data.identity.sessionId === identity.sessionId
					&& p.data.fact?.catalogVersion === actualCatalog?.version && p.data.fact?.skillIdentity ? [p.data.fact.skillIdentity] : [];
			});
			if (explicit)
				excluded.push(explicit.identity);
			const candidates = settings.observer.skills.enabled && actualCatalog && !explicit ? selectCatalogCandidates(actualCatalog, request.messages, ('content' in snapshot.projectedMessage ? typeof snapshot.projectedMessage.content === 'string' ? snapshot.projectedMessage.content
				: snapshot.projectedMessage.content.filter(b => b.type === 'text').map(b => b.text).join('\n') : ''), excluded) : { candidates: [], total: 0, coverage: 'unknown' as const };
			const projection = ctx.sessionManager.buildSessionProjection();
			const input = buildObserverInput({ snapshot, ...(old ? { previous: old } : {}), recent: projection.entries.flatMap(e => e.messages.map(message => ({ sourceEntryId: e.sourceEntry.id, message }))),
				facts: [...oldFacts.executionFacts, ...currentFacts.executionFacts].slice(-16), skills: { candidates: candidates.candidates, total: candidates.total, coverage: candidates.coverage }, ...(explicit ? { explicit } : {}) });
			if (!input)
				return fallback();
			inputs.set(ctx.sessionManager, input);
			const priorReservation = ctx.sessionManager.getBranch().findLast(e => { const parsed = parseObserverEvent(e); return parsed?.customType === 'pi-gear-router.observer.v1' && parsed.data.budgetOwnerId && branch.some(source => source.id === parsed.data.identity.userEntryId && source.type === 'message' && source.message.role === 'user'); });
			const priorEvent = priorReservation ? parseObserverEvent(priorReservation) : undefined;
			const ownerId = old?.budget.ownerId ?? (priorEvent?.customType === 'pi-gear-router.observer.v1' ? priorEvent.data.budgetOwnerId : undefined) ?? `source:${identity.userEntryId}`;
			let budget = recoverObserverBudget(ctx, old?.budget ?? newObserverBudget(ownerId));
			if (!budget) {
				gaps.add(ctx.sessionManager);
				return fallback();
			}
			if (budget.logicalCalls >= settings.observer.maxCallsPerTask)
				budget.exhausted = true;
			const active = () => tracker.check(snapshot, ctx, policy(ctx), request.signal).valid;
			let callFailure: string | undefined, observed: ValidatedObservationSummary | undefined;
			const decision = await decideObserverRoute({ reason: 'user', identity, context: input, ...(old ? { previous: old } : {}), settings, budget,
				facts: { ...oldFacts, coverage: gaps.has(ctx.sessionManager) ? 'unknown' : oldFacts.coverage }, dispatchUsable: !!old && !!physical.fromTarget(old.dispatch, ctx) }, async () => {
				const evidenceKey = observerDigest({ sessionId: identity.sessionId, source: identity.userEntryId, content: identity.userContentDigest,
					projection: snapshot.projectionDigest, policy: identity.policyFingerprint, catalog: identity.catalogVersion ?? 'none' })!;
				const outcome = await owner.run({ identity, budget: budget!, record: { callId: `turn:${evidenceKey}`, evidenceKey, kind: 'turn', sourceUserEntryId: identity.userEntryId, status: 'reserved', attempts: 0 },
					limit: settings.observer.maxCallsPerTask, append: e => { pi.appendEntry(e.customType, e.data); changed(ctx); }, active, canAccount: () => tracker.canAccount(snapshot, ctx),
					notify: () => { gaps.add(ctx.sessionManager); if (tracker.canAccount(snapshot, ctx)) changed(ctx, { accountingUnknown: true }); }, invoke: onLateAccounting => evaluate(ctx, 'turn', () => observeTurn(ctx, input, { onLateAccounting, timeoutMs: settings.judgeTimeoutMs, maxTransportRetries: settings.observer.maxTransportRetries, ...(request.signal ? { signal: request.signal } : {}) })),
					...(request.signal ? { signal: request.signal } : {}) });
				budget = outcome.budget;
				callFailure = outcome.reason;
				observed = outcome.result;
				if (outcome.reason === 'reservation-failed' || outcome.reason === 'accounting-failed')
					gaps.add(ctx.sessionManager);
				return outcome.result ?? { outcome: 'unavailable', fields: {}, skills: [], failure: 'service-or-adapter-error' };
			}, request.signal);
			request.signal?.throwIfAborted();
			if (!active())
				return fallback();
			if (callFailure || !decision.state) {
				const pair = fallback();
				const state = parseObserverState({ schema: 'observer-routing', version: 1, turn: identity,
					...(old?.task ? { task: { ...old.task, ...(oldFacts.dirty ? { dirty: true, samples: [], seenEvidenceKeys: [] } : {}) } } : {}),
					capability: old?.capability ?? { persistentProfile: 'respond', turnProfile: 'respond', requestedBand: 1, protectedBand: 1, taskBand: 1 },
					dispatch: { provider: pair.model.provider, model: pair.model.id, thinkingLevel: pair.thinkingLevel }, budget,
					...(observed ? { observation: observed } : {}),
					diagnostics: { coverage: gaps.has(ctx.sessionManager) ? 'unknown' : oldFacts.coverage, reasons: [budget.exhausted ? 'budget-exhausted' : callFailure ?? observed?.failure ?? 'observation-unavailable'] } });
				return { ...pair, ...(state ? { state } : {}) };
			}
			const next = structuredClone(decision.state);
			next.budget = budget;
			if (old?.task && observerTrustedChoice(next.observation?.fields.relation) === 'new_task')
				next.budget = resetObserverBudget(budget, next.task!.id, true, settings.observer.maxCallsPerTask);
			const dispatched = physical.resolve(decision.protectedBand ?? next.capability.protectedBand, request, ctx, settings);
			next.dispatch = { provider: dispatched.model.provider, model: dispatched.model.id, thinkingLevel: dispatched.thinkingLevel };
			const prepared = gaps.has(ctx.sessionManager) ? undefined : prepareGuidance(next, actualCatalog, request.messages, settings, input.request, excluded);
			next.diagnostics.reasons = [...next.diagnostics.reasons, ...(input.skills.coverage !== 'known' ? ['catalog-coverage-' + input.skills.coverage] : []), ...input.missing.map(s => s.slice(0, 80))].slice(0, 16);
			const state = parseObserverState(prepared ? { ...prepared, diagnostics: next.diagnostics } : next);
			if (!state || !active())
				return fallback();
			routed.set(ctx.sessionManager, { snapshot, system: structuredClone(request.messages.filter(m => m.role === 'system')), state });
			return { ...dispatched, state };
		},
		invalidate(ctx: ExtensionContext, reason: string) {
			activities.delete(ctx.sessionManager);
			evaluations.delete(ctx.sessionManager);
			invalidatePending(ctx, reason);
			routed.delete(ctx.sessionManager);
			snapshots.delete(ctx.sessionManager);
			inputs.delete(ctx.sessionManager);
		},
		tracker, facts,
	};
}
