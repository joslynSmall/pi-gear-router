import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { SessionManager, VIRTUAL_MODEL_STATE_ENTRY } from '@earendil-works/pi-coding-agent';
const dir=mkdtempSync(join(tmpdir(),'gear-session-'));
process.env.PI_GEAR_ROUTER_DATA_DIR=dir;
const {default:extension}=await import('../src/index.ts');
after(()=>rmSync(dir,{recursive:true,force:true}));
const user=(content,timestamp)=>({role:'user',content,timestamp});
function setup(session=SessionManager.inMemory(dir)) {
  writeFileSync(join(dir,'settings.json'),JSON.stringify({gears:Object.fromEntries(['light','standard','heavy'].map(g=>[g,{provider:'offline',model:g,thinkingLevel:'low'}]))}));
  let route,n=0;const commands=new Map();
  extension({on:()=>{},registerCommand:(name,cmd)=>commands.set(name,cmd),appendEntry:(type,data)=>session.appendCustomEntry(type,data),registerVirtualModel:d=>{route=d.route;}});
  const ctx={cwd:dir,mode:'print',hasUI:false,model:{provider:'gears',id:'auto'},sessionManager:session,ui:{notify:()=>{}},
    modelRegistry:{find:(_p,id)=>({provider:'offline',id,api:'openai-responses',reasoning:true}),hasConfiguredAuth:()=>true,getModelOfType:()=>({}),
      classify:async()=>({stopReason:'stop',answers:{gear:{type:'score',score:++n===1?1.9:1,confidence:.9}},usage:{input:10}})}};
  const state=()=>session.getBranch().findLast(e=>e.type==='custom'&&e.customType===VIRTUAL_MODEL_STATE_ENTRY)?.data.state;
  const run=async()=>{const r=await route({reason:'user',thinkingLevel:'high',state:state(),messages:session.buildSessionProjection().messages},ctx);if(r.state)session.appendCustomEntry(VIRTUAL_MODEL_STATE_ENTRY,{provider:'gears',modelId:'auto',state:r.state});return r;};
  return {session,run,state,calls:()=>n,command:p=>commands.get('gear-phase').handler(p,ctx)};
}
test('phase survives real SessionManager compaction and ordinary new messages without rejudgment',async()=>{
  const h=setup();const first=h.session.appendMessage(user('complex design',1));await h.run();
  h.session.appendCompaction('summary',first,1000);h.session.appendMessage(user('继续',2));
  assert.equal((await h.run()).model.id,'heavy');assert.equal(h.calls(),1);
  await h.command('implement');h.session.appendMessage(user('继续',3));assert.equal((await h.run()).model.id,'standard');assert.equal(h.calls(),2);
});
test('tree navigation isolates pending phase commands and restores original phase/gear',async()=>{
  const h=setup();h.session.appendMessage(user('complex design',1));await h.run();const root=h.session.getLeafId();
  await h.command('implement');h.session.appendMessage(user('继续',2));await h.run();assert.equal(h.state().phase,'implement');
  h.session.branch(root);h.session.appendMessage(user('另一条分支',3));await h.run();
  assert.equal(h.state().phase,'plan');assert.equal(h.state().gear,'heavy');assert.equal(h.calls(),2);
});
test('reopen and branched-session restore phase and consumed command without classifier call',async()=>{
  const h=setup(SessionManager.create(dir,join(dir,'sessions')));
  h.session.appendMessage(user('complex design',1));await h.run();await h.command('implement');h.session.appendMessage(user('执行',2));await h.run();
  // A real response causes the SessionManager to flush its buffered session entries to disk.
  h.session.appendMessage({role:'assistant',content:[{type:'text',text:'done'}],api:'openai-responses',provider:'offline',model:'standard',stopReason:'stop',timestamp:3,
    usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}});
  const reopened=setup(SessionManager.open(h.session.getSessionFile()));reopened.session.appendMessage(user('继续',4));
  assert.equal((await reopened.run()).model.id,'standard');assert.equal(reopened.calls(),0);assert.equal(reopened.state().phase,'implement');
  const forkPath=h.session.createBranchedSession(h.session.getLeafId());assert.ok(forkPath);
  const fork=setup(SessionManager.open(forkPath));fork.session.appendMessage(user('继续',5));
  assert.equal((await fork.run()).model.id,'standard');assert.equal(fork.calls(),0);
});
