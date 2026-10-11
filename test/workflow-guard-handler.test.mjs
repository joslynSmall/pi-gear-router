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

test('tool guard is fail-closed in planning but does not constrain execution', () => {
  const planning = setup({ getAllTools: () => [{ name: 'safe', annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } }] });
  const guard = planning.handlers.get('tool_call');
  assert.equal(guard({ toolName: 'edit', input: {} }, planning.ctx).block, true);
  assert.equal(guard({ toolName: 'bash', input: { command: 'npm test' } }, planning.ctx).block, true);
  assert.equal(guard({ toolName: 'bash', input: { command: 'git status --short' } }, planning.ctx), undefined);
  assert.equal(guard({ toolName: 'read', input: {} }, planning.ctx), undefined);
  assert.equal(guard({ toolName: 'find', input: {} }, planning.ctx).block, true, 'a same-named custom tool still needs explicit read-only metadata');
  assert.equal(guard({ toolName: 'safe', input: {} }, planning.ctx), undefined);
  assert.equal(guard({ toolName: 'unknown', input: {} }, planning.ctx).block, true);
  const broken = setup({ getAllTools: () => { throw new Error('registry unavailable'); } });
  assert.equal(broken.handlers.get('tool_call')({ toolName: 'custom', input: {} }, broken.ctx).block, true);
  const execution = setup({ phase: 'execution' });
  assert.equal(execution.handlers.get('tool_call')({ toolName: 'edit', input: {} }, execution.ctx), undefined);
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
  const second = setup({ reminder: true });
  const blocked = second.handlers.get('agent_before_settle')(event, second.ctx);
  assert.equal(blocked.continue, undefined);
  assert.equal(blocked.entries[0].data.kind, 'blocked');
  assert.equal(settle({ ...event, outcome: 'error' }, first.ctx), undefined);
  assert.equal(settle(event, { ...first.ctx, hasPendingMessages: () => true }), undefined);
});
