import assert from 'node:assert/strict';
import { test } from 'node:test';
import { judgeWorkflowHandoff, judgeWorkflowTurn } from '../src/workflow-judge.ts';

const packet = {
  kind: 'execution', goal: 'Implement phase workflow', nonGoals: ['No KV migration'],
  decisions: [{ decision: 'Use events', rationale: 'Tools run after route state persists' }],
  steps: [{ id: '1', scope: ['src/index.ts'], change: 'Wire route', acceptance: ['npm test'] }],
  constraints: ['Keep retry sticky'], validation: ['npm test'], risks: ['Wrong phase switch'], blockingUnknowns: [],
};
const choice = (value, confidence = .9) => ({ type: 'choice', choice: value, confidence, probabilities: probabilities(value, confidence) });
function probabilities(value, confidence) {
  const labels = ['deliver', 'not_deliver'].includes(value) ? ['deliver', 'not_deliver']
    : ['planning', 'execution', 'none'].includes(value) ? ['planning', 'execution', 'none']
      : ['low', 'medium', 'high'].includes(value) ? ['low', 'medium', 'high']
        : ['ready', 'needs_convergence', 'blocked'].includes(value) ? ['ready', 'needs_convergence', 'blocked']
          : ['same_task', 'new_task', 'uncertain'];
  const rest = (1 - confidence) / (labels.length - 1);
  return Object.fromEntries(labels.map(label => [label, label === value ? confidence : rest]));
}
function harness(answers) {
  const calls = [];
  const ctx = { modelRegistry: {
    getModelOfType: () => ({}),
    async classify(_model, input, options) { calls.push({ input, options }); return { stopReason: 'stop', answers, usage: { input: 17 } }; },
  } };
  return { ctx, calls };
}
function turnAnswers(overrides = {}) {
  return {
    gear: { type: 'score', score: 1.6, confidence: .9 },
    objective: { type: 'choice', choice: 'deliver', confidence: .9, probabilities: { deliver: .9, plan_only: .025, research_only: .025, review: .025, question: .025 } },
    start: choice('planning'), clarity: choice('low'), risk: choice('medium'), ...overrides,
  };
}
function handoffAnswers(overrides = {}) {
  return {
    delivery: choice('deliver'), readiness: choice('ready'), risk: choice('medium'),
    capability: { type: 'score', score: .9, confidence: .95 }, ...overrides,
  };
}

test('workflow turn classifies objective/start/clarity/risk in one bounded call', async () => {
  const h = harness(turnAnswers());
  const input = { request: 'Research, design and implement a workflow router', recent: [], observations: [], nonTextInput: false };
  const result = await judgeWorkflowTurn(h.ctx, input, 1234);
  assert.equal(result.kind, 'valid');
  assert.deepEqual(result.judgment, {
    gear: { score: 1.6, confidence: .9, inputTokens: 17 }, confidence: .9, objective: 'deliver', start: 'planning', clarity: 'low', risk: 'medium',
  });
  assert.equal(result.relation, undefined);
});

test('workflow turn keeps capability-score confidence separate from workflow intent confidence', async () => {
  const h = harness(turnAnswers({ gear: { type: 'score', score: .5, confidence: .22 } }));
  const result = await judgeWorkflowTurn(h.ctx, { request: 'Implement the bounded fixture after planning', recent: [], observations: [], nonTextInput: false }, 1000);
  assert.equal(result.kind, 'valid');
  assert.equal(result.judgment.gear.confidence, .22);
  assert.equal(result.judgment.confidence, .9, 'workflow authorization depends on semantic choices, not capability calibration');
});

test('workflow turn validates all choices, relation and probabilities', async () => {
  const input = { request: 'Implement it', task: { anchor: 'workflow', userChanges: [] }, recent: [], observations: [], nonTextInput: false };
  const complete = { ...turnAnswers(), relation: choice('same_task') };
  let h = harness(complete);
  let result = await judgeWorkflowTurn(h.ctx, input, 1000);
  assert.equal(result.kind, 'valid'); assert.equal(result.relation, 'same_task');
  assert.deepEqual(Object.keys(h.calls[0].input.questions), ['gear', 'objective', 'start', 'clarity', 'risk', 'relation']);
  for (const answers of [
    { ...complete, objective: choice('unknown') },
    { ...complete, start: { ...choice('planning'), probabilities: { planning: .5, execution: .5, none: .5 } } },
  ]) {
    h = harness(answers);
    const partial = await judgeWorkflowTurn(h.ctx, input, 1000);
    assert.equal(partial.kind, 'partial');
    assert.deepEqual(partial.fallbackJudgment, { score: 1.6, confidence: .9, inputTokens: 17 });
  }
  h = harness({ ...complete, gear: { type: 'score', score: 2.1, confidence: .9 } });
  assert.equal((await judgeWorkflowTurn(h.ctx, input, 1000)).kind, 'unavailable');
  h = harness({ ...complete, relation: { type: 'choice', choice: 'same_task', confidence: .9, probabilities: { same_task: .5, new_task: .5, uncertain: .5 } } });
  assert.equal((await judgeWorkflowTurn(h.ctx, input, 1000)).kind, 'partial');
});

test('workflow handoff keeps capability-score confidence separate from readiness confidence', async () => {
  const h = harness(handoffAnswers({ capability: { type: 'score', score: .5, confidence: .22 } }));
  const result = await judgeWorkflowHandoff(h.ctx, { objective: 'deliver', phase: 'planning', packet, validation: [] }, 1000);
  assert.equal(result.kind, 'valid');
  assert.equal(result.judgment.capability.confidence, .22);
  assert.equal(result.judgment.confidence, .9, 'handoff authorization depends on delivery/readiness/risk choices, not capability calibration');
});

test('workflow handoff readiness uses a single independent classifier call', async () => {
  const h = harness(handoffAnswers());
  const result = await judgeWorkflowHandoff(h.ctx, {
    objective: 'deliver', phase: 'planning', packet, task: { anchor: 'workflow', userChanges: [] }, validation: ['passed:npm-test'],
  }, 1000);
  assert.equal(result.kind, 'valid');
  assert.deepEqual(result.judgment, {
    delivery: 'deliver', readiness: 'ready', risk: 'medium', capability: { score: .9, confidence: .95, inputTokens: 17 }, confidence: .9,
  });
  assert.deepEqual(Object.keys(h.calls[0].input.questions), ['delivery', 'readiness', 'risk', 'capability']);
  assert.equal(h.calls[0].input.state.packet, packet);
});

test('workflow handoff rejects malformed answers and reports unavailable classifier failures', async () => {
  const h = harness(handoffAnswers({ readiness: choice('blocked') }));
  let result = await judgeWorkflowHandoff(h.ctx, { objective: 'deliver', phase: 'planning', packet, validation: [] }, 1000);
  assert.equal(result.kind, 'valid'); assert.equal(result.judgment.readiness, 'blocked');
  h.ctx.modelRegistry.classify = async () => ({ stopReason: 'error', answers: {}, errorMessage: 'upstream 503' });
  result = await judgeWorkflowHandoff(h.ctx, { objective: 'deliver', phase: 'planning', packet, validation: [] }, 1000);
  assert.equal(result.kind, 'unavailable'); assert.equal(result.failure, 'classify-error: upstream 503');
  h.ctx.modelRegistry.classify = async () => ({ stopReason: 'stop', answers: { ...handoffAnswers(), delivery: { type: 'choice', choice: 'deliver', confidence: .9, probabilities: { deliver: .4, not_deliver: .6 } } } });
  assert.equal((await judgeWorkflowHandoff(h.ctx, { objective: 'deliver', phase: 'planning', packet, validation: [] }, 1000)).kind, 'unavailable');
  h.ctx.modelRegistry.getModelOfType = () => undefined;
  assert.equal((await judgeWorkflowHandoff(h.ctx, { objective: 'deliver', phase: 'planning', packet, validation: [] }, 1000)).attempted, false);
});
