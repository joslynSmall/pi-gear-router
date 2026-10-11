import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'pi-gear-observation-test-'));
process.env.PI_GEAR_ROUTER_DATA_DIR = dir;
writeFileSync(join(dir, 'settings.json'), JSON.stringify({ routingMode: 'legacy-workflow' }));
after(() => rmSync(dir, { recursive: true, force: true }));
const { isVerificationCommand, verificationCommandKind, registerObservations, branchFacts, OBSERVATION_TYPE } = await import('../src/observation.ts');
import { newWorkflowState, WORKFLOW_EVENT_TYPE } from '../src/workflow-routing.ts';
test('verification recognizer excludes ambiguous shell chains and arbitrary commands', () => {
  for (const command of ['npm test', 'npm run typecheck && npm test', 'pnpm test --run', 'npx tsc --noEmit']) assert.equal(isVerificationCommand(command), true, command);
  assert.equal(verificationCommandKind('npm run typecheck && npm test'), 'npm');
  assert.equal(verificationCommandKind('echo test'), undefined);
  for (const command of ['echo test', 'npm test && git status', 'cd foo && npm test', 'npm test; echo ok', 'npm test | tee log', 'npm test\n', 'npm test || true', 'npm test $(echo x)']) assert.equal(isVerificationCommand(command), false, command);
});
test('nested failed verification persists only a bounded branch marker once per user turn', () => {
  const entries = [{ type: 'custom', id: 's1', customType: 'pi.virtual-model-state', data: { provider: 'gears', modelId: 'auto', state: { turnId: 'u1', task: { taskId: 't1' } } } }];
  let handler;
  registerObservations({ on: (_name, fn) => { handler = fn; }, appendEntry: (type, data) => entries.push({ type: 'custom', id: 'm1', customType: type, data }) });
  const ctx = { model: { provider: 'gears', id: 'auto' }, sessionManager: { getBranch: () => entries } };
  const event = { toolName: 'bash', toolCallId: 'parent/1', parentToolCallId: 'parent', input: { command: 'npm test' }, structuredContent: { exit_code: 1, output: 'secret output' }, isError: true };
  handler(event, ctx); handler({ ...event, toolCallId: 'parent/2' }, ctx);
  assert.equal(entries.filter(e => e.customType === OBSERVATION_TYPE).length, 1);
  assert.deepEqual(entries.at(-1).data, { version: 1, taskId: 't1', turnId: 'u1', kind: 'verification-failed' });
  const facts = branchFacts(ctx, { taskId: 't1', observationCursor: 's1' }, [], true);
  assert.equal(facts.verificationFailed, true);
});

test('workflow validation facts are branch-scoped, deduplicated, and never retain command text/output', () => {
  const workflow = newWorkflowState({ workflowId: 'workflow:u1', initialTurnId: 'u1', objective: 'deliver', phase: 'execution', policyFingerprint: 'a'.repeat(64), requestedBand: 1 });
  const entries = [{ type: 'custom', id: 's1', customType: 'pi.virtual-model-state', data: { provider: 'gears', modelId: 'auto', state: { turnId: 'u1', workflow, task: { taskId: 't1' } } } }];
  let handler;
  registerObservations({ on: (_name, fn) => { handler = fn; }, appendEntry: (type, data) => entries.push({ type: 'custom', id: `e-${entries.length}`, customType: type, data }) });
  const ctx = { model: { provider: 'gears', id: 'auto' }, sessionManager: { getBranch: () => entries } };
  const passed = { toolName: 'bash', input: { command: 'npm test' }, structuredContent: { exit_code: 0, output: 'sensitive test output' }, isError: false };
  handler(passed, ctx); handler(passed, ctx);
  const failed = { ...passed, structuredContent: { exit_code: 1, output: 'more sensitive output' }, isError: true };
  handler(failed, ctx); handler(failed, ctx);
  // A repair and rerun may legitimately reverse a previous failure; only consecutive identical outcomes deduplicate.
  handler(passed, ctx);
  const facts = entries.filter(entry => entry.customType === WORKFLOW_EVENT_TYPE).map(entry => entry.data);
  assert.deepEqual(facts, [
    { version: 1, kind: 'validation', workflowId: 'workflow:u1', sourceTurnId: 'u1', outcome: 'passed', commandKind: 'npm' },
    { version: 1, kind: 'validation', workflowId: 'workflow:u1', sourceTurnId: 'u1', outcome: 'failed', commandKind: 'npm' },
    { version: 1, kind: 'validation', workflowId: 'workflow:u1', sourceTurnId: 'u1', outcome: 'passed', commandKind: 'npm' },
  ]);
  assert.equal(JSON.stringify(facts).includes('sensitive'), false);
  assert.equal(entries.filter(entry => entry.customType === OBSERVATION_TYPE).length, 1, 'existing failure marker remains available to task routing');
});

test('unknown or inconsistent exit metadata does not fabricate failed verification', () => {
  const entries = [{ type: 'custom', id: 's1', customType: 'pi.virtual-model-state', data: { provider: 'gears', modelId: 'auto', state: { turnId: 'u1', task: { taskId: 't1' } } } }];
  let handler;
  registerObservations({ on: (_name, fn) => { handler = fn; }, appendEntry: () => assert.fail('No marker expected') });
  const ctx = { model: { provider: 'gears', id: 'auto' }, sessionManager: { getBranch: () => entries } };
  for (const event of [
    { structuredContent: { exit_code: 0 }, isError: true },
    { structuredContent: { exit_code: 1 }, isError: false },
    { structuredContent: {}, isError: true },
    { structuredContent: { exit_code: '1' }, isError: true },
    { structuredContent: { exit_code: 1 }, isError: true, toolName: 'codemode' },
    { structuredContent: { exit_code: 1 }, isError: true, input: { command: 'npm test && git status' } },
  ]) handler({ toolName: 'bash', input: { command: 'npm test' }, ...event }, ctx);
});

test('append failure is nonblocking and makes subsequent coverage unknown', () => {
  let handler;
  const entries = [{ type: 'custom', id: 's1', customType: 'pi.virtual-model-state', data: { provider: 'gears', modelId: 'auto', state: { turnId: 'u1', task: { taskId: 't1' } } } }];
  registerObservations({ on: (_name, fn) => { handler = fn; }, appendEntry: () => { throw new Error('storage unavailable'); } });
  const ctx = { model: { provider: 'gears', id: 'auto' }, sessionManager: { getBranch: () => entries } };
  handler({ toolName: 'bash', input: { command: 'npm test' }, structuredContent: { exit_code: 1 }, isError: true }, ctx);
  assert.equal(branchFacts(ctx, { taskId: 't1', observationCursor: 's1' }, [], true).coverage, 'unknown');
});

test('a new public assistant message omitted from routed context creates an observation gap', () => {
  const assistant = { role: 'assistant', content: [{ type: 'text', text: 'New plan and remaining work' }], timestamp: 2 };
  const current = { role: 'user', content: '继续', timestamp: 3 };
  const ctx = { sessionManager: { getBranch: () => [{ type: 'custom', id: 's1' }, { type: 'message', id: 'a1', message: assistant }, { type: 'message', id: 'u2', message: current }] } };
  assert.equal(branchFacts(ctx, { taskId: 't1', observationCursor: 's1' }, [current], true).contextMissing, true);
});

test('completion hints are consumed by cursor, not treated as proof, and manual model gaps rejudge', () => {
  const assistant = { role: 'assistant', content: [{ type: 'text', text: '任务已完成。' }], timestamp: 2 };
  const current = { role: 'user', content: '继续', timestamp: 3 };
  const entries = [{ type: 'custom', id: 's1' }, { type: 'message', id: 'a1', message: assistant }, { type: 'model_change', id: 'm1', provider: 'other', modelId: 'manual' }, { type: 'message', id: 'u2', message: current }];
  const ctx = { sessionManager: { getBranch: () => entries } };
  const facts = branchFacts(ctx, { taskId: 't1', observationCursor: 's1' }, [assistant, current], true);
  assert.equal(facts.completionHint, true); assert.equal(facts.manualModelGap, true);
  assert.equal(branchFacts(ctx, { taskId: 't1', observationCursor: 'u2' }, [assistant, current], true).completionHint, false);
  for (const text of ['尚未完成', '```\n已完成\n```', 'The task is not done']) {
    assert.equal(branchFacts(ctx, { taskId: 't1', observationCursor: 's1' }, [{ ...assistant, content: [{ type: 'text', text }] }, current], true).completionHint, false);
  }
  assert.equal(branchFacts(ctx, { taskId: 't1', observationCursor: 'not-on-branch' }, [assistant, current], true).contextMissing, true);
});
