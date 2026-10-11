import assert from 'node:assert/strict';
import { test } from 'node:test';
import { initialPlanGear, implementationGear, phaseChoiceIntent, skillMatchesPhase, validPhaseState } from '../src/phase-routing.ts';

test('phase choices only switch on an explicit confirmation', () => {
  assert.equal(phaseChoiceIntent('开始实现'), 'implement');
  assert.equal(phaseChoiceIntent('继续计划'), 'stay');
  assert.equal(phaseChoiceIntent('自己补充', '按这个做'), 'implement');
  assert.equal(phaseChoiceIntent('自己补充', '先补充验收标准'), 'stay');
  assert.equal(phaseChoiceIntent(undefined, ''), undefined);
});

test('plan starts capable and implementation switches once to the lower gear', () => {
  assert.equal(initialPlanGear({ score: 1.8, confidence: .9, inputTokens: 1 }), 'heavy');
  assert.equal(initialPlanGear({ score: .4, confidence: .9, inputTokens: 1 }), 'standard');
  assert.equal(implementationGear({ score: .8, confidence: .9, inputTokens: 1 }, 'heavy'), 'standard');
  assert.equal(implementationGear({ score: 1.9, confidence: .9, inputTokens: 1 }, 'heavy'), 'heavy');
});

test('skill categories stay disjoint and persisted phase state is strict', () => {
  assert.equal(skillMatchesPhase('requirements', '需求搜集', 'plan'), true);
  assert.equal(skillMatchesPhase('verification', '运行测试', 'plan'), false);
  assert.equal(skillMatchesPhase('implementation', '实现改动', 'implement'), true);
  assert.equal(validPhaseState({ version: 1, phase: 'implement', revising: true, planGear: 'heavy', implementGear: 'standard' })?.revising, true);
  assert.equal(validPhaseState({ version: 1, phase: 'implement', revising: false, planGear: 'heavy' }), undefined);
});
