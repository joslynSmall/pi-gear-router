import assert from 'node:assert/strict';
import {test}from'node:test';
import {spawnSync}from'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,existsSync}from'node:fs';
import {tmpdir}from'node:os';import {join}from'node:path';
test('live observer smoke default is offline and never reads auth, rewrites reports or bypasses opt-in',t=>{
 const dir=mkdtempSync(join(tmpdir(),'observer-smoke-offline-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const sentinel=join(dir,'auth.json');writeFileSync(sentinel,'DO NOT READ');
 const guard=join(dir,'guard.mjs');writeFileSync(guard,`globalThis.fetch=()=>{throw Error('NETWORK_FORBIDDEN');};`);
 const report='docs/observer-guided-routing-live-smoke.json',before=existsSync(report)?readFileSync(report,'utf8'):undefined;
 const result=spawnSync(process.execPath,['--import',guard,'test/live-observer-smoke.mjs'],{encoding:'utf8',env:{...process.env,HOME:dir,PI_GEAR_ROUTER_DATA_DIR:dir},timeout:10000});
 assert.equal(result.status,0,result.stderr);assert.ok(result.stdout.includes('"classifierCalls": 6'));assert.ok(!result.stdout.includes('DO NOT READ'));
 assert.equal(readFileSync(sentinel,'utf8'),'DO NOT READ');assert.equal(existsSync(report)?readFileSync(report,'utf8'):undefined,before);
});

test('budget-fix smoke plan is opt-in, uses visible synthetic catalog and never overwrites historical reports by default',()=>{
 const reports=['docs/observer-guided-routing-live-smoke.json','docs/observer-guided-routing-visible-smoke.json','docs/observer-guided-routing-anchors-v2-smoke.json','docs/observer-guided-routing-budget-fix-smoke.json'];
 const before=reports.map(p=>existsSync(p)?readFileSync(p,'utf8'):undefined);
 const result=spawnSync(process.execPath,['test/live-observer-smoke.mjs','--budget-fix'],{encoding:'utf8',timeout:10000});
 assert.equal(result.status,0,result.stderr);const {plan}=JSON.parse(result.stdout);
 assert.equal(plan.visibleCatalog,true);assert.equal(plan.report,reports[3]);assert.equal(plan.classifierCalls,6);assert.equal(plan.chatCalls,4);
 assert.deepEqual(reports.map(p=>existsSync(p)?readFileSync(p,'utf8'):undefined),before);
});

test('live smoke setup failure records only safe category, leaves fake personal config unchanged and cleans temporary credentials',t=>{
 const dir=mkdtempSync(join(tmpdir(),'observer-smoke-failure-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 mkdirSync(join(dir,'docs'));const authDir=join(dir,'.pi','agent');mkdirSync(authDir,{recursive:true});const authPath=join(authDir,'auth.json');writeFileSync(authPath,'{}');
 const guard=join(dir,'guard.mjs');writeFileSync(guard,`globalThis.fetch=()=>{throw Error('NETWORK_FORBIDDEN');};`);
 const result=spawnSync(process.execPath,['--import',guard,join(process.cwd(),'test/live-observer-smoke.mjs'),'--run'],{cwd:dir,encoding:'utf8',env:{HOME:dir,PATH:process.env.PATH,NODE_OPTIONS:''},timeout:10000});
 assert.equal(result.status,1,result.stderr);const report=JSON.parse(readFileSync(join(dir,'docs','observer-guided-routing-live-smoke.json'),'utf8'));
 assert.equal(report.failureStage,'classifier-auth');assert.equal(report.limits.classifierCalls,0);assert.equal(report.temporaryCredentialsCleaned,true);assert.equal(report.personalFilesUnchanged,true);
 assert.equal(readFileSync(authPath,'utf8'),'{}');assert.ok(!JSON.stringify(report).includes('NETWORK_FORBIDDEN'));
});
