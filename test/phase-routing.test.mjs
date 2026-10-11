import assert from 'node:assert/strict';
import { test } from 'node:test';
import { initialPlanGear, implementationGear, implementationHint, parseState, activeGear } from '../src/phase-routing.ts';

test('plan threshold is confidence >= .8 and score < 1.5; no light selection', () => {
  for (const [score, confidence, gear] of [[0,.8,'standard'],[1.49,.8,'standard'],[1.5,.8,'heavy'],[0,.79,'heavy'],[2,1,'heavy']])
    assert.equal(initialPlanGear({score,confidence,inputTokens:0}),gear);
  assert.equal(initialPlanGear(), 'heavy');
});
test('implementation defaults standard and confidently hard preserves original gear', () => {
  assert.equal(implementationGear(undefined,'heavy'),'standard');
  assert.equal(implementationGear({score:1.5,confidence:.8},'heavy'),'heavy');
  assert.equal(implementationGear({score:1.9,confidence:.79},'heavy'),'standard');
  assert.equal(implementationGear({score:1.9,confidence:.9},'standard'),'standard');
});
test('candidate phrases and negation; generic English implementation questions are not approval', () => {
  for (const s of ['开始实现','确认需求','按这个计划做','批准计划','start implementing','approve the plan']) assert.equal(implementationHint(s),true,s);
  for (const s of ['不要开始实现','先别确认需求','do not start implementing','继续','How would you implement this?']) assert.equal(implementationHint(s),false,s);
});
test('valid state strips unknown content; malformed state is not reinterpreted', () => {
  const state = {version:2,phase:'plan',planGear:'heavy',gear:'heavy',fallback:false,secret:'not preserved'};
  assert.deepEqual(parseState(state), {version:2,phase:'plan',planGear:'heavy',gear:'heavy',fallback:false});
  assert.equal(activeGear(parseState(state)), 'heavy');
  for (const v of [null,{}, {...state,version:3},{...state,phase:'implement'},{...state,planGear:'other'}, {...state,dispatch:{model:'x'}}, {version:1,mode:'observer'}]) assert.equal(parseState(v),undefined);
});
test('old task phases migrate, revision does not create a third phase', () => {
  const old = {gear:'standard',fallback:true,phaseRoute:{version:1,phase:'implement',revising:true,planGear:'heavy',implementGear:'standard'}};
  const migrated = parseState(old);
  assert.equal(migrated.phase,'implement'); assert.equal(activeGear(migrated),'standard'); assert.equal('revising' in migrated,false);
  assert.equal(parseState({...old,version:3}),undefined,'unknown new versions must not pass through legacy migration');
});
