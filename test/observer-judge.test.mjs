import assert from 'node:assert/strict';
import { test } from 'node:test';
import { handoffQuestions, observerQuestions, parseObserverAnswers, parseObserverField, observeTurn } from '../src/observer-judge.ts';
const input = () => ({ schema: 'observer-input-v1', request: 'Synthetic review', methodObservations: [], controlFacts: [], recentPublicAssistant: [], executionFacts: [], skills: { candidates: [], total: 0, coverage: 'known' }, missing: [], nonTextInput: false });
function answers(i) {
  return Object.fromEntries(Object.entries(observerQuestions(i)).map(([key,q]) => [key, q.type === 'score' ? { type:'score', score:1, confidence:.95 }
    : q.type === 'bool' ? { type:'bool', probability:.9 } : { type:'choice', choice:Object.keys(q.criteria)[0], confidence:.95,
      probabilities:Object.fromEntries(Object.keys(q.criteria).map((l,n) => [l, n === 0 ? 1 : 0])) }]));
}

test('single schema includes task relation only when present and at most 12 real candidate booleans', () => {
  const i = input(); i.skills = { candidates: Array.from({length:12},(_,n)=>({candidateId:`c${n}`,name:`method-${n}`,description:'Synthetic'})),total:12,coverage:'known' };
  assert.equal(Object.keys(observerQuestions(i)).length,19); assert.ok(Object.keys(observerQuestions(i)).length <= 20);
  i.task = { id:'t', anchor:'Synthetic', userChanges:[] }; assert.equal(Object.keys(observerQuestions(i)).length,20); assert.ok(Object.keys(observerQuestions(i)).length <= 21);
  assert.equal(observerQuestions(i).skill_0.type,'bool'); assert.ok(!Object.keys(observerQuestions(i)).includes('authorization'));
});

test('handoff capability anchors distinguish mechanical work, engineering decisions, and heavy reasoning without changing gates', () => {
  const q = handoffQuestions.capability;
  assert.equal(q.type, 'score'); assert.equal(q.criteria.length, 3);
  assert.match(q.criteria[0], /well-scoped.*obvious approach/);
  assert.match(q.criteria[1], /implementation decisions/);
  assert.match(q.criteria[2], /subtle root-cause analysis/);
  assert.equal(Object.keys(handoffQuestions).length, 6);
  assert.ok(!Object.keys(handoffQuestions).includes('permission'));
});

test('strict per-field parsing rejects 0.99/1.01, chosen nonmax/extra labels without dropping independent valid fields', () => {
  const i=input(), a=answers(i);
  assert.equal(parseObserverAnswers({stopReason:'stop',answers:a},i).outcome,'valid');
  for(const sum of [.99,1.01]) {
    const b=structuredClone(a); b.risk.probabilities.low=sum;
    const r=parseObserverAnswers({stopReason:'stop',answers:b},i); assert.equal(r.outcome,'partial');
    assert.equal(r.fields.risk.status,'invalid'); assert.equal(r.fields.capability.status,'valid');
  }
  const extra=structuredClone(a); extra.work.probabilities.extra=0;
  assert.equal(parseObserverAnswers({stopReason:'stop',answers:extra},i).fields.work.status,'invalid');
  a.risk.choice='high'; assert.equal(parseObserverAnswers({stopReason:'stop',answers:a},i).fields.risk.status,'invalid');
});

test('strict tolerance boundaries and numeric domains are applied without probability normalization',()=>{
 const q=observerQuestions(input()).risk;
 for(const sum of [.99901,1.00099]){const f=parseObserverField({type:'choice',choice:'low',confidence:.9,probabilities:{low:sum,medium:0,high:0,unknown:0}},q);assert.equal(f.status,sum>1?'invalid':'valid');if(f.status==='valid')assert.equal(f.probabilities.low,sum);}
 assert.equal(parseObserverField({type:'choice',choice:'low',confidence:.9,probabilities:{low:.9,medium:.10101,high:0,unknown:0}},q).status,'invalid');
 assert.equal(parseObserverField({type:'choice',choice:'low',confidence:.9,probabilities:{low:.9,medium:.10099,high:0,unknown:0}},q).status,'valid');
 for(const p of [NaN,Infinity,-.1,1.1])assert.equal(parseObserverField({type:'bool',probability:p},observerQuestions(input()).clarification).status,'invalid');
});

test('low-confidence valid, missing field, invalid shapes and adapter-cleared answers remain distinct', () => {
  const i=input(), a=answers(i); a.work.confidence=.2;
  assert.equal(parseObserverAnswers({stopReason:'stop',answers:a},i).fields.work.status,'valid');
  delete a.risk; assert.equal(parseObserverAnswers({stopReason:'stop',answers:a},i).fields.risk.status,'missing');
  a.capability.score=NaN; assert.equal(parseObserverAnswers({stopReason:'stop',answers:a},i).fields.capability.status,'invalid');
  assert.equal(parseObserverAnswers({stopReason:'error',answers:{},errorMessage:'secret token'},i).outcome,'unavailable');
  assert.ok(!JSON.stringify(parseObserverAnswers({stopReason:'error',answers:{},errorMessage:'secret token'},i)).includes('secret'));
});

test('adapter targets only classifier Jev, disables provider retry and never makes a repair call for invalid output', async () => {
  let calls=0, optionsSeen;
  const ctx={modelRegistry:{getModelOfType:(type,p,id)=>{assert.deepEqual([type,p,id],['classifier','typesafe','jev-latest']);return {provider:p,id};},
    hasConfiguredAuth:()=>true, classify:async (_model,_context,options)=>{calls++;optionsSeen=options;return {stopReason:'stop',answers:{},usage:{input:3,output:1,totalTokens:4}};}}};
  const result=await observeTurn(ctx,input(),{timeoutMs:100,maxTransportRetries:1});
  assert.equal(calls,1);assert.equal(optionsSeen.maxRetries,0);assert.equal(result.result.outcome,'invalid'); assert.equal(result.attempts,1);
  assert.equal(result.usage.input,3);
});

test('transport retries are at most one with a shared deadline; parser failures preserve usage and never repair', async () => {
  const previous=globalThis.fetch;let attempts=0;
  globalThis.fetch=async()=>{attempts++;if(attempts===1)throw Error('synthetic transport');return new Response('{}');};
  try {
    const i=input(),ctx={modelRegistry:{getModelOfType:()=>({provider:'typesafe',id:'jev-latest'}),getProviderAuthStatus:()=>({configured:true}),
      classify:async(_model,_input,options)=>{try{await options.fetch('https://synthetic.invalid');return {stopReason:'stop',answers:answers(i)};}catch{return {stopReason:'error',answers:{}};}}}};
    const result=await observeTurn(ctx,i,{timeoutMs:100,maxTransportRetries:1});assert.equal(result.attempts,2);assert.equal(result.result.outcome,'valid');
    assert.equal(attempts,2);
    const invalid=parseObserverAnswers({stopReason:'error',answers:{},errorMessage:'System One API did not return a choice answer for work'},i);
    assert.equal(invalid.outcome,'invalid');assert.equal(invalid.failure,'invalid-shape');
    const missing=await observeTurn({modelRegistry:{getModelOfType:()=>undefined}},i,{timeoutMs:100,maxTransportRetries:0});assert.equal(missing.attempts,0);
  } finally {globalThis.fetch=previous;}
});

test('classifier-only environment auth uses async public resolution, not chat-only synchronous snapshot',async()=>{
 let calls=0;const i=input(),ctx={modelRegistry:{getModelOfType:()=>({provider:'typesafe',id:'jev-latest'}),getProviderAuthStatus:()=>({configured:false}),getProviderAuth:async()=>({auth:{apiKey:'synthetic'}}),classify:async()=>{calls++;return {stopReason:'stop',answers:answers(i)};}}};
 assert.equal((await observeTurn(ctx,i,{timeoutMs:100,maxTransportRetries:0})).result.outcome,'valid');assert.equal(calls,1);
 ctx.modelRegistry.getProviderAuth=()=>new Promise(()=>{});assert.equal((await observeTurn(ctx,i,{timeoutMs:10,maxTransportRetries:0})).result.failure,'timeout');assert.equal(calls,1);
});

test('deadline bounds even an adapter ignoring abort and external abort propagates', async () => {
  const ctx={modelRegistry:{getModelOfType:()=>({provider:'typesafe',id:'jev-latest'}),hasConfiguredAuth:()=>true,classify:()=>new Promise(()=>{})}};
  const result=await observeTurn(ctx,input(),{timeoutMs:10,maxTransportRetries:0});assert.equal(result.result.failure,'timeout');
  const c=new AbortController();const work=observeTurn(ctx,input(),{timeoutMs:10000,maxTransportRetries:0,signal:c.signal});c.abort();
  await assert.rejects(work,/abort/i);
});
