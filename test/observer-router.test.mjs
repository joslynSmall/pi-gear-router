import assert from 'node:assert/strict';
import {test,after}from'node:test';
import {mkdtempSync,writeFileSync,rmSync}from'node:fs';
import {tmpdir}from'node:os';import {join}from'node:path';
const dir=mkdtempSync(join(tmpdir(),'observer-router-'));process.env.PI_GEAR_ROUTER_DATA_DIR=dir;
const {default:extension}=await import('../src/index.ts');after(()=>rmSync(dir,{recursive:true,force:true}));
const model=id=>({provider:'synthetic',id,api:'openai-responses',reasoning:true,thinkingLevelMap:{off:'off',low:'low',medium:'medium',high:'high',xhigh:'xhigh'}});
function host(mode='observer'){
 writeFileSync(join(dir,'settings.json'),JSON.stringify({routingMode:mode,gears:Object.fromEntries(['light','standard','heavy'].map(g=>[g,{provider:'synthetic',model:g,thinkingLevel:'high'}]))}));
 let route,calls=0,active=[],statuses=[];const handlers=new Map(),entries=[],tools=[],commands=new Map(),notices=[];
 extension({on:(name,fn)=>{const old=handlers.get(name);handlers.set(name,async(...args)=>{const a=await old?.(...args);return await fn(...args)??a;});},appendEntry:(customType,data)=>entries.push({id:'e'+entries.length,type:'custom',customType,data}),registerVirtualModel:d=>route=d.route,registerTool:t=>tools.push(t),registerCommand:(name,command)=>commands.set(name,command),getActiveTools:()=>active,setActiveTools:a=>active=a});
 const ctx={mode:'tui',model:{provider:'gears',id:'auto'},cwd:dir,isProjectTrusted:()=>false,hasPendingMessages:()=>false,getSystemPrompt:()=>'',ui:{theme:{fg:(_c,t)=>t},setStatus:(_k,s)=>statuses.push(s),notify:(text,type)=>notices.push({text,type})},sessionManager:{getSessionId:()=>dir,getBranch:()=>entries,buildSessionProjection:()=>({entries:entries.filter(e=>e.type==='message').map(e=>({sourceEntry:e,messages:[e.message]}))})},modelRegistry:{find:(_p,id)=>model(id),hasConfiguredAuth:()=>true,getModelOfType:()=>({provider:'typesafe',id:'jev-latest'}),getProviderAuthStatus:()=>({configured:true}),classify:async(_m,input)=>{calls++;return {stopReason:'stop',answers:Object.fromEntries(Object.entries(input.questions).map(([k,q])=>[k,q.type==='score'?{type:'score',score:1.9,confidence:.95}:q.type==='bool'?{type:'bool',probability:0}:{type:'choice',choice:({relation:'same_task',messageEffect:'request_work',work:'design',clarity:'clear',risk:'low',methodGate:'none_observed'})[k],confidence:.95,probabilities:Object.fromEntries(Object.keys(q.criteria).map(l=>[l,l===({relation:'same_task',messageEffect:'request_work',work:'design',clarity:'clear',risk:'low',methodGate:'none_observed'})[k]?1:0]))}]))};}}};
 return {ctx,entries,handlers,statuses,tools,commands,notices,get active(){return active;},get calls(){return calls;},run:(request)=>route({reason:'user',messages:[],thinkingLevel:'high',...request},ctx)};
}
test('repeat/retry source reuse preserves dispatch and budget with no extra classification, TUI distinguishes demand',async()=>{
 const h=host();h.entries.push({id:'u',type:'message',message:{role:'user',content:'Synthetic design',timestamp:1}});
 await h.handlers.get('input')({text:'Synthetic design'},h.ctx);const first=await h.run({messages:[h.entries[0].message]});
 assert.equal(h.calls,1);assert.equal(first.state.capability.protectedBand,4);assert.match(h.statuses.at(-1),/^路由 收敛 → heavy · xhigh.*Jev 1\/24$/);
 for(const reason of ['user','retry','continuation']){const next=await h.run({reason,state:first.state,previous:{model:first.model,thinkingLevel:first.thinkingLevel}});assert.equal(next.model.id,first.model.id);}
 assert.equal(h.calls,1);
});
test('gear-status reads current branch facts without classifying, persists nothing, and clears status after manual selection',async()=>{
 const h=host();h.entries.push({id:'u',type:'message',message:{role:'user',content:'Synthetic design',timestamp:1}});
 const first=await h.run({messages:[h.entries[0].message]});
 h.entries.push({id:'state',type:'custom',customType:'pi.virtual-model-state',data:{provider:'gears',modelId:'auto',state:first.state}});
 assert.ok(h.commands.has('gear-status'));const before=h.entries.length;
 await h.commands.get('gear-status').handler('',h.ctx);
 assert.equal(h.entries.length,before);assert.equal(h.calls,1);assert.match(h.notices.at(-1).text,/持续任务：收敛，能力 band 4/);
 assert.match(h.notices.at(-1).text,/不表示实施批准或业务完成/);
 h.ctx.model=model('manual');await h.handlers.get('model_select')({},h.ctx);
 assert.equal(h.statuses.at(-1),undefined);
 await h.commands.get('gear-status').handler('',h.ctx);assert.match(h.notices.at(-1).text,/手选物理模型/);assert.equal(h.calls,1);
});

test('observer diagnostics are available in print/RPC without calling UI; failures preserve identity/usage ledger',async()=>{
 for(const mode of ['print','rpc']){
  const h=host();h.ctx.mode=mode;h.ctx.ui.setStatus=()=>{throw Error('UI must not be called');};
  h.entries.push({id:'u',type:'message',message:{role:'user',content:'Synthetic design',timestamp:1}});
  const result=await h.run({messages:[h.entries[0].message]});assert.equal(result.state.diagnostics.coverage,'known');
 }
 const h=host();h.entries.push({id:'u',type:'message',message:{role:'user',content:'Synthetic',timestamp:1}});
 h.ctx.modelRegistry.classify=async()=>({stopReason:'error',answers:{},errorMessage:'https://secret.invalid?credential=secret',usage:{input:5,output:0,totalTokens:5}});
 const result=await h.run({messages:[h.entries[0].message]});assert.equal(result.state.observation.outcome,'unavailable');assert.equal(result.state.budget.logicalCalls,1);
 assert.ok(!JSON.stringify(h.entries).includes('secret'));assert.equal(h.entries.find(e=>e.data?.usage).data.usage.input,5);
});

test('status tracks pending observation, branch accounting and accepted handoff without any extra Jev calls',async()=>{
 const h=host();h.entries.push({id:'u',type:'message',message:{role:'user',content:'Synthetic design',timestamp:1}});
 let release,entered;const started=new Promise(r=>entered=r),gate=new Promise(r=>release=r),classify=h.ctx.modelRegistry.classify;
 h.ctx.modelRegistry.classify=async(...args)=>{entered();await gate;return classify(...args);};
 const run=h.run({messages:[h.entries[0].message]});await started;
 assert.match(h.statuses.at(-1),/Jev 观察中/);release();const first=await run;
 h.entries.push({id:'state',type:'custom',customType:'pi.virtual-model-state',data:{provider:'gears',modelId:'auto',state:first.state}});
 const before=h.calls,notify=h.ctx.ui.notify;h.ctx.ui.notify=()=>{throw Error('No UI in print');};h.ctx.mode='print';
 await h.commands.get('gear-status').handler('',h.ctx);assert.equal(h.calls,before);h.ctx.mode='tui';h.ctx.ui.notify=notify;
 const lastCall=first.state.budget.calls[0];
 h.entries.push({id:'usage',type:'custom',customType:'pi-gear-router.observer.v1',data:{version:1,kind:'call-result',identity:first.state.turn,budgetOwnerId:first.state.budget.ownerId,call:{...lastCall,attempts:2,status:'stale'},usage:{input:3,output:1,totalTokens:4}}});
 await h.commands.get('gear-status').handler('',h.ctx);assert.match(h.notices.at(-1).text,/transport attempts：2/);
 assert.equal(h.calls,before);
});

test('finishing an old observation after session/tree replacement cannot repaint the new empty branch',async()=>{
 const h=host();h.entries.push({id:'u',type:'message',message:{role:'user',content:'Synthetic',timestamp:1}});
 let release,entered;const gate=new Promise(r=>release=r),started=new Promise(r=>entered=r),classify=h.ctx.modelRegistry.classify;
 h.ctx.modelRegistry.classify=async(...args)=>{entered();await gate;return classify(...args);};
 const pending=h.run({messages:[h.entries[0].message]});await started;
 h.entries.splice(0);await h.handlers.get('session_tree')({},h.ctx);const cleared=h.statuses.length;
 release();await pending;assert.ok(h.statuses.slice(cleared).every(s=>s===undefined),JSON.stringify(h.statuses));
});

test('A20 all resolved modes have exactly one tool owner; execute refusal does not rely on inactive exposure',async()=>{
 for(const [mode,workflow,expected]of [['task',false,[]],['observer',false,['gear_capability_handoff']],['observer',true,['gear_workflow_handoff']],['task',true,['gear_workflow_handoff']],['legacy-workflow',false,['gear_workflow_handoff']],['disabled',true,[]],['bad',false,[]]]){
  const h=host(mode);const file=JSON.parse((await import('node:fs')).readFileSync(join(dir,'settings.json'),'utf8'));file.workflow={enabled:workflow};if(mode==='disabled')file.enabled=false;writeFileSync(join(dir,'settings.json'),JSON.stringify(file));
  await h.handlers.get('before_agent_start')({systemPromptOptions:{skills:[]}},h.ctx);assert.deepEqual(h.active,expected,`${mode}/${workflow}`);
  for(const tool of h.tools){if(expected.includes(tool.name))continue;const result=await tool.execute('synthetic',{packet:{}},undefined,undefined,h.ctx);assert.equal(result.details.accepted,false);}
 }
});

test('mode round trip invalidates pending capability acceptance even with unchanged source and policy restored',async()=>{
 const h=host();h.entries.push({id:'u',type:'message',message:{role:'user',content:'Synthetic design',timestamp:1}});
 await h.handlers.get('input')({text:'Synthetic design'},h.ctx);const first=await h.run({messages:[h.entries[0].message]});
 h.entries.push({id:'state',type:'custom',customType:'pi.virtual-model-state',data:{provider:'gears',modelId:'auto',state:first.state}});
 h.ctx.modelRegistry.classify=async(_m,input)=>({stopReason:'stop',answers:Object.fromEntries(Object.entries(input.questions).map(([k,q])=>[k,q.type==='score'?{type:'score',score:.6,confidence:.95}:{type:'choice',choice:{readiness:'ready',scope:'relevant',clarity:'clear',risk:'low',methodGate:'none_observed'}[k],confidence:.95,probabilities:Object.fromEntries(Object.keys(q.criteria).map(l=>[l,l==={readiness:'ready',scope:'relevant',clarity:'clear',risk:'low',methodGate:'none_observed'}[k]?1:0]))}]))});
 const packet={version:1,taskId:first.state.task.id,sourceUserEntryId:'u',nextWork:'implement',goal:'Synthetic',scope:['one'],nonGoals:[],decisions:[],steps:[{change:'one',acceptance:['check']}],constraints:[],validation:['check'],risks:[],blockingUnknowns:[],methodGate:'none_reported',permissionEvidence:[],reason:'work-converged'};
 const tool=h.tools.find(t=>t.name==='gear_capability_handoff'),accepted=await tool.execute('handoff',{packet},undefined,undefined,h.ctx);assert.equal(accepted.details.accepted,true);assert.match(h.statuses.at(-1),/交接已接受·未消费/);
 h.entries.push({id:'tool',type:'message',message:{role:'toolResult',toolCallId:'handoff',toolName:tool.name,isError:false,details:accepted.details,content:accepted.content,timestamp:2}});
 const {readFileSync}=await import('node:fs');const settings=JSON.parse(readFileSync(join(dir,'settings.json'),'utf8'));
 writeFileSync(join(dir,'settings.json'),JSON.stringify({...settings,enabled:false}));await h.run({reason:'continuation',state:first.state,previous:{model:first.model,thinkingLevel:first.thinkingLevel}});
 writeFileSync(join(dir,'settings.json'),JSON.stringify(settings));await h.run({reason:'continuation',state:first.state,previous:{model:first.model,thinkingLevel:first.thinkingLevel}});
 assert.equal(h.entries.filter(e=>e.data?.kind==='consumed').length,0);assert.ok(h.entries.some(e=>e.data?.kind==='invalidated'));
});

test('retry status and details show actual returned physical pair, without rewriting persistent task demand',async()=>{
 const h=host();h.entries.push({id:'u',type:'message',message:{role:'user',content:'Synthetic',timestamp:1}});
 const first=await h.run({messages:[h.entries[0].message]});h.entries.push({id:'state',type:'custom',customType:'pi.virtual-model-state',data:{provider:'gears',modelId:'auto',state:first.state}});
 const retry=await h.run({reason:'retry',state:first.state,failed:{model:model('standard'),thinkingLevel:'medium'}});
 assert.equal(retry.model.id,'standard');assert.match(h.statuses.at(-1),/→ standard · medium/);
 await h.commands.get('gear-status').handler('',h.ctx);assert.match(h.notices.at(-1).text,/实际派发：synthetic\/standard · medium/);
 assert.equal(first.state.capability.taskBand,4);assert.equal(first.state.dispatch.model,'heavy');assert.equal(h.calls,1);
});

test('direct and reduced SDK remain bounded physical fallback without guidance or classification',async()=>{
 const h=host();assert.equal((await h.run({reason:'direct'})).model.id,'light');assert.equal(h.calls,0);
 delete h.ctx.sessionManager.buildSessionProjection;assert.equal((await h.run({})).model.id,'standard');assert.equal(h.calls,0);
});
