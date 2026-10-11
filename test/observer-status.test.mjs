import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaultSettings } from '../src/gears.ts';
import { newObserverBudget, observerDigest } from '../src/observer-routing.ts';
import { observerStatus } from '../src/observer-status.ts';
const identity = { sessionId:'s', userEntryId:'u', userContentDigest:'a'.repeat(64), inputEpoch:1, branchEpoch:0, policyFingerprint:'b'.repeat(64) };
const choice = value => ({status:'valid',type:'choice',choice:value,confidence:.95,probabilities:{[value]:1}});
function fixture() {
 const settings=defaultSettings();settings.routingMode='observer';
 const state={schema:'observer-routing',version:1,turn:identity,
  capability:{persistentProfile:'implement',turnProfile:'respond',requestedBand:0,protectedBand:0,taskBand:2},
  dispatch:{provider:'synthetic',model:'light',thinkingLevel:'high'},budget:newObserverBudget('task'),
  observation:{outcome:'valid',fields:{messageEffect:choice('explain')},skills:[]},diagnostics:{coverage:'known',reasons:[]}};
 settings.gears.light={...state.dispatch};return {state,settings};
}
test('compact explanation status preserves task demand in details and never advertises valid as confidence',()=>{
 const {state,settings}=fixture(),view=observerStatus(state,[],settings);
 assert.equal(view.text,'路由 解释 → light · high ｜ 临时降档 ｜ Jev 0/24');
 assert.match(view.details,/持续任务：实施，能力 band 2/);assert.match(view.details,/本轮请求／保护能力：0 → 0/);
 assert.ok(!view.text.includes('valid'));assert.equal(view.tone,'accent');
});
const packet={version:1,taskId:'task',sourceUserEntryId:'u',nextWork:'implement',goal:'Synthetic',scope:['one'],nonGoals:[],decisions:[],steps:[{change:'one',acceptance:['check']}],constraints:[],validation:['check'],risks:[],blockingUnknowns:[],methodGate:'none_reported',permissionEvidence:[],reason:'work-converged'};
const event = (kind, extra={}) => ({type:'custom',customType:'pi-gear-router.capability.v1',data:{version:1,kind,id:'handoff',packetDigest:observerDigest(packet),identity,...(kind==='accepted'?{handoff:{id:'handoff',packetDigest:observerDigest(packet),identity,packet,targetProfile:'implement',requestedBand:1,protectedBand:2}}:{}),...extra}});
test('handoff accepted, consumed and actual response remain distinct, old-source events cannot leak',()=>{
 const {state,settings}=fixture();state.capability.turnProfile='implement';state.capability.requestedBand=2;state.capability.protectedBand=2;
 state.dispatch={...settings.gears.standard,thinkingLevel:'high'};
 for(const [events,label]of [[['accepted'],'交接已接受·未消费'],[['accepted','consumed'],'交接已消费·待响应'],[['accepted','consumed','physical-response-observed'],'交接已生效']]){
  const view=observerStatus(state,events.map(k=>event(k)),settings);assert.ok(view.text.includes(label),view.text);
  assert.ok(!view.text.includes('已批准'));assert.ok(!view.text.includes('完成'));
 }
 const unrelated=event('physical-response-observed',{identity:{...identity,userEntryId:'abandoned'}});
 assert.ok(!observerStatus(state,[unrelated],settings).text.includes('生效'));
 const rejected=observerStatus(state,[event('invalidated',{reason:'readiness-not-accepted'})],settings);
 assert.match(rejected.text,/交接证据不足·保持/);assert.equal(rejected.tone,'warning');
});
test('errors, waiting, budget and terminal controls are bounded and not mistaken for low confidence',()=>{
 const {state,settings}=fixture();state.observation.failure='timeout';state.observation.outcome='unavailable';
 assert.match(observerStatus(state,[],settings).text,/路由 沿用.*Jev 超时/);
 state.observation.failure='invalid-probabilities';assert.match(observerStatus(state,[],settings).text,/观察概率无效/);assert.equal(observerStatus(state,[],settings).tone,'error');
 delete state.observation.failure;state.observation.outcome='valid';state.diagnostics.reasons=['SECRET\x1b[31m'];
 state.dispatch.model='malicious\x1b[31m\nmodel';const view=observerStatus(state,[],settings);
 assert.ok(!/[\x00-\x1f]/.test(view.text));assert.ok(!view.details.includes('SECRET'));
 state.budget.exhausted=true;assert.match(observerStatus(state,[],settings).text,/观察额度耗尽/);
 assert.match(observerStatus(state,[],settings,{pending:'handoff'}).text,/交接评估中/);
});
