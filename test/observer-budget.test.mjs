import assert from 'node:assert/strict';
import { test } from 'node:test';
import { newObserverBudget, reserveObserverCall, finishObserverCall, resetObserverBudget } from '../src/observer-routing.ts';
import { createObserverCallOwner, observeTurn } from '../src/observer-judge.ts';
import { recoverObserverBudget } from '../src/observation.ts';
const source = () => ({ sessionId: 's', userEntryId: 'u', userContentDigest: 'a'.repeat(64), policyFingerprint: 'b'.repeat(64), inputEpoch: 1, branchEpoch: 0 });
function host() {
  const events = []; let current = true, writable = true, notifications = [];
  return { events, notifications, set current(v) { current = v; }, set writable(v) { writable = v; },
    append(event) { if (!writable) throw Error('secret persistence error'); events.push(event); },
    active: () => current, canAccount: () => current, notify: reason => notifications.push(reason) };
}
const call = (key = 'e') => ({ callId: `call-${key}`, evidenceKey: key, kind: 'turn', sourceUserEntryId: 'u', status: 'reserved', attempts: 0 });

test('logical budget reserves before transport, deduplicates and never refunds failure or cancellation', () => {
  const original = newObserverBudget('task');
  const first = reserveObserverCall(original, call(), 2); assert.equal(first.kind, 'reserved');
  assert.equal(original.logicalCalls, 0); assert.equal(first.budget.logicalCalls, 1);
  assert.equal(reserveObserverCall(first.budget, call(), 2).kind, 'duplicate');
  const failed = finishObserverCall(first.budget, 'call-e', 'aborted', 1);
  assert.equal(failed.logicalCalls, 1); assert.equal(failed.transportAttempts, 1);
  const second = reserveObserverCall(failed, call('e2'), 2); assert.equal(second.budget.logicalCalls, 2);
  assert.equal(reserveObserverCall(second.budget, call('e3'), 2).kind, 'exhausted');
  assert.equal(resetObserverBudget(second.budget, 'new', true, 2).ownerId, 'task', 'exhaustion cannot be bypassed by guessed new task');
  assert.equal(resetObserverBudget(failed, 'new', false, 2).ownerId, 'task');
  assert.equal(resetObserverBudget(failed, 'new', true, 2).ownerId, 'new');
});

test('call owner persists reservation before calling once and shares concurrent work', async () => {
  const h = host(), owner = createObserverCallOwner(); let release; const gate = new Promise(r => release = r); let calls = 0;
  const options = { identity: source(), budget: newObserverBudget('task'), record: call(), limit: 24, ...h,
    async invoke() { calls++; assert.equal(h.events[0].data.kind, 'reservation'); await gate; return { result: { synthetic: true }, attempts: 1, usage: { input: 5, output: 2, totalTokens: 7 } }; } };
  const a = owner.run(options), b = owner.run(options); release();
  const [one, two] = await Promise.all([a, b]); assert.equal(calls, 1); assert.deepEqual(one, two);
  assert.equal(one.budget.logicalCalls, 1); assert.equal(one.budget.transportAttempts, 1);
  assert.equal(h.events.length, 2); assert.deepEqual(h.events[1].data.usage, { input: 5, output: 2, totalTokens: 7 });
  const repeat = await owner.run(options); assert.deepEqual(repeat, one); assert.equal(calls, 1);
});

test('shared call ledger never rolls back transition, guidance or exhaustion updates made outside transport', async () => {
  const h = host(), owner = createObserverCallOwner();
  const options = { identity: source(), budget: newObserverBudget('task'), limit: 24, ...h,
    invoke: async () => ({ result: {}, attempts: 1 }) };
  const first = await owner.run({ ...options, record: call('first') });
  const updated = { ...first.budget, transitions: 1, guides: 2 };
  const second = await owner.run({ ...options, budget: updated, record: call('second') });
  assert.equal(second.budget.transitions, 1); assert.equal(second.budget.guides, 2);
  const exhausted = await owner.run({ ...options, budget: { ...second.budget, exhausted: true }, record: call('third') });
  assert.equal(exhausted.reason, 'budget-exhausted'); assert.equal(exhausted.budget.logicalCalls, 2);
});

test('reservation failure and restored duplicate disable transport instead of silently spending again', async () => {
  const h = host(), owner = createObserverCallOwner(); h.writable = false;
  let calls = 0; const options = { identity: source(), budget: newObserverBudget('task'), record: call(), limit: 24, ...h, invoke: async () => { calls++; return { result: {}, attempts: 1 }; } };
  assert.equal((await owner.run(options)).reason, 'reservation-failed'); assert.equal(calls, 0);
  h.writable = true;
  const restored = reserveObserverCall(options.budget, call(), 24).budget;
  assert.equal((await createObserverCallOwner().run({ ...options, budget: restored })).reason, 'restored-call'); assert.equal(calls, 0);
});

test('stale completion never returns routing data or writes an unrelated branch; usage is not erased', async () => {
  const h = host(), owner = createObserverCallOwner(); let release, entered;
  const gate = new Promise(r => release = r), started = new Promise(r => entered = r);
  const run = owner.run({ identity: source(), budget: newObserverBudget('task'), record: call(), limit: 24, ...h,
    async invoke() { entered(); await gate; return { result: { mustNotCommit: true }, attempts: 1, usage: { input: 4, output: 1, totalTokens: 5 } }; } });
  await started; h.current = false; release(); const result = await run;
  assert.equal(result.result, undefined); assert.equal(result.reason, 'stale'); assert.equal(result.budget.logicalCalls, 1);
  assert.equal(h.events.length, 1); assert.deepEqual(h.notifications, ['accounting-coverage-unknown']);
});

test('cancelled call remains reserved/accounted and the abort propagates, without credential error text', async () => {
  const h = host(), controller = new AbortController();
  const owner = createObserverCallOwner();
  const options = { identity: source(), budget: newObserverBudget('task'), record: call(), limit: 24, ...h, signal: controller.signal,
    async invoke() { controller.abort(); throw Error('https://secret.invalid?apiKey=secret'); } };
  await assert.rejects(owner.run(options), /abort/i);
  assert.equal(h.events[1].data.call.status, 'aborted'); assert.equal(h.events[1].data.call.attempts, 1);
  assert.ok(!JSON.stringify(h.events).includes('secret'));
});

test('distinct parallel candidates share a ledger and cannot overspend the same stale budget snapshot', async () => {
  const h = host(), owner = createObserverCallOwner(); let release; const gate = new Promise(r => release = r); let calls = 0;
  const options = { identity: source(), budget: newObserverBudget('task'), limit: 1, ...h,
    invoke: async () => { calls++; await gate; return { result: {}, attempts: 1 }; } };
  const a = owner.run({ ...options, record: call('first') });
  const b = owner.run({ ...options, record: call('second') });
  release(); const [one, two] = await Promise.all([a, b]);
  assert.equal(calls, 1); assert.equal(one.budget.logicalCalls, 1); assert.equal(two.reason, 'budget-exhausted');
});

test('restored budget reads only matching owner events on current branch, including an unfinished reservation', () => {
  const data = (kind, owner, record) => ({ type:'custom', customType:'pi-gear-router.observer.v1', data:{version:1,kind,identity:source(),budgetOwnerId:owner,call:record} });
  const branch = [data('reservation','task',call()),data('call-result','task',{...call(),status:'failed',attempts:1}),data('reservation','other',call('other'))];
  const ctx={sessionManager:{getBranch:()=>branch,getSessionId:()=>source().sessionId}};
  const restored=recoverObserverBudget(ctx,newObserverBudget('task'));
  assert.equal(restored.logicalCalls,1);assert.equal(restored.transportAttempts,1);assert.equal(restored.calls[0].status,'failed');
  assert.equal(reserveObserverCall(restored,call(),24).kind,'duplicate');
});

test('forked branch carries proven ancestor reservations, but never imports unrelated source events',()=>{
 const event={type:'custom',customType:'pi-gear-router.observer.v1',data:{version:1,kind:'reservation',identity:source(),budgetOwnerId:'task',call:call()}};
 const branch=[{id:'u',type:'message',message:{role:'user',content:'Synthetic'}},event];
 const ctx={sessionManager:{getSessionId:()=> 'fork',getBranch:()=>branch}};
 assert.equal(recoverObserverBudget(ctx,newObserverBudget('task')).logicalCalls,1);
 branch.shift();assert.equal(recoverObserverBudget(ctx,newObserverBudget('task')).logicalCalls,0);
});

test('late usage after a bounded timeout is accounting only, deduplicated, and refused after branch replacement', async () => {
  for (const branchChanged of [false, true]) {
    const h = host(), owner = createObserverCallOwner(); let resolve, late;
    const transport = new Promise(r => resolve = r);
    const recorded = new Promise(r => late = r);
    const input = { schema: 'observer-input-v1', request: 'Synthetic', methodObservations: [], controlFacts: [], recentPublicAssistant: [], executionFacts: [], skills: { candidates: [], total: 0, coverage: 'known' }, missing: [], nonTextInput: false };
    const ctx = { modelRegistry: { getModelOfType: () => ({ provider: 'typesafe', id: 'jev-latest' }), classify: () => transport } };
    const result = await owner.run({ identity: source(), budget: newObserverBudget('task'), record: call(), limit: 24, ...h,
      notify(reason) { h.notify(reason); late(); },
      append(event) { h.append(event); if (event.data.usage) late(); },
      invoke: onLateAccounting => observeTurn(ctx, input, { timeoutMs: 10, maxTransportRetries: 0, onLateAccounting }) });
    assert.equal(result.result.failure, 'timeout'); assert.equal(result.budget.logicalCalls, 1);
    if (branchChanged) h.current = false;
    resolve({ stopReason: 'stop', answers: {}, usage: { input: 4, output: 2, totalTokens: 6 } });
    await recorded;
    assert.equal(result.result.failure, 'timeout', 'Late transport never returns a new decision');
    const usage = h.events.filter(e => e.data.usage);
    assert.equal(usage.length, branchChanged ? 0 : 1);
    if (!branchChanged) assert.equal(usage[0].data.call.status, 'stale');
    else assert.deepEqual(h.notifications, ['accounting-coverage-unknown']);
  }
});

test('late usage after cancellation records once without refund, result or cross-branch write', async () => {
  const h = host(), controller = new AbortController(); let resolve, entered, late;
  const transport = new Promise(r => resolve = r), started = new Promise(r => entered = r), accounted = new Promise(r => late = r);
  const input = { schema: 'observer-input-v1', request: 'Synthetic', methodObservations: [], controlFacts: [], recentPublicAssistant: [], executionFacts: [], skills: { candidates: [], total: 0, coverage: 'known' }, missing: [], nonTextInput: false };
  const ctx = { modelRegistry: { getModelOfType: () => ({ provider: 'typesafe', id: 'jev-latest' }), classify: () => { entered(); return transport; } } };
  const work = createObserverCallOwner().run({ identity: source(), budget: newObserverBudget('task'), record: call(), limit: 24, ...h, signal: controller.signal,
    append(event) { h.append(event); if (event.data.usage) late(); },
    invoke: onLateAccounting => observeTurn(ctx, input, { timeoutMs: 1000, maxTransportRetries: 0, signal: controller.signal, onLateAccounting }) });
  await started; controller.abort(); await assert.rejects(work, /abort/i);
  resolve({ stopReason: 'stop', answers: {}, usage: { input: 3, output: 1, totalTokens: 4 } }); await accounted;
  assert.equal(h.events.filter(e => e.data.usage).length, 1); assert.equal(h.events[1].data.call.status, 'aborted');
  assert.equal(h.events.at(-1).data.call.attempts, 1); assert.equal(h.events[0].data.kind, 'reservation');
});

test('result append failure reports partial coverage and does not return unrecorded routing output', async () => {
  const h = host(); let count = 0;
  const result = await createObserverCallOwner().run({ identity: source(), budget: newObserverBudget('task'), record: call(), limit: 24, ...h,
    append(event) { if (++count === 2) throw Error('disk'); h.append(event); }, invoke: async () => ({ result: {}, attempts: 1 }) });
  assert.equal(result.reason, 'accounting-failed'); assert.equal(result.result, undefined); assert.equal(result.budget.logicalCalls, 1);
});
