import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const dir = mkdtempSync(join(tmpdir(), 'pi-gear-router-test-'));
process.env.PI_GEAR_ROUTER_DATA_DIR = dir;
const { default: extension } = await import('../src/index.ts');
after(() => rmSync(dir, { recursive: true, force: true }));

const model = (id) => ({ provider: 'test', id, api: 'openai-responses', reasoning: true, thinkingLevelMap: { off: 'off', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' } });
const user = (text, timestamp = 1) => ({ role: 'user', content: text, timestamp });

function harness(scores = [0.2, 1, 1.8]) {
  const targets = Object.fromEntries(['light', 'standard', 'heavy'].map((gear) => [gear, { provider: 'test', model: gear, thinkingLevel: gear === 'light' ? 'low' : gear === 'standard' ? 'medium' : 'high' }]));
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({ gears: targets }));
  let route;
  const handlers = new Map();
  extension({
    on(event, handler) { handlers.set(event, handler); return () => handlers.delete(event); },
    appendEntry(customType, data) { entries.push({ type: 'custom', id: `custom-${entries.length}`, customType, data }); },
    registerVirtualModel(definition) { route = definition.route; },
  });
  const statuses = [];
  const calls = [];
  const unavailable = new Set();
  const noAuth = new Set();
  const entries = [];
  const ctx = {
    mode: 'tui',
    model: { provider: 'gears', id: 'auto' },
    ui: { theme: { fg: (_color, text) => text }, setStatus: (key, text) => statuses.push({ key, text }) },
    sessionManager: { getBranch: () => entries, buildSessionProjection() { throw new Error('Judge must use routed messages'); } },
    modelRegistry: {
      find: (_provider, id) => unavailable.has(id) ? undefined : model(id),
      hasConfiguredAuth: (m) => !noAuth.has(m.id),
      getModelOfType: () => ({ id: 'jev-latest' }),
      async classify(_model, input) {
        calls.push(input);
        const score = scores[Math.min(calls.length - 1, scores.length - 1)];
        if (score === null) return { stopReason: 'error', answers: {} };
        return { stopReason: 'stop', answers: { gear: { type: 'score', score, confidence: 0.9 }, relation: { type: 'choice', choice: 'new_task', probabilities: { same_task: .02, new_task: .96, uncertain: .02 }, confidence: .96 } }, usage: { input: 42 } };
      },
    },
  };
  const run = (overrides = {}) => route({ reason: 'user', thinkingLevel: 'xhigh', messages: [user('task')], ...overrides }, ctx);
  return { run, calls, targets, unavailable, noAuth, ctx, entries, statuses, handlers };
}

test('each new user turn is judged and can move light → standard → heavy → light', async () => {
  const h = harness([0.2, 1, 1.8, 0.1]);
  let state;
  for (const [index, gear] of ['light', 'standard', 'heavy', 'light'].entries()) {
    const result = await h.run({ state, messages: [user(`task ${index}`, index + 1)] });
    assert.equal(result.model.id, gear);
    assert.equal(result.state.inputTokens, 42);
    state = result.state;
  }
  assert.equal(h.calls.length, 4);
  assert.equal(h.calls[3].state.request, 'task 3');
});

test('same turn repeated user routing reuses decision after transcript length changes', async () => {
  const h = harness();
  h.entries.push({ type: 'message', id: 'user-1', message: user('task') });
  const first = await h.run();
  const second = await h.run({ state: first.state, messages: [{ role: 'system', content: 'compacted', timestamp: 0 }, user('task')] });
  assert.equal(second.model.id, first.model.id);
  assert.equal(h.calls.length, 1);
});

test('auto thinking level follows the Jev band, not Pi manual thinking selection', async () => {
  const h = harness([0.2, 0.7, 1.2, 1.6, 1.9]);
  const expected = [
    ['light', 'high'], ['standard', 'medium'], ['standard', 'high'],
    ['heavy', 'high'], ['heavy', 'xhigh'],
  ];
  for (const [index, [gear, thinkingLevel]] of expected.entries()) {
    const result = await h.run({ thinkingLevel: 'max', messages: [user(`task ${index}`, index + 1)] });
    assert.equal(result.model.id, gear);
    assert.equal(result.thinkingLevel, thinkingLevel);
  }
  assert.equal(h.calls.length, 5);
});

test('continuations and retries preserve actual physical pair, not changed settings', async () => {
  const h = harness([1.9]);
  const first = await h.run();
  assert.equal(first.thinkingLevel, 'xhigh');
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({ gears: { heavy: { ...h.targets.heavy, model: 'changed', thinkingLevel: 'low' } } }));
  const previous = { model: first.model, thinkingLevel: 'xhigh' };
  const next = await h.run({ reason: 'continuation', state: first.state, previous });
  const retry = await h.run({ reason: 'retry', state: first.state, failed: { ...previous, message: {} } });
  assert.equal(next.model.id, 'heavy');
  assert.equal(retry.model.id, 'heavy');
  assert.equal(next.thinkingLevel, 'xhigh');
  assert.equal(retry.thinkingLevel, 'xhigh');
  assert.equal(h.calls.length, 1);
});

test('failed judgment stores fallback once; next user turn tries Jev again', async () => {
  const h = harness([null, 0.2]);
  const first = await h.run();
  assert.equal(first.model.id, 'standard');
  assert.equal(first.state.fallback, true);
  assert.equal(first.state.decision.judgeFailure, 'classify-error');
  await h.run({ reason: 'continuation', state: first.state });
  await h.run({ reason: 'retry', state: first.state });
  assert.equal(h.calls.length, 1);
  const next = await h.run({ state: first.state, messages: [user('new task', 2)] });
  assert.equal(next.model.id, 'light');
  assert.equal(h.calls.length, 2);
});

test('direct calls never classify or return state', async () => {
  const h = harness();
  const result = await h.run({ reason: 'direct' });
  assert.equal(result.model.id, 'light');
  assert.equal(result.state, undefined);
  assert.equal(h.calls.length, 0);
});

test('missing target and unauthenticated target use available standard and record actual gear', async () => {
  for (const failure of ['unavailable', 'noAuth']) {
    const h = harness([1.8]);
    h[failure].add('heavy');
    const result = await h.run();
    assert.equal(result.model.id, 'standard');
    assert.equal(result.state.gear, 'standard');
    assert.equal(result.state.fallback, true);
  }
});

test('disabled routing skips judge and retains previous pair, or standard without previous', async () => {
  const h = harness();
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({ enabled: false, gears: h.targets }));
  const result = await h.run({ previous: { model: model('manual'), thinkingLevel: 'low' } });
  assert.equal(result.model.id, 'manual');
  assert.equal(result.thinkingLevel, 'low');
  assert.equal((await h.run()).model.id, 'standard');
  assert.equal(h.calls.length, 0);
});

test('old state lacking turn identity does not suppress a new user judgment', async () => {
  const h = harness([0.2]);
  const result = await h.run({ state: { gear: 'heavy', score: 1.8, adjustedScore: 1.8, confidence: 0.9 } });
  assert.equal(result.model.id, 'light');
  assert.equal(h.calls.length, 1);
});


test('router-failure retry prefers saved current turn over an older previous response', async () => {
  const h = harness([1.8]);
  const first = await h.run();
  const retry = await h.run({ reason: 'retry', state: first.state,
    previous: { model: model('light'), thinkingLevel: 'low' } });
  assert.equal(retry.model.id, 'heavy');
  assert.equal(retry.thinkingLevel, 'xhigh');
  assert.equal(h.calls.length, 1);
});

test('subsequent judge failure retains previous turn pair but records a new fallback', async () => {
  const h = harness([1.8, null]);
  const first = await h.run();
  const next = await h.run({ state: first.state, messages: [user('next task', 2)] });
  assert.equal(next.model.id, 'heavy');
  assert.equal(next.state.fallbackReason, 'judge-unavailable');
  assert.notEqual(next.state.turnId, first.state.turnId);
  assert.equal(next.state.score, -1);
  await h.run({ reason: 'continuation', state: next.state });
  assert.equal(h.calls.length, 2);
});

test('all configured gears unavailable uses previous, or throws actionable error', async () => {
  const h = harness();
  for (const gear of ['light', 'standard', 'heavy']) h.unavailable.add(gear);
  const result = await h.run({ previous: { model: model('manual'), thinkingLevel: 'low' } });
  assert.equal(result.model.id, 'manual');
  assert.equal(result.state.dispatch.model, 'manual');
  assert.equal(result.state.fallback, true);
  await assert.rejects(h.run(), /settings.json.*authentication/);
});

test('same turn target vanishing resolves a fallback without another classifier call', async () => {
  const h = harness([1.8]);
  const first = await h.run();
  h.unavailable.add('heavy');
  const repeat = await h.run({ state: first.state });
  assert.equal(repeat.model.id, 'standard');
  assert.equal(repeat.state.fallbackReason, 'target-unavailable');
  assert.equal(h.calls.length, 1);
});

test('disabled then re-enabled routing does not reuse a disabled verdict', async () => {
  const h = harness([1.8]);
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({ enabled: false, gears: h.targets }));
  const first = await h.run();
  assert.equal(first.state.fallbackReason, 'disabled');
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({ enabled: true, gears: h.targets }));
  const next = await h.run({ state: first.state });
  assert.equal(next.model.id, 'heavy');
  assert.equal(h.calls.length, 1);
});

test('orphan continuation judges once; existing physical pair needs no classifier', async () => {
  const h = harness();
  const first = await h.run({ reason: 'continuation' });
  assert.equal(h.calls.length, 1);
  await h.run({ reason: 'continuation', state: first.state });
  assert.equal(h.calls.length, 1);
  const second = harness();
  const result = await second.run({ reason: 'retry', failed: { model: model('manual'), thinkingLevel: 'low' } });
  assert.equal(result.model.id, 'manual');
  assert.equal(second.calls.length, 0);
});

test('three fresh user continuations inherit pair and status; fourth calls Jev once', async () => {
  const h = harness([1.92, 1.9]);
  h.entries.push({ type: 'message', id: 'u1', message: user('Complex payment races', 1) });
  let r = await h.run({ messages: [user('Complex payment races', 1)] });
  let last;
  for (let n = 2; n <= 5; n++) {
    h.entries.push({ type: 'custom', id: `s${n}`, customType: 'pi.virtual-model-state', data: { provider: 'gears', modelId: 'auto', state: r.state } });
    h.entries.push({ type: 'message', id: `u${n}`, message: user('继续', n) });
    last = r;
    r = await h.run({ state: r.state, messages: [user('Complex payment races', 1), user('继续', n)] });
    assert.equal(r.model.id, 'heavy'); assert.equal(r.thinkingLevel, 'xhigh');
    if (n < 5) { assert.equal(r.state.decision.source, 'inherited'); assert.equal(r.state.inputTokens, 0); assert.match(h.statuses.at(-1).text, /沿用.*续接/); }
  }
  assert.equal(h.calls.length, 2);
  assert.notEqual(last.state.turnId, r.state.turnId);
});

test('completion signal reassesses but cannot bypass the same-task downgrade window', async () => {
  const h = harness([1.92, .2]);
  h.ctx.modelRegistry.classify = async (_model, input) => {
    h.calls.push(input);
    return { stopReason: 'stop', answers: { gear: { type: 'score', score: h.calls.length === 1 ? 1.92 : .2, confidence: .9 }, relation: { type: 'choice', choice: 'same_task', confidence: .99, probabilities: { same_task: .98, new_task: .01, uncertain: .01 } } } };
  };
  h.entries.push({ type: 'message', id: 'u1', message: user('Complex task', 1) });
  const first = await h.run({ messages: [user('Complex task', 1)] });
  const done = { role: 'assistant', content: [{ type: 'text', text: '任务已完成。' }], timestamp: 2 };
  h.entries.push({ type: 'custom', id: 's1', customType: 'pi.virtual-model-state', data: { provider: 'gears', modelId: 'auto', state: first.state } }, { type: 'message', id: 'a1', message: done }, { type: 'message', id: 'u2', message: user('继续', 3) });
  const next = await h.run({ state: first.state, messages: [user('Complex task', 1), done, user('继续', 3)] });
  assert.equal(h.calls.length, 2); assert.equal(next.state.decision.trigger, 'completion-hint'); assert.equal(next.state.task.committedBand, 4); assert.equal(next.state.score, .2);
});

test('disabling mid-turn never replaces the saved pair with an older previous response', async () => {
  const h = harness([1.92]); const first = await h.run();
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({ enabled: false, gears: h.targets }));
  const repeat = await h.run({ state: first.state, previous: { model: model('light'), thinkingLevel: 'low' } });
  assert.equal(repeat.model.id, 'heavy'); assert.equal(repeat.thinkingLevel, 'xhigh'); assert.equal(h.calls.length, 1);
});

test('cancellation prevents routing and classifier work', async () => {
  const h = harness();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(h.run({ signal: controller.signal }), { name: 'AbortError' });
  assert.equal(h.calls.length, 0);
});


test('cancellation during classification never persists a fallback decision', async () => {
  const h = harness();
  const controller = new AbortController();
  h.ctx.modelRegistry.classify = async () => {
    controller.abort();
    return { stopReason: 'error', answers: {} };
  };
  await assert.rejects(h.run({ signal: controller.signal }), { name: 'AbortError' });
});

test('cancellation during physical resolution restores footer and does not return candidate state', async () => {
  const h = harness([1.92]); const abort = new AbortController();
  h.ctx.modelRegistry.find = (_provider, id) => { abort.abort(); return model(id); };
  await assert.rejects(h.run({ signal: abort.signal }), { name: 'AbortError' });
  assert.equal(h.calls.length, 1); assert.equal(h.entries.length, 0); assert.equal(h.statuses.at(-1).text, undefined);
});

test('physical fallback retains task capability; next turn reassesses rather than inherits', async () => {
  const h = harness([1.92, 1.92]); h.entries.push({ type: 'message', id: 'u1', message: user('Complex task', 1) });
  h.unavailable.add('heavy');
  const first = await h.run({ messages: [user('Complex task', 1)] });
  assert.equal(first.state.gear, 'standard'); assert.equal(first.state.fallback, true); assert.equal(first.state.task.committedBand, 4);
  h.entries.push({ type: 'custom', id: 's1', customType: 'pi.virtual-model-state', data: { provider: 'gears', modelId: 'auto', state: first.state } });
  h.entries.push({ type: 'message', id: 'u2', message: user('继续', 2) });
  await h.run({ state: first.state, messages: [user('继续', 2)] });
  assert.equal(h.calls.length, 2);
});

test('continuation fallback stores its replacement pair when old dispatch becomes unavailable', async () => {
  const h = harness([1.8]);
  const first = await h.run();
  h.unavailable.add('heavy');
  const continuation = await h.run({ reason: 'continuation', state: first.state });
  assert.equal(continuation.model.id, 'standard');
  assert.equal(continuation.state.dispatch.model, 'standard');
  assert.equal(continuation.state.gear, 'standard');
  assert.equal(continuation.state.fallbackReason, 'target-unavailable');
  assert.equal(h.calls.length, 1);
});

test('custom bands drive gear and thinking dispatch', async () => {
  const h = harness([0.9]);
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({ gears: h.targets, bands: [
    { max: 1, gear: 'light', thinkingLevel: 'low' },
    { gear: 'heavy', thinkingLevel: 'xhigh' },
  ] }));
  const result = await h.run();
  assert.equal(result.model.id, 'light');
  assert.equal(result.thinkingLevel, 'low');
});
