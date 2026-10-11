import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaultSettings } from '../src/gears.ts';
import {
  canTransition,
  consumeHandoff,
  newWorkflowState,
  refreshWorkflowState,
  validWorkflowEvent,
  validWorkflowPacket,
  validWorkflowState,
  workflowBand,
  workflowFacts,
  latestValidationOutcome,
  workflowPacketDigest,
} from '../src/workflow-routing.ts';

const packet = () => ({
  kind: 'execution',
  goal: 'Add phase routing',
  nonGoals: ['Do not transfer KV cache'],
  decisions: [{ decision: 'Use handoff events', rationale: 'Router state is written before tools run' }],
  steps: [{ id: 'types', scope: ['src/types.ts'], change: 'Add workflow state', acceptance: ['State validates'] }],
  constraints: ['Keep retry sticky'],
  validation: ['npm test'],
  risks: ['Invalid event could switch models'],
  blockingUnknowns: [],
});

function state(overrides = {}) {
  const settings = defaultSettings();
  return newWorkflowState({
    workflowId: 'workflow:user-1', initialTurnId: 'user-1', objective: 'deliver', phase: 'planning',
    policyFingerprint: 'a'.repeat(64), requestedBand: 3, ...overrides,
  });
}
function accepted(overrides = {}) {
  const value = packet();
  return {
    version: 1, kind: 'accepted-handoff', workflowId: 'workflow:user-1', sourceTurnId: 'user-1', handoffId: 'handoff-1',
    from: 'planning', to: 'execution', packet: value, packetDigest: workflowPacketDigest(value), readinessConfidence: .91, requestedBand: 1,
    ...overrides,
  };
}

test('workflow packets are strict, bounded and never return the mutable input object', () => {
  const value = packet();
  const variants = [
    value,
    { kind: 'verification', goal: 'Verify', implementedSteps: ['wired route'], validationPlan: ['npm test'], expectedEvidence: ['pass'], knownLimitations: [], blockingUnknowns: [] },
    { kind: 'recovery', goal: 'Recover', currentState: 'test fails', failedAssumptions: ['old invariant'], evidence: ['exit 1'], questionsToResolve: ['ownership'], constraints: ['read only'], blockingUnknowns: ['Need inspect'] },
    { kind: 'complete', goal: 'Complete', acceptanceEvidence: ['test pass'], validationSummary: ['npm test'], remainingIssues: [] },
  ];
  for (const candidate of variants) {
    const valid = validWorkflowPacket(candidate);
    assert.deepEqual(valid, candidate);
    assert.notEqual(valid, candidate);
  }
  const valid = validWorkflowPacket(value);
  assert.notEqual(valid.steps, value.steps);
  for (const bad of [
    { ...value, extra: true },
    { ...value, steps: [] },
    { ...value, steps: [{ ...value.steps[0], scope: [] }] },
    { ...value, blockingUnknowns: 'nope' },
    { ...value, goal: 'x'.repeat(2001) },
    { kind: 'unknown' },
  ]) assert.equal(validWorkflowPacket(bad), undefined);
  assert.deepEqual(validWorkflowPacket(JSON.parse(JSON.stringify(value))), value, 'JSON round-trip must preserve a valid packet');
});

test('workflow state rejects malformed, unknown and oversized persisted state', () => {
  const s = state();
  const valid = validWorkflowState(s, 5);
  assert.deepEqual(valid, s);
  assert.notEqual(valid, s);
  for (const bad of [
    { ...s, version: 2 },
    { ...s, phase: 'teleport' },
    { ...s, activeProfile: 'teleport' },
    { ...s, phase: 'execution', activeProfile: 'planning', lastTransition: { to: 'execution', reason: 'initial' } },
    { ...s, phase: 'verification', activeProfile: 'verification', lastTransition: { to: 'verification', reason: 'initial' } },
    { ...s, phase: 'complete', activeProfile: undefined, activePacket: { handoffId: 'h1', from: 'planning', to: 'execution', digest: workflowPacketDigest(packet()), packet: packet() }, lastTransition: { to: 'complete', reason: 'initial' } },
    { ...s, phase: 'execution', activeProfile: 'execution', activePacket: { handoffId: 'h1', from: 'planning', to: 'execution', digest: workflowPacketDigest(packet()), packet: packet() }, lastTransition: { handoffId: 'other', from: 'planning', to: 'execution', reason: 'accepted-handoff', requestedBand: 1 } },
    { ...s, consumedHandoffIds: Array.from({ length: 9 }, (_, i) => `h-${i}`) },
    { ...s, extra: true },
    { ...s, workflowId: 'x'.repeat(301) },
  ]) assert.equal(validWorkflowState(bad, 5), undefined);
});

test('accepted events require an exact digest, legal edge and bounded band', () => {
  const good = accepted();
  assert.deepEqual(validWorkflowEvent(good, 5), good);
  for (const bad of [
    { ...good, packetDigest: 'b'.repeat(64) },
    { ...good, from: 'planning', to: 'recovery' },
    { ...good, requestedBand: 5 },
    { ...good, packet: { ...good.packet, blockingUnknowns: 'not-array' } },
    { ...good, packet: { ...good.packet, blockingUnknowns: ['Need contract'] } },
    { ...good, extra: true },
  ]) assert.equal(validWorkflowEvent(bad, 5), undefined);
});

test('transition table permits only approved phase edges', () => {
  for (const [from, to] of [
    ['planning', 'execution'], ['execution', 'verification'], ['execution', 'recovery'],
    ['verification', 'recovery'], ['verification', 'complete'], ['recovery', 'execution'],
  ]) assert.equal(canTransition(from, to), true, `${from} -> ${to}`);
  for (const [from, to] of [
    ['planning', 'complete'], ['planning', 'recovery'], ['execution', 'complete'],
    ['recovery', 'verification'], ['complete', 'planning'], ['blocked', 'execution'],
  ]) assert.equal(canTransition(from, to), false, `${from} -> ${to}`);
});

test('event facts are branch/workflow scoped and deduplicate accepted handoffs', () => {
  const event = accepted();
  const facts = workflowFacts([
    event, structuredClone(event),
    { version: 1, kind: 'reminder', workflowId: 'workflow:user-1', phase: 'planning', sourceTurnId: 'user-1' },
    { version: 1, kind: 'validation', workflowId: 'workflow:user-1', sourceTurnId: 'user-1', outcome: 'passed', commandKind: 'npm-test' },
    { ...event, workflowId: 'workflow:other', handoffId: 'other' },
  ], 'workflow:user-1', 5);
  assert.equal(facts.accepted.length, 1);
  assert.equal(facts.reminderCount, 1);
  assert.equal(facts.validationPassed, true);
  assert.equal(facts.validationFailed, false);
});

test('event folding consumes only the supplied active-branch event input', () => {
  const settings = defaultSettings();
  const handoff = accepted();
  const activeBranch = [{ version: 1, kind: 'reminder', workflowId: 'workflow:user-1', phase: 'planning', sourceTurnId: 'user-1' }];
  const otherBranch = [...activeBranch, handoff];
  assert.equal(consumeHandoff(state(), activeBranch, settings), undefined);
  assert.equal(consumeHandoff(state(), otherBranch, settings).state.phase, 'execution');
});

test('a handoff is consumed exactly once and only for its source turn/current phase', () => {
  const settings = defaultSettings();
  const first = consumeHandoff(state(), [accepted()], settings);
  assert.ok(first);
  assert.equal(first.state.phase, 'execution');
  assert.equal(first.state.activeProfile, 'execution');
  assert.equal(first.state.transitionCount, 1);
  assert.equal(first.requestedBand, 1);
  assert.equal(first.state.activePacket?.packet.kind, 'execution');
  assert.equal(consumeHandoff(first.state, [accepted()], settings), undefined);
  assert.equal(consumeHandoff(state(), [accepted({ sourceTurnId: 'user-2' })], settings), undefined);
  assert.equal(consumeHandoff(state(), [accepted({ from: 'execution', to: 'verification' })], settings), undefined);
  assert.equal(consumeHandoff(state(), [accepted({ readinessConfidence: .2 })], settings), undefined, 'the reducer rechecks the configured readiness threshold');
});

test('completion consumption also requires a current-turn passing validation fact', () => {
  const settings = defaultSettings();
  const execution = consumeHandoff(state(), [accepted()], settings).state;
  const verificationPacket = { kind: 'verification', goal: 'Verify', implementedSteps: ['wired'], validationPlan: ['npm test'], expectedEvidence: ['pass'], knownLimitations: [], blockingUnknowns: [] };
  const verification = consumeHandoff(execution, [accepted({ handoffId: 'verify', from: 'execution', to: 'verification', packet: verificationPacket, packetDigest: workflowPacketDigest(verificationPacket) })], settings).state;
  const completionPacket = { kind: 'complete', goal: 'Complete', acceptanceEvidence: ['pass'], validationSummary: ['npm test'], remainingIssues: [] };
  const complete = accepted({ handoffId: 'complete', from: 'verification', to: 'complete', packet: completionPacket, packetDigest: workflowPacketDigest(completionPacket) });
  assert.equal(consumeHandoff(verification, [complete], settings), undefined);
  const validation = { version: 1, kind: 'validation', workflowId: verification.workflowId, sourceTurnId: verification.activeTurnId, outcome: 'passed', commandKind: 'npm' };
  assert.equal(consumeHandoff(verification, [validation, complete], settings).state.phase, 'complete');
});

test('transition budget blocks automatic consumption without changing the source state', () => {
  const settings = defaultSettings();
  settings.workflow.maxTransitions = 1;
  const exhausted = { ...state(), transitionCount: 1 };
  assert.equal(consumeHandoff(exhausted, [accepted()], settings), undefined);
  assert.equal(exhausted.phase, 'planning');
});

test('an accepted event beyond the transition budget becomes a budget-exhausted terminal state', () => {
  const settings = defaultSettings();
  settings.workflow.maxTransitions = 1;
  const exhausted = { ...state(), transitionCount: 1 };
  const blocked = refreshWorkflowState(exhausted, [accepted()], settings);
  assert.equal(blocked.phase, 'blocked');
  assert.equal(blocked.lastTransition.reason, 'budget-exhausted');
  assert.equal(blocked.activePacket, undefined);
});

test('a matching blocked event turns an active profile into a packet-free terminal state', () => {
  const settings = defaultSettings();
  const execution = consumeHandoff(state(), [accepted()], settings).state;
  const blocked = refreshWorkflowState(execution, [{ version: 1, kind: 'blocked', workflowId: execution.workflowId, phase: 'execution', sourceTurnId: execution.activeTurnId }], settings);
  assert.equal(blocked.phase, 'blocked');
  assert.equal(blocked.activeProfile, undefined);
  assert.equal(blocked.activePacket, undefined);
  assert.ok(validWorkflowState(blocked, settings.bands.length));
});

test('validation eligibility reflects the latest branch fact for the active user turn', () => {
  const events = [
    { version: 1, kind: 'validation', workflowId: 'workflow:user-1', sourceTurnId: 'user-1', outcome: 'passed', commandKind: 'npm' },
    { version: 1, kind: 'validation', workflowId: 'workflow:user-1', sourceTurnId: 'user-2', outcome: 'passed', commandKind: 'npm' },
    { version: 1, kind: 'validation', workflowId: 'workflow:user-1', sourceTurnId: 'user-2', outcome: 'failed', commandKind: 'npm' },
  ];
  const facts = workflowFacts(events, 'workflow:user-1', 5);
  assert.equal(facts.validationPassed, true);
  assert.equal(facts.validationFailed, true);
  assert.equal(facts.latestValidationOutcome, 'failed');
  assert.equal(latestValidationOutcome(events, 'workflow:user-1', 'user-1', 5), 'passed');
  assert.equal(latestValidationOutcome(events, 'workflow:user-1', 'user-2', 5), 'failed');
});

test('phase floors preserve high-risk work and only lower atomic execution', () => {
  const settings = defaultSettings();
  assert.equal(workflowBand(settings, { profile: 'planning', score: .1, risk: 'low', clarity: 'high' }), 3);
  assert.equal(workflowBand(settings, { profile: 'execution', score: .1, risk: 'medium', clarity: 'high' }), 1);
  assert.equal(workflowBand(settings, { profile: 'execution', score: .1, risk: 'low', clarity: 'high', packet: packet() }), 0);
  assert.equal(workflowBand(settings, { profile: 'execution', score: .1, risk: 'high', clarity: 'high', packet: packet() }), 3);
  assert.equal(workflowBand(settings, { profile: 'recovery', score: .1, risk: 'low', clarity: 'high' }), 3);
});
