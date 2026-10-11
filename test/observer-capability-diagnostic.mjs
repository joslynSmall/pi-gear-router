// 独立诊断原型；默认只重放已保存的输出，不读取认证、不联网。
import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { defaultSettings } from '../src/gears.ts';
import { handoffQuestions, parseObserverField, checkCapabilityHandoff } from '../src/observer-judge.ts';
import { readinessCapability } from '../src/observer-handoff.ts';
export const plan = { syntheticOnly: true, classifier: 'typesafe/jev-latest', calls: 8, attempts: 8, chatCalls: 0,
  deadlineMs: 15000, totalDeadlineMs: 120000, retries: 0, repetitions: 2,
  arms: ['baseline', 'detailed-anchors', 'next-work-boundary', 'minimal-context'],
  report: 'docs/observer-capability-diagnostic.json', productionPolicyChanged: false };
const settings = defaultSettings(); settings.routingMode = 'observer';
const state = { capability: { taskBand: 3 }, task: { dirty: false, cooldown: 0 } };
const packet = { version: 1, taskId: 'synthetic-task', sourceUserEntryId: 'synthetic-user', nextWork: 'implement',
  goal: 'Implement a bounded string-key trimmer', scope: ['One pure function over a string key and string value'],
  nonGoals: ['No repository integration, persistence, network, or API changes'],
  decisions: [{ decision: 'Trim only the key, preserve the value', rationale: 'Fixed synthetic acceptance' }],
  steps: [{ change: 'Trim the key, reject it if empty after trimming, return the trimmed key and unchanged value',
    acceptance: ['Whitespace-padded key is trimmed', 'Blank key is rejected', 'Value remains identical'] }],
  constraints: ['All inputs are strings', 'No dependency or compatibility decisions remain'],
  validation: ['Synthetic cases for blank, padded, and nonblank keys and unchanged values'],
  risks: ['Reversible isolated pure function only'], blockingUnknowns: [], methodGate: 'none_reported',
  permissionEvidence: [], reason: 'work-converged' };
const context = { schema: 'observer-input-v1', request: 'Investigate the synthetic string-trimmer design and documentation alignment, then prepare one capability handoff for already specified implementation. Do not implement during this test. No pending approval for preparing capability materials.',
  task: { id: 'synthetic-task', anchor: 'Synthetic string-trimmer alignment review', userChanges: [] },
  recentPublicAssistant: [{ sourceEntryId: 'synthetic-assistant', text: 'Synthetic analysis: trim the key, reject blank keys, preserve values. Scope and acceptance are fixed. No compatibility unknowns remain.' }],
  methodObservations: [], controlFacts: [], executionFacts: [], skills: { candidates: [], total: 0, coverage: 'known' }, missing: [], nonTextInput: false };
export function evaluate(answers) {
  const fields = Object.fromEntries(Object.entries(handoffQuestions).map(([name, q]) => [name, parseObserverField(answers?.[name], q)]));
  const decision = readinessCapability(state, packet, { fields }, settings);
  return { fields, acceptedByPolicy: !!decision, ...(decision ? { bands: decision } : {}),
    validFields: Object.values(fields).filter(f => f.status === 'valid').length };
}
export function replay() {
  const reports = ['docs/observer-guided-routing-live-smoke.json', 'docs/observer-guided-routing-visible-smoke.json'];
  return reports.map(path => {
    if (!existsSync(path)) return { path, available: false };
    const saved = JSON.parse(readFileSync(path, 'utf8'));
    const rows = saved.classifier.filter(row => row.questions.includes('readiness'));
    return { path, available: true, readinessCalls: rows.length, rows: rows.map(row => ({ stopReason: row.stopReason, ...evaluate(row.answers) })),
      limitation: 'Only saved output is replayed with a fixed local band-3 policy fixture; original live packet/input was not recorded. Not a new live run.' };
  });
}
console.log(JSON.stringify({ plan, replay: replay() }, null, 2));
if (!process.argv.includes('--run')) process.exit(0);
const digest = path => existsSync(path) ? createHash('sha256').update(readFileSync(path)).digest('hex') : null;
const personal = ['auth.json', 'models.json', 'pi-gear-router/settings.json'].map(p => join(homedir(), '.pi', 'agent', p));
const before = personal.map(digest), temp = mkdtempSync(join(tmpdir(), 'pi-capability-diagnostic-'));
const report = { version: 1, startedAt: new Date().toISOString(), plan, fixture: { packet, context, taskBand: 3 }, rows: [], passed: false };
let runtime, stage = 'setup', calls = 0;
const controller = new AbortController(), start = Date.now();
const timer = setTimeout(() => controller.abort(), plan.totalDeadlineMs);
try {
  for (const [index, name] of ['auth.json', 'models.json'].entries()) if (existsSync(personal[index])) {
    copyFileSync(personal[index], join(temp, name)); chmodSync(join(temp, name), 0o600);
  }
  const { ModelRuntime } = await import('@earendil-works/pi-coding-agent');
  runtime = await ModelRuntime.create({ authPath: join(temp, 'auth.json'), modelsPath: existsSync(join(temp, 'models.json')) ? join(temp, 'models.json') : null,
    modelsStorePath: join(temp, 'catalog.json'), allowModelNetwork: false, refreshOnCreate: false });
  stage = 'classifier-catalog'; assert.ok(runtime.getModelOfType('classifier', 'typesafe', 'jev-latest'));
  // checkCapabilityHandoff resolves public auth inside its shared bounded deadline.
  stage = 'classify';
  for (let repetition = 0; repetition < plan.repetitions; repetition++) for (const arm of plan.arms) {
    controller.signal.throwIfAborted();
    let captured;
    const ctx = { modelRegistry: { getModelOfType: (...args) => runtime.getModelOfType(...args), getProviderAuth: p => runtime.getAuth(p),
      classify: async (model, input, options) => {
        assert.ok(calls < plan.calls); assert.equal(options.maxRetries, 0); assert.equal(model.provider, 'typesafe'); assert.equal(model.id, 'jev-latest');
        const probe = structuredClone(input);
        // Freeze the original short anchors: production may evolve after this diagnostic.
        probe.questions.capability.criteria = ['Light mechanical', 'Standard engineering', 'Heavy convergence or high cost of error'];
        if (arm === 'detailed-anchors') probe.questions.capability.criteria = [
          'Light: straightforward, well-scoped work with an obvious approach, such as formatting, a simple lookup, a mechanical edit, or a small low-risk change.',
          'Standard: typical coding-agent work requiring repository inspection, implementation decisions, debugging, or coordinated changes with moderate uncertainty.',
          'Heavy: work requiring unusually deep reasoning or caution, such as subtle root-cause analysis, architecture decisions, broad refactors, security-sensitive changes, high ambiguity, or high-cost failure.' ];
        if (arm === 'next-work-boundary') probe.questions.capability.instructions += ' Rate only packet.nextWork, packet.scope and packet.steps after convergence, not the earlier investigation or the act of preparing this packet. The packet reports bounded material, not permission.';
        if (arm === 'minimal-context') {
          probe.state.request = 'Assess the bounded proposed next work in the synthetic packet; do not execute it or infer permission.';
          probe.state.task = null; probe.state.recentPublicAssistant = [];
        }
        calls++;
        const result = await runtime.classify(model, probe, { ...options, maxRetries: 0 });
        captured = { stopReason: result.stopReason, ...evaluate(result.answers), ...(result.usage ? { usage: result.usage } : {}),
          inputDigest: createHash('sha256').update(JSON.stringify(probe.state)).digest('hex'), questions: probe.questions };
        return result;
      } } };
    const at = Date.now();
    const execution = await checkCapabilityHandoff(ctx, { packet, context }, { timeoutMs: Math.min(plan.deadlineMs, Math.max(1, plan.totalDeadlineMs - (Date.now() - start))),
      maxTransportRetries: 0, signal: controller.signal });
    report.rows.push({ arm, repetition: repetition + 1, elapsedMs: Date.now() - at, attempts: execution.attempts,
      ...(captured ?? { failure: execution.result.failure ?? 'no-transport-output' }) });
    // Late adapter output cannot become a persisted successful probe row.
  }
  report.completed = report.rows.length === plan.calls;
  report.summary = plan.arms.map(arm => {
    const rows = report.rows.filter(row => row.arm === arm);
    return { arm, calls: rows.length, allFieldsValid: rows.filter(r => r.validFields === 6 && r.stopReason === 'stop').length,
      acceptedByPolicy: rows.filter(r => r.acceptedByPolicy && r.stopReason === 'stop').length,
      scores: rows.map(r => r.fields?.capability ?? { status: 'missing' }) };
  });
  report.passed = report.completed && report.rows.every(r => r.stopReason === 'stop' && r.validFields === 6);
  report.interpretation = 'Diagnostic transport/schema completion only. Acceptance is exploratory; no production prompt/policy change, no real handoff consumed. Two repeats per arm cannot establish calibration or causality.';
  if (!report.passed) process.exitCode = 1;
} catch (error) {
  report.failureStage = stage;
  report.failure = error?.name === 'AbortError' ? 'deadline-or-abort' : error?.name === 'AssertionError' ? 'fixture-assertion-failed' : 'service-or-adapter-error';
  process.exitCode = 1;
} finally {
  clearTimeout(timer);
  try { await runtime?.dispose?.(); } catch { report.runtimeCleanupFailure = true; process.exitCode = 1; }
  report.personalFilesUnchanged = personal.every((p, i) => digest(p) === before[i]);
  rmSync(temp, { recursive: true, force: true }); report.temporaryCredentialsCleaned = !existsSync(temp);
  if (!report.personalFilesUnchanged || !report.temporaryCredentialsCleaned) process.exitCode = 1;
  report.limits = { calls, attempts: report.rows.reduce((sum, r) => sum + r.attempts, 0), chatCalls: 0, elapsedMs: Date.now() - start };
  writeFileSync(join(process.cwd(), plan.report), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ summary: report.summary, limits: report.limits, failure: report.failure,
    personalFilesUnchanged: report.personalFilesUnchanged, temporaryCredentialsCleaned: report.temporaryCredentialsCleaned }, null, 2));
}
