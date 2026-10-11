import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { createObserverIdentityTracker } from '../src/observation.ts';
import { createObserverSdkFixture, deferred, waitForGate, FIXTURE_PROVIDER } from './helpers/observer-sdk-fixture.mjs';

function fixture() {
  const manager = SessionManager.inMemory(process.cwd()), handlers = new Map();
  const tracker = createObserverIdentityTracker({ on(name, handler) { handlers.set(name, handler); return () => {}; } });
  const ctx = { sessionManager: manager, model: { provider: 'gears', id: 'auto' }, hasPendingMessages: () => false };
  const policy = { mode: 'observer', policyFingerprint: 'b'.repeat(64), catalogVersion: 'c'.repeat(64) };
  const user = content => manager.appendMessage({ role: 'user', content, timestamp: 1 });
  return { manager, handlers, tracker, ctx, policy, user };
}

test('identity is the true persisted source even when later custom context converts to provider-user text', () => {
  const f = fixture(); f.handlers.get('input')({ text: 'Raw candidate', source: 'interactive' }, f.ctx);
  const id = f.user('Transformed actual request');
  f.manager.appendCustomMessageEntry('synthetic.advisory', 'Not a user request', false);
  const snapshot = f.tracker.capture(f.ctx, f.policy);
  assert.equal(snapshot.identity.userEntryId, id); assert.equal(snapshot.identity.inputEpoch, 1);
  assert.equal(snapshot.projectedMessage.content, 'Transformed actual request');
  assert.deepEqual(f.tracker.check(snapshot, f.ctx, f.policy), { valid: true });
  const again = f.tracker.capture(f.ctx, f.policy);
  assert.deepEqual(again.identity, snapshot.identity);
  f.manager.appendCustomEntry('synthetic.diagnostic', { reason: 'normal append' });
  assert.deepEqual(f.tracker.check(snapshot, f.ctx, f.policy), { valid: true }, 'Leaf growth is not an identity change');
});

test('source digest includes complete content beyond external input bounds, including nontext locally', () => {
  const f = fixture(); f.user([{ type: 'text', text: 'x'.repeat(70000) }, { type: 'image', data: 'synthetic-image', mimeType: 'image/png' }]);
  const first = f.tracker.capture(f.ctx, f.policy); assert.ok(first);
  f.user([{ type: 'text', text: 'x'.repeat(70000) }, { type: 'image', data: 'different-image', mimeType: 'image/png' }]);
  const second = f.tracker.capture(f.ctx, f.policy);
  assert.notEqual(first.identity.userContentDigest, second.identity.userContentDigest);
  assert.equal(f.tracker.check(first, f.ctx, f.policy).reason, 'source-superseded');
});

test('context edits use projection for visible input but keep raw source identity and invalidate old snapshot', () => {
  const f = fixture(), id = f.user('Raw retained text');
  const first = f.tracker.capture(f.ctx, f.policy);
  f.manager.appendContextEdit(id, { content: 'Visible edited text' });
  assert.equal(f.tracker.check(first, f.ctx, f.policy).reason, 'projection-changed');
  const edited = f.tracker.capture(f.ctx, f.policy);
  assert.equal(edited.identity.userContentDigest, first.identity.userContentDigest);
  assert.equal(edited.projectedMessage.content, 'Visible edited text');
  f.manager.appendContextEdit(id, null);
  assert.equal(f.tracker.capture(f.ctx, f.policy), undefined);
  assert.equal(f.tracker.check(edited, f.ctx, f.policy).reason, 'source-not-visible');
});

test('handled raw input has no new source and pending input invalidates work before persistence', () => {
  const f = fixture(); f.handlers.get('input')({}, f.ctx);
  assert.equal(f.tracker.capture(f.ctx, f.policy), undefined);
  f.user('Real request'); const first = f.tracker.capture(f.ctx, f.policy);
  f.handlers.get('input')({ text: 'Pause candidate, perhaps later handled' }, f.ctx);
  assert.equal(f.tracker.check(first, f.ctx, f.policy).reason, 'input-changed');
  assert.equal(f.tracker.canAccount(first,f.ctx),true,'Pending input may invalidate routing without erasing usage on the same source branch');
  assert.equal(f.tracker.check(f.tracker.capture(f.ctx, f.policy), { ...f.ctx, hasPendingMessages: () => true }, f.policy).reason, 'pending-input');
});

test('tree/reload/session/model gaps invalidate captured epoch even if the same source and model reappear', () => {
  for (const event of ['session_tree', 'session_start', 'session_shutdown', 'model_select']) {
    const f = fixture(); f.user('Real request'); const snapshot = f.tracker.capture(f.ctx, f.policy);
    f.handlers.get(event)({}, f.ctx);
    assert.equal(f.tracker.check(snapshot, f.ctx, f.policy).reason, 'runtime-changed', event);
    assert.equal(f.tracker.canAccount(snapshot,f.ctx),false);
    const fresh = f.tracker.capture(f.ctx, f.policy);
    assert.notEqual(fresh.identity.branchEpoch, snapshot.identity.branchEpoch);
  }
});

test('branch changes, catalog/policy/mode changes, missing host capability and abort fail closed with fixed reasons', () => {
  const f = fixture(); const root = f.manager.appendCustomEntry('synthetic.root', {});
  const id = f.user('Real request'), snapshot = f.tracker.capture(f.ctx, f.policy);
  assert.equal(f.tracker.check(snapshot, f.ctx, { ...f.policy, catalogVersion: 'd'.repeat(64) }).reason, 'catalog-changed');
  assert.equal(f.tracker.check(snapshot, f.ctx, { ...f.policy, policyFingerprint: 'e'.repeat(64) }).reason, 'policy-changed');
  assert.equal(f.tracker.check(snapshot, f.ctx, { ...f.policy, mode: 'task' }).reason, 'mode-disabled');
  assert.equal(f.tracker.capture({ ...f.ctx, model: { provider: 'manual', id: 'heavy' } }, f.policy), undefined);
  assert.equal(f.tracker.check(snapshot, { ...f.ctx, model: { provider: 'manual', id: 'heavy' } }, f.policy).reason, 'model-changed');
  assert.equal(f.tracker.check(snapshot, { ...f.ctx, hasPendingMessages: undefined }, f.policy).reason, 'coverage-unknown');
  assert.equal(f.tracker.capture({ ...f.ctx, sessionManager: { getBranch: () => [] } }, f.policy), undefined);
  const controller = new AbortController(); controller.abort();
  assert.equal(f.tracker.check(snapshot, f.ctx, f.policy, controller.signal).reason, 'aborted');
  f.manager.branch(root);
  assert.equal(f.tracker.check(snapshot, f.ctx, f.policy).reason, 'source-off-branch');
  assert.ok(f.manager.getEntries().some(e => e.id === id), 'Abandoned entries exist but are never used to recover a source');
});

test('real SDK steering during delayed observation invalidates only the old result without aborting dispatch', { timeout: 10000 }, async t => {
  const entered = deferred(), release = deferred(), records = [];
  const policy = { mode: 'observer', policyFingerprint: 'b'.repeat(64) };
  let tracker;
  const f = await createObserverSdkFixture(t, { extensions: [pi => {
    tracker = createObserverIdentityTracker(pi);
    pi.registerVirtualModel({ provider: 'gears', id: 'auto', name: 'Identity probe', thinkingLevels: ['high'],
      async route(request, ctx) {
        const snapshot = tracker.capture(ctx, policy);
        if (records.length === 0) {
          records.push({ snapshot }); entered.resolve(); await waitForGate(release, request.signal);
          records[0].checked = tracker.check(snapshot, ctx, policy, request.signal);
        } else records.push({ snapshot, checked: tracker.check(snapshot, ctx, policy, request.signal) });
        // Sticky synthetic pair regardless of observation validity.
        return { model: ctx.modelRegistry.find(FIXTURE_PROVIDER, 'heavy'), thinkingLevel: 'high' };
      } });
  }] });
  await f.session.setModel(f.runtime.services.modelRuntime.getModel('gears', 'auto'));
  const run = f.session.prompt('Synthetic initial observation');
  try { await entered.promise; await f.session.steer('Synthetic new constraint'); }
  finally { release.resolve(); }
  await run; await f.session.waitForIdle();
  assert.deepEqual(records[0].checked, { valid: false, reason: 'pending-input' });
  assert.deepEqual(records[1].checked, { valid: true });
  assert.notEqual(records[0].snapshot.identity.userEntryId, records[1].snapshot.identity.userEntryId);
  assert.equal(f.requests.length, 2);
  assert.deepEqual(f.requests.map(r => r.model.id), ['heavy', 'heavy']);
  f.assertClean();
});

test('real SDK reload makes captured old extension context unusable instead of writing late state', { timeout: 10000 }, async t => {
  const captures = [], policy = { mode: 'observer', policyFingerprint: 'b'.repeat(64) };
  let tracker;
  const f = await createObserverSdkFixture(t, { extensions: [pi => {
    tracker = createObserverIdentityTracker(pi);
    pi.registerVirtualModel({ provider: 'gears', id: 'auto', name: 'Identity reload probe', thinkingLevels: ['high'],
      route(_request, ctx) {
        captures.push({ tracker, ctx, snapshot: tracker.capture(ctx, policy) });
        return { model: ctx.modelRegistry.find(FIXTURE_PROVIDER, 'heavy'), thinkingLevel: 'high' };
      } });
  }] });
  await f.session.setModel(f.runtime.services.modelRuntime.getModel('gears', 'auto'));
  await f.session.prompt('Synthetic before reload');
  await f.session.reload();
  const old = captures[0];
  assert.deepEqual(old.tracker.check(old.snapshot, old.ctx, policy), { valid: false, reason: 'coverage-unknown' });
  await f.session.prompt('Synthetic after reload');
  assert.ok(captures[1].snapshot); assert.equal(captures[1].tracker.check(captures[1].snapshot, captures[1].ctx, policy).valid, true);
  f.assertClean();
});

test('capture cannot substitute a summarized or omitted source with an older raw user entry', () => {
  const f = fixture(), old = f.user('Old'), next = f.user('Next');
  const source = f.tracker.capture(f.ctx, f.policy);
  f.manager.appendCompaction('Synthetic summary', next, 100);
  assert.deepEqual(f.tracker.check(source, f.ctx, f.policy), { valid: true }, 'Compaction preserving source is valid');
  f.manager.appendContextEdit(next, null);
  assert.equal(f.tracker.capture(f.ctx, f.policy), undefined);
  assert.ok(f.manager.getBranch().some(e => e.id === old));
});
