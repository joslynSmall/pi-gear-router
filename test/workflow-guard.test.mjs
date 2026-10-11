import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaultSettings } from '../src/gears.ts';
import { newWorkflowState, workflowPacketDigest } from '../src/workflow-routing.ts';
import { isReadOnlyShell, shouldRemind, workflowInstruction } from '../src/workflow-guard.ts';

const settings = () => ({ ...defaultSettings(), workflow: { ...defaultSettings().workflow, enabled: true } });
const state = (overrides = {}) => newWorkflowState({
  workflowId: 'workflow:u1', initialTurnId: 'u1', objective: 'deliver', phase: 'planning',
  policyFingerprint: 'a'.repeat(64), requestedBand: 3, ...overrides,
});

test('read-only shell grammar accepts only a narrow independently read-only subset', () => {
  for (const command of ['pwd', 'pwd -P', 'ls', 'ls -lah src', 'find src test', 'rg -n workflow src', 'grep -R workflow src', 'git status --short', 'git diff --stat', 'git log --oneline', 'git show --stat']) {
    assert.equal(isReadOnlyShell(command), true, command);
  }
  for (const command of ['find . -exec rm {} \\;', 'find . -delete', 'ls; rm -rf .', 'rg x src | tee out', 'git reset --hard', 'git diff --output=x', 'npm test', 'echo $(pwd)', 'grep x src > out', 'ls --color=always']) {
    assert.equal(isReadOnlyShell(command), false, command);
  }
});

test('phase instruction is stable, phase-specific, and packet-bound', () => {
  const planning = state();
  assert.match(workflowInstruction(planning), /planning.*read-only/su);
  const packet = {
    kind: 'execution', goal: 'Implement it', nonGoals: ['No schema change'], decisions: [{ decision: 'Use event', rationale: 'Replayable' }],
    steps: [{ id: '1', scope: ['src/index.ts'], change: 'route', acceptance: ['tests pass'] }], constraints: ['keep sticky'], validation: ['npm test'], risks: ['bad switch'], blockingUnknowns: [],
  };
  const execution = { ...planning, phase: 'execution', activeProfile: 'execution', activePacket: { handoffId: 'h1', from: 'planning', to: 'execution', digest: workflowPacketDigest(packet), packet } };
  const instruction = workflowInstruction(execution);
  assert.match(instruction, /Phase: execution/u);
  assert.match(instruction, /latest user request is authoritative/u);
  assert.match(instruction, /"goal":"Implement it"/u);
  assert.equal(workflowInstruction(execution), instruction, 'same phase/state produces byte-stable control text');
});

test('reminder eligibility is bounded per phase and turn and excludes accepted/rejected/error paths', () => {
  const config = settings();
  const planning = state();
  const base = { state: planning, settings: config, outcome: 'completed', canContinue: true, hasPendingMessages: false, events: [], turnId: 'u1' };
  assert.equal(shouldRemind(base), 'remind');
  const reminder = { version: 1, kind: 'reminder', workflowId: planning.workflowId, phase: 'planning', sourceTurnId: 'u1' };
  assert.equal(shouldRemind({ ...base, events: [reminder] }), 'block');
  assert.equal(shouldRemind({ ...base, outcome: 'error' }), undefined);
  assert.equal(shouldRemind({ ...base, hasPendingMessages: true }), undefined);
  assert.equal(shouldRemind({ ...base, events: [{ version: 1, kind: 'handoff-rejected', workflowId: planning.workflowId, sourceTurnId: 'u1', from: 'planning', to: 'execution', reason: 'needs convergence' }] }), undefined);
  assert.equal(shouldRemind({ ...base, events: [{ version: 1, kind: 'handoff-rejected', workflowId: planning.workflowId, sourceTurnId: 'u1', from: 'execution', to: 'recovery', reason: 'other phase' }] }), 'remind');
  const acceptedPacket = { kind: 'execution', goal: 'x', nonGoals: [], decisions: [{ decision: 'x', rationale: 'x' }], steps: [{ id: '1', scope: ['x'], change: 'x', acceptance: ['x'] }], constraints: [], validation: [], risks: [], blockingUnknowns: [] };
  assert.equal(shouldRemind({ ...base, events: [{ version: 1, kind: 'accepted-handoff', workflowId: planning.workflowId, sourceTurnId: 'u1', handoffId: 'h1', from: 'planning', to: 'execution', packet: acceptedPacket, packetDigest: workflowPacketDigest(acceptedPacket), readinessConfidence: .9, requestedBand: 1 }] }), undefined);
  const recovery = { ...state({ phase: 'recovery' }), activeProfile: 'recovery' };
  assert.equal(shouldRemind({ ...base, state: recovery, turnId: 'u1', events: [reminder] }), 'remind', 'planning reminder does not exhaust recovery reminder budget');
});
