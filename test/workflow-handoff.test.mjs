import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaultSettings } from '../src/gears.ts';
import { registerWorkflowHandoff } from '../src/workflow-handoff.ts';
import { newWorkflowState, WORKFLOW_EVENT_TYPE } from '../src/workflow-routing.ts';

const packet = () => ({
  kind: 'execution', goal: 'Implement workflow route', nonGoals: ['No KV transfer'],
  decisions: [{ decision: 'Use custom event', rationale: 'Route state precedes tools' }],
  steps: [{ id: 'route', scope: ['src/index.ts'], change: 'Consume accepted event', acceptance: ['npm test'] }],
  constraints: ['Keep retry sticky'], validation: ['npm test'], risks: ['Bad model switch'], blockingUnknowns: [],
});
const choice = (value, labels, confidence = .95) => ({ type: 'choice', choice: value, confidence, probabilities: Object.fromEntries(labels.map(label => [label, label === value ? confidence : (1 - confidence) / (labels.length - 1)])) });
const readiness = () => ({
  delivery: choice('deliver', ['deliver', 'not_deliver']), readiness: choice('ready', ['ready', 'needs_convergence', 'blocked']),
  risk: choice('medium', ['low', 'medium', 'high']), capability: { type: 'score', score: .9, confidence: .95 },
});
function setup({ workflow = true, model = { provider: 'gears', id: 'auto' }, answers = readiness() } = {}) {
  const config = defaultSettings(); config.workflow.enabled = workflow;
  const state = newWorkflowState({ workflowId: 'workflow:u1', initialTurnId: 'u1', objective: 'deliver', phase: 'planning', policyFingerprint: 'a'.repeat(64), requestedBand: 3 });
  const entries = [{ type: 'custom', id: 'state', customType: 'pi.virtual-model-state', data: { provider: 'gears', modelId: 'auto', state: { turnId: 'u1', workflow: state } } }];
  let tool;
  const pi = {
    registerTool(value) { tool = value; },
    appendEntry(type, data) { entries.push({ type: 'custom', id: `event-${entries.length}`, customType: type, data }); },
  };
  registerWorkflowHandoff(pi, () => config);
  const statuses = [];
  const ctx = {
    mode: 'tui', model, cwd: process.cwd(), sessionManager: { getBranch: () => entries },
    ui: { theme: { fg: (_color, text) => text }, setStatus: (_key, text) => statuses.push(text) },
    modelRegistry: { getModelOfType: () => ({}), async classify() { return { stopReason: 'stop', answers, usage: { input: 13 } }; } },
  };
  return { config, ctx, entries, state, tool: () => tool, statuses }; 
}

test('handoff tool accepts a locally valid, independently ready execution packet and writes one event', async () => {
  const h = setup();
  const result = await h.tool().execute('call-1', { packet: packet() }, undefined, undefined, h.ctx);
  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.accepted, true);
  assert.equal(result.structuredContent.targetPhase, 'execution');
  assert.equal(result.structuredContent.requestedBand, 1);
  assert.deepEqual(result.structuredContent.packet, packet());
  assert.deepEqual(result.usage, { input: 13 });
  const event = h.entries.at(-1);
  assert.equal(event.customType, WORKFLOW_EVENT_TYPE);
  assert.equal(event.data.kind, 'accepted-handoff');
  assert.equal(event.data.sourceTurnId, 'u1');
  assert.equal(event.data.from, 'planning');
  assert.equal(event.data.to, 'execution');
  assert.deepEqual(h.statuses, ['工作流 planning · handoff 提交中', '工作流 planning · 已接受 → execution']);
});

test('handoff accepts at most one source phase/turn before its continuation', async () => {
  const h = setup();
  const first = await h.tool().execute('call-1', { packet: packet() }, undefined, undefined, h.ctx);
  assert.equal(first.structuredContent.accepted, true);
  const duplicate = await h.tool().execute('call-2', { packet: packet() }, undefined, undefined, h.ctx);
  assert.equal(duplicate.isError, true);
  assert.equal(duplicate.structuredContent.reason, 'handoff-already-accepted');
  assert.equal(h.entries.filter(entry => entry.customType === WORKFLOW_EVENT_TYPE && entry.data.kind === 'accepted-handoff').length, 1);
});

test('handoff rejects invalid packets, blockers, wrong model and low readiness without acceptance', async () => {
  for (const variant of [
    { params: { packet: { ...packet(), blockingUnknowns: ['Need API contract'] } } },
    { params: { packet: { ...packet(), steps: [] } } },
    { model: { provider: 'test', id: 'manual' }, params: { packet: packet() } },
    { answers: { ...readiness(), readiness: choice('needs_convergence', ['ready', 'needs_convergence', 'blocked']) }, params: { packet: packet() }, rejected: true },
    { answers: { ...readiness(), delivery: choice('not_deliver', ['deliver', 'not_deliver']) }, params: { packet: packet() }, rejected: true },
  ]) {
    const h = setup(variant);
    const result = await h.tool().execute('call-1', variant.params, undefined, undefined, h.ctx);
    assert.equal(result.isError, true);
    const workflowEvents = h.entries.filter(entry => entry.customType === WORKFLOW_EVENT_TYPE);
    assert.equal(workflowEvents.some(entry => entry.data.kind === 'accepted-handoff'), false);
    assert.equal(workflowEvents.some(entry => entry.data.kind === 'handoff-rejected'), !!variant.rejected);
  }
});

test('handoff never accepts unavailable, aborted or stale workflow state', async () => {
  const unavailable = setup();
  unavailable.ctx.modelRegistry.classify = async () => ({ stopReason: 'error', answers: {} });
  let result = await unavailable.tool().execute('call-1', { packet: packet() }, undefined, undefined, unavailable.ctx);
  assert.equal(result.isError, true);
  assert.equal(unavailable.entries.filter(entry => entry.customType === WORKFLOW_EVENT_TYPE).length, 0);
  assert.deepEqual(unavailable.statuses, ['工作流 planning · handoff 提交中', '工作流 planning · handoff 未验证']);

  const aborted = setup();
  const controller = new AbortController(); controller.abort();
  await assert.rejects(aborted.tool().execute('call-1', { packet: packet() }, controller.signal, undefined, aborted.ctx), { name: 'AbortError' });
  assert.equal(aborted.entries.filter(entry => entry.customType === WORKFLOW_EVENT_TYPE).length, 0);

  const stale = setup();
  stale.entries[0].data.state.workflow.activeTurnId = 'newer-turn';
  result = await stale.tool().execute('call-1', { packet: packet() }, undefined, undefined, stale.ctx);
  assert.equal(result.isError, true);
  assert.equal(stale.entries.filter(entry => entry.customType === WORKFLOW_EVENT_TYPE).length, 0);
});
