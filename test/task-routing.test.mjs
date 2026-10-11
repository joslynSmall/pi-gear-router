import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decideTask, policyFingerprint, validTask } from '../src/task-routing.ts';
import { bandForScore, clampScore, defaultSettings } from '../src/gears.ts';
import { isContinuation } from '../src/task-context.ts';
const user = (content, timestamp) => ({ role: 'user', content, timestamp });
const facts = { coverage: 'known', verificationFailed: false, completionHint: false, manualModelGap: false, contextMissing: false };
function setup() {
  const settings = defaultSettings(); let calls = 0;
  const run = async (previous, text, n, score = 1.92, relation = 'same_task', overrides = {}) => decideTask({
    turnId: `u${n}`, messages: [user(text, n)], previous, settings,
    policyFingerprint: policyFingerprint(settings), facts, savedDispatchUsable: true, ...overrides,
  }, async () => { calls++; return { kind: 'valid', judgment: { score, confidence: .9, inputTokens: 42 }, relation, relationConfidence: .9, relationProbability: .9 }; });
  const state = (d) => ({ gear: 'heavy', score: d.judgment?.score ?? 1.92, adjustedScore: 1.92, confidence: .9, fallback: false, task: d.task, decision: d.trace });
  return { run, state, calls: () => calls, settings };
}
test('complex task inherits exactly three user continuations then reassesses without new samples', async () => {
  const h = setup(); let d = await h.run(undefined, 'Analyze payment concurrency', 1);
  assert.equal(d.requestedBand, 4);
  for (let i = 2; i <= 4; i++) { d = await h.run(h.state(d), '继续', i); assert.equal(d.trace.source, 'inherited'); assert.equal(d.task.samples.length, 1); }
  d = await h.run(h.state(d), '继续', 5);
  assert.equal(d.trace.source, 'judged'); assert.equal(h.calls(), 2);
});

test('continuation recognition is a complete pure-text allowlist, not a substring heuristic', () => {
  for (const text of ['继续', '继续吧！', '  PLEASE CONTINUE. ', '按刚才的方案继续。', 'go on']) assert.equal(isContinuation(text), true, text);
  for (const text of ['好的', '谢谢', '继续，另外增加权限校验', 'continue and fix auth', '继续!!', '继续\n第二阶段', '完成']) assert.equal(isContinuation(text), false, text);
});

test('same task upgrades immediately; different task resets high demand', async () => {
  const h = setup(); let d = await h.run(undefined, 'Implement component', 1, .7);
  d = await h.run(h.state(d), 'Also resolve security races', 2, 1.92);
  assert.equal(d.requestedBand, 4); assert.equal(d.trace.action, 'upgrade');
  const oldTask = d.task.taskId;
  d = await h.run(h.state(d), 'Independent README title edit', 3, .15, 'new_task');
  assert.equal(d.requestedBand, 0); assert.notEqual(d.task.taskId, oldTask); assert.equal(d.task.samples.length, 1);
});

test('two distinct low observations permit downgrade but boundary noise does not', async () => {
  const h = setup(); let d = await h.run(undefined, 'Analyze payment races', 1);
  d = await h.run(h.state(d), 'Implement the accepted plan', 2, 1.70);
  assert.equal(d.requestedBand, 4); assert.equal(d.task.review.expedited, true);
  d = await h.run(h.state(d), 'Finish implementation details', 3, 1.68);
  assert.equal(d.requestedBand, 3); assert.equal(d.trace.action, 'downgrade');
  assert.equal(d.judgment.score, 1.68); assert.equal(d.trace.windowMaxRaw, 1.70);
  d = await h.run(h.state(d), 'Review more subtle race', 4, 1.92);
  d = await h.run(h.state(d), 'Review phase A', 5, 1.79);
  d = await h.run(h.state(d), 'Review phase B', 6, 1.78);
  assert.equal(d.requestedBand, 4);
});

test('duplicate context cannot confirm downgrade and expedited review backs off', async () => {
  const h = setup(); let d = await h.run(undefined, 'Complex task', 1);
  d = await h.run(h.state(d), 'Implement plan', 2, 1.7);
  // Once request/context has settled, two equivalent continuations are not new evidence.
  d = await h.run(h.state(d), '继续', 3, 1.7);
  // First continuation context differs from substantive request; reset to a higher band.
  d = await h.run(h.state(d), 'Complex new stage', 4, 1.92);
  const expired = h.state(d); expired.task.inheritedTurns = 3;
  d = await h.run(expired, '继续', 5, 1.7);
  const before = structuredClone(d.task.samples);
  d = await h.run(h.state(d), '继续吧', 6, 1.68);
  assert.equal(d.requestedBand, 4);
  assert.deepEqual(d.task.samples, before);
  assert.equal(d.task.review.expedited, false);
  d = await h.run(h.state(d), '继续', 7, .1);
  assert.equal(d.trace.source, 'inherited');
});

test('scope changes, attachments, unknown coverage and failed previous dispatch disable inheritance', async () => {
  const h = setup(); const first = await h.run(undefined, 'Complex task', 1);
  for (const [text, overrides] of [
    ['继续，另外增加权限校验', {}],
    ['继续', { facts: { ...facts, verificationFailed: true } }],
    ['继续', { facts: { ...facts, coverage: 'unknown' } }],
    ['继续', { savedDispatchUsable: false }],
    ['继续', { previous: { ...h.state(first), fallback: true } }],
    ['继续', { messages: [user([{ type: 'text', text: '继续' }, { type: 'image', data: 'x' }], 2)] }],
  ]) {
    const next = await h.run(h.state(first), text, 2, 1.9, 'same_task', overrides);
    assert.equal(next.trace.source, 'judged');
  }
});

test('uncertain relation is provisional, not a permanent difficulty floor', async () => {
  const h = setup(); const first = await h.run(undefined, 'Simple task', 1, .2);
  let d = await h.run(h.state(first), 'What about this?', 2, 1.92, 'uncertain');
  assert.equal(d.requestedBand, 4); assert.equal(d.task.committedBand, 0); assert.equal(d.task.continuity, 'uncertain');
  d = await h.run(h.state(d), 'Independent simple edit', 3, .1, 'new_task');
  assert.equal(d.requestedBand, 0);
});

test('configuration fingerprint ignores key order, keeps dormant workflow tuning inert, and reacts when opt-in', () => {
  const h = setup();
  const reordered = { ...h.settings, taskRouting: { minConfidence: .8, downgradeMargin: .08, downgradeWindow: 2, maxInheritedTurns: 3 } };
  assert.equal(policyFingerprint(reordered), policyFingerprint(h.settings));
  assert.notEqual(policyFingerprint({ ...h.settings, gearBias: .3 }), policyFingerprint(h.settings));
  assert.equal(policyFingerprint({ ...h.settings, workflow: { ...h.settings.workflow, planningMinBand: 1 } }), policyFingerprint(h.settings));
  const enabled = { ...h.settings, workflow: { ...h.settings.workflow, enabled: true } };
  assert.notEqual(policyFingerprint(enabled), policyFingerprint(h.settings));
  assert.notEqual(policyFingerprint({ ...enabled, workflow: { ...enabled.workflow, planningMinBand: 1 } }), policyFingerprint(enabled));
});

test('invalid and oversized task state is never eligible for inheritance', async () => {
  const h = setup(); const d = await h.run(undefined, 'Complex task', 1);
  for (const t of [{ ...d.task, version: 2 }, { ...d.task, samples: [{ rawScore: NaN }] }, { ...d.task, anchor: 'x'.repeat(70000) }, { ...d.task, inheritedTurns: 11 }]) assert.equal(validTask(t, h.settings.bands.length), undefined);
  const next = await h.run({ ...h.state(d), task: { ...d.task, version: 2 } }, '继续', 2);
  assert.equal(next.trace.source, 'judged');
});

test('low confidence interrupts window; failure and partial do not gain inheritance', async () => {
  const h = setup(); let d = await h.run(undefined, 'Complex task', 1);
  d = await h.run(h.state(d), 'Implement stage A', 2, 1.6);
  d = await decideTask({ turnId: 'u3', previous: h.state(d), messages: [user('Stage B', 3)], settings: h.settings, policyFingerprint: policyFingerprint(h.settings), facts, savedDispatchUsable: true }, async () => ({ kind: 'valid', judgment: { score: .7, confidence: .79, inputTokens: 4 }, relation: 'same_task', relationConfidence: .99, relationProbability: .99 }));
  assert.equal(d.requestedBand, 4); assert.equal(d.task.samples.length, 0); assert.equal(d.task.requireRejudge, true);
  d = await h.run(h.state(d), 'Stage C', 4, .7);
  assert.equal(d.requestedBand, 4); assert.equal(d.task.samples.length, 1);
  const failed = await decideTask({ turnId: 'u5', previous: h.state(d), messages: [user('继续', 5)], settings: h.settings, policyFingerprint: policyFingerprint(h.settings), facts, savedDispatchUsable: true }, async () => ({ kind: 'unavailable' }));
  assert.equal(failed.trace.source, 'fallback'); assert.equal(failed.task.samples.length, 0); assert.equal(failed.task.requireRejudge, true);
});

test('bias is applied once and zero inheritance does not disable stabilization', async () => {
  const h = setup(); h.settings.gearBias = .3; h.settings.taskRouting.maxInheritedTurns = 0;
  let d = await h.run(undefined, 'Complex task', 1, 1.8);
  d = await h.run(h.state(d), 'Stage A', 2, .87);
  assert.equal(d.requestedBand, 4);
  d = await h.run(h.state(d), 'Stage B', 3, .87);
  assert.equal(d.requestedBand, 2); assert.ok(Math.abs(d.trace.protectedScore - 1.07) < 1e-12);
  assert.deepEqual(d.task.samples.map(s => s.rawScore), [.87, .87]);
  d = await h.run(h.state(d), '继续', 4, 1.9);
  assert.equal(d.trace.source, 'judged'); assert.equal(d.requestedBand, 4);
});

test('policy changes rejudge and remap only ordinary real-score baselines', async () => {
  const h = setup(); let d = await h.run(undefined, 'Complex task', 1, 1.9);
  h.settings.gearBias = -1;
  d = await h.run(h.state(d), '继续', 2, 1.9);
  assert.equal(d.requestedBand, 3); assert.equal(d.trace.action, 'config-remap'); assert.equal(d.task.samples.length, 1);
  h.settings.gearBias = 0;
  d = await h.run(h.state(d), 'Continue implementation stage', 3, 1.92);
  d = await h.run(h.state(d), 'Stage A', 4, .99);
  d = await h.run(h.state(d), 'Stage B', 5, .99);
  assert.equal(d.task.committedBand, 2); assert.equal(d.task.committedRawScore, .99);
  h.settings.gearBias = -.1;
  d = await h.run(h.state(d), '继续', 6, .95);
  assert.equal(d.requestedBand, 2); assert.equal(d.trace.action, 'hold');
  // A subsequent non-bias policy change must not reinterpret protective margin as a raw score.
  h.settings.taskRouting.downgradeWindow = 3;
  d = await h.run(h.state(d), 'Continue', 7, .95);
  assert.equal(d.requestedBand, 2);
});

test('repeating a long substantive request does not duplicate bounded user changes', async () => {
  const h = setup(); h.settings.taskRouting.downgradeWindow = 8;
  let d = await h.run(undefined, 'Complex task', 1);
  const long = 'Implement ' + 'a'.repeat(2000) + ' exactly';
  for (let n = 2; n < 8; n++) d = await h.run(h.state(d), long, n, 1.7);
  assert.equal(d.task.userChanges.length, 1);
  assert.ok(d.task.samples.length <= 3); assert.equal(d.requestedBand, 4);
});

test('finite property grid checks band bounds and immediate same-task upgrades', async () => {
  let cases = 0;
  for (const bias of [-1, -.3, 0, .3, 1]) for (let a = 0; a <= 20; a++) for (let b = 0; b <= 20; b++) {
    const h = setup(); h.settings.gearBias = bias;
    const first = await h.run(undefined, 'Task', 1, a / 10);
    const next = await h.run(h.state(first), 'New constraint', 2, b / 10);
    assert.ok(next.requestedBand >= first.requestedBand && next.requestedBand <= 4);
    assert.ok(validTask(next.task, h.settings.bands.length)); cases++;
  }
  assert.equal(cases, 2205);
});

test('window property grid cannot turn protection margin into upgrade or skip target boundary', async () => {
  let cases = 0;
  for (const bias of [-1, 0, 1]) for (const margin of [0, .08, .15]) for (let a = 0; a <= 20; a++) for (let b = 0; b <= 20; b++) {
    const h = setup(); h.settings.gearBias = bias; h.settings.taskRouting.downgradeMargin = margin;
    const first = await h.run(undefined, 'Task', 1, a / 10);
    const next = await h.run(h.state(first), 'Stage change', 2, b / 10);
    const scoreBand = bandForScore(b / 10, bias);
    if (scoreBand <= first.requestedBand) {
      const protectedBand = bandForScore(clampScore(clampScore(Math.max(a, b) / 10 + bias * .4) + margin));
      assert.equal(next.requestedBand, Math.min(first.requestedBand, protectedBand));
    } else assert.equal(next.requestedBand, scoreBand);
    cases++;
  }
  assert.equal(cases, 3969);
});

test('cancellation during judge leaves input unchanged and cannot return fallback', async () => {
  const h = setup(); const first = await h.run(undefined, 'Complex task', 1);
  const previous = h.state(first), original = structuredClone(previous), abort = new AbortController();
  await assert.rejects(decideTask({ turnId: 'u2', previous, messages: [user('New work', 2)], settings: h.settings, policyFingerprint: policyFingerprint(h.settings), facts, savedDispatchUsable: true }, async () => { abort.abort(); return { kind: 'unavailable' }; }, abort.signal), { name: 'AbortError' });
  assert.deepEqual(previous, original);
});

test('band-count change rejudges and rejects an out-of-range committed band', async () => {
  const h = setup();
  let d = await h.run(undefined, 'Complex task', 1, 1.9);
  assert.equal(d.task.committedBand, 4);
  h.settings.bands = [
    { max: 0.3, gear: 'light', thinkingLevel: 'low' },
    { max: 0.6, gear: 'light', thinkingLevel: 'high' },
    { max: 1.0, gear: 'standard', thinkingLevel: 'medium' },
    { max: 1.4, gear: 'standard', thinkingLevel: 'high' },
    { max: 1.7, gear: 'heavy', thinkingLevel: 'high' },
    { gear: 'heavy', thinkingLevel: 'xhigh' },
  ];
  d = await h.run(h.state(d), 'Continue', 2, 0.2);
  assert.equal(d.trace.trigger, 'config-changed');
  assert.ok(d.trace.requestedBand <= h.settings.bands.length - 1);
  h.settings.bands = [
    { max: 1, gear: 'light', thinkingLevel: 'low' },
    { gear: 'heavy', thinkingLevel: 'xhigh' },
  ];
  const stale = { ...h.state(d), task: { ...d.task, committedBand: 4 } };
  const next = await h.run(stale, 'Continue again', 3, 0.2);
  assert.equal(next.task.committedBand, 0);
  assert.notEqual(next.task.taskId, d.task.taskId);
});

test('unavailable classifier reason is preserved in the decision trace', async () => {
  const h = setup();
  const d = await decideTask({ turnId: 'u1', messages: [user('Task', 1)], settings: h.settings, policyFingerprint: policyFingerprint(h.settings), facts, savedDispatchUsable: true },
    async () => ({ kind: 'unavailable', attempted: true, failure: 'classify-error: upstream 503' }));
  assert.equal(d.trace.source, 'fallback');
  assert.equal(d.trace.judgeFailure, 'classify-error: upstream 503');
});
