import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { registerObserverFacts, observerBranchFacts } from '../src/observation.ts';
const identity = { sessionId: 's', userEntryId: 'u', userContentDigest: 'a'.repeat(64), policyFingerprint: 'b'.repeat(64), inputEpoch: 1, branchEpoch: 0, catalogVersion: 'c'.repeat(64) };
function fixture() {
  const manager = SessionManager.inMemory(process.cwd()), handlers = new Map(), events = []; let write = true;
  const actual = { ...identity, sessionId: manager.getSessionId(), userEntryId: manager.appendMessage({ role: 'user', content: 'Synthetic work', timestamp: 1 }) };
  const pi = { on: (name, handler) => handlers.set(name, handler), appendEntry: (customType, data) => { if (!write) throw Error('sensitive error'); events.push(data); manager.appendCustomEntry(customType, data); } };
  const ctx = { sessionManager: manager, model: { provider: 'gears', id: 'auto' }, hasPendingMessages: () => false };
  const options = { enabled: () => true, identity: () => actual, skillForPath: path => path === '/synthetic/method/SKILL.md' ? { identity: 'd'.repeat(64), catalogVersion: actual.catalogVersion } : undefined };
  const facts = registerObserverFacts(pi, options);
  return { manager, handlers, events, actual, ctx, facts, set writable(v) { write = v; } };
}

test('supported verification results record bounded facts; success is not business completion', () => {
  const f = fixture(), handler = f.handlers.get('tool_result');
  handler({ toolName: 'bash', input: { command: 'npm test' }, structuredContent: { exit_code: 0, output: 'SECRET' }, isError: false }, f.ctx);
  handler({ toolName: 'bash', input: { command: 'npm test' }, structuredContent: { exit_code: 1, output: 'SECRET' }, isError: true }, f.ctx);
  handler({ toolName: 'bash', input: { command: 'npm test' }, structuredContent: { exit_code: 1 }, isError: true }, f.ctx);
  const result = observerBranchFacts(f.ctx, f.actual, f.facts.coverage(f.ctx));
  assert.equal(result.dirty, true); assert.equal(result.executionFacts.length, 2);
  assert.deepEqual(result.executionFacts.map(f => f.kind), ['verification-passed', 'verification-failed']);
  assert.ok(!JSON.stringify(f.events).includes('SECRET')); assert.ok(!JSON.stringify(f.events).includes('npm test'));
  assert.equal(result.complete, undefined);
});

test('successfully reading a runtime Skill records identity/catalog only; nested incomplete coverage stays unknown', () => {
  const f = fixture(), handler = f.handlers.get('tool_result');
  handler({ toolName: 'read', input: { path: '/synthetic/method/SKILL.md' }, isError: false, parentToolCallId: 'parent' }, f.ctx);
  const result = observerBranchFacts(f.ctx, f.actual, f.facts.coverage(f.ctx));
  assert.equal(result.executionFacts[0].kind, 'body-read-observed'); assert.equal(result.executionFacts[0].skillIdentity, 'd'.repeat(64));
  assert.equal(result.executionFacts[0].catalogVersion, 'c'.repeat(64)); assert.ok(!JSON.stringify(f.events).includes('/synthetic'));
  f.handlers.get('message_end')({ message: { role: 'toolResult', nestedCalls: { complete: false, calls: [] } } }, f.ctx);
  assert.equal(f.facts.coverage(f.ctx), 'unknown');
});

test('explicit expansion observation remains scoped, deduplicated and does not declare following', () => {
  const f=fixture(),skill={identity:'d'.repeat(64),catalogVersion:'c'.repeat(64)};
  assert.equal(f.facts.recordExplicit(f.ctx,f.actual,skill),true);
  assert.equal(f.facts.recordExplicit(f.ctx,f.actual,skill),true);assert.equal(f.events.length,1);
  assert.equal(f.events[0].fact.kind,'explicit-expansion-observed');assert.equal(f.events[0].following,undefined);
  assert.equal(f.facts.recordExplicit(f.ctx,{...f.actual,userEntryId:'other'},skill),false);
});

test('wrong branch, failed read, inconsistent verification, pending input and append failure do not fabricate evidence', () => {
  const f = fixture(), handler = f.handlers.get('tool_result');
  handler({ toolName: 'read', input: { path: '/synthetic/method/SKILL.md' }, isError: true }, f.ctx);
  handler({ toolName: 'bash', input: { command: 'npm test' }, structuredContent: { exit_code: 1 }, isError: false }, f.ctx);
  handler({ toolName: 'bash', input: { command: 'echo SECRET' }, structuredContent: { exit_code: 1 }, isError: true }, f.ctx);
  assert.equal(f.events.length, 0);
  f.writable = false;
  handler({ toolName: 'bash', input: { command: 'npm test' }, structuredContent: { exit_code: 1 }, isError: true }, f.ctx);
  assert.equal(f.facts.coverage(f.ctx), 'unknown');
  assert.equal(observerBranchFacts(f.ctx, { ...f.actual, userEntryId: 'abandoned' }, 'known').coverage, 'unknown');
});
