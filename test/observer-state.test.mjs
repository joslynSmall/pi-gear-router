import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseObserverState, parseObserverEvent, parseObserverInput, parseCapabilityPacket, observerDigest, compatibleObserverDispatch } from '../src/observer-routing.ts';

const identity = () => ({ sessionId: 'session-1', userEntryId: 'user-1', userContentDigest: 'a'.repeat(64), inputEpoch: 1, branchEpoch: 0, policyFingerprint: 'b'.repeat(64) });
const state = () => ({ schema: 'observer-routing', version: 1, turn: identity(),
  capability: { persistentProfile: 'converge', turnProfile: 'respond', requestedBand: 0, protectedBand: 0, taskBand: 3 },
  dispatch: { provider: 'synthetic', model: 'heavy', thinkingLevel: 'high' },
  budget: { ownerId: 'task-1', logicalCalls: 0, transportAttempts: 0, transitions: 0, guides: 0, exhausted: false, calls: [] },
  diagnostics: { coverage: 'known', reasons: [] },
});

test('observer state is a fresh immutable whitelist snapshot, never a legacy workflow alias', () => {
  const input = state(); input.authorization = 'grant'; input.dispatch.hidden = 'not propagated';
  const result = parseObserverState(input);
  assert.ok(result); assert.equal(result.authorization, undefined); assert.equal(result.dispatch.hidden, undefined);
  assert.equal(result.capability.persistentProfile, 'converge'); assert.equal(result.capability.turnProfile, 'respond');
  input.dispatch.model = 'changed'; assert.equal(result.dispatch.model, 'heavy');
  assert.throws(() => { result.capability.taskBand = 0; }, TypeError);
  for (const version of [0, 2, '1']) assert.equal(parseObserverState({ ...state(), version }), undefined);
  assert.equal(parseObserverState({ ...state(), schema: 'workflow' }), undefined);
});

test('compatibility requires an independently matching source and extracts only a validated physical pair', () => {
  const legacy = { turnId: 'user-1:' + 'a'.repeat(64), dispatch: state().dispatch, workflow: { phase: 'complete' } };
  assert.deepEqual(compatibleObserverDispatch(legacy, identity()), state().dispatch);
  assert.equal(compatibleObserverDispatch(legacy, { ...identity(), userEntryId: 'other' }), undefined);
  const unknown = { ...state(), version: 9, activeHandoff: { accepted: true } };
  assert.deepEqual(compatibleObserverDispatch(unknown, identity()), state().dispatch);
  assert.equal(compatibleObserverDispatch(unknown, { ...identity(), sessionId: 'other' }), undefined);
  assert.equal(compatibleObserverDispatch({ dispatch: state().dispatch }, identity()), undefined);
  assert.equal(compatibleObserverDispatch({ ...unknown, dispatch: { ...state().dispatch, thinkingLevel: 'typo' } }, identity()), undefined);
});

test('stable digest ignores object insertion order but preserves array order and Unicode content', () => {
  assert.equal(observerDigest({ a: 1, b: ['中文', '😀'] }), observerDigest({ b: ['中文', '😀'], a: 1 }));
  assert.notEqual(observerDigest(['a', 'b']), observerDigest(['b', 'a']));
  assert.equal(observerDigest({ x: undefined }), undefined);
});

const packet = () => ({ version: 1, taskId: 'task-1', sourceUserEntryId: 'user-1', nextWork: 'implement', goal: 'Synthetic goal',
  scope: ['module'], nonGoals: [], decisions: [], steps: [{ change: 'Synthetic change', acceptance: ['Synthetic check'] }], constraints: [],
  validation: ['synthetic check'], risks: [], blockingUnknowns: [], methodGate: 'none_reported',
  permissionEvidence: [{ userEntryId: 'user-1', summary: 'Synthetic user evidence, not approval' }], reason: 'work-converged' });
const input = () => ({ schema: 'observer-input-v1', request: 'Synthetic request', methodObservations: [], controlFacts: [],
  recentPublicAssistant: [], executionFacts: [], skills: { candidates: [], total: 0, coverage: 'known' }, missing: [], nonTextInput: false });

test('non-JSON, cyclic, sparse, accessor and prototype data are rejected without evaluating getters', () => {
  let invoked = 0;
  const getter = {}; Object.defineProperty(getter, 'secret', { enumerable: true, get() { invoked++; return 'secret'; } });
  const sparse = []; sparse.length = 2;
  const decorated = []; decorated.extra = 'value';
  const cycle = {}; cycle.self = cycle;
  for (const bad of [NaN, Infinity, -Infinity, undefined, () => {}, 1n, Symbol(), new Date(), new Map(),
    new (class Example {})(), Object.create({ inherited: true }), getter, sparse, decorated, cycle, JSON.parse('{"__proto__":{}}')]) {
    assert.equal(parseObserverState({ ...state(), extra: bad }), undefined);
    assert.equal(observerDigest(bad), undefined);
  }
  assert.equal(invoked, 0);
  const deep = {}; let node = deep;
  for (let i = 0; i < 30; i++) node = node.child = {};
  assert.equal(observerDigest(deep), undefined);
});

test('invalid profiles, bands, identity and budget counters never produce a resumable state', () => {
  for (const change of [s => s.capability.turnProfile = 'complete', s => s.capability.taskBand = 16,
    s => s.capability.requestedBand = -.1, s => s.turn.inputEpoch = 1.5, s => s.turn.userContentDigest = 'bad',
    s => s.budget.logicalCalls = 1, s => s.budget.transportAttempts = 1, s => s.budget.transitions = 9,
    s => s.budget.guides = 13, s => s.dispatch.model = '', s => s.dispatch.thinkingLevel = 'typo']) {
    const value = state(); change(value); assert.equal(parseObserverState(value), undefined);
  }
});

test('complete event envelopes reject old/unknown protocols and accepted events without matching material', () => {
  const envelope = { customType: 'pi-gear-router.observer.v1', data: { version: 1, kind: 'diagnostic', identity: identity(), reasons: ['coverage-unknown'], secret: 'strip' } };
  assert.ok(parseObserverEvent(envelope)); assert.equal(parseObserverEvent(envelope).data.secret, undefined);
  for (const customType of ['pi-gear-router.workflow', 'pi-gear-router.capability.v2', 'pi-gear-router.observer.v0']) assert.equal(parseObserverEvent({ ...envelope, customType }), undefined);
  assert.equal(parseObserverEvent({ ...envelope, extra: 'x'.repeat(16384) }), undefined);
  assert.equal(parseObserverEvent({ ...envelope, data: { ...envelope.data, version: 2 } }), undefined);
  const entry = { ...envelope, type: 'custom', id: 'entry-1', parentId: 'entry-0', timestamp: '2026-01-01T00:00:00.000Z' };
  assert.ok(parseObserverEvent(entry));
  assert.equal(parseObserverEvent({ ...entry, padding: 'a'.repeat(16384) }), undefined, 'Session entry metadata participates in byte limit');
  const p = packet(), digest = observerDigest(p);
  const handoff = { id: 'handoff-1', packetDigest: digest, identity: identity(), packet: p, targetProfile: 'implement', requestedBand: 1, protectedBand: 1 };
  const accepted = { customType: 'pi-gear-router.capability.v1', data: { version: 1, kind: 'accepted', id: 'handoff-1', packetDigest: digest, identity: identity(), handoff } };
  assert.ok(parseObserverEvent(accepted));
  assert.equal(parseObserverEvent({ ...accepted, data: { ...accepted.data, handoff: undefined } }), undefined);
  assert.equal(parseObserverEvent({ ...accepted, data: { ...accepted.data, id: 'mismatched' } }), undefined);
  assert.equal(parseObserverEvent({ ...accepted, data: { ...accepted.data, handoff: { ...handoff, packetDigest: 'c'.repeat(64) } } }), undefined);
});

test('state byte limit applies before whitelist stripping, including multibyte Unicode', () => {
  const base = state();
  const size = Buffer.byteLength(JSON.stringify({ ...base, extra: '' }));
  assert.ok(parseObserverState({ ...base, extra: 'x'.repeat(65536 - size) }));
  assert.equal(parseObserverState({ ...base, extra: 'x'.repeat(65537 - size) }), undefined);
  assert.equal(parseObserverState({ ...base, extra: '😀'.repeat(17000) }), undefined);
});

test('packet list/text/aggregate bounds are checked without granting permissions', () => {
  assert.ok(parseCapabilityPacket(packet()));
  const p = packet(); p.authorization = 'grant';
  assert.equal(parseCapabilityPacket(p).authorization, undefined);
  assert.equal(parseCapabilityPacket({ ...packet(), nextWork: 'complete' }), undefined);
  assert.equal(parseCapabilityPacket({ ...packet(), scope: Array(9).fill('x') }), undefined);
  assert.equal(parseCapabilityPacket({ ...packet(), goal: '😀'.repeat(1001) }), undefined);
  assert.equal(parseCapabilityPacket({ ...packet(), steps: [{ change: 'x', acceptance: Array(5).fill('x') }] }), undefined);
  assert.equal(parseCapabilityPacket({ ...packet(), scope: Array(8).fill('a'.repeat(1000)) }), undefined);
});

test('guidance separately enforces Unicode and byte limits and snapshots nested data', () => {
  const s = state(); s.guidance = { key: 'guide-1', sourceUserEntryId: 'user-1', candidateIds: [], text: 'a'.repeat(800), status: 'prepared' };
  assert.ok(parseObserverState(s));
  s.guidance.text = 'a'.repeat(801); assert.equal(parseObserverState(s), undefined);
  s.guidance.text = '😀'.repeat(600); assert.equal(parseObserverState(s), undefined);
  s.guidance.text = '😀'.repeat(512); assert.ok(parseObserverState(s));
});

test('bounded observer input admits only public metadata, limits history and does not coerce images/system', () => {
  const i = input(); i.systemPrompt = 'strip'; i.hiddenThinking = 'strip';
  const parsed = parseObserverInput(i); assert.ok(parsed); assert.equal(parsed.systemPrompt, undefined);
  assert.equal(parsed.hiddenThinking, undefined);
  assert.equal(parseObserverInput({ ...input(), request: 'a'.repeat(16001) }), undefined);
  assert.equal(parseObserverInput({ ...input(), recentPublicAssistant: Array(3).fill({ sourceEntryId: 'a', text: 'x' }) }), undefined);
  assert.equal(parseObserverInput({ ...input(), skills: { candidates: Array(13).fill({ candidateId: 'a', name: 'a', description: 'x' }), total: 13, coverage: 'partial' } }), undefined);
  assert.equal(parseObserverInput({ ...input(), request: '😀'.repeat(16000), recentPublicAssistant: [{ sourceEntryId: 'a', text: '😀'.repeat(1000) }] }), undefined, 'UTF-8 JSON bound independent of characters');
});

test('call ledger is bounded and its counters cannot omit reservations or double-count evidence', () => {
  const s = state(), call = { callId: 'call-1', evidenceKey: 'evidence-1', kind: 'turn', sourceUserEntryId: 'user-1', status: 'reserved', attempts: 1 };
  s.budget.calls = [call]; s.budget.logicalCalls = 1; s.budget.transportAttempts = 1;
  assert.ok(parseObserverState(s));
  s.budget.calls.push({ ...call, callId: 'call-2' }); s.budget.logicalCalls = 2; s.budget.transportAttempts = 2;
  assert.equal(parseObserverState(s), undefined);
  s.budget.calls = Array.from({ length: 64 }, (_, i) => ({ ...call, callId: `call-${i}`, evidenceKey: `key-${i}`, attempts: 2 }));
  s.budget.logicalCalls = 64; s.budget.transportAttempts = 128; s.budget.exhausted = true;
  assert.ok(parseObserverState(s));
  s.budget.calls.push({ ...call, callId: 'overflow', evidenceKey: 'overflow' });
  assert.equal(parseObserverState(s), undefined);
});

test('event budget is checked on the complete envelope at the byte boundary', () => {
  const base = { customType: 'pi-gear-router.observer.v1', data: { version: 1, kind: 'diagnostic', identity: identity(), reasons: [] }, padding: '' };
  const size = Buffer.byteLength(JSON.stringify(base));
  assert.ok(parseObserverEvent({ ...base, padding: 'x'.repeat(16384 - size) }));
  assert.equal(parseObserverEvent({ ...base, padding: 'x'.repeat(16385 - size) }), undefined);
  const symbol = Symbol('unknown'); base[symbol] = 'hidden';
  assert.equal(parseObserverEvent(base), undefined);
});

test('reported usage is retained even for a failed classifier result without becoming a free-call claim', () => {
  const report = { input: 5, output: 3, totalTokens: 8, cacheRead: 2, cacheWrite: 1, cacheWrite1h: 1, reasoning: 2,
    cost: { input: .001, output: .002, cacheRead: 0, cacheWrite: 0, total: .003 } };
  const envelope = { customType: 'pi-gear-router.observer.v1', data: { version: 1, kind: 'call-result', identity: identity(),
    call: { callId: 'c', evidenceKey: 'e', kind: 'turn', sourceUserEntryId: 'user-1', status: 'failed', attempts: 1 }, usage: report } };
  assert.deepEqual(parseObserverEvent(envelope).data.usage, report);
  envelope.data.usage.totalTokens = Infinity; assert.equal(parseObserverEvent(envelope), undefined);
});

test('active handoff binds task, profile, packet digest and source; parsing is not readiness approval', () => {
  const s = state(), p = packet();
  s.task = { id: 'task-1', anchor: 'Synthetic goal', anchorUserEntryId: 'user-1', userChanges: [], active: true, continuity: 'confirmed',
    inheritedTurns: 0, dirty: false, methodObservations: [], controlFacts: [], samples: [], seenEvidenceKeys: [], cooldown: 0 };
  s.activeHandoff = { id: 'h', packetDigest: observerDigest(p), identity: identity(), packet: p, targetProfile: 'implement', requestedBand: 1, protectedBand: 1 };
  assert.ok(parseObserverState(s));
  s.task.id = 'other'; assert.equal(parseObserverState(s), undefined); s.task.id = 'task-1';
  s.activeHandoff.identity.branchEpoch = 1; assert.equal(parseObserverState(s), undefined);
});

test('persisted observation validity labels cannot bypass strict probability validation', () => {
  const s = state(); s.observation = { outcome: 'valid', fields: { risk: { status: 'valid', type: 'choice', choice: 'low', confidence: .9,
    probabilities: { low: .9, medium: .05, high: .03, unknown: .02 } } }, skills: [] };
  assert.ok(parseObserverState(s));
  for (const [unknown, valid] of [[.0195, true], [.018, false], [.0215, false]]) {
    s.observation.fields.risk.probabilities.unknown = unknown;
    assert.equal(!!parseObserverState(s), valid);
  }
  s.observation.fields.risk.probabilities.unknown = .02;
  s.observation.fields.risk.choice = 'high'; assert.equal(parseObserverState(s), undefined);
  s.observation.fields.risk.choice = 'low'; s.observation.fields.risk.probabilities.extra = 0;
  assert.equal(parseObserverState(s), undefined);
  delete s.observation.fields.risk.probabilities.extra;
  s.observation.fields.risk.probabilities.unknown = .01;
  assert.equal(parseObserverState(s), undefined);
  s.observation.fields.risk = { status: 'invalid', reason: 'invalid-probabilities' };
  assert.ok(parseObserverState(s));
});
