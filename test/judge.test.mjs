import assert from 'node:assert/strict';
import { test } from 'node:test';
import { judgeGear, judgeTask } from '../src/judge.ts';
import { buildTaskContext } from '../src/task-context.ts';

const user = (content, timestamp = 1) => ({ role: 'user', content, timestamp });
function harness(answer = { type: 'score', score: 1.2, confidence: 0.8 }) {
  const calls = [];
  const ctx = { modelRegistry: {
    getModelOfType: () => ({}),
    async classify(_model, input, options) {
      calls.push({ input, options });
      return { stopReason: 'stop', answers: { gear: answer }, usage: { input: 10 } };
    },
  } };
  return { ctx, calls };
}

test('judge reads current routed user, excludes it from recent, and omits tools/thinking', async () => {
  const h = harness();
  const signal = new AbortController().signal;
  const result = await judgeGear(h.ctx, [
    user('old task'),
    { role: 'assistant', content: [{ type: 'thinking', thinking: 'secret' }, { type: 'text', text: 'answer' }] },
    { role: 'toolResult', content: [{ type: 'text', text: 'tool output' }] },
    user([{ type: 'image', data: 'ignored' }, { type: 'text', text: 'current task' }], 2),
  ], 1234, signal);
  assert.deepEqual(result, { score: 1.2, confidence: 0.8, inputTokens: 10 });
  assert.equal(h.calls[0].input.state.request, 'current task');
  assert.deepEqual(h.calls[0].input.state.recent, [
    { role: 'user', text: 'old task' }, { role: 'assistant', text: 'answer' },
  ]);
  assert.deepEqual(h.calls[0].options, { signal, timeoutMs: 1234 });
});

test('long request keeps its head and tail, recent context is bounded', async () => {
  const h = harness();
  const previous = Array.from({ length: 20 }, (_, i) => user(`prior-${i}` + 'x'.repeat(400), i));
  await judgeGear(h.ctx, [...previous, user('HEAD' + 'a'.repeat(17000) + 'TAIL', 21)], 15000);
  const state = h.calls[0].input.state;
  assert.equal(state.request.length, 16000);
  assert.ok(state.request.startsWith('HEAD'));
  assert.ok(state.request.endsWith('TAIL'));
  assert.equal(state.recent.length, 10);
  assert.ok(state.recent.every((message) => message.text.length <= 256));
});

test('unavailable classifier, empty/image-only input, exception and non-stop outcome return null', async () => {
  const h = harness();
  assert.equal(await judgeGear(h.ctx, [], 1), null);
  assert.equal(await judgeGear(h.ctx, [user([{ type: 'image', data: 'x' }])], 1), null);
  assert.equal(h.calls.length, 0);
  h.ctx.modelRegistry.getModelOfType = () => undefined;
  assert.equal(await judgeGear(h.ctx, [user('task')], 1), null);
  h.ctx.modelRegistry.getModelOfType = () => ({});
  h.ctx.modelRegistry.classify = async () => { throw new Error('timeout'); };
  assert.equal(await judgeGear(h.ctx, [user('task')], 1), null);
  h.ctx.modelRegistry.classify = async () => ({ stopReason: 'error', answers: {} });
  assert.equal(await judgeGear(h.ctx, [user('task')], 1), null);
});

test('task judge sends relation and score in one call and validates partial answers', async () => {
  const h = harness();
  const input = { request: '继续', task: { anchor: 'Complex payment races', userChanges: [] }, recent: [], observations: [], nonTextInput: false };
  let result = await judgeTask(h.ctx, input, 1000);
  assert.equal(result.kind, 'partial'); assert.equal(result.judgment.score, 1.2);
  assert.deepEqual(Object.keys(h.calls[0].input.questions), ['gear', 'relation']);
  h.ctx.modelRegistry.classify = async () => ({ stopReason: 'stop', answers: { gear: { type: 'score', score: 1.9, confidence: .9 }, relation: { type: 'choice', choice: 'same_task', confidence: .9, probabilities: { same_task: .9, new_task: .05, uncertain: .05 } } } });
  result = await judgeTask(h.ctx, input, 1000);
  assert.equal(result.kind, 'valid'); assert.equal(result.relation, 'same_task'); assert.equal(result.relationProbability, .9);
  for (const probabilities of [{ same_task: 2, new_task: 0, uncertain: 0 }, { same_task: .1, new_task: .8, uncertain: .1 }, { same_task: .9 }]) {
    h.ctx.modelRegistry.classify = async () => ({ stopReason: 'stop', answers: { gear: { type: 'score', score: 1, confidence: .9 }, relation: { type: 'choice', choice: 'same_task', confidence: .9, probabilities } } });
    assert.equal((await judgeTask(h.ctx, input, 1000)).kind, 'partial');
  }
});

test('task judge preserves timeout/cancellation and reports unavailable without supplementary requests', async () => {
  const h = harness(); const signal = new AbortController().signal;
  const input = { request: 'Task', recent: [], observations: [], nonTextInput: false };
  await judgeTask(h.ctx, input, 1234, signal);
  assert.equal(h.calls[0].options.signal, signal); assert.equal(h.calls[0].options.timeoutMs, 1234); assert.equal(typeof h.calls[0].options.fetch, 'function'); assert.deepEqual(Object.keys(h.calls[0].input.questions), ['gear']);
  for (const answer of [{ type: 'score', score: NaN, confidence: .9 }, { type: 'score', score: 2.1, confidence: .9 }, { type: 'score', score: 1, confidence: Infinity }, { type: 'score', score: 1, confidence: '0.9' }]) {
    h.ctx.modelRegistry.classify = async () => ({ stopReason: 'stop', answers: { gear: answer } });
    assert.equal((await judgeTask(h.ctx, input, 1234)).kind, 'unavailable');
  }
  h.ctx.modelRegistry.classify = async () => { throw new Error('timeout'); };
  assert.equal((await judgeTask(h.ctx, input, 1234)).kind, 'unavailable');
  h.ctx.modelRegistry.classify = async () => assert.fail('Empty inputs must not call classifier');
  assert.equal((await judgeTask(h.ctx, { ...input, request: '', nonTextInput: true }, 1234)).attempted, false);
  h.ctx.modelRegistry.getModelOfType = () => undefined;
  assert.equal((await judgeTask(h.ctx, input, 1234)).attempted, false);
});

test('task context bounds public messages and never sends thinking, tools or old scores', () => {
  const input = buildTaskContext([user('old'), { role: 'assistant', content: [{ type: 'thinking', thinking: 'hidden' }, { type: 'text', text: 'PUBLIC'.repeat(500) }] }, { role: 'toolResult', content: [{ type: 'text', text: 'credential file' }] }, user('HEAD' + 'x'.repeat(20000) + 'TAIL', 2)], { anchor: 'task', userChanges: ['change'], committedRawScore: 1.9 }, { coverage: 'known', verificationFailed: true });
  assert.equal(input.request.length, 16000); assert.ok(input.request.startsWith('HEAD')); assert.ok(input.request.endsWith('TAIL'));
  assert.equal(input.recent[0].text.length, 1000);
  assert.ok(!JSON.stringify(input).includes('hidden')); assert.ok(!JSON.stringify(input).includes('credential file'));
  assert.ok(!JSON.stringify(input).includes('1.9'));
});

test('invalid numeric verdicts do not accidentally select heavy', async () => {
  for (const answer of [undefined, { type: 'choice' },
    { type: 'score', score: NaN, confidence: 0.8 },
    { type: 'score', score: Infinity, confidence: 0.8 },
    { type: 'score', score: -1, confidence: 0.8 },
    { type: 'score', score: 2.1, confidence: 0.8 },
    { type: 'score', score: 1, confidence: NaN },
    { type: 'score', score: 1, confidence: 1.1 },
  ]) {
    const h = harness(answer === undefined ? { type: 'missing' } : answer);
    assert.equal(await judgeGear(h.ctx, [user('task')], 1), null);
  }
});

test('unavailable verdicts carry a bounded diagnostic reason', async () => {
  const h = harness();
  const input = { request: 'Task', recent: [], observations: [], nonTextInput: false };
  h.ctx.modelRegistry.classify = async () => ({ stopReason: 'error', answers: {}, errorMessage: 'upstream 503' });
  let result = await judgeTask(h.ctx, input, 1000);
  assert.equal(result.kind, 'unavailable');
  assert.equal(result.failure, 'classify-error: upstream 503');
  h.ctx.modelRegistry.classify = async () => ({ stopReason: 'aborted', answers: {} });
  assert.equal((await judgeTask(h.ctx, input, 1000)).failure, 'classify-aborted');
  h.ctx.modelRegistry.classify = async () => { throw new Error('Request timed out after 1000ms'); };
  assert.equal((await judgeTask(h.ctx, input, 1000)).failure, 'Request timed out after 1000ms');
  h.ctx.modelRegistry.classify = async () => ({ stopReason: 'stop', answers: { gear: { type: 'score', score: NaN, confidence: .9 } } });
  assert.equal((await judgeTask(h.ctx, input, 1000)).failure, 'invalid-answer');
  assert.equal((await judgeTask(h.ctx, { ...input, request: '' }, 1000)).failure, 'empty-request');
  h.ctx.modelRegistry.getModelOfType = () => undefined;
  result = await judgeTask(h.ctx, input, 1000);
  assert.equal(result.failure, 'classifier-model-missing'); assert.equal(result.attempted, false);
  h.ctx.modelRegistry.getModelOfType = () => ({});
  h.ctx.modelRegistry.classify = async () => { throw new Error('x'.repeat(500)); };
  assert.equal((await judgeTask(h.ctx, input, 1000)).failure.length, 200);
});

test('transport failures are retried and can recover within the judge window', async () => {
  const h = harness();
  const input = { request: 'Task', recent: [], observations: [], nonTextInput: false };
  const realFetch = globalThis.fetch;
  let attempts = 0;
  globalThis.fetch = async () => { attempts++; if (attempts < 3) throw new TypeError('fetch failed'); return new Response('{}', { status: 200 }); };
  h.ctx.modelRegistry.classify = async (_model, _context, options) => {
    try { await options.fetch('http://classifier', {}); return { stopReason: 'stop', answers: { gear: { type: 'score', score: 1.1, confidence: .9 } }, usage: { input: 7 } }; }
    catch (error) { return { stopReason: 'error', answers: {}, errorMessage: error.message }; }
  };
  try {
    const result = await judgeTask(h.ctx, input, 5000);
    assert.equal(result.kind, 'valid');
    assert.equal(result.judgment.score, 1.1);
    assert.equal(attempts, 3);
  } finally { globalThis.fetch = realFetch; }
});

test('transport failures stay bounded and preserve the reason after retries', async () => {
  const h = harness();
  const input = { request: 'Task', recent: [], observations: [], nonTextInput: false };
  const realFetch = globalThis.fetch;
  let attempts = 0;
  globalThis.fetch = async () => { attempts++; throw new TypeError('fetch failed'); };
  h.ctx.modelRegistry.classify = async (_model, _context, options) => {
    try { await options.fetch('http://classifier', {}); return { stopReason: 'stop', answers: {} }; }
    catch (error) { return { stopReason: 'error', answers: {}, errorMessage: error.message }; }
  };
  try {
    const result = await judgeTask(h.ctx, input, 5000);
    assert.equal(result.kind, 'unavailable');
    assert.equal(result.failure, 'classify-error: fetch failed');
    assert.equal(attempts, 3);
  } finally { globalThis.fetch = realFetch; }
});

test('non-transport classifier errors are not retried', async () => {
  const h = harness();
  const input = { request: 'Task', recent: [], observations: [], nonTextInput: false };
  let calls = 0;
  h.ctx.modelRegistry.classify = async () => { calls++; return { stopReason: 'error', answers: {}, errorMessage: 'System One API error (401): bad key' }; };
  const result = await judgeTask(h.ctx, input, 5000);
  assert.equal(calls, 1);
  assert.equal(result.failure, 'classify-error: System One API error (401): bad key');
});
