import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildObserverInput } from '../src/observer-guidance.ts';
const options = text => ({ snapshot: { projectedMessage: { role:'user',content:text,timestamp:1 },identity:{userEntryId:'u'},projectionDigest:'x' }, recent:[],facts:[],skills:{candidates:[],total:0,coverage:'known'} });

test('external input excludes thinking/images/tool/system while preserving actual public request', () => {
  const o=options([{type:'text',text:'Synthetic request'},{type:'image',data:'SECRET_IMAGE',mimeType:'image/png'}]);
  o.recent=[{sourceEntryId:'a',message:{role:'assistant',content:[{type:'thinking',thinking:'SECRET_THINKING',thinkingSignature:'SECRET_SIGNATURE'},{type:'text',text:'Public answer'}]}},
    {sourceEntryId:'tool',message:{role:'toolResult',content:[{type:'text',text:'SECRET_TOOL'}]}}];
  const result=buildObserverInput(o); assert.ok(result);assert.equal(result.request,'Synthetic request');assert.equal(result.nonTextInput,true);
  assert.deepEqual(result.recentPublicAssistant,[{sourceEntryId:'a',text:'Public answer'}]);assert.ok(!JSON.stringify(result).includes('SECRET'));
});

test('long Unicode and multibyte input remains within independent limits, prioritizing source over old context', () => {
  const o=options('😀'.repeat(20000));o.recent=[{sourceEntryId:'a',message:{role:'assistant',content:'😀'.repeat(10000)}}];
  const before=structuredClone(o);const result=buildObserverInput(o);assert.ok(result);
  assert.ok([...result.request].length<=16000);assert.ok(Buffer.byteLength(JSON.stringify(result))<=65536);assert.ok([...JSON.stringify(result)].length<=32000);
  assert.deepEqual(o,before);assert.ok(result.missing.includes('input-truncated'));
});

test('unknown explicit expansion does not export body/path; reliable expansion exports selection and arguments only', () => {
  const o=options('<skill name="synthetic" location="/SECRET_PATH">\nSECRET_BODY\n</skill>\n\nSynthetic request');
  const unknown=buildObserverInput(o);assert.equal(unknown.request,'');assert.ok(unknown.missing.includes('explicit-expansion-unverified'));
  assert.ok(!JSON.stringify(unknown).includes('SECRET'));
  o.explicit={identity:'a'.repeat(64),name:'synthetic',request:'Synthetic request'};
  const known=buildObserverInput(o);assert.equal(known.request,'Synthetic request');assert.equal(known.selectedSkill.name,'synthetic');
  assert.ok(!JSON.stringify(known).includes('SECRET'));
});
