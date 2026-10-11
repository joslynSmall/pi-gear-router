import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { SessionManager, VIRTUAL_MODEL_STATE_ENTRY } from '@earendil-works/pi-coding-agent';

const dir = mkdtempSync(join(tmpdir(), 'pi-gear-session-'));
process.env.PI_GEAR_ROUTER_DATA_DIR = dir;
const { default: extension } = await import('../src/index.ts');
after(() => rmSync(dir, { recursive: true, force: true }));
const user = (text, timestamp) => ({ role: 'user', content: text, timestamp });

function setup(session = SessionManager.inMemory(), scores = [.2, 1], relation = 'new_task') {
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({ gears: Object.fromEntries(
    ['light', 'standard', 'heavy'].map((gear) => [gear, { provider: 'test', model: gear, thinkingLevel: 'low' }]),
  ) }));
  let route;
  const handlers = new Map();
  let calls = 0;
  extension({ on: (name, handler) => { const previous = handlers.get(name); handlers.set(name, (...args) => { previous?.(...args); return handler(...args); }); }, appendEntry: (type, data) => session.appendCustomEntry(type, data), registerVirtualModel: (definition) => { route = definition.route; } });
  const ctx = { mode: 'print', model: { provider: 'gears', id: 'auto' }, sessionManager: session, modelRegistry: {
    find: (_provider, id) => ({ provider: 'test', id, api: 'openai-responses', reasoning: true }),
    hasConfiguredAuth: () => true,
    getModelOfType: () => ({}),
    classify: async () => { calls++; return { stopReason: 'stop', answers: { gear: { type: 'score', score: scores[Math.min(calls - 1, scores.length - 1)], confidence: 0.9 }, relation: { type: 'choice', choice: relation, confidence: .99, probabilities: Object.fromEntries(['new_task', 'same_task', 'uncertain'].map(k => [k, k === relation ? .98 : .01])) } } }; },
  } };
  const run = (reason = 'user', previous) => {
    const state = session.getBranch().findLast((entry) => entry.type === 'custom' && entry.customType === VIRTUAL_MODEL_STATE_ENTRY)?.data.state;
    return route({ reason, thinkingLevel: 'high', state, messages: session.buildSessionProjection().messages, previous }, ctx);
  };
  const persist = (result) => session.appendCustomEntry(VIRTUAL_MODEL_STATE_ENTRY, { provider: 'gears', modelId: 'auto', state: result.state });
  return { session, run, persist, calls: () => calls, handlers, ctx };
}

test('real Pi session state survives compaction; new same-text user entry is judged', async () => {
  const h = setup();
  const firstId = h.session.appendMessage(user('same task', 10));
  const first = await h.run();
  assert.ok(first.state.turnId.startsWith(firstId));
  h.persist(first);
  h.session.appendCompaction('summary', firstId, 1000);
  const repeated = await h.run();
  assert.equal(repeated.model.id, 'standard');
  assert.equal(repeated.state, undefined);
  assert.equal(h.calls(), 1);
  // Even identical content and timestamp are distinct requests because entry IDs differ.
  const secondId = h.session.appendMessage(user('same task', 10));
  const second = await h.run();
  assert.equal(second.model.id, 'standard');
  assert.equal(second.state.sessionLock.gear, 'standard');
  assert.ok(second.state.turnId.startsWith(secondId));
  assert.equal(h.calls(), 2);
});

test('tree navigation restores branch verdict and a newly appended task is rejudged', async () => {
  const h = setup();
  h.session.appendMessage(user('first', 1));
  const first = await h.run();
  const firstStateId = h.persist(first);
  h.session.appendMessage(user('second', 2));
  h.persist(await h.run());
  h.session.branch(firstStateId);
  const restored = await h.run();
  assert.equal(restored.model.id, 'standard');
  assert.equal(h.calls(), 2);
  h.session.appendMessage(user('alternate task', 3));
  await h.run();
  assert.equal(h.calls(), 3);
});

test('persisted task restores after reopen, fork and compaction without cross-branch leakage', async () => {
  const h = setup(SessionManager.create(dir, join(dir, 'sessions')), [1.92, .2]);
  const userId = h.session.appendMessage(user('Analyze payment races', 1));
  const first = await h.run(); const originalId = h.persist(first);
  const taskId = first.state.task.taskId;
  h.session.appendMessage(user('Independent title edit', 2));
  h.persist(await h.run());
  // Separate physical JSONL session containing only the original task branch.
  const forkPath = h.session.createBranchedSession(originalId);
  assert.ok(forkPath);
  const fork = setup(SessionManager.open(forkPath), [1.9], 'same_task');
  fork.session.appendCompaction('bounded summary', userId, 1000);
  fork.session.appendMessage(user('继续', 3));
  const inherited = await fork.run(); fork.persist(inherited);
  assert.equal(inherited.state.task.taskId, taskId); assert.equal(inherited.state.decision.source, 'inherited');
  assert.equal(fork.calls(), 0); assert.equal(inherited.state.task.inheritedTurns, 1);
  const reopened = setup(SessionManager.open(fork.session.getSessionFile()), [1.9], 'same_task');
  reopened.session.appendMessage(user('继续', 4));
  const restored = await reopened.run();
  assert.equal(restored.state.task.taskId, taskId); assert.equal(restored.state.task.inheritedTurns, 2); assert.equal(reopened.calls(), 0);
  reopened.persist(restored);
  const crossCwd = setup(SessionManager.forkFrom(reopened.session.getSessionFile(), join(dir, 'other'), join(dir, 'forks')), [1.9], 'same_task');
  crossCwd.session.appendMessage(user('继续', 5));
  const forked = await crossCwd.run();
  assert.equal(forked.state.task.taskId, taskId); assert.equal(forked.state.task.inheritedTurns, 3); assert.equal(crossCwd.calls(), 0);
});

test('tree selection restores task counter and marker is consumed only on its branch', async () => {
  const h = setup(SessionManager.inMemory(), [1.92, 1.9], 'same_task');
  h.session.appendMessage(user('Complex task', 1));
  const first = await h.run(); const root = h.persist(first);
  h.handlers.get('tool_result')({ toolName: 'bash', input: { command: 'npm test' }, structuredContent: { exit_code: 1 }, isError: true }, h.ctx);
  h.session.appendMessage(user('继续', 2));
  const reviewed = await h.run(); h.persist(reviewed);
  assert.equal(reviewed.state.decision.trigger, 'verification-failed'); assert.equal(h.calls(), 2);
  h.session.branch(root);
  h.session.appendMessage(user('继续', 3));
  const alternate = await h.run();
  assert.equal(alternate.state.decision.source, 'inherited'); assert.equal(alternate.state.task.inheritedTurns, 1); assert.equal(h.calls(), 2);
});
