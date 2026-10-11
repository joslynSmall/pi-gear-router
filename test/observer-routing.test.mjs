import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaultSettings } from '../src/gears.ts';
import { decideObserverRoute, observerPolicyFingerprint, newObserverBudget } from '../src/observer-routing.ts';
import { observerQuestions, parseObserverAnswers } from '../src/observer-judge.ts';
const identity=(n,s)=>({sessionId:'s',userEntryId:`u${n}`,userContentDigest:'a'.repeat(64),inputEpoch:n,branchEpoch:0,policyFingerprint:observerPolicyFingerprint(s)});
const context=request=>({schema:'observer-input-v1',request,methodObservations:[],controlFacts:[],recentPublicAssistant:[],executionFacts:[],skills:{candidates:[],total:0,coverage:'known'},missing:[],nonTextInput:false});
function verdict(input,work='design',score=1.2,changes={}) {
  const values={relation:'same_task',messageEffect:'request_work',work,clarity:'clear',risk:'low',methodGate:'none_observed'};
  const answers=Object.fromEntries(Object.entries(observerQuestions(input)).map(([key,q])=>[key,q.type==='score'?{type:'score',score,confidence:.95}:q.type==='bool'?{type:'bool',probability:0}:{type:'choice',choice:values[key],confidence:.95,probabilities:Object.fromEntries(Object.keys(q.criteria).map(l=>[l,l===values[key]?1:0]))}]));
  Object.assign(answers,changes);return parseObserverAnswers({stopReason:'stop',answers},input);
}
async function route(n,old,{request='Synthetic work',work='design',score=1.2,changes={},facts,settings=defaultSettings()}={}) {
  settings.routingMode='observer';const i=context(request);if(old?.task)i.task={id:old.task.id,anchor:old.task.anchor,userChanges:old.task.userChanges};
  const result=await decideObserverRoute({reason:'user',identity:identity(n,settings),context:i,previous:old,settings,
    budget:old?.budget??newObserverBudget('t'),facts:facts??{coverage:'known',dirty:false,executionFacts:[]},dispatchUsable:true},async()=>verdict(i,work,score,changes));
  return result.state;
}
const choice=(selected,labels)=>({type:'choice',choice:selected,confidence:.95,probabilities:Object.fromEntries(labels.map(l=>[l,l===selected?1:0]))});

test('complex review and design converge; ambiguous low/medium risk does not veto common investigation action',async()=>{
  const state=await route(1,undefined,{work:'investigate',score:1.3,changes:{risk:{type:'choice',choice:'medium',confidence:.4,probabilities:{low:.45,medium:.5,high:.03,unknown:.02}}}});
  assert.equal(state.capability.turnProfile,'converge');assert.ok(state.capability.protectedBand>=3);assert.equal(state.authorization,undefined);
});

test('explain is temporary respond, preserves task demand and restores it on literal continuation without observe',async()=>{
  const first=await route(1);const explained=await route(2,first,{work:'answer',score:.1,changes:{messageEffect:choice('explain',['request_work','continue','explain','change_scope','pause','cancel','clarify_reference'])}});
  assert.equal(explained.task.id,first.task.id);assert.equal(explained.capability.taskBand,first.capability.taskBand);
  assert.equal(explained.capability.turnProfile,'respond');assert.equal(explained.task.samples.length,first.task.samples.length);
  const s=defaultSettings();s.routingMode='observer';let calls=0;
  const result=await decideObserverRoute({reason:'user',identity:identity(3,s),context:{...context('继续'),task:{id:first.task.id,anchor:first.task.anchor,userChanges:[]}},previous:explained,
    settings:s,budget:explained.budget,facts:{coverage:'known',dirty:false,executionFacts:[]},dispatchUsable:true},async()=>{calls++;throw Error('must not observe');});
  assert.equal(calls,0);assert.equal(result.state.capability.turnProfile,'converge');assert.equal(result.state.capability.protectedBand,first.capability.taskBand);
});

test('two independent low observations permit downgrade, repeated source never adds a sample',async()=>{
  const first=await route(1,undefined,{score:1.9});const low1=await route(2,first,{work:'implement',score:.6});
  assert.equal(low1.capability.taskBand,first.capability.taskBand);
  const repeated=await route(2,low1,{work:'implement',score:.6});assert.equal(repeated.task.samples.length,low1.task.samples.length);
  const low2=await route(3,low1,{work:'implement',score:.6});assert.equal(low2.capability.taskBand,1);
});

test('waiting gate cannot be erased by none_observed; pause/cancel clear candidates without inventing permission',async()=>{
  const waiting=await route(1,undefined,{changes:{methodGate:choice('waiting',['waiting','none_observed','unknown'])}});
  assert.ok(waiting.task.methodObservations.length);const low=await route(2,waiting,{work:'implement',score:.6});
  assert.ok(low.task.methodObservations.length);assert.equal(low.capability.taskBand,waiting.capability.taskBand);
  const cancelled=await route(3,low,{changes:{messageEffect:choice('cancel',['request_work','continue','explain','change_scope','pause','cancel','clarify_reference'])}});
  assert.equal(cancelled.task.active,false);assert.equal(cancelled.task.samples.length,0);assert.equal(cancelled.activeHandoff,undefined);
});

test('trusted independent new goal escapes old demand but uncertain relation never overwrites the anchor',async()=>{
  const first=await route(1,undefined,{score:1.9});
  const uncertain=await route(2,first,{work:'answer',score:.1,changes:{relation:choice('uncertain',['same_task','new_task','uncertain'])}});
  assert.equal(uncertain.task.id,first.task.id);assert.equal(uncertain.task.anchor,first.task.anchor);
  const fresh=await route(3,first,{work:'answer',score:.1,changes:{relation:choice('new_task',['same_task','new_task','uncertain'])}});
  assert.notEqual(fresh.task.id,first.task.id);assert.equal(fresh.capability.taskBand,0);
});

test('image/invalid risk cannot lower task demand; stageAware=false never applies converge floor',async()=>{
  const first=await route(1,undefined,{score:1.9});
  const invalid=await route(2,first,{work:'implement',score:.2,changes:{risk:{type:'choice',choice:'low',confidence:.95,probabilities:{low:.99,medium:0,high:0,unknown:0}}}});
  assert.equal(invalid.capability.taskBand,first.capability.taskBand);
  const s=defaultSettings();s.observer.stageAware=false;
  const noFloor=await route(1,undefined,{settings:s,work:'design',score:.6});assert.equal(noFloor.capability.protectedBand,1);assert.equal(noFloor.capability.persistentProfile,'respond');
});

test('failed execution clears previous downgrade candidates; provisional relation leaves windows untouched',async()=>{
  const first=await route(1,undefined,{score:1.9});const low=await route(2,first,{work:'implement',score:.6});
  assert.equal(low.task.samples.length,1);
  const provisional=await route(3,low,{work:'answer',score:.1,changes:{relation:choice('uncertain',['same_task','new_task','uncertain'])}});
  assert.equal(provisional.task.samples.length,1);
  const dirty=await route(3,low,{work:'implement',score:.6,facts:{coverage:'known',dirty:true,executionFacts:[]}});
  assert.equal(dirty.task.samples.length,0);assert.equal(dirty.capability.taskBand,first.capability.taskBand);
});

test('A6/A10 changed compatibility scope restores converge and image/high-risk work cannot mechanically lower',async()=>{
 const first=await route(1,undefined,{work:'implement',score:1.3});
 const changed=await route(2,first,{work:'implement',score:.1,changes:{messageEffect:choice('change_scope',['request_work','continue','explain','change_scope','pause','cancel','clarify_reference'])}});
 assert.equal(changed.capability.turnProfile,'converge');assert.ok(changed.capability.protectedBand>=3);assert.equal(changed.task.samples.length,0);
 const high=await route(3,changed,{work:'implement',score:.1,changes:{risk:choice('high',['low','medium','high','unknown'])}});assert.ok(high.capability.taskBand>=changed.capability.taskBand);
});

test('high-risk implementation can raise a previously low task demand without confusing capability with permission',async()=>{
 const low=await route(1,undefined,{work:'implement',score:.6});const high=await route(2,low,{work:'implement',score:.6,changes:{risk:choice('high',['low','medium','high','unknown'])}});
 assert.ok(high.capability.protectedBand>=3);assert.equal(high.capability.turnProfile,'implement');assert.equal(high.permission,undefined);
});

test('bounded generated trajectories maintain source/turn separation, retry invariants and distinct-evidence window',async()=>{
 let state=await route(1,undefined,{score:1.9});
 for(let n=2;n<=26;n++){
  const previous=state;state=await route(n,previous,{work:n%3===0?'answer':'implement',score:n%3===0?.1:.6,
   changes:n%3===0?{messageEffect:choice('explain',['request_work','continue','explain','change_scope','pause','cancel','clarify_reference'])}:{}});
  assert.equal(state.task.id,previous.task.id);assert.notEqual(state.turn.userEntryId,previous.turn.userEntryId);
  assert.ok(state.task.samples.length<=2);assert.equal(new Set(state.task.samples.map(s=>s.evidenceKey)).size,state.task.samples.length);
  if(n%3===0)assert.equal(state.capability.taskBand,previous.capability.taskBand);
  const s=defaultSettings();s.routingMode='observer';
  const retry=await decideObserverRoute({reason:'retry',identity:state.turn,context:context('Synthetic'),previous:state,settings:s,budget:state.budget,facts:{coverage:'known',dirty:false,executionFacts:[]},dispatchUsable:true},async()=>{throw Error('retry must not classify');});
  assert.equal(retry.retainPhysicalPair,true);
 }
});

test('dirty/unknown coverage prevents literal inheritance; continuation/retry never observes or downgrades',async()=>{
  const first=await route(1),s=defaultSettings();s.routingMode='observer';let calls=0;
  for(const reason of ['continuation','retry']) {
    const decision=await decideObserverRoute({reason,identity:first.turn,context:context('continue'),previous:first,settings:s,budget:first.budget,facts:{coverage:'unknown',dirty:true,executionFacts:[]},dispatchUsable:true},async()=>{calls++;throw Error();});
    assert.equal(decision.retainPhysicalPair,true);
  }
  assert.equal(calls,0);const dirty=await route(2,first,{request:'继续',facts:{coverage:'unknown',dirty:true,executionFacts:[]}});
  assert.equal(dirty.task.inheritedTurns,0);
});
