import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaultSettings } from '../src/gears.ts';
import { registerWorkflowGuard } from '../src/workflow-guard.ts';
import { newWorkflowState, WORKFLOW_EVENT_TYPE } from '../src/workflow-routing.ts';

function setup({ phase = 'planning', reminder = false, getAllTools = () => [] } = {}) {
  const config = defaultSettings(); config.workflow.enabled = true;
  const state = newWorkflowState({ workflowId: 'workflow:u1', initialTurnId: 'u1', objective: 'deliver', phase, policyFingerprint: 'a'.repeat(64), requestedBand: phase === 'planning' ? 3 : 1 });
  const entries = [{ type: 'custom', id: 'state', customType: 'pi.virtual-model-state', data: { provider: 'gears', modelId: 'auto', state: { turnId: 'u1', workflow: state } } }];
  if (reminder) entries.push({ type: 'custom', id: 'reminder', customType: WORKFLOW_EVENT_TYPE, data: { version: 1, kind: 'reminder', workflowId: state.workflowId, phase: 'planning', sourceTurnId: 'u1' } });
  const handlers = new Map();
  const pi = { on(name, handler) { handlers.set(name, handler); return () => {}; }, getAllTools };
  registerWorkflowGuard(pi, () => config);
  const ctx = {
    cwd: process.cwd(), model: { provider: 'gears', id: 'auto' }, hasPendingMessages: () => false,
    sessionManager: { getBranch: () => entries },
  };
  return { config, ctx, entries, handlers, state };
}

test('guard injects after the leading system message and only for active gears workflow', () => {
  const h = setup();
  const handler = h.handlers.get('context_with_system');
  const messages = [{ role: 'system', content: 'base system', timestamp: 0 }, { role: 'user', content: 'task', timestamp: 1 }];
  const result = handler({ messages }, h.ctx);
  assert.equal(result.messages.length, 3);
  assert.equal(result.messages[0].content, 'base system');
  assert.match(result.messages[1].content, /Phase: planning/u);
  assert.equal(result.messages[2].role, 'user');
  assert.equal(handler({ messages: [{ role: 'user', content: 'task', timestamp: 1 }] }, h.ctx), undefined);
  assert.equal(handler({ messages }, { ...h.ctx, model: { provider: 'test', id: 'manual' } }), undefined);
});

test('workflow phases leave all tool permissions to the host', () => {
  for (const phase of ['planning', 'recovery', 'execution', 'verification']) {
    const h = setup({ phase, getAllTools: () => { throw new Error('router must not inspect tool permissions'); } });
    assert.equal(h.handlers.has('tool_call'), false, phase);
  }
});

test('settle handler appends one hidden reminder, then a blocked event without continuation', () => {
  const first = setup();
  const settle = first.handlers.get('agent_before_settle');
  const event = { outcome: 'completed', context: { canContinue: true } };
  const reminder = settle(event, first.ctx);
  assert.equal(reminder.continue, true);
  assert.equal(reminder.entries[0].data.kind, 'reminder');
  assert.equal(reminder.entries[1].type, 'custom_message');
  assert.equal(reminder.entries[1].display, false);
  assert.doesNotMatch(reminder.entries[1].content, /read-only|Do not modify files/u);
  assert.match(reminder.entries[1].content, /Pi.*permissions/u);
  const second = setup({ reminder: true });
  const blocked = second.handlers.get('agent_before_settle')(event, second.ctx);
  assert.equal(blocked.continue, undefined);
  assert.equal(blocked.entries[0].data.kind, 'blocked');
  assert.equal(settle({ ...event, outcome: 'error' }, first.ctx), undefined);
  assert.equal(settle(event, { ...first.ctx, hasPendingMessages: () => true }), undefined);
});
