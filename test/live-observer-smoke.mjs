// Standalone opt-in. No network or credentials are accessed in default mode.
import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
const plan={syntheticOnly:true,classifier:'typesafe/jev-latest',classifierCalls:6,classifierAttempts:6,chatCalls:4,chatMaxOutputTokens:2000,
 classifierDeadlineMs:15000,chatDeadlineMs:45000,totalDeadlineMs:150000,transportRetries:0,
 fixtures:['runtime investigation with capability handoff','same-task explanation','alternate directory','no Skills','large directory/12 candidate maximum schema'],
 probabilityTolerance:.001,report:process.argv.includes('--budget-fix')?'docs/observer-guided-routing-budget-fix-smoke.json':process.argv.includes('--handoff-anchors-v2')?'docs/observer-guided-routing-anchors-v2-smoke.json':process.argv.includes('--visible-catalog')?'docs/observer-guided-routing-visible-smoke.json':'docs/observer-guided-routing-live-smoke.json',
 visibleCatalog:process.argv.includes('--visible-catalog')||process.argv.includes('--handoff-anchors-v2')||process.argv.includes('--budget-fix'),
 expected:{runtimeWork:'investigate',relevantSkillIndex:0,irrelevantSkillIndices:[1,2,3,4,5,6,7,8,9,10,11],handoff:'one explicit capability candidate; no approval or business completion'}};
console.log(JSON.stringify({plan},null,2));
if(!process.argv.includes('--run'))process.exit(0);
const temp=mkdtempSync(join(tmpdir(),'pi-observer-live-')),agentDir=join(homedir(),'.pi','agent');
const personal=['auth.json','models.json','pi-gear-router/settings.json'].map(p=>join(agentDir,p));
const digest=p=>existsSync(p)?createHash('sha256').update(readFileSync(p)).digest('hex'):null;
const before=personal.map(digest),env=process.env.PI_GEAR_ROUTER_DATA_DIR;
const report={version:1,startedAt:new Date().toISOString(),plan,classifier:[],routes:[],responses:[],semantic:[],events:[],limits:{},passed:false};
let session,runtime,timer,chatCalls=0,classifierCalls=0,stage='setup';
const deadline=Date.now()+plan.totalDeadlineMs;
try{
 for(const name of ['auth.json','models.json'])if(existsSync(join(agentDir,name))){copyFileSync(join(agentDir,name),join(temp,name));chmodSync(join(temp,name),0o600);}
 if(existsSync(join(agentDir,'pi-gear-router','settings.json')))copyFileSync(join(agentDir,'pi-gear-router','settings.json'),join(temp,'settings.json'));
 const {ModelRuntime,SettingsManager,DefaultResourceLoader,SessionManager,createAgentSession,createSyntheticSourceInfo,formatSkillsForPrompt}=await import('@earendil-works/pi-coding-agent');
 process.env.PI_GEAR_ROUTER_DATA_DIR=temp;
 const {loadSettings}=await import('../src/settings.ts');const original=loadSettings();
 const settings={...original,routingMode:'observer',workflow:{...original.workflow,enabled:false},observer:{...original.observer,maxCallsPerTask:6,maxTransportRetries:0},judgeTimeoutMs:15000};
 writeFileSync(join(temp,'settings.json'),JSON.stringify(settings),{mode:0o600});
 runtime=await ModelRuntime.create({authPath:join(temp,'auth.json'),modelsPath:existsSync(join(temp,'models.json'))?join(temp,'models.json'):null,modelsStorePath:join(temp,'catalog.json'),allowModelNetwork:false,refreshOnCreate:false});
 stage='classifier-catalog';assert.ok(runtime.getModelOfType('classifier','typesafe','jev-latest'));stage='classifier-auth';assert.ok(await runtime.getAuth('typesafe'));
 for(const [gear,target] of Object.entries(settings.gears)){stage=`target-catalog-${gear}`;assert.ok(runtime.getModel(target.provider,target.model));stage=`target-auth-${gear}`;assert.ok(runtime.getProviderAuthStatus(target.provider).configured);}stage='sdk-setup';
 report.targets=settings.gears;
 const {parseObserverField,observeTurn}=await import('../src/observer-judge.ts');
 const nativeClassify=runtime.classify.bind(runtime);
 runtime.classify=async(model,context,options)=>{
  assert.ok(classifierCalls<plan.classifierCalls,'classifier call cap');assert.ok(Date.now()<deadline,'total deadline');classifierCalls++;
  assert.equal(model.provider,'typesafe');assert.equal(model.id,'jev-latest');assert.equal(options.maxRetries,0);
  assert.ok(!JSON.stringify(context.state).includes(temp),'No local Skill path in classifier input');
  const start=Date.now(),result=await nativeClassify(model,context,{...options,maxRetries:0});
  const fields=Object.fromEntries(Object.entries(context.questions).map(([key,question])=>[key,parseObserverField(result.answers[key],question)]));
  const safe={model:`${model.provider}/${model.id}`,elapsedMs:Date.now()-start,stopReason:result.stopReason,questions:Object.keys(context.questions),answers:result.answers,validatedFields:fields,...(result.usage?{usage:result.usage}:{})};
  report.classifier.push(safe);return result;
 };
 const nativeStream=runtime.streamSimple.bind(runtime);
 runtime.streamSimple=(model,context,options)=>{
  assert.ok(chatCalls<plan.chatCalls,'chat call cap');assert.ok(Date.now()<deadline,'total deadline');chatCalls++;
  report.responses.push({model:`${model.provider}/${model.id}`,thinking:options?.reasoning??'off',guidePresent:JSON.stringify(context.messages).includes('路由观察建议')});
  return nativeStream(model,context,{...options,maxTokens:plan.chatMaxOutputTokens,maxRetries:0,timeoutMs:Math.min(plan.chatDeadlineMs,Math.max(1,deadline-Date.now()))});
 };
 const skills=Array.from({length:12},(_,n)=>{
  const baseDir=join(temp,'skills',`synthetic-method-${n}`);mkdirSync(baseDir,{recursive:true});const filePath=join(baseDir,'SKILL.md');
  writeFileSync(filePath,'Synthetic fixture body. No approvals or instructions.',{mode:0o600});return {name:`synthetic-method-${n}`,description:n===0?'Review synthetic repository changes and documentation alignment':'Mechanical synthetic number formatting',filePath,baseDir,disableModelInvocation:false,sourceInfo:createSyntheticSourceInfo(filePath,{source:'sdk'})};
 });
 const settingsManager=SettingsManager.inMemory({retry:{enabled:false},providerRetry:{maxRetries:0},compaction:{enabled:false},cacheWarming:'off',packages:[]});
 const {default:router}=await import('../src/index.ts');
 const resourceLoader=new DefaultResourceLoader({cwd:temp,agentDir:temp,settingsManager,noExtensions:true,noSkills:true,noPromptTemplates:true,noThemes:true,noContextFiles:true,skillsOverride:()=>({skills,diagnostics:[]}),
  systemPrompt:'Synthetic bounded observer routing smoke. No real repository or user data. Do not claim permission or business completion. First investigate the synthetic compatibility question, then submit at most one gear_capability_handoff using the task/source IDs from the controlled context. Synthetic scope: a reversible string trimmer that rejects blank keys; no compatibility unknowns, external inputs or approvals. Packet nextWork implement, scope and one step/acceptance and validation nonempty, blockingUnknowns empty, methodGate none_reported. Do not read files or perform implementation. After the handoff result only give a short explanation (at most 100 words); do not call the tool again. For a subsequent explanation request, only answer briefly without tools.',
  extensionFactories:[...(plan.visibleCatalog?[pi=>pi.on('tool_call',event=>{
   if(event.toolName!=='read')return;
   const path=typeof event.input.path==='string'?resolve(temp,event.input.path):'';
   if(!skills.some(skill=>resolve(skill.filePath)===path))return {block:true,reason:'Smoke reader permits only synthetic Skill files'};
  })]:[]),pi=>router({...pi,registerVirtualModel:d=>pi.registerVirtualModel({...d,route:async(request,ctx)=>{const result=await d.route(request,ctx);const s=result.state;report.routes.push({reason:request.reason,model:`${result.model.provider}/${result.model.id}`,thinking:result.thinkingLevel,...(s?.schema==='observer-routing'?{profile:s.capability.turnProfile,requested:s.capability.requestedBand,protected:s.capability.protectedBand,budget:s.budget.logicalCalls,transitions:s.budget.transitions,outcome:s.observation?.outcome??'reused',taskBand:s.capability.taskBand,taskId:s.task?.id}:{})});return result;}})})]});
 await resourceLoader.reload();assert.deepEqual(resourceLoader.getExtensions().errors,[]);
 ({session}=await createAgentSession({cwd:temp,agentDir:temp,modelRuntime:runtime,settingsManager,resourceLoader,sessionManager:SessionManager.inMemory(temp),model:runtime.getModel(settings.gears.heavy.provider,settings.gears.heavy.model),tools:plan.visibleCatalog?['read','gear_capability_handoff']:['gear_capability_handoff']}));
 const errors=[];await session.bindExtensions({mode:'print',onError:e=>errors.push(e.event??'extension-error')});await session.setModel(runtime.getModel('gears','auto'));
 timer=setTimeout(()=>{void session.abort();},Math.max(1,deadline-Date.now()));
 await session.prompt(plan.visibleCatalog
  ? 'Investigate the synthetic string-trimmer design and documentation alignment, then prepare one capability handoff for the already specified implementation work. Synthetic scope and acceptance: trim a string key, reject an empty key, preserve the string value. This test approves producing analysis and capability materials only; it does not request actual code writes. There is no pending project or method approval gate for producing those materials. Scope is reversible, bounded and fully specified, no dependencies or compatibility unknowns. Use current task/source IDs. Keep the explanation brief; do not read any personal files or execute code.'
  : 'Investigate the synthetic string-trimmer design and documentation alignment. The task is reversible and fully specified: reject blank keys after trim, preserve values. Prepare one bounded capability handoff for implementation but do not implement. This is synthetic test work only.');
 await session.prompt('Explain the current conclusion in two sentences. Do not continue implementation or submit another handoff.');
 const branch=session.sessionManager.getBranch();
 report.events=branch.filter(e=>e.type==='custom'&&e.customType==='pi-gear-router.capability.v1').map(e=>({kind:e.data.kind,id:e.data.id}));
 report.toolResults=branch.filter(e=>e.type==='message'&&e.message.role==='toolResult'&&e.message.toolName==='gear_capability_handoff').map(e=>({isError:e.message.isError,accepted:e.message.details?.accepted??false,reason:e.message.details?.reason??'unknown'}));
 report.guideStatuses=branch.filter(e=>e.type==='custom'&&e.customType==='pi-gear-router.observer.v1'&&e.data.guidance).map(e=>e.data.guidance.status);
 report.assistant=branch.filter(e=>e.type==='message'&&e.message.role==='assistant').map(e=>({stopReason:e.message.stopReason,model:`${e.message.provider}/${e.message.model}`,usage:e.message.usage}));
 // Separate bounded native Jev fixtures; same schema/parser, no chat coordinator.
 const {captureCatalog,selectCatalogCandidates}=await import('../src/observer-guidance.ts');
 for(const [label,count]of [['alternate-directory',2],['no-skills',0],['large-directory',30]]){
  if(classifierCalls>=plan.classifierCalls)break;
  const metadata=Array.from({length:count},(_,n)=>({...skills[n%12],name:`alternate-${n}`,description:n===0?'Review synthetic repository changes and documentation':'Synthetic unrelated formatting'}));
  const catalog=captureCatalog(metadata,temp,1),messages=[{role:'system',content:'',sections:{skills:`<skills>\n${formatSkillsForPrompt(metadata,'read').trim()}\n</skills>`},timestamp:1}];
  const selected=selectCatalogCandidates(catalog,messages,'Review synthetic repository changes and documentation');
  const input={schema:'observer-input-v1',request:'Review synthetic repository changes and documentation for design consistency, do not implement.',task:{id:'synthetic-task',anchor:'Synthetic alignment review',userChanges:[]},methodObservations:[],controlFacts:[],recentPublicAssistant:[],executionFacts:[],skills:{candidates:selected.candidates,total:selected.total,coverage:selected.coverage},missing:[],nonTextInput:false};
  // maximum current schema uses exactly 12 candidates, not invented unused questions.
  if(label==='large-directory')input.skills={candidates:skills.map((s,n)=>({candidateId:`synthetic-${n}`,name:s.name,description:s.description})),total:30,coverage:'partial'};
  const observed=await observeTurn({modelRegistry:{getModelOfType:(...a)=>runtime.getModelOfType(...a),getProviderAuth:p=>runtime.getAuth(p),classify:(...a)=>runtime.classify(...a)}},input,{timeoutMs:15000,maxTransportRetries:0});
  report.semantic.push({fixture:label,outcome:observed.result.outcome,work:observed.result.fields.work,capability:observed.result.fields.capability,skills:observed.result.skills,coverage:input.skills.coverage,candidates:input.skills.candidates.length,
   recall:{total:selected.total,considered:selected.candidates.length,omitted:selected.omitted,capacityFixture:label==='large-directory'},
   expectedRelevantCandidate:input.skills.candidates[0]?.candidateId??null,
   suggested:observed.result.skills.filter(s=>s.field.status==='valid'&&s.field.type==='bool'&&s.field.probability>=.7).map(s=>s.candidateId)});
 }
 report.invalidFields=report.classifier.flatMap((row,index)=>Object.entries(row.validatedFields).filter(([,field])=>field.status==='invalid').map(([name,field])=>({call:index+1,name,reason:field.reason})));
 report.fieldValidity={total:report.classifier.reduce((n,c)=>n+Object.keys(c.validatedFields).length,0),invalid:report.invalidFields.length,
  missing:report.classifier.reduce((n,c)=>n+Object.values(c.validatedFields).filter(f=>f.status==='missing').length,0)};
 report.limits={classifierCalls,chatCalls,actualAttempts:classifierCalls};report.extensionErrors=errors;
 report.transportPassed=errors.length===0&&report.assistant.every(a=>!['error','aborted'].includes(a.stopReason))&&report.routes.length>=2;
 report.handoff={accepted:report.events.some(e=>e.kind==='accepted'),consumed:report.events.some(e=>e.kind==='consumed'),physicalResponseObserved:report.events.some(e=>e.kind==='physical-response-observed')};
  const consumedRoute=report.routes.find(r=>r.reason==='continuation'&&r.transitions>0);
 report.budgetContinuity=!report.handoff.consumed||!!consumedRoute&&report.routes.slice(report.routes.indexOf(consumedRoute)+1).filter(r=>r.taskId===consumedRoute.taskId).every(r=>r.transitions>=consumedRoute.transitions);
 report.passed=report.budgetContinuity&&report.transportPassed&&report.handoff.accepted&&report.handoff.consumed&&report.handoff.physicalResponseObserved&&(!plan.visibleCatalog||report.responses.some(r=>r.guidePresent));if(!report.passed)process.exitCode=1;report.qualityAcceptance='Exploratory synthetic evidence; no accuracy, universal gate, cache or cost guarantee';
}catch(error){report.failureStage=stage;report.limits={classifierCalls,chatCalls};report.failure=error?.name==='AssertionError'?'fixture-assertion-failed':error?.name==='AbortError'?'deadline-or-abort':'service-or-adapter-error';process.exitCode=1;
}finally{
 clearTimeout(timer);
 try{await session?.abort();}catch{report.cleanupRuntimeFailure=true;process.exitCode=1;}
 try{session?.dispose();await runtime?.dispose?.();}catch{report.cleanupRuntimeFailure=true;process.exitCode=1;}
 report.personalFilesUnchanged=personal.every((p,i)=>digest(p)===before[i]);if(!report.personalFilesUnchanged)process.exitCode=1;
 if(env===undefined)delete process.env.PI_GEAR_ROUTER_DATA_DIR;else process.env.PI_GEAR_ROUTER_DATA_DIR=env;
 rmSync(temp,{recursive:true,force:true});report.temporaryCredentialsCleaned=!existsSync(temp);
 writeFileSync(join(process.cwd(),plan.report),JSON.stringify(report,null,2)+'\n');
 console.log(JSON.stringify({passed:report.passed,transportPassed:report.transportPassed,budgetContinuity:report.budgetContinuity,handoff:report.handoff,limits:report.limits,invalidFields:report.invalidFields,personalFilesUnchanged:report.personalFilesUnchanged,temporaryCredentialsCleaned:report.temporaryCredentialsCleaned,report:plan.report},null,2));
}
