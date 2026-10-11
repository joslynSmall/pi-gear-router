import assert from 'node:assert/strict';
import { test } from 'node:test';
import { judgeGear, resilientFetch } from '../src/judge.ts';
const user = (content, timestamp = 1) => ({ role: 'user', content, timestamp });
function harness(answer = { type: 'score', score: 1.2, confidence: .8 }) {
  const calls = [], ctx = { modelRegistry: { getModelOfType: () => ({}), classify: async (_model, input, options) => {
    calls.push({ input, options }); return { stopReason: 'stop', answers: { gear: answer }, usage: { input: 10 } };
  } } };
  return { ctx, calls, run: (messages, phase = 'plan', ms = 1234, signal) => judgeGear(ctx, messages, phase, ms, signal) };
}
test('judge sends routed request and public recent text, never system/thinking/tools/images', async () => {
  const h = harness();
  const r = await h.run([{ role: 'system', content: 'system secret' }, user('old'),
    { role: 'assistant', content: [{ type: 'thinking', thinking: 'secret' }, { type: 'text', text: 'plan' }] },
    { role: 'toolResult', content: [{ type: 'text', text: 'tool secret' }] },
    user([{ type: 'image', data: 'secret' }, { type: 'text', text: 'current' }], 2)], 'implement');
  assert.deepEqual(r, { judgment: { score: 1.2, confidence: .8, inputTokens: 10 } });
  assert.deepEqual(h.calls[0].input.state, { phase: 'implement', request: 'current', recent: [{ role: 'user', text: 'old' }, { role: 'assistant', text: 'plan' }] });
  assert.equal(h.calls[0].options.timeoutMs, 1234); assert.equal(h.calls[0].options.maxRetries, 0);
  assert.equal(typeof h.calls[0].options.fetch, 'function');
});
test('request preserves head/tail and recent context is bounded by count and code points', async () => {
  const h = harness(); const prior = Array.from({ length: 20 }, (_, i) => user('😀'.repeat(1500), i));
  await h.run([...prior, user('HEAD' + 'x'.repeat(20000) + 'TAIL', 21)]);
  const s = h.calls[0].input.state; assert.equal(s.request.length,16000); assert.ok(s.request.startsWith('HEAD')); assert.ok(s.request.endsWith('TAIL'));
  assert.equal(s.recent.length,6); assert.ok(s.recent.every(m => [...m.text].length <= 1000));
});
test('missing classifier, empty/image-only text and provider errors are safe failures', async () => {
  const h = harness();
  assert.equal((await h.run([])).failure,'empty-request');
  assert.equal((await h.run([user([{type:'image',data:'x'}])])).failure,'empty-request');
  h.ctx.modelRegistry.getModelOfType = () => undefined; assert.equal((await h.run([user('task')])).failure,'classifier-model-missing');
  h.ctx.modelRegistry.getModelOfType = () => ({});
  h.ctx.modelRegistry.classify = async () => { throw new Error('contains private provider data'); };
  assert.equal((await h.run([user('task')])).failure,'classifier-error');
  h.ctx.modelRegistry.classify = async () => ({stopReason:'error',answers:{}});
  assert.equal((await h.run([user('task')])).failure,'classify-error');
});
test('numeric validation rejects non-finite/out-of-range judgments and wrong types', async () => {
  for(const answer of [{type:'choice'},{type:'score',score:NaN,confidence:.8},{type:'score',score:2.1,confidence:.8},{type:'score',score:1,confidence:Infinity},{type:'score',score:-1,confidence:.8},{type:'score',score:1,confidence:1.1}])
    assert.equal((await harness(answer).run([user('task')])).failure,'invalid-answer');
});
test('missing/invalid usage is zero, not an invalid verdict', async () => {
  const h = harness(); h.ctx.modelRegistry.classify = async () => ({stopReason:'stop',answers:{gear:{type:'score',score:0,confidence:1}},usage:{input:NaN}});
  assert.equal((await h.run([user('task')])).judgment.inputTokens,0);
});
test('combined timeout and outer abort cancel transport without extra calls', async () => {
  for(const outer of [false,true]) {
    const h=harness(), controller=new AbortController();
    h.ctx.modelRegistry.classify = async (_m,_i,options) => new Promise((resolve,reject) => {
      const timer=setTimeout(()=>resolve({stopReason:'stop',answers:{}}),1000);
      options.signal.addEventListener('abort',()=>{clearTimeout(timer);reject(options.signal.reason);},{once:true});
      if(outer) controller.abort();
    });
    assert.equal((await h.run([user('task')],'plan',20,controller.signal)).failure,'aborted-or-timeout');
  }
});
test('registry lookup exceptions fall back, and a stalled adapter is bounded even before transport', async () => {
  const h=harness(); h.ctx.modelRegistry.getModelOfType=()=>{throw new Error('catalog not ready');};
  assert.equal((await h.run([user('task')])).failure,'classifier-error');
  h.ctx.modelRegistry.getModelOfType=()=>({});
  h.ctx.modelRegistry.classify=()=>new Promise(resolve=>setTimeout(()=>resolve({stopReason:'stop',answers:{}}),80));
  assert.equal((await h.run([user('task')],'plan',10)).failure,'aborted-or-timeout');
});
test('transport failures retry at most twice; HTTP failures do not get fetch-level retries', async () => {
  const original=globalThis.fetch;
  try {
    let n=0; globalThis.fetch=async()=>{if(++n<3)throw new TypeError('fetch failed');return new Response('{}');};
    await resilientFetch(AbortSignal.timeout(3000))('http://offline'); assert.equal(n,3);
    n=0; globalThis.fetch=async()=>{n++;return new Response('{}',{status:401});};
    const r=await resilientFetch(AbortSignal.timeout(3000))('http://offline');assert.equal(r.status,401);assert.equal(n,1);
    n=0; globalThis.fetch=async()=>{n++;throw new TypeError('fetch failed');};
    await assert.rejects(resilientFetch(AbortSignal.timeout(3000))('http://offline'),/fetch failed/);assert.equal(n,3);
  } finally {globalThis.fetch=original;}
});
