import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';

test('real offline SDK loop: first judge, explicit phase command, sticky tool follow-up, no workflow tools', {timeout:20000}, async()=>{
  const dir=mkdtempSync(join(tmpdir(),'gear-sdk-'));process.env.PI_GEAR_ROUTER_DATA_DIR=dir;
  let session;const originalFetch=globalThis.fetch;
  globalThis.fetch=async()=>{throw new Error('Network forbidden in offline SDK test');};
  try {
    const {default:router}=await import('../src/index.ts');
    writeFileSync(join(dir,'settings.json'),JSON.stringify({gears:Object.fromEntries(['light','standard','heavy'].map(g=>[g,{provider:'offline',model:g,thinkingLevel:g==='heavy'?'high':'low'}]))}));
    writeFileSync(join(dir,'fixture.txt'),'hello');
    const runtime=await ModelRuntime.create({authPath:join(dir,'auth.json'),modelsPath:null,modelsStorePath:join(dir,'models.json'),allowModelNetwork:false,refreshOnCreate:false});
    runtime.registerProvider('offline',{api:'openai-responses',baseUrl:'https://offline.invalid',apiKey:'offline',models:['light','standard','heavy'].map(id=>({id,name:id,reasoning:true,thinkingLevelMap:{low:'low',high:'high'},input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:100000,maxTokens:10000}))});
    let classifiers=0;const routes=[],inputs=[];
    runtime.classify=async(_m,input)=>{inputs.push(input);return {stopReason:'stop',answers:{gear:{type:'score',score:++classifiers===1?1.9:1,confidence:.9}},usage:{input:42}};};
    const stream=(model,context,options)=>{
      routes.push({model:model.id,thinking:options.reasoning});
      const invoke=context.messages.at(-1)?.role==='user'&&JSON.stringify(context.messages.at(-1)).includes('读文件');
      const message={role:'assistant',content:invoke?[{type:'toolCall',id:'read-file',name:'read',arguments:{path:join(dir,'fixture.txt')}}]:[{type:'text',text:'Answer.'}],
        api:model.api,provider:model.provider,model:model.id,stopReason:invoke?'toolUse':'stop',timestamp:Date.now(),
        usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}};
      const events=createAssistantMessageEventStream();events.push({type:'start',partial:message});events.push({type:'done',reason:message.stopReason,message});return events;
    };
    runtime.streamSimple=stream;runtime.stream=stream;
    const settingsManager=SettingsManager.inMemory({compaction:{enabled:false},retry:{enabled:false},providerRetry:{maxRetries:0},cacheWarming:{enabled:false},packages:[]});
    const loader=new DefaultResourceLoader({cwd:dir,agentDir:dir,settingsManager,noExtensions:true,noSkills:true,noContextFiles:true,noPromptTemplates:true,noThemes:true,extensionFactories:[router]});
    await loader.reload();assert.equal(loader.getExtensions().errors.length,0);
    const manager=SessionManager.inMemory(dir);
    ({session}=await createAgentSession({cwd:dir,agentDir:dir,modelRuntime:runtime,model:runtime.getModel('offline','heavy'),resourceLoader:loader,settingsManager,sessionManager:manager,tools:['read']}));
    await session.bindExtensions({mode:'print',onError:error=>{throw new Error(error.message);}});
    await session.setModel(runtime.getModel('gears','auto'));
    const state=()=>manager.getBranch().findLast(e=>e.type==='custom'&&e.customType==='pi.virtual-model-state')?.data.state;
    await session.prompt('设计复杂功能');assert.equal(classifiers,1);assert.equal(state().phase,'plan');assert.equal(routes.at(-1).model,'heavy');
    await session.prompt('开始实现');assert.equal(classifiers,1);assert.equal(state().phase,'plan','print has no dialog; keywords cannot silently approve');
    const before=routes.length;await session.prompt('/gear-phase implement');assert.equal(routes.length,before);assert.equal(classifiers,1);
    await session.prompt('读文件');assert.equal(classifiers,2);assert.equal(state().phase,'implement');assert.equal(inputs[1].state.phase,'implement');
    assert.deepEqual(routes.slice(before),[{model:'standard',thinking:'low'},{model:'standard',thinking:'low'}]);
    await session.prompt('继续');assert.equal(classifiers,2);
    await session.prompt('/gear-phase plan');await session.prompt('继续设计');assert.equal(classifiers,2);assert.equal(state().phase,'plan');assert.equal(routes.at(-1).model,'heavy');
    assert.deepEqual(session.getActiveToolNames(),['read']);
    assert.ok(!manager.getBranch().some(e=>e.type==='custom_message'),'no guidance messages inserted');
    assert.ok(!manager.getBranch().some(e=>e.type==='custom'&&/observer|workflow|observation/.test(e.customType)));
  } finally {session?.dispose();globalThis.fetch=originalFetch;rmSync(dir,{recursive:true,force:true});}
});
