import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaultSettings, resolveRoutingMode, resolveObserverPolicy } from '../src/gears.ts';
import { observerPolicyFingerprint } from '../src/observer-routing.ts';
import { policyFingerprint } from '../src/task-routing.ts';

test('resolved routing owner follows the complete decision table, with legacy protection winning conflicts', () => {
  for (const [mode, workflow, enabled, owner, reason] of [
    [undefined, false, true, 'task', undefined], [undefined, true, true, 'legacy-workflow', undefined],
    ['observer', false, true, 'observer', undefined], ['observer', true, true, 'legacy-workflow', 'mode-conflict'],
    ['task', false, true, 'task', undefined], ['task', true, true, 'legacy-workflow', 'mode-conflict'],
    ['legacy-workflow', false, true, 'legacy-workflow', undefined], ['legacy-workflow', true, true, 'legacy-workflow', undefined],
    ['observer', true, false, 'disabled', undefined], ['typo', false, true, 'task', 'invalid-mode'],
    ['typo', true, true, 'legacy-workflow', 'invalid-mode'],
  ]) {
    const s = defaultSettings(); s.routingMode = mode; s.workflow.enabled = workflow; s.enabled = enabled;
    assert.deepEqual(resolveRoutingMode(s), { mode: owner, ...(reason ? { diagnostic: reason } : {}) });
  }
  const s = defaultSettings(); s.routingModeInvalid = true;
  assert.deepEqual(resolveRoutingMode(s), { mode: 'task', diagnostic: 'invalid-mode' });
});

test('observer defaults do not activate a mode, mutable defaults are isolated, and reduced bands map floors upward', () => {
  const s = defaultSettings(); assert.equal(resolveRoutingMode(s).mode, 'task');
  assert.deepEqual(s.observer, { guidance: { enabled: true, maxCandidates: 2, maxChars: 800, maxPerTask: 6 }, skills: { enabled: true }, stageAware: true,
    minBands: { converge: 3, implement: 1, verify: 1, respond: 0 }, maxCallsPerTask: 24, maxTransitions: 4, maxTransportRetries: 0 });
  s.bands = [{ gear: 'heavy', thinkingLevel: 'high' }];
  const policy = resolveObserverPolicy(s);
  assert.deepEqual(policy.minBands, { converge: 0, implement: 0, verify: 0, respond: 0 });
  assert.deepEqual(policy.clampedFloors, ['converge', 'implement', 'verify']);
  policy.guidance.maxPerTask = 0; assert.equal(s.observer.guidance.maxPerTask, 6);
  s.observer.minBands.converge = 99;
  assert.equal(resolveObserverPolicy(s).minBands.converge, 0);
  assert.ok(resolveObserverPolicy(s).clampedFloors.includes('converge'));
  assert.equal(defaultSettings().observer.minBands.converge, 3);
});

test('dormant observer configuration does not invalidate existing task/legacy continuity', () => {
  for (const enabled of [false, true]) {
    const s = defaultSettings(); s.workflow.enabled = enabled;
    const initial = policyFingerprint(s);
    s.observer.guidance.enabled = false; s.observer.skills.enabled = false; s.observer.minBands.converge = 15; s.observer.maxCallsPerTask = 64;
    assert.equal(policyFingerprint(s), initial);
  }
});

test('observer fingerprint binds mode, bands, targets, bias, budgets, floors, switches and protocol versions', () => {
  const s = defaultSettings(); s.routingMode = 'observer';
  const initial = observerPolicyFingerprint(s); assert.match(initial, /^[a-f0-9]{64}$/);
  assert.equal(observerPolicyFingerprint(structuredClone(s)), initial);
  for (const change of [s => s.routingMode = 'task', s => s.workflow.enabled = true, s => s.enabled = false,
    s => s.observer.maxCallsPerTask = 23, s => s.observer.guidance.maxPerTask = 5, s => s.observer.stageAware = false,
    s => s.observer.skills.enabled = false, s => s.observer.minBands.converge = 4, s => s.gearBias = .1,
    s => s.gears.heavy.model = 'different', s => s.bands[0].thinkingLevel = 'low', s => s.judgeTimeoutMs = 14000,
    s => s.taskRouting.minConfidence = .9]) {
    const changed = structuredClone(s); change(changed); assert.notEqual(observerPolicyFingerprint(changed), initial);
  }
  assert.notEqual(observerPolicyFingerprint(s, 'different-contract'), initial);
  const a = resolveObserverPolicy(s); a.skills.enabled = false;
  assert.equal(s.observer.skills.enabled, true);
});
