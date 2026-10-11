import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaultSettings } from '../src/gears.ts';
import { localCapabilityGate, readinessCapability, registerCapabilityHandoff } from '../src/observer-handoff.ts';
const choice=(value,labels)=>({status:'valid',type:'choice',choice:value,confidence:.95,probabilities:Object.fromEntries(labels.map(l=>[l,l===value?1:0]))});
function fixture(){
 const identity={sessionId:'s',userEntryId:'u',userContentDigest:'a'.repeat(64),inputEpoch:1,branchEpoch:1,policyFingerprint:'b'.repeat(64)};
 const settings=defaultSettings();settings.routingMode='observer';
 const state={turn:identity,task:{id:'t',anchorUserEntryId:'u',active:true,methodObservations:[],controlFacts:[],cooldown:0,dirty:false},budget:{logicalCalls:1,transitions:0,exhausted:false},capability:{taskBand:4}};
 const packet={version:1,taskId:'t',sourceUserEntryId:'u',nextWork:'implement',goal:'Synthetic',scope:['one'],nonGoals:[],decisions:[],steps:[{change:'one',acceptance:['check']}],constraints:[],validation:['check'],risks:[],blockingUnknowns:[],methodGate:'none_reported',permissionEvidence:[],reason:'work-converged'};
 const ctx={model:{provider:'gears',id:'auto'},hasPendingMessages:()=>false,sessionManager:{getSessionId:()=>identity.sessionId,getBranch:()=>[{id:'u',type:'message',message:{role:'user',content:'synthetic'}}]}};
 const readiness={fields:{readiness:choice('ready',['ready','needs_convergence','blocked']),scope:choice('relevant',['relevant','unrelated','unknown']),clarity:choice('clear',['clear','unresolved','unknown']),risk:choice('low',['low','medium','high','unknown']),methodGate:choice('none_observed',['none_observed','waiting','unknown']),capability:{status:'valid',type:'score',score:.6,confidence:.95}}};
 return {ctx,state,packet,settings,readiness};
}
test('local capability gate refuses source/mode/gates/permission references and incomplete implementation without classification',()=>{
 const f=fixture();assert.equal(localCapabilityGate(f.ctx,f.state,f.packet,f.settings).reason,'candidate');
 for(const p of [{...f.packet,sourceUserEntryId:'fake'},{...f.packet,methodGate:'waiting'},{...f.packet,steps:[]},{...f.packet,permissionEvidence:[{userEntryId:'fake',summary:'approved'}]},{...f.packet,version:2},{...f.packet,nextWork:'complete'},{...f.packet,goal:'x'.repeat(1001)}])assert.equal(localCapabilityGate(f.ctx,f.state,p,f.settings).packet,undefined);
 f.settings.routingMode='task';assert.equal(localCapabilityGate(f.ctx,f.state,f.packet,f.settings).reason,'inactive');
 f.settings.routingMode='observer';f.state.task.methodObservations=[{waitingFor:'approval-reported'}];assert.equal(localCapabilityGate(f.ctx,f.state,f.packet,f.settings).reason,'method-or-control-wait');
});
test('readiness limits lowering to one band and low-risk evidence; high-risk upshift is allowed without permission',()=>{
 const f=fixture();assert.deepEqual(readinessCapability(f.state,f.packet,f.readiness,f.settings),{requestedBand:1,protectedBand:3});
 f.readiness.fields.risk=choice('high',['low','medium','high','unknown']);assert.equal(readinessCapability(f.state,f.packet,f.readiness,f.settings),undefined);
 f.readiness.fields.capability.score=2;assert.equal(readinessCapability(f.state,f.packet,f.readiness,f.settings).protectedBand,4);
 f.readiness.fields.methodGate=choice('unknown',['none_observed','waiting','unknown']);assert.equal(readinessCapability(f.state,f.packet,f.readiness,f.settings),undefined);
});
test('readiness missing/partial/invalid probability and cooling-down candidates never become acceptance',()=>{
 for(const mutate of [f=>f.readiness.fields.readiness.confidence=.79,f=>f.readiness.fields.capability.confidence=.37,f=>delete f.readiness.fields.scope,f=>f.readiness.fields.risk={status:'invalid',reason:'invalid-probabilities'},f=>f.readiness.fields.methodGate=choice('waiting',['none_observed','waiting','unknown']),f=>f.state.task.cooldown=1,f=>f.state.task.dirty=true]){
  const f=fixture();mutate(f);assert.equal(readinessCapability(f.state,f.packet,f.readiness,f.settings),undefined);
 }
});

test('accepted-event append failure or source change after readiness cannot leave in-memory acceptance',async()=>{
 const f=fixture();let tool,accepted=0,calls=0;
 registerCapabilityHandoff({registerTool:t=>tool=t,appendEntry:()=>{if(++calls===2)throw Error('synthetic disk');}},{settings:()=>f.settings,current:()=>({state:f.state,input:{}}),valid:()=>true,readiness:async()=>f.readiness,accepted:()=>accepted++});
 assert.equal((await tool.execute('one',{packet:f.packet},undefined,undefined,f.ctx)).details.accepted,false);assert.equal(accepted,0);
 let valid=true;registerCapabilityHandoff({registerTool:t=>tool=t,appendEntry:()=>{}},{settings:()=>f.settings,current:()=>({state:f.state,input:{}}),valid:()=>valid,readiness:async()=>{valid=false;return f.readiness;},accepted:()=>accepted++});
 assert.equal((await tool.execute('one',{packet:f.packet},undefined,undefined,f.ctx)).details.accepted,false);assert.equal(accepted,0);
});

test('tool is inactive/sequential, rejects wrong mode in execute and cannot accept if persistence fails',async()=>{
 const f=fixture();let tool,calls=0,events=[];
 registerCapabilityHandoff({registerTool:t=>tool=t,appendEntry:(type,data)=>events.push({type,data})},{settings:()=>f.settings,current:()=>({state:f.state,input:{}}),valid:()=>true,readiness:async()=>{calls++;return f.readiness;},accepted:()=>{}});
 assert.equal(tool.defaultActive,false);assert.equal(tool.executionMode,'sequential');
 f.settings.routingMode='task';assert.equal((await tool.execute('one',{packet:f.packet},undefined,undefined,f.ctx)).details.reason,'inactive');assert.equal(calls,0);
 f.settings.routingMode='observer';const accepted=await tool.execute('one',{packet:f.packet},undefined,undefined,f.ctx);assert.equal(accepted.details.accepted,true);assert.equal(calls,1);assert.equal(events.at(-1).data.kind,'accepted');
 registerCapabilityHandoff({registerTool:t=>tool=t,appendEntry:()=>{throw Error('SECRET');}},{settings:()=>f.settings,current:()=>({state:f.state,input:{}}),valid:()=>true,readiness:async()=>{calls++;return f.readiness;},accepted:()=>{throw Error('must not happen');}});
 assert.equal((await tool.execute('two',{packet:f.packet},undefined,undefined,f.ctx)).details.accepted,false);assert.equal(calls,1);
});
