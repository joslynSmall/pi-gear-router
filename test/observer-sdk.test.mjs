import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createObserverSdkFixture, FIXTURE_PROVIDER, deferred, waitForGate } from './helpers/observer-sdk-fixture.mjs';
const directory=mkdtempSync(join(tmpdir(),'observer-production-'));
process.env.PI_GEAR_ROUTER_DATA_DIR=directory;
const {default:extension}=await import('../src/index.ts');
const {parseObserverState}=await import('../src/observer-routing.ts');
after(()=>rmSync(directory,{recursive:true,force:true}));
function answers(input, overrides={}) {
 return Object.fromEntries(Object.entries(input.questions).map(([key,q])=>[key,q.type==='score'?{type:'score',score:1.9,confidence:.95}:q.type==='bool'?{type:'bool',probability:key.startsWith('skill_')?.9:.05}:{type:'choice',choice:overrides[key]??({relation:'same_task',messageEffect:'request_work',work:'investigate',clarity:'clear',risk:'low',methodGate:'none_observed'})[key],confidence:.95,probabilities:Object.fromEntries(Object.keys(q.criteria).map(k=>[k,k===(overrides[key]??({relation:'same_task',messageEffect:'request_work',work:'investigate',clarity:'clear',risk:'low',methodGate:'none_observed'})[key])?1:0]))}]));
}
export function packet(state){return {version:1,taskId:state.task.id,sourceUserEntryId:state.turn.userEntryId,nextWork:'implement',goal:'Synthetic change',scope:['synthetic'],nonGoals:[],decisions:[],steps:[{change:'synthetic',acceptance:['synthetic check']}],constraints:[],validation:['synthetic check'],risks:[],blockingUnknowns:[],methodGate:'none_reported',permissionEvidence:[],reason:'work-converged'};}
function ready(input){const chosen={readiness:'ready',scope:'relevant',clarity:'clear',risk:'low',methodGate:'none_observed'};return Object.fromEntries(Object.entries(input.questions).map(([k,q])=>[k,q.type==='score'?{type:'score',score:.6,confidence:.95}:{type:'choice',choice:chosen[k],confidence:.95,probabilities:Object.fromEntries(Object.keys(q.criteria).map(l=>[l,l===chosen[k]?1:0]))}]));}
async function fixture(t,options={}){
 const f=await createObserverSdkFixture(t,{...options,virtualPlaceholders:[{provider:'gears',id:'auto',name:'Observer production placeholder',thinkingLevels:['off','high']}],extensions:[pi=>{writeFileSync(join(directory,'settings.json'),JSON.stringify({routingMode:'observer',...(options.routerSettings??{}),gears:Object.fromEntries(['light','standard','heavy'].map(g=>[g,{provider:FIXTURE_PROVIDER,model:g,thinkingLevel:g==='heavy'?'high':g==='standard'?'medium':'low'}]))}));extension(pi);},...(options.extraExtensions??[])],classify:(call,_signal,fixture)=>options.classify?options.classify(call,_signal,fixture):({stopReason:'stop',answers:call.context.questions.readiness?ready(call.context):answers(call.context),usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}})});
 await f.runtime.services.modelRuntime.setRuntimeApiKey('typesafe','synthetic-unused-key');
 await f.session.setModel(f.runtime.services.modelRuntime.getModel('gears','auto'));return f;
}
function latest(f){const e=f.manager.getBranch().findLast(e=>e.type==='custom'&&e.customType==='pi.virtual-model-state'&&e.data.provider==='gears');return parseObserverState(e?.data.state);}

test('production observer dispatch and same-round request-local guidance reach actual SDK provider without legacy control',async t=>{
 const f=await fixture(t);await f.session.prompt('Synthetic investigate repository changes');
 assert.equal(f.classifierCalls.length,1);assert.equal(f.requests[0].model.id,'heavy');
 const state=latest(f);assert.ok(state);assert.equal(state.capability.turnProfile,'converge');assert.equal(state.budget.logicalCalls,1);
 const text=JSON.stringify(f.requests[0].messages);assert.ok(text.includes('路由观察建议'));assert.ok(text.includes('review-fixture'));
 assert.ok(!text.includes('GEAR WORKFLOW CONTROL'));assert.ok(!text.includes('SYNTHETIC_BODY'));assert.equal(f.requests.length,1);
 assert.equal(f.manager.getBranch().filter(e=>e.type==='message'&&e.message.role==='user').length,1);
 assert.equal(f.manager.getBranch().filter(e=>e.type==='custom'&&e.customType==='pi-gear-router.workflow.v1').length,0);f.assertClean();
});

test('production ordinary tool continuation retains physical pair, avoids classification and preserves system/tools',async t=>{
 const f=await fixture(t,{reply:call=>call.index===1?{content:[{type:'toolCall',id:'ping',name:'fixture_ping',arguments:{}}],stopReason:'toolUse'}:undefined});
 await f.session.prompt('Synthetic investigate changes');assert.equal(f.requests.length,2);assert.equal(f.classifierCalls.length,1);
 assert.equal(f.requests[0].model.id,f.requests[1].model.id);assert.ok(JSON.stringify(f.requests[1].messages).includes('路由观察建议'));
 const messages=f.requests[1].messages;const caller=messages.findIndex(m=>m.role==='assistant'&&m.content.some(b=>b.type==='toolCall'));
 assert.equal(messages[caller+1].role,'toolResult');f.assertClean();
});

test('explicit capability handoff uses an independent Jev call and only next tool continuation consumes it',async t=>{
 const f=await fixture(t,{tools:['read','fixture_ping','gear_capability_handoff'],reply:(call,_signal,f)=>call.index===1?{content:[{type:'toolCall',id:'capability',name:'gear_capability_handoff',arguments:{packet:packet(latest(f))}}],stopReason:'toolUse'}:undefined});
 assert.ok(f.session.getAllTools().some(t=>t.name==='gear_capability_handoff'),JSON.stringify(f.session.getAllTools()));
 await f.session.prompt('Synthetic investigate repository changes');
 assert.equal(f.classifierCalls.length,2,JSON.stringify(f.manager.getBranch().filter(e=>e.type==='message'&&e.message.role==='toolResult')));assert.ok(f.classifierCalls[1].context.questions.readiness);assert.ok(!f.classifierCalls[1].context.questions.skill_0);
 assert.equal(f.requests.length,2);const state=latest(f);assert.equal(state.capability.persistentProfile,'implement');
 assert.equal(state.budget.transitions,1);assert.equal(state.budget.logicalCalls,2);assert.equal(state.task.cooldown,2);
 assert.equal(f.requests[0].model.id,'heavy');assert.equal(f.requests[1].model.id,'heavy','one band lower may keep physical model');
 assert.equal(f.manager.getBranch().filter(e=>e.type==='custom'&&e.customType==='pi-gear-router.capability.v1'&&e.data.kind==='consumed').length,1);
 await f.session.prompt('Explain the current synthetic conclusion without implementation');
 assert.equal(latest(f).budget.transitions,1,'A new observation cannot erase the consumed transition');
 assert.equal(latest(f).task.id,state.task.id);
 f.assertClean();
});

test('real SDK status and gear-status update from accepted through actual response without creating user turns or calls',async t=>{
 const statuses=[],notices=[];
 const f=await fixture(t,{tools:['read','gear_capability_handoff'],reply:(call,_signal,f)=>call.index===1?{content:[{type:'toolCall',id:'capability-ui',name:'gear_capability_handoff',arguments:{packet:packet(latest(f))}}],stopReason:'toolUse'}:undefined});
 await f.session.bindExtensions({mode:'tui',uiContext:{theme:{fg:(_color,text)=>text},setStatus:(_key,text)=>statuses.push(text),notify:text=>notices.push(text)},onError:e=>f.extensionErrors.push(e)});
 await f.session.prompt('Synthetic investigate repository changes');
 assert.ok(statuses.some(s=>s?.includes('Jev 观察中')),JSON.stringify(statuses));
 assert.ok(statuses.some(s=>s?.includes('交接评估中')),JSON.stringify(statuses));
 assert.ok(statuses.some(s=>s?.includes('交接已接受·未消费')),JSON.stringify(statuses));
 assert.match(statuses.at(-1),/交接已生效/);
 const before=f.manager.getBranch().length,calls=f.classifierCalls.length,requests=f.requests.length;
 await f.session.prompt('/gear-status');
 assert.match(notices.at(-1),/已接受 → 已消费 → 已观察实际响应/);
 assert.equal(f.classifierCalls.length,calls);assert.equal(f.requests.length,requests);assert.equal(f.manager.getBranch().length,before);
 await f.session.bindExtensions({mode:'rpc',uiContext:{theme:{fg:(_color,text)=>text},setStatus:()=>{throw Error('RPC has no terminal status');},notify:text=>notices.push(text)},onError:e=>f.extensionErrors.push(e)});
 await f.session.prompt('/gear-status');assert.match(notices.at(-1),/已观察实际响应/);
 assert.equal(f.manager.getBranch().length,before);assert.equal(f.classifierCalls.length,calls);
 await f.session.bindExtensions({mode:'tui',uiContext:{theme:{fg:(_color,text)=>text},setStatus:(_key,text)=>statuses.push(text),notify:text=>notices.push(text)},onError:e=>f.extensionErrors.push(e)});
 await f.session.setModel(f.runtime.services.modelRuntime.getModel(FIXTURE_PROVIDER,'light'));assert.equal(statuses.at(-1),undefined);f.assertClean();
});

test('steering while Jev is delayed invalidates stale routing/guidance but keeps same-branch reservation accounting',async t=>{
 const entered=deferred(),release=deferred();let count=0;
 const f=await fixture(t,{classify:async(call,options)=>{if(++count===1){entered.resolve();await waitForGate(release,options.signal);}return {stopReason:'stop',answers:answers(call.context)};}});
 const running=f.session.prompt('Synthetic initial investigation');await entered.promise;await f.session.steer('Synthetic independent correction');release.resolve();await running;
 assert.equal(f.classifierCalls.length,2);assert.equal(f.requests.length,2);
 assert.ok(!JSON.stringify(f.requests[0].messages).includes('路由观察建议'));
 const calls=f.manager.getBranch().filter(e=>e.type==='custom'&&e.customType==='pi-gear-router.observer.v1'&&e.data.kind==='call-result');
 assert.equal(calls[0].data.call.status,'stale');assert.equal(latest(f).budget.logicalCalls,2);f.assertClean();
});

test('reload retains task demand, guide dedupe and budget without restoring pending guide',async t=>{
 const f=await fixture(t);await f.session.prompt('Synthetic investigate repository changes');const first=latest(f);
 await f.session.reload();await f.session.prompt('继续');const second=latest(f);
 assert.equal(second.task.id,first.task.id);assert.equal(second.budget.logicalCalls,first.budget.logicalCalls);
 assert.equal(second.capability.taskBand,first.capability.taskBand);assert.ok(!JSON.stringify(f.requests.at(-1).messages).includes('路由观察建议'));f.assertClean();
});

test('disabled mode, stageAware=false and unknown method gate do not activate old workflow controls',async t=>{
 const f=await fixture(t,{routerSettings:{observer:{stageAware:false}},classify:call=>({stopReason:'stop',answers:answers(call.context,{methodGate:'unknown'})})});
 await f.session.prompt('Synthetic investigate changes');assert.equal(latest(f).capability.persistentProfile,'respond');
 assert.ok(!f.session.getActiveToolNames().includes('gear_workflow_handoff'));assert.ok(!f.session.getActiveToolNames().includes('gear_capability_handoff'));
 assert.ok(!JSON.stringify(f.requests[0].messages).includes('GEAR WORKFLOW CONTROL'));f.assertClean();
});

test('external permission block or error replacement prevents capability acceptance/consumption',async t=>{
 for(const replacement of [false,true]){
  const f=await fixture(t,{tools:['read','fixture_ping','gear_capability_handoff'],extraExtensions:[pi=>replacement
   ?pi.on('tool_result',e=>e.toolName==='gear_capability_handoff'?{isError:true,content:[{type:'text',text:'Synthetic permission rejection'}]}:undefined)
   :pi.on('tool_call',e=>e.toolName==='gear_capability_handoff'?{block:true,reason:'Synthetic external permission'}:undefined)],
   reply:(call,_signal,f)=>call.index===1?{content:[{type:'toolCall',id:'capability',name:'gear_capability_handoff',arguments:{packet:packet(latest(f))}}],stopReason:'toolUse'}:undefined});
  await f.session.prompt('Synthetic investigate changes');assert.equal(latest(f).budget.transitions,0);assert.equal(f.requests.length,2);
  assert.equal(f.requests[1].thinkingLevel,f.requests[0].thinkingLevel);assert.equal(f.classifierCalls.length,replacement?2:1);f.assertClean();await f.dispose();
 }
});

test('retry never consumes accepted handoff; following legal continuation can consume once',async t=>{
 const f=await fixture(t,{tools:['read','fixture_ping','gear_capability_handoff'],retry:{enabled:true,maxRetries:1,baseDelayMs:1},
  reply:(call,_signal,f)=>call.index===1?{content:[{type:'toolCall',id:'capability',name:'gear_capability_handoff',arguments:{packet:packet(latest(f))}}],stopReason:'toolUse'}:call.index===2?{stopReason:'error',errorMessage:'rate limit synthetic'}:undefined});
 await f.session.prompt('Synthetic investigate changes');assert.equal(f.classifierCalls.length,2);assert.equal(f.requests.length,3);
 assert.equal(f.requests[1].thinkingLevel,f.requests[2].thinkingLevel);assert.equal(latest(f).budget.transitions,1);f.assertClean();
});

test('explicit-only Skill expansion sends selected identity and arguments, never its body or paths',async t=>{
 const f=await fixture(t);await f.session.prompt('/skill:explicit-fixture Synthetic requested work');
 assert.equal(f.classifierCalls.length,1);const state=f.classifierCalls[0].context.state;assert.equal(state.selectedSkill.name,'explicit-fixture');assert.equal(state.request,'Synthetic requested work');assert.equal(state.skills.candidates.length,0,'An explicit method selection is not replaced by advisory alternatives');
 assert.ok(!JSON.stringify(state).includes('SYNTHETIC_BODY'));assert.ok(!JSON.stringify(state).includes(f.directory));
 const event=f.manager.getBranch().find(e=>e.type==='custom'&&e.customType==='pi-gear-router.observer.v1'&&e.data.fact?.kind==='explicit-expansion-observed');assert.ok(event);f.assertClean();
});

test('exhaustion is sticky across subsequent requests and reload, with no free new-task guesses',async t=>{
 const f=await fixture(t,{routerSettings:{observer:{maxCallsPerTask:1}}});await f.session.prompt('Synthetic investigate');const first=latest(f);
 await f.session.prompt('Synthetic different task');await f.session.reload();await f.session.prompt('Another synthetic goal');
 assert.equal(f.classifierCalls.length,1);assert.equal(latest(f).budget.ownerId,first.budget.ownerId);assert.equal(f.requests.length,3);f.assertClean();
});

test('A2/A12 different runtime directories and no Skills route without invented method candidates',async t=>{
 for(const skills of [[],[{name:'user-b-method',description:'Inspect synthetic changes'}]]){
  const f=await fixture(t,{skills});await f.session.prompt('Synthetic investigate changes');
  assert.ok(latest(f),JSON.stringify({calls:f.classifierCalls,branch:f.manager.getBranch()}));
  assert.equal(latest(f).capability.turnProfile,'converge');assert.equal(f.classifierCalls[0].context.state.skills.candidates.length,skills.length);
  const text=JSON.stringify(f.requests[0].messages);assert.equal(text.includes('review-fixture'),false);
  if(skills.length)assert.ok(text.includes('user-b-method'));else assert.ok(!text.includes('路由观察建议'));f.assertClean();await f.dispose();
 }
});

test('A7/A18 authorized design document write is not blocked by capability profile and does not mean business complete',async t=>{
 const f=await fixture(t,{tools:['read','write'],reply:call=>call.index===1?{content:[{type:'toolCall',id:'write-doc',name:'write',arguments:{path:'synthetic-design.md',content:'Synthetic approved document'}}],stopReason:'toolUse'}:undefined});
 await f.session.prompt('Synthetic authorization: write only synthetic-design.md with the discussed design.');
 const result=f.manager.getBranch().find(e=>e.type==='message'&&e.message.role==='toolResult'&&e.message.toolCallId==='write-doc');
 assert.equal(result.message.isError,false);assert.equal(latest(f).capability.turnProfile,'converge');assert.equal(latest(f).task.active,true);
 assert.equal(f.requests.length,2);assert.equal(f.classifierCalls.length,1);f.assertClean();
});

test('A8 method wait rejects readiness locally while preserving convergence and normal answer',async t=>{
 const f=await fixture(t,{tools:['read','gear_capability_handoff'],classify:call=>({stopReason:'stop',answers:answers(call.context,{methodGate:'waiting'})}),
  reply:(call,_signal,f)=>call.index===1?{content:[{type:'toolCall',id:'waiting',name:'gear_capability_handoff',arguments:{packet:packet(latest(f))}}],stopReason:'toolUse'}:undefined});
 await f.session.prompt('Synthetic: discuss only; wait for approval before implementation.');
 assert.equal(f.classifierCalls.length,1);assert.equal(latest(f).budget.transitions,0);assert.ok(latest(f).task.methodObservations.some(o=>o.waitingFor));assert.equal(f.requests.length,2);f.assertClean();
});

test('A17 branch navigation and session replacement never restore pending acceptance or abandoned guides',async t=>{
 const f=await fixture(t);await f.session.prompt('Synthetic first design');const first=latest(f),root=f.manager.getBranch().at(-1);
 await f.session.prompt('Synthetic later work');await f.session.navigateTree(root.id,{summarize:false});await f.session.prompt('继续');
 assert.equal(latest(f).task.id,first.task.id);assert.ok(!JSON.stringify(f.requests.at(-1).messages).includes('路由观察建议'));
 await f.runtime.newSession();await f.session.setModel(f.runtime.services.modelRuntime.getModel('gears','auto'));await f.session.prompt('Synthetic new session');
 assert.equal(latest(f).budget.logicalCalls,1);assert.notEqual(latest(f).turn.sessionId,first.turn.sessionId);f.assertClean();
});

test('handoff delayed readiness invalidated by steering cannot accept or change the next user request',async t=>{
 const entered=deferred(),release=deferred();
 const f=await fixture(t,{tools:['read','gear_capability_handoff'],classify:async(call,options)=>{if(call.context.questions.readiness){entered.resolve();await waitForGate(release,options.signal);return {stopReason:'stop',answers:ready(call.context)};}return {stopReason:'stop',answers:answers(call.context)};},
  reply:(call,_signal,f)=>call.index===1?{content:[{type:'toolCall',id:'delayed-handoff',name:'gear_capability_handoff',arguments:{packet:packet(latest(f))}}],stopReason:'toolUse'}:undefined});
 const running=f.session.prompt('Synthetic investigate changes');await entered.promise;await f.session.steer('Synthetic pause and discuss');release.resolve();await running;
 assert.equal(f.manager.getBranch().filter(e=>e.type==='custom'&&e.customType==='pi-gear-router.capability.v1'&&e.data.kind==='accepted').length,0);
 assert.equal(latest(f).budget.transitions,0);f.assertClean();
});

test('compaction keeps budgets but removed source cannot restore stale guide or capability material',async t=>{
 const f=await fixture(t);await f.session.prompt('Synthetic initial investigation');const first=latest(f);
 const retained=f.manager.getBranch().findLast(e=>e.type==='message'&&e.message.role==='assistant');
 f.manager.appendCompaction('Synthetic summary, not authority',retained.id,100);
 await f.session.prompt('Synthetic follow-up explanation');assert.equal(latest(f).budget.logicalCalls,2);
 assert.equal(latest(f).task.id,first.task.id);f.assertClean();
});

test('cancel during native observer call propagates, accounts attempt and does not dispatch stale result',async t=>{
 const entered=deferred();const f=await fixture(t,{classify:async(_call,options)=>{entered.resolve();await waitForGate(deferred(),options.signal);}});
 const work=f.session.prompt('Synthetic delayed classify');await entered.promise;await f.session.abort();await work;
 assert.equal(f.requests.length,0);const events=f.manager.getBranch().filter(e=>e.type==='custom'&&e.customType==='pi-gear-router.observer.v1');
 assert.equal(events.find(e=>e.data.kind==='reservation').data.call.status,'reserved');
 assert.equal(events.find(e=>e.data.kind==='call-result').data.call.status,'aborted');f.assertClean();
});

test('production persisted resume and fork restore budgets/task demand without inheriting pending authority',async t=>{
 const f=await fixture(t,{persisted:true});await f.session.prompt('Synthetic persistent investigation');const first=latest(f),file=f.session.sessionFile,root=f.manager.getLeafId();
 await f.runtime.fork(root,{position:'at'});await f.runtime.services.modelRuntime.setRuntimeApiKey('typesafe','synthetic-unused-key');await f.session.prompt('继续');
 assert.equal(latest(f).task.id,first.task.id);assert.equal(latest(f).budget.logicalCalls,2,'fork has a new source session so old fact coverage conservatively requires a fresh observation');assert.ok(!JSON.stringify(f.requests.at(-1).messages).includes('路由观察建议'));
 await f.runtime.switchSession(file);await f.runtime.services.modelRuntime.setRuntimeApiKey('typesafe','synthetic-unused-key');await f.session.prompt('继续');
 assert.equal(latest(f).task.id,first.task.id);assert.equal(latest(f).budget.logicalCalls,1);f.assertClean();
});

test('production literal continuation is bounded; recommendation is not repeated on a new user source',async t=>{
 const f=await fixture(t);await f.session.prompt('Synthetic investigate repository changes');await f.session.prompt('继续');
 assert.equal(f.classifierCalls.length,1);assert.equal(f.requests.length,2);assert.equal(latest(f).task.inheritedTurns,1);
 assert.ok(!JSON.stringify(f.requests[1].messages).includes('路由观察建议'));f.assertClean();
});
