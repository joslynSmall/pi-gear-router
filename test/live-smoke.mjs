// Explicitly opt-in: real classifier/model calls can incur charges. Not included in npm test.
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';

if (!process.argv.includes('--run')) {
  console.log('Opt-in live verification: node test/live-smoke.mjs --run');
  process.exit(0);
}
const agentDir = join(homedir(), '.pi', 'agent');
const temporary = mkdtempSync(join(tmpdir(), 'pi-gear-live-'));
const logPath = join(temporary, 'results.json');
const report = { startedAt: new Date().toISOString(), classifiers: [], routes: [], turns: [], probes: [] };
const log = (kind, data) => console.log(JSON.stringify({ kind, ...data }));
let session;
let globalTimer;
let sequence = 0;
let timedOut = false;
try {
  // Credential refresh writes only to this temporary copy; personal files are untouched.
  const authPath = join(temporary, 'auth.json');
  if (existsSync(join(agentDir, 'auth.json'))) copyFileSync(join(agentDir, 'auth.json'), authPath);
  copyFileSync(join(agentDir, 'pi-gear-router', 'settings.json'), join(temporary, 'settings.json'));
  process.env.PI_GEAR_ROUTER_DATA_DIR = temporary;
  const { default: router } = await import('../src/index.ts');
  const { loadSettings } = await import('../src/settings.ts');
  const settings = loadSettings();
  assert.notEqual(settings.enabled, false, 'Live verification requires enabled routing');
  report.configuration = { gearBias: settings.gearBias, judgeTimeoutMs: settings.judgeTimeoutMs, gears: settings.gears, taskRouting: settings.taskRouting };
  const runtime = await ModelRuntime.create({
    authPath, modelsPath: join(agentDir, 'models.json'), modelsStorePath: join(temporary, 'models-cache.json'),
    allowModelNetwork: false,
  });
  assert.ok(runtime.getModelOfType('classifier', 'typesafe', 'jev-latest'), 'Jev missing from catalog');
  assert.ok(runtime.hasConfiguredAuth('typesafe'), 'Jev credentials not configured');
  for (const target of Object.values(settings.gears)) {
    assert.ok(runtime.getModel(target.provider, target.model), `Missing model ${target.provider}/${target.model}`);
    assert.ok(runtime.hasConfiguredAuth(target.provider), `Unconfigured provider ${target.provider}`);
  }
  log('preflight', report.configuration);

  const classify = runtime.classify.bind(runtime);
  runtime.classify = async (model, context, options) => {
    const started = Date.now();
    const result = await classify(model, context, options);
    const answer = result.answers.gear;
    const record = {
      turn: sequence, model: `${model.provider}/${model.id}`, durationMs: Date.now() - started,
      request: context.state.request, stopReason: result.stopReason,
      score: answer?.type === 'score' ? answer.score : null,
      confidence: answer?.type === 'score' ? answer.confidence : null,
      relation: result.answers.relation ?? null,
      usage: result.usage,
    };
    report.classifiers.push(record);
    log('classifier', record);
    return result;
  };
  // Limit every real physical model call, including tool continuations.
  const streamSimple = runtime.streamSimple.bind(runtime);
  runtime.streamSimple = (model, context, options) => streamSimple(model, context, {
    ...options, maxTokens: 6000, maxRetries: 0, timeoutMs: 90000,
  });
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false }, retry: { enabled: false }, providerRetry: { maxRetries: 0 },
    cacheWarming: { enabled: false }, packages: [],
  });
  const resourceLoader = new DefaultResourceLoader({
    cwd: temporary, agentDir: temporary, settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    systemPrompt: 'You are a coding assistant in a synthetic smoke test. Be concise. Do not access files except the explicitly named smoke-fixture.txt. Use read only when the user requests it. Do not write files or run commands.',
    extensionFactories: [(pi) => router({
      on: pi.on.bind(pi),
      appendEntry: pi.appendEntry.bind(pi),
      registerVirtualModel(definition) {
        pi.registerVirtualModel({ ...definition, async route(request, ctx) {
          const started = Date.now();
          const result = await definition.route(request, ctx);
          const record = {
            turn: sequence, reason: request.reason, durationMs: Date.now() - started,
            model: `${result.model.provider}/${result.model.id}`, thinkingLevel: result.thinkingLevel,
            newState: result.state ?? null,
          };
          report.routes.push(record);
          log('route', record);
          return result;
        } });
      },
    })],
  });
  await resourceLoader.reload();
  const errors = resourceLoader.getExtensions().errors;
  assert.equal(errors.length, 0, 'Extension loader failed');
  const sessionManager = SessionManager.inMemory(temporary);
  ({ session } = await createAgentSession({
    cwd: temporary, agentDir: temporary, modelRuntime: runtime, resourceLoader, settingsManager,
    model: runtime.getModel(settings.gears.standard.provider, settings.gears.standard.model),
    thinkingLevel: 'high', tools: ['read'], sessionManager,
  }));
  await session.bindExtensions({ mode: 'print', onError: (error) => log('extension-error', { message: error.message }) });
  const virtual = runtime.getModel('gears', 'auto');
  assert.ok(virtual && virtual.api === 'pi-virtual', 'Virtual model was not registered');
  await session.setModel(virtual);
  assert.equal(session.model.provider, 'gears');
  assert.equal(session.model.id, 'auto');
  globalTimer = setTimeout(() => { timedOut = true; void session.abort(); }, 360000);
  writeFileSync(join(temporary, 'smoke-fixture.txt'), 'LIVE_TOOL_MARKER_42\n');
  const prompts = [
    { label: 'simple', text: 'This is an independent simple request: what is 2 + 2? Reply only with the number.' },
    { label: 'complex', text: 'This is a new, independent engineering task. Analyze the subtle concurrency/security flaw in this payment workflow: a handler checks whether event_id is processed, reads balance, calls an external charge API, updates balance, then inserts the event_id; two workers may race, database commits may fail, and provider callbacks may be duplicated or arrive out of order. Propose a minimal safe architecture preserving ledger correctness and preventing double charges. Distinguish atomic database invariants from exactly-once external effects, and account for idempotency-key scope, crash windows, retries and reconciliation. State which guarantees are impossible without provider support. Give the core reasoning and two race/crash counterexamples; keep the answer under 180 words.' },
    { label: 'standard-coding', text: 'New independent ordinary feature implementation: build a React + TypeScript searchable users list backed by GET /api/users?q=...&page=..., returning {items:[{id,name}],totalPages}. Implement 250ms input debounce, query/page state synchronized with browser URL and back/forward navigation, resetting page when query changes, loading/error/empty UI, and cancellation or protection against stale fetch responses. Provide a compact component and outline tests for debounce, URL navigation, pagination and stale responses. This is routine application work, not a system architecture redesign. No tools required; make reasonable implementation choices. Keep the answer under 500 words.' },
    { label: 'tool-follow-up', text: 'Use the read tool exactly once to read smoke-fixture.txt in the current directory, then reply with its marker exactly. Do not use any other tools.' },
    { label: 'simple-again', text: 'New independent simple arithmetic question, unrelated to prior tasks: what is 3 + 4? Reply only with the number.' },
  ];
  const taskPrompts = [
    prompts[1],
    { label: 'continue-complex', text: '继续' },
    { label: 'same-task-stage', text: 'Continue the same payment design: turn the accepted architecture into compact pseudocode showing transaction boundaries and idempotency keys. No tools. Under 180 words.' },
    prompts[4],
  ];
  const selectedPrompts = process.argv.includes('--standard-only')
    ? prompts.filter((item) => item.label === 'standard-coding')
    : process.argv.includes('--task-aware') ? taskPrompts : prompts;
  for (const item of selectedPrompts) {
    sequence++;
    const start = Date.now();
    const startMessages = session.messages.length;
    const startClassifiers = report.classifiers.length;
    const startRoutes = report.routes.length;
    const timeout = setTimeout(() => { timedOut = true; void session.abort(); }, 100000);
    log('turn-start', { turn: sequence, label: item.label });
    try { await session.prompt(item.text); } finally { clearTimeout(timeout); }
    const responses = session.messages.slice(startMessages).filter((message) => message.role === 'assistant');
    const latest = responses.at(-1);
    const state = sessionManager.getBranch().findLast((entry) => entry.type === 'custom' && entry.customType === 'pi.virtual-model-state')?.data.state;
    const record = {
      turn: sequence, label: item.label, durationMs: Date.now() - start,
      classifierCalls: report.classifiers.length - startClassifiers,
      routeReasons: report.routes.slice(startRoutes).map((record) => record.reason),
      state, responses: responses.map((message) => ({
        model: `${message.provider}/${message.model}`, thinkingLevel: message.thinkingLevel,
        stopReason: message.stopReason, toolCalls: message.content.filter((block) => block.type === 'toolCall').map((block) => block.name),
        text: message.content.filter((block) => block.type === 'text').map((block) => block.text).join(''), usage: message.usage,
      })),
    };
    report.turns.push(record);
    log('turn-result', record);
    assert.equal(timedOut, false, 'Live test exceeded time limit');
    assert.ok(latest && !['error', 'aborted'].includes(latest.stopReason), 'Physical model request failed');
    assert.equal(record.classifierCalls, state.decision?.source === 'inherited' ? 0 : 1, 'Classification count must match decision source');
    assert.equal(state.fallback, false, 'Live Jev judgment or configured target fell back');
    assert.ok(record.responses.at(-1).text.trim(), 'Model returned an empty answer');
    if (item.label === 'continue-complex' && settings.taskRouting.maxInheritedTurns > 0 && !report.turns.at(-2)?.state.task.requireRejudge && !report.turns.at(-2)?.state.task.review) {
      assert.equal(state.decision.source, 'inherited', 'Eligible continuation should skip classification');
      assert.deepEqual(state.dispatch, report.turns.at(-2).state.dispatch);
    }
    if (item.label === 'simple') assert.equal(record.responses.at(-1).text.trim(), '4');
    if (item.label === 'simple-again') assert.equal(record.responses.at(-1).text.trim(), '7');
    if (item.label === 'tool-follow-up') {
      assert.ok(record.routeReasons.includes('continuation'), 'Model did not execute requested tool');
      assert.equal(record.responses.flatMap((response) => response.toolCalls).length, 1);
      assert.equal(record.responses.at(-1).text.trim(), 'LIVE_TOOL_MARKER_42');
      assert.equal(new Set(record.responses.map((response) => `${response.model}:${response.thinkingLevel}`)).size, 1, 'Physical pair changed within tool turn');
    }
  }
  assert.equal(new Set(report.turns.map((turn) => turn.state.turnId)).size, selectedPrompts.length, 'Distinct turns must have distinct identities');
  report.observedGears = [...new Set(report.turns.map((turn) => turn.state.gear))];
  // Ensure any tier not selected by Jev still receives one bounded real-service smoke request.
  for (const [gear, target] of Object.entries(settings.gears)) {
    if (process.argv.includes('--standard-only') || report.observedGears.includes(gear)) continue;
    const start = Date.now();
    const response = await runtime.completeSimple(runtime.getModel(target.provider, target.model), {
      messages: [{ role: 'user', content: 'For a connectivity smoke test, reply with only PONG.', timestamp: Date.now() }],
    }, { reasoning: target.thinkingLevel, maxTokens: 6000, maxRetries: 0, timeoutMs: 90000, signal: AbortSignal.timeout(90000) });
    const record = { gear, model: `${response.provider}/${response.model}`, durationMs: Date.now() - start,
      stopReason: response.stopReason, text: response.content.filter((block) => block.type === 'text').map((block) => block.text).join(''), usage: response.usage };
    report.probes.push(record);
    log('model-probe', record);
    assert.equal(response.stopReason, 'stop');
    assert.equal(record.text.trim(), 'PONG');
  }
  report.passed = true;
  log('summary', { passed: true, classifierCalls: report.classifiers.length, observedGears: report.observedGears,
    modelProbes: report.probes.length, reportPath: logPath });
} catch (error) {
  report.passed = false;
  report.failure = { name: error.name, message: error.message };
  log('failure', { ...report.failure, reportPath: logPath });
  process.exitCode = 1;
} finally {
  clearTimeout(globalTimer);
  session?.dispose();
  report.finishedAt = new Date().toISOString();
  writeFileSync(logPath, JSON.stringify(report, null, 2), { mode: 0o600 });
  // Keep sanitized diagnostic results, remove temporary credential copy immediately.
  rmSync(join(temporary, 'auth.json'), { force: true });
  rmSync(join(temporary, 'auth.json.lock'), { force: true });
}
