import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const dir = mkdtempSync(join(tmpdir(), 'pi-gear-workflow-router-'));
process.env.PI_GEAR_ROUTER_DATA_DIR = dir;
const { default: extension } = await import('../src/index.ts');
const { WORKFLOW_EVENT_TYPE, workflowPacketDigest } = await import('../src/workflow-routing.ts');
after(() => rmSync(dir, { recursive: true, force: true }));

const model = (id) => ({ provider: 'test', id, api: 'openai-responses', reasoning: true, thinkingLevelMap: { off: 'off', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' } });
const user = (text, timestamp = 1) => ({ role: 'user', content: text, timestamp });
const score = (value, confidence = .95) => ({ type: 'score', score: value, confidence });
const choice = (value, labels, confidence = .95) => ({
  type: 'choice', choice: value, confidence,
  probabilities: Object.fromEntries(labels.map(label => [label, label === value ? confidence : (1 - confidence) / (labels.length - 1)])),
});
const labels = {
  objective: ['deliver', 'plan_only', 'research_only', 'review', 'question'],
  start: ['planning', 'execution', 'none'], clarity: ['low', 'medium', 'high'], risk: ['low', 'medium', 'high'],
  relation: ['same_task', 'new_task', 'uncertain'],
};
function workflowAnswers({ start = 'planning', clarity = 'low', risk = 'medium', relation, gear = 1.6, gearConfidence = .95 } = {}) {
  return {
    gear: score(gear, gearConfidence), objective: choice('deliver', labels.objective), start: choice(start, labels.start),
    clarity: choice(clarity, labels.clarity), risk: choice(risk, labels.risk),
    ...(relation ? { relation: choice(relation, labels.relation) } : {}),
  };
}
function harness() {
  const targets = Object.fromEntries(['light', 'standard', 'heavy'].map((gear) => [gear, { provider: 'test', model: gear, thinkingLevel: gear === 'light' ? 'low' : gear === 'standard' ? 'medium' : gear === 'heavy' ? 'high' : 'low' }]));
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({ gears: targets, workflow: { enabled: true } }));
  const entries = [];
  const handlers = new Map();
  let route;
  let tool;
  let activeTools = ['read'];
  const calls = [];
  extension({
    on(name, handler) { handlers.set(name, handler); return () => handlers.delete(name); },
    appendEntry(customType, data) { entries.push({ type: 'custom', id: `custom-${entries.length}`, customType, data }); },
    registerVirtualModel(definition) { route = definition.route; },
    registerTool(value) { tool = value; },
    getActiveTools: () => activeTools,
    setActiveTools: (names) => { activeTools = names; },
  });
  const ctx = {
    mode: 'tui', model: { provider: 'gears', id: 'auto' }, cwd: process.cwd(),
    ui: { theme: { fg: (_color, text) => text }, setStatus() {} },
    sessionManager: { getBranch: () => entries },
    modelRegistry: {
      find: (_provider, id) => model(id), hasConfiguredAuth: () => true, getModelOfType: () => ({ id: 'jev-latest' }),
      async classify(_model, input) { calls.push(input); return { stopReason: 'stop', answers: workflowAnswers(), usage: { input: 21 } }; },
    },
  };
  const run = (overrides = {}) => route({ reason: 'user', thinkingLevel: 'xhigh', messages: [user('Research and implement phase routing')], ...overrides }, ctx);
  return { calls, ctx, entries, handlers, run, targets, tool: () => tool, activeTools: () => activeTools }; 
}
function executionPacket() {
  return {
    kind: 'execution', goal: 'Wire phase routing', nonGoals: ['No cache transfer'],
    decisions: [{ decision: 'Use event', rationale: 'The tool runs after route state is persisted' }],
    steps: [{ id: 'route', scope: ['src/index.ts'], change: 'consume event', acceptance: ['npm test passes'] }],
    constraints: ['Retry remains sticky'], validation: ['npm test'], risks: ['wrong phase'], blockingUnknowns: [],
  };
}
function accepted(state, packet = executionPacket(), { handoffId = 'handoff-1', from = state.workflow.phase, to = 'execution', requestedBand = 1 } = {}) {
  return {
    version: 1, kind: 'accepted-handoff', workflowId: state.workflow.workflowId, sourceTurnId: state.turnId, handoffId,
    from, to, packet, packetDigest: workflowPacketDigest(packet), readinessConfidence: .95, requestedBand,
  };
}
function verificationPacket() {
  return { kind: 'verification', goal: 'Verify route', implementedSteps: ['Route wired'], validationPlan: ['npm test'], expectedEvidence: ['All tests pass'], knownLimitations: [], blockingUnknowns: [] };
}
function completionPacket() {
  return { kind: 'complete', goal: 'Complete route', acceptanceEvidence: ['All tests passed'], validationSummary: ['npm test passed'], remainingIssues: [] };
}

test('session tree status folds a later blocked event over the saved virtual state', () => {
  const h = harness();
  const saved = {
    gear: 'heavy', score: 1.6, adjustedScore: 1.6, confidence: .95,
    dispatch: { provider: 'test', model: 'heavy', thinkingLevel: 'high' }, fallback: false,
    workflow: { version: 1, workflowId: 'workflow:u1', objective: 'deliver', phase: 'planning', activeProfile: 'planning', initialTurnId: 'u1', activeTurnId: 'u1', transitionCount: 0, reminderCount: 0, consumedHandoffIds: [], policyFingerprint: 'a'.repeat(64), lastTransition: { to: 'planning', reason: 'initial', requestedBand: 3 } },
  };
  h.entries.push({ type: 'custom', id: 'state', customType: 'pi.virtual-model-state', data: { provider: 'gears', modelId: 'auto', state: saved } });
  h.entries.push({ type: 'custom', id: 'blocked', customType: WORKFLOW_EVENT_TYPE, data: { version: 1, kind: 'blocked', workflowId: 'workflow:u1', phase: 'planning', sourceTurnId: 'u1' } });
  let shown;
  h.ctx.ui.setStatus = (_key, text) => { shown = text; };
  h.handlers.get('session_tree')({}, h.ctx);
  assert.match(shown, /工作流 blocked · 已阻塞/u);
});

test('workflow handoff tool is active only for an explicit opt-in run', () => {
  const h = harness();
  h.handlers.get('before_agent_start')({}, h.ctx);
  assert.deepEqual(h.activeTools(), ['read', 'gear_workflow_handoff']);
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({ gears: h.targets, workflow: { enabled: false } }));
  h.handlers.get('before_agent_start')({}, h.ctx);
  assert.deepEqual(h.activeTools(), ['read']);
});

test('workflow non-start diagnostics persist and explain the TUI status without changing dispatch', async () => {
  const cases = [
    { name: 'confidence', answers: { ...workflowAnswers({ gear: 1.04 }), risk: choice('low', labels.risk, .69) }, reason: 'low-confidence', shown: /工作流未启动：置信度不足（0\.69<0\.80）/u, model: 'standard' },
    { name: 'review', answers: { ...workflowAnswers(), objective: choice('review', labels.objective) }, reason: 'review', shown: /工作流不适用：审查请求/u, model: 'heavy' },
    { name: 'question', answers: { ...workflowAnswers(), objective: choice('question', labels.objective) }, reason: 'question', shown: /工作流不适用：问答请求/u, model: 'heavy' },
    { name: 'none', answers: workflowAnswers({ start: 'none' }), reason: 'no-phase', shown: /工作流不适用：无需阶段编排/u, model: 'heavy' },
    { name: 'unsafe execution', answers: workflowAnswers({ start: 'execution', risk: 'high' }), reason: 'execution-not-ready', shown: /工作流未启动：直接执行条件不足/u, model: 'heavy' },
    { name: 'partial', answers: { gear: score(1.6) }, reason: 'invalid-classification', shown: /工作流未启动：分类不完整/u, model: 'heavy' },
    { name: 'unavailable', stopReason: 'error', answers: {}, reason: 'classifier-unavailable', shown: /工作流未启动：分类不可用/u, model: 'standard' },
  ];
  for (const item of cases) {
    const h = harness();
    h.entries.push({ type: 'message', id: 'u1', message: user('Research and implement phase routing') });
    let shown;
    h.ctx.ui.setStatus = (_key, text) => { shown = text; };
    h.ctx.modelRegistry.classify = async () => ({ stopReason: item.stopReason ?? 'stop', answers: item.answers, usage: { input: 21 } });
    const result = await h.run();
    assert.equal(result.state.workflow, undefined, item.name);
    assert.equal(result.state.workflowDiagnostic.reason, item.reason, item.name);
    assert.equal(result.model.id, item.model, item.name);
    assert.match(shown, item.shown, item.name);
    h.entries.push({ type: 'custom', customType: 'pi.virtual-model-state', data: { provider: 'gears', modelId: 'auto', state: JSON.parse(JSON.stringify(result.state)) } });
    h.handlers.get('session_tree')({}, h.ctx);
    assert.match(shown, item.shown, `${item.name} restores from persisted state`);
    const continuation = await h.run({ reason: 'continuation', state: result.state, previous: { model: result.model, thinkingLevel: result.thinkingLevel } });
    assert.equal(continuation.state, undefined, 'diagnostics do not break physical stickiness');
    assert.match(shown, item.shown);
  }
});

test('legacy status distinguishes an enabled but unassessed workflow without inventing a verdict', async () => {
  const h = harness();
  let shown;
  h.ctx.ui.setStatus = (_key, text) => { shown = text; };
  h.entries.push({ type: 'custom', customType: 'pi.virtual-model-state', data: { provider: 'gears', modelId: 'auto', state: {
    gear: 'standard', score: 1.04, adjustedScore: 1.04, confidence: .9, dispatch: { provider: 'test', model: 'standard', thinkingLevel: 'high' },
  } } });
  h.handlers.get('session_start')({}, h.ctx);
  assert.match(shown, /工作流待评估：新请求生效/u);
  assert.doesNotMatch(shown, /置信度不足/u);
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({ gears: h.targets, workflow: { enabled: false } }));
  h.handlers.get('session_tree')({}, h.ctx);
  assert.equal(shown, 'Jev 1.04 → standard/high → test/standard');
});

test('diagnostic rendering rejects malformed persisted data and hides stale phases while disabled', async () => {
  const h = harness();
  const result = await h.run();
  let shown;
  h.ctx.ui.setStatus = (_key, text) => { shown = text; };
  const entry = { type: 'custom', customType: 'pi.virtual-model-state', data: { provider: 'gears', modelId: 'auto', state: {
    ...result.state, workflow: undefined, workflowDiagnostic: { version: 1, reason: '__proto__', confidence: NaN },
  } } };
  h.entries.push(entry);
  h.handlers.get('session_tree')({}, h.ctx);
  assert.match(shown, /工作流待评估：新请求生效/u);
  assert.doesNotMatch(shown, /__proto__|NaN|undefined/u);
  entry.data.state.workflowDiagnostic = { version: 1, reason: 'low-confidence', confidence: 'untrusted-content', minConfidence: .8 };
  h.handlers.get('session_tree')({}, h.ctx);
  assert.match(shown, /工作流未启动：置信度不足/u);
  assert.doesNotMatch(shown, /untrusted-content/u);
  entry.data.state = result.state;
  h.handlers.get('session_tree')({}, h.ctx);
  assert.match(shown, /工作流 planning/u);
  assert.doesNotMatch(shown, /工作流未启动|工作流待评估/u);
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({ gears: h.targets, workflow: { enabled: false } }));
  h.handlers.get('session_tree')({}, h.ctx);
  assert.doesNotMatch(shown, /工作流/u);
});

test('a low capability-score confidence does not veto a high-confidence workflow intent', async () => {
  const h = harness();
  h.entries.push({ type: 'message', id: 'u1', message: user('Research and implement phase routing') });
  h.ctx.modelRegistry.classify = async (_model, input) => {
    h.calls.push(input);
    return { stopReason: 'stop', answers: workflowAnswers({ gear: .4, gearConfidence: .22 }), usage: { input: 21 } };
  };
  const result = await h.run();
  assert.equal(result.state.workflow.phase, 'planning');
  assert.equal(result.model.id, 'heavy');
});

test('opt-in workflow starts planning, consumes only an accepted continuation, then stays sticky', async () => {
  const h = harness();
  h.entries.push({ type: 'message', id: 'u1', message: user('Research and implement phase routing') });
  const first = await h.run();
  assert.equal(first.model.id, 'heavy');
  assert.equal(first.thinkingLevel, 'high');
  assert.equal(first.state.workflow.phase, 'planning');
  assert.equal(first.state.workflow.activeTurnId, first.state.turnId);
  assert.equal(h.calls.length, 1);

  h.entries.push({ type: 'custom', id: 'accepted', customType: WORKFLOW_EVENT_TYPE, data: accepted(first.state) });
  const execution = await h.run({ reason: 'continuation', state: first.state, previous: { model: first.model, thinkingLevel: first.thinkingLevel } });
  assert.equal(execution.model.id, 'standard');
  assert.equal(execution.thinkingLevel, 'medium');
  assert.equal(execution.state.workflow.phase, 'execution');
  assert.equal(execution.state.workflow.activePacket.packet.kind, 'execution');
  assert.equal(execution.state.workflow.consumedHandoffIds[0], 'handoff-1');
  assert.equal(h.calls.length, 1, 'handoff consumption must not make another classifier request');

  const sticky = await h.run({ reason: 'continuation', state: execution.state, previous: { model: execution.model, thinkingLevel: execution.thinkingLevel } });
  assert.equal(sticky.model.id, 'standard');
  assert.equal(sticky.thinkingLevel, 'medium');
  assert.equal(h.calls.length, 1);
});

test('unavailable execution target falls back physically without lowering workflow phase or requested band', async () => {
  const h = harness();
  h.entries.push({ type: 'message', id: 'u1', message: user('Research and implement phase routing') });
  const planning = await h.run();
  h.entries.push({ type: 'custom', id: 'accepted', customType: WORKFLOW_EVENT_TYPE, data: accepted(planning.state, executionPacket(), { requestedBand: 1 }) });
  h.ctx.modelRegistry.find = (_provider, id) => id === 'standard' ? undefined : model(id);
  const execution = await h.run({ reason: 'continuation', state: planning.state, previous: { model: planning.model, thinkingLevel: planning.thinkingLevel } });
  assert.equal(execution.model.id, 'light', 'existing resolver falls back standard → light → heavy');
  assert.equal(execution.state.fallback, true);
  assert.equal(execution.state.workflow.phase, 'execution');
  assert.equal(execution.state.workflow.lastTransition.requestedBand, 1);
});

test('accepted verification and completion handoffs persist phase and terminal state', async () => {
  const h = harness();
  h.entries.push({ type: 'message', id: 'u1', message: user('Research and implement phase routing') });
  const planning = await h.run();
  h.entries.push({ type: 'custom', id: 'execution', customType: WORKFLOW_EVENT_TYPE, data: accepted(planning.state) });
  const execution = await h.run({ reason: 'continuation', state: planning.state, previous: { model: planning.model, thinkingLevel: planning.thinkingLevel } });
  h.entries.push({ type: 'custom', id: 'verification', customType: WORKFLOW_EVENT_TYPE, data: accepted(execution.state, verificationPacket(), { handoffId: 'handoff-2', to: 'verification' }) });
  const verification = await h.run({ reason: 'continuation', state: execution.state, previous: { model: execution.model, thinkingLevel: execution.thinkingLevel } });
  assert.equal(verification.state.workflow.phase, 'verification');
  assert.equal(verification.state.workflow.activePacket.packet.kind, 'verification');
  h.entries.push({ type: 'custom', id: 'passed', customType: WORKFLOW_EVENT_TYPE, data: { version: 1, kind: 'validation', workflowId: verification.state.workflow.workflowId, sourceTurnId: verification.state.turnId, outcome: 'passed', commandKind: 'npm' } });
  h.entries.push({ type: 'custom', id: 'complete', customType: WORKFLOW_EVENT_TYPE, data: accepted(verification.state, completionPacket(), { handoffId: 'handoff-3', to: 'complete', requestedBand: 1 }) });
  const complete = await h.run({ reason: 'continuation', state: verification.state, previous: { model: verification.model, thinkingLevel: verification.thinkingLevel } });
  assert.equal(complete.state.workflow.phase, 'complete');
  assert.equal(complete.state.workflow.activeProfile, undefined);
  assert.equal(complete.state.workflow.activePacket, undefined);
  assert.equal(complete.state.workflow.lastTransition.reason, 'accepted-handoff');
});

test('a new planning request supersedes an execution packet and invalidates its old handoff turn', async () => {
  const h = harness();
  h.entries.push({ type: 'message', id: 'u1', message: user('Research and implement phase routing', 1) });
  const planning = await h.run();
  h.entries.push({ type: 'custom', id: 'execution', customType: WORKFLOW_EVENT_TYPE, data: accepted(planning.state) });
  const execution = await h.run({ reason: 'continuation', state: planning.state, previous: { model: planning.model, thinkingLevel: planning.thinkingLevel } });
  h.entries.push({ type: 'message', id: 'u2', message: user('Stop implementation and make a new plan for the architecture', 2) });
  h.ctx.modelRegistry.classify = async (_model, input) => {
    h.calls.push(input);
    return { stopReason: 'stop', answers: workflowAnswers({ start: 'planning', relation: 'same_task' }), usage: { input: 13 } };
  };
  const replanned = await h.run({ state: execution.state, messages: [user('Research and implement phase routing', 1), user('Stop implementation and make a new plan for the architecture', 2)] });
  assert.equal(replanned.state.workflow.phase, 'planning');
  assert.notEqual(replanned.state.workflow.workflowId, execution.state.workflow.workflowId);
  assert.equal(replanned.state.workflow.lastTransition.reason, 'user-superseded');
  assert.equal(replanned.state.workflow.activeTurnId, replanned.state.turnId);
});

test('a manual model change after a handoff prevents gears/auto from consuming it later', async () => {
  const h = harness();
  h.entries.push({ type: 'message', id: 'u1', message: user('Research and implement phase routing') });
  const planning = await h.run();
  h.entries.push({ type: 'custom', id: 'accepted', customType: WORKFLOW_EVENT_TYPE, data: accepted(planning.state) });
  h.entries.push({ type: 'model_change', id: 'manual', provider: 'test', modelId: 'manual' });
  const result = await h.run({ reason: 'continuation', state: planning.state, previous: { model: planning.model, thinkingLevel: planning.thinkingLevel } });
  assert.equal(result.model.id, 'heavy');
  assert.equal(result.state, undefined, 'the unconsumed handoff has no authority after a manual model gap');
});

test('retry never consumes an accepted handoff; stale and malformed events have no authority', async () => {
  const h = harness();
  h.entries.push({ type: 'message', id: 'u1', message: user('Research and implement phase routing') });
  const first = await h.run();
  const good = accepted(first.state);
  h.entries.push({ type: 'custom', id: 'stale', customType: WORKFLOW_EVENT_TYPE, data: { ...good, sourceTurnId: 'other' } });
  h.entries.push({ type: 'custom', id: 'bad', customType: WORKFLOW_EVENT_TYPE, data: { ...good, handoffId: 'bad', packetDigest: '0'.repeat(64) } });
  h.entries.push({ type: 'custom', id: 'good', customType: WORKFLOW_EVENT_TYPE, data: good });
  const retry = await h.run({ reason: 'retry', state: first.state, failed: { model: first.model, thinkingLevel: first.thinkingLevel } });
  assert.equal(retry.model.id, 'heavy');
  assert.equal(retry.state, undefined, 'retry retains the failed physical route and does not consume workflow state');
  const transitioned = await h.run({ reason: 'continuation', state: first.state, previous: { model: first.model, thinkingLevel: first.thinkingLevel } });
  assert.equal(transitioned.model.id, 'standard');
  assert.deepEqual(transitioned.state.workflow.consumedHandoffIds, ['handoff-1']);
});

test('non-text user input never starts a v1 workflow even with an otherwise valid verdict', async () => {
  const h = harness();
  const request = { role: 'user', content: [{ type: 'text', text: 'Implement the visible change' }, { type: 'image', data: 'opaque-fixture' }], timestamp: 1 };
  h.entries.push({ type: 'message', id: 'u1', message: request });
  h.ctx.modelRegistry.classify = async (_model, input) => {
    h.calls.push(input);
    return { stopReason: 'stop', answers: workflowAnswers({ start: 'planning', clarity: 'low', risk: 'medium', gear: 1.6 }), usage: { input: 8 } };
  };
  const result = await h.run({ messages: [request] });
  assert.equal(result.state.workflow, undefined);
  assert.equal(result.state.workflowDiagnostic.reason, 'non-text-input');
  assert.equal(result.model.id, 'heavy', 'the valid gear verdict still feeds the existing task-aware fallback');
});

test('clear low-risk delivery may start execution directly; incomplete workflow answers fall back safely', async () => {
  const h = harness();
  h.entries.push({ type: 'message', id: 'u1', message: user('Implement the one-line explicit change') });
  h.ctx.modelRegistry.classify = async (_model, input) => {
    h.calls.push(input);
    return { stopReason: 'stop', answers: workflowAnswers({ start: 'execution', clarity: 'high', risk: 'low', gear: .1 }), usage: { input: 8 } };
  };
  const direct = await h.run({ messages: [user('Implement the one-line explicit change')] });
  assert.equal(direct.model.id, 'standard', 'direct execution has no accepted packet and therefore cannot use atomic/light');
  assert.equal(direct.state.workflow.phase, 'execution');
  assert.equal(direct.state.workflow.activeProfile, 'execution');

  const fallback = harness();
  fallback.entries.push({ type: 'message', id: 'u2', message: user('Implement something') });
  fallback.ctx.modelRegistry.classify = async (_model, input) => {
    fallback.calls.push(input);
    return { stopReason: 'stop', answers: { gear: score(1.6) }, usage: { input: 8 } };
  };
  const result = await fallback.run({ messages: [user('Implement something', 2)] });
  assert.equal(result.state.workflow, undefined);
  assert.equal(result.model.id, 'heavy', 'existing task fallback still uses the valid gear score');
});
