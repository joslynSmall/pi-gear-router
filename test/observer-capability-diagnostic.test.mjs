import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('capability diagnostic default replays actual low-confidence output offline without auth or report write', t => {
  const dir = mkdtempSync(join(tmpdir(), 'capability-replay-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const guard = join(dir, 'guard.mjs'); writeFileSync(guard, `globalThis.fetch=()=>{throw Error('NETWORK_FORBIDDEN');};`);
  const path = 'docs/observer-capability-diagnostic.json', before = existsSync(path) ? readFileSync(path, 'utf8') : undefined;
  const result = spawnSync(process.execPath, ['--import', guard, 'test/observer-capability-diagnostic.mjs'], {
    encoding: 'utf8', env: { ...process.env, HOME: dir }, timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout); assert.equal(output.plan.calls, 8); assert.equal(output.plan.chatCalls, 0);
  const replay = output.replay.find(r => r.path.includes('visible-smoke'));
  assert.equal(replay.readinessCalls, 1); assert.equal(replay.rows[0].validFields, 6);
  assert.equal(replay.rows[0].fields.capability.confidence, .37);
  assert.equal(replay.rows[0].acceptedByPolicy, false, 'Original live output cannot accept band-3 handoff');
  assert.equal(existsSync(path) ? readFileSync(path, 'utf8') : undefined, before);
});

test('capability diagnostic missing auth is bounded, safe, and cleans temporary copies', t => {
  const dir = mkdtempSync(join(tmpdir(), 'capability-failure-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'docs')); mkdirSync(join(dir, '.pi', 'agent'), { recursive: true });
  const auth = join(dir, '.pi', 'agent', 'auth.json'); writeFileSync(auth, '{}');
  const guard = join(dir, 'guard.mjs'); writeFileSync(guard, `globalThis.fetch=()=>{throw Error('NETWORK_FORBIDDEN');};`);
  const result = spawnSync(process.execPath, ['--import', guard, join(process.cwd(), 'test/observer-capability-diagnostic.mjs'), '--run'], {
    cwd: dir, encoding: 'utf8', env: { HOME: dir, PATH: process.env.PATH, NODE_OPTIONS: '' }, timeout: 10000 });
  assert.equal(result.status, 1, result.stderr);
  const report = JSON.parse(readFileSync(join(dir, 'docs', 'observer-capability-diagnostic.json'), 'utf8'));
  assert.equal(report.passed, false); assert.equal(report.limits.calls, 0);
  assert.equal(report.personalFilesUnchanged, true); assert.equal(report.temporaryCredentialsCleaned, true);
  assert.equal(readFileSync(auth, 'utf8'), '{}'); assert.ok(!JSON.stringify(report).includes('NETWORK_FORBIDDEN'));
});
