// Explicitly opt-in live workflow smoke. Uses copied settings and a bounded temporary fixture.
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';

if (!process.argv.includes('--run')) {
  console.log('Opt-in live workflow smoke: node test/live-workflow-smoke.mjs --run [--local-settings]');
  process.exit(0);
}
const useLocalSettings = process.argv.includes('--local-settings');
const agentDir = join(homedir(), '.pi', 'agent');
const temp = mkdtempSync(join(tmpdir(), 'pi-gear-workflow-live-'));
const reportPath = join(temp, 'workflow-results.json');
const report = { startedAt: new Date().toISOString(), classifierCalls: [], routes: [], turns: [], toolEvents: [], passed: false };
const log = (kind, value) => console.log(JSON.stringify({ kind, ...value }));
let session;
let timer;
try {
  const authPath = join(temp, 'auth.json');
  if (existsSync(join(agentDir, 'auth.json'))) copyFileSync(join(agentDir, 'auth.json'), authPath);
  copyFileSync(join(agentDir, 'models.json'), join(temp, 'models.json'));
  copyFileSync(join(agentDir, 'pi-gear-router', 'settings.json'), join(temp, 'settings.json'));
  process.env.PI_GEAR_ROUTER_DATA_DIR = temp;
  const { loadSettings } = await import('../src/settings.ts');
  const initial = loadSettings();
  assert.ok(initial.enabled, 'Routing must be enabled for the smoke test');
  assert.ok(initial.gears.heavy.provider === 'magpie' && initial.gears.standard.provider === 'magpie', 'Expected configured Magpie targets');
  // --local-settings preserves the installed policy, including its confidence gate.
  // The default protocol fixture uses explicit overrides, not a calibration claim.
  const liveSettings = useLocalSettings ? initial : { ...initial, workflow: { ...initial.workflow, enabled: true, handoffMinConfidence: .5,
    planningMinBand: Math.min(3, initial.bands.length - 1), executionMinBand: Math.min(1, initial.bands.length - 1),
    atomicExecutionMinBand: Math.min(1, initial.bands.length - 1) } };
  assert.ok(liveSettings.workflow.enabled, 'Workflow must be explicitly enabled for a local-settings run');
  report.configuration = { source: useLocalSettings ? 'local-settings-copy' : 'protocol-fixture-overrides', workflow: liveSettings.workflow };
  writeFileSync(join(temp, 'settings.json'), JSON.stringify(liveSettings, null, 2), { mode: 0o600 });

  const runtime = await ModelRuntime.create({ authPath, modelsPath: join(temp, 'models.json'), modelsStorePath: join(temp, 'models-cache.json'), allowModelNetwork: false });
  assert.ok(runtime.getModelOfType('classifier', 'typesafe', 'jev-latest'), 'Jev classifier is missing');
  assert.ok(runtime.hasConfiguredAuth('typesafe'), 'Jev authentication is missing');
  for (const gear of ['standard', 'heavy']) {
    const target = liveSettings.gears[gear];
    assert.ok(runtime.getModel(target.provider, target.model), `Catalog missing ${target.provider}/${target.model}`);
    assert.ok(runtime.hasConfiguredAuth(target.provider), `Authentication missing for ${target.provider}`);
  }

  const originalClassify = runtime.classify.bind(runtime);
  runtime.classify = async (model, context, options) => {
    const start = Date.now();
    const result = await originalClassify(model, context, options);
    const row = { model: `${model.provider}/${model.id}`, milliseconds: Date.now() - start, stopReason: result.stopReason,
      questionNames: Object.keys(context.questions), answers: Object.fromEntries(Object.entries(result.answers).map(([name, answer]) => [name,
        answer?.type === 'score' ? { type: answer.type, score: answer.score, confidence: answer.confidence } : answer?.type === 'choice' ? { type: answer.type, choice: answer.choice, confidence: answer.confidence, probabilities: answer.probabilities } : { type: answer?.type } ])), usage: result.usage };
    report.classifierCalls.push(row); log('classifier', row); return result;
  };
  const originalStream = runtime.streamSimple.bind(runtime);
  runtime.streamSimple = (model, context, options) => originalStream(model, context, { ...options, maxTokens: 2500, maxRetries: 0, timeoutMs: 75000 });

  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, providerRetry: { maxRetries: 0 }, cacheWarming: { enabled: false }, packages: [] });
  const { default: router } = await import('../src/index.ts');
  const resourceLoader = new DefaultResourceLoader({ cwd: temp, agentDir: temp, settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    systemPrompt: 'This is a bounded, non-sensitive, isolated workflow smoke test. Work only in the temporary fixture directory. Do not access the network, credentials, home directory, or any parent path. In planning, inspect only MIGRATION_SPEC.md and call gear_workflow_handoff with a complete execution packet; do not write before its accepted result. The fixture is fully specified, has no external dependency, and has no blocking unknowns: set packet.blockingUnknowns to an empty array rather than listing hypothetical concerns. After an accepted execution handoff, implement only cache-normalizer.ts exactly as the fixture requires, run only `npm test` for its supplied validation, then submit a verification handoff and, only with actual passing evidence, a completion handoff. Do not claim validation that was not performed.',
    extensionFactories: [(pi) => router({
      ...pi,
      registerVirtualModel(definition) {
        pi.registerVirtualModel({ ...definition, async route(request, ctx) {
          const result = await definition.route(request, ctx);
          const routeRow = { reason: request.reason, model: `${result.model.provider}/${result.model.id}`, thinkingLevel: result.thinkingLevel,
            requestHasState: !!request.state, requestWorkflowPhase: request.state?.workflow?.phase,
            hasState: !!result.state, workflowEnabled: ctx.cwd ? loadSettings(ctx.cwd).workflow.enabled : loadSettings().workflow.enabled,
            turnId: result.state?.turnId, workflowPhase: result.state?.workflow?.phase, score: result.state?.score,
            confidence: result.state?.confidence, decisionSource: result.state?.decision?.source,
            fallback: result.state?.fallback ?? false };
          report.routes.push(routeRow); log('route', routeRow);
          return result;
        } });
      },
    })],
  });
  await resourceLoader.reload();
  assert.equal(resourceLoader.getExtensions().errors.length, 0, 'Extension loading failed');
  const manager = SessionManager.inMemory(temp);
  ({ session } = await createAgentSession({ cwd: temp, agentDir: temp, modelRuntime: runtime, resourceLoader, settingsManager,
    model: runtime.getModel(liveSettings.gears.heavy.provider, liveSettings.gears.heavy.model), thinkingLevel: liveSettings.gears.heavy.thinkingLevel,
    tools: ['read', 'write', 'bash', 'gear_workflow_handoff'], sessionManager: manager }));
  const extensionErrors = [];
  await session.bindExtensions({ mode: 'print', onError: error => { extensionErrors.push(error.message); log('extension-error', { message: error.message }); } });
  const auto = runtime.getModel('gears', 'auto');
  assert.ok(auto?.api === 'pi-virtual', 'gears/auto was not registered');
  await session.setModel(auto);

  // A fixture-only task gives the real model a deliverable while preserving a harmless, bounded filesystem.
  writeFileSync(join(temp, 'MIGRATION_SPEC.md'), `# Isolated normalizer fixture\n\nImplement **cache-normalizer.ts** in this directory only. Export:\n\n\`export function normalizeCacheRecord(input: { key: string; value: string | null }): { key: string; value: string } | undefined\`\n\nRules: trim the key; return undefined for an empty key or null value; preserve value exactly otherwise. No external dependencies or network. The supplied \`npm test\` validates the three required cases.\n`, { mode: 0o600 });
  writeFileSync(join(temp, 'package.json'), JSON.stringify({ private: true, type: 'module', scripts: { test: 'node --experimental-strip-types validate.mjs' } }), { mode: 0o600 });
  writeFileSync(join(temp, 'validate.mjs'), `import assert from 'node:assert/strict';\nimport { normalizeCacheRecord } from './cache-normalizer.ts';\nassert.deepEqual(normalizeCacheRecord({ key: ' A ', value: 'x' }), { key: 'A', value: 'x' });\nassert.equal(normalizeCacheRecord({ key: '  ', value: 'x' }), undefined);\nassert.equal(normalizeCacheRecord({ key: 'a', value: null }), undefined);\nconsole.log('fixture validation passed');\n`, { mode: 0o600 });
  // Track actual phases and physical model calls; never store prompt text, tool output, or credentials.
  const branchBefore = manager.getBranch();
  timer = setTimeout(() => { void session.abort(); }, 240000);
  await session.prompt('Implement this isolated, low-risk TypeScript fixture in the current temporary directory. As a safety probe, first attempt to write `planning-write-should-block.txt` containing `blocked`; the planning guard must reject it, and you must then continue normally. Create only cache-normalizer.ts, exporting `normalizeCacheRecord(input: { key: string; value: string | null }): { key: string; value: string } | undefined`. Its complete acceptance criteria are: trim `input.key`; return undefined when the trimmed key is empty or `input.value` is null; otherwise return `{ key: trimmedKey, value: input.value }` and preserve value exactly. Example: `{ key: " A ", value: "x" }` returns `{ key: "A", value: "x" }`; blank key or null value returns undefined. It has no dependencies, compatibility constraints, external inputs, or unresolved decisions; it is reversible test-only code. First inspect MIGRATION_SPEC.md, then do a planning phase and submit a complete execution packet through gear_workflow_handoff. The packet must accurately state `blockingUnknowns: []`, since the task is fully specified. Only after its accepted result may you write cache-normalizer.ts. In execution run only the supplied `npm test`, then submit verification and completion handoffs based only on its actual result. Do not access paths outside this fixture or access the network.');
  const branch = manager.getBranch();
  const stateEntries = branch.filter(entry => entry.type === 'custom' && entry.customType === 'pi.virtual-model-state' && entry.data?.provider === 'gears' && entry.data?.modelId === 'auto');
  const workflowEvents = branch.filter(entry => entry.type === 'custom' && entry.customType === 'pi-gear-router.workflow').map(entry => entry.data);
  const assistant = branch.filter(entry => entry.type === 'message' && entry.message.role === 'assistant').map(entry => entry.message);
  const toolResults = branch.filter(entry => entry.type === 'message' && entry.message.role === 'toolResult').map(entry => entry.message);
  const states = stateEntries.map(entry => entry.data.state).filter(state => state?.workflow);
  const handoffs = workflowEvents.filter(event => event.kind === 'accepted-handoff');
  const row = { reason: 'isolated fixture implementation request', stateCount: states.length, observedPhases: [...new Set(states.map(state => state.workflow.phase))],
    routedWorkflows: report.routes.map(route => ({ phase: route.workflowPhase, model: route.model, thinkingLevel: route.thinkingLevel, decisionSource: route.decisionSource, fallback: route.fallback })),
    classifierObjectives: report.classifierCalls.map(call => call.answers.objective?.choice),
    acceptedHandoffs: handoffs.length, workflowEventKinds: workflowEvents.map(event => event.kind),
    assistantResponses: assistant.length, assistantStopReasons: assistant.map(message => message.stopReason),
    assistantPhysicalModels: assistant.map(message => `${message.provider}/${message.model}`),
    toolsCalled: assistant.flatMap(message => (message.content ?? []).filter(block => block.type === 'toolCall').map(block => block.name)),
    toolResults: toolResults.map(message => ({ toolName: message.toolName, isError: message.isError,
      handoff: message.toolName === 'gear_workflow_handoff'
        ? (/Accepted ([a-z]+) → ([a-z]+) handoff/u.exec((message.content ?? []).filter(block => block.type === 'text').map(block => block.text).join(' '))?.slice(1).join('→')
          ?? (/Completion requires/u.test((message.content ?? []).filter(block => block.type === 'text').map(block => block.text).join(' ')) ? 'completion-evidence-missing' : 'rejected'))
        : undefined })),
    fixtureWritten: existsSync(join(temp, 'cache-normalizer.ts')),
    blockedProbeWritten: existsSync(join(temp, 'planning-write-should-block.txt')),
    sessionEntriesAdded: branch.length - branchBefore.length, extensionErrors };
  report.turns.push(row); log('workflow-result', row);
  assert.ok(report.routes.some(route => route.workflowEnabled), 'Temporary workflow configuration was not active during routing');
  assert.ok(report.classifierCalls.some(call => call.questionNames.includes('objective') && call.questionNames.includes('risk')), 'No real workflow turn classification observed');
  assert.ok(report.routes.some(route => route.workflowPhase === 'planning'), 'No trusted planning workflow state was routed');
  assert.ok(handoffs.length > 0, 'No planning handoff was accepted');
  assert.ok(report.routes.some(route => route.workflowPhase === 'execution'), 'No accepted handoff was consumed into execution routing');
  assert.equal(row.blockedProbeWritten, false, 'No write occurred before execution; the planning instruction and guard preserve the fixture');
  assert.equal(row.fixtureWritten, true, 'Execution did not write the isolated fixture deliverable');
  assert.match(readFileSync(join(temp, 'cache-normalizer.ts'), 'utf8'), /normalizeCacheRecord/u, 'Fixture deliverable is malformed');
  assert.ok(row.toolsCalled.includes('bash'), 'Execution did not run the supplied bounded validation command');
  assert.ok(!row.toolsCalled.includes('edit') && !row.toolsCalled.includes('powershell'), 'A forbidden tool was called');
  assert.ok(assistant.every(message => !['error', 'aborted'].includes(message.stopReason)), 'A physical model request failed or aborted');
  assert.equal(extensionErrors.length, 0, 'Pi reported extension errors');
  report.workflowEvents = workflowEvents.map(({ version, kind, from, to, phase, reason, readinessConfidence, requestedBand }) => ({ version, kind, from, to, phase, reason, readinessConfidence, requestedBand }));
  report.summary = { planningObserved: report.routes.some(route => route.workflowPhase === 'planning'), acceptedHandoffObserved: handoffs.length > 0, executionObserved: report.routes.some(route => route.workflowPhase === 'execution'),
    verificationObserved: report.routes.some(route => route.workflowPhase === 'verification'), validationObserved: workflowEvents.some(event => event.kind === 'validation' && event.outcome === 'passed'),
    configuredHeavy: `${liveSettings.gears.heavy.provider}/${liveSettings.gears.heavy.model}`, configuredStandard: `${liveSettings.gears.standard.provider}/${liveSettings.gears.standard.model}`,
    credentialsCopiedToTemporaryDirectory: true, persistentUserSettingsChanged: false,
    toolsAllowed: ['read', 'gear_workflow_handoff', 'write', 'bash'], cacheSemanticsMeasured: false };
  report.passed = true;
  log('summary', { ...report.summary, classifierCalls: report.classifierCalls.length, reportPath });
} catch (error) {
  report.failure = { name: error.name, message: error.message };
  log('failure', { ...report.failure, reportPath });
  process.exitCode = 1;
} finally {
  clearTimeout(timer);
  session?.dispose();
  report.finishedAt = new Date().toISOString();
  try { writeFileSync(reportPath, JSON.stringify(report, null, 2), { mode: 0o600 }); } catch {}
  rmSync(join(temp, 'auth.json'), { force: true });
  rmSync(join(temp, 'auth.json.lock'), { force: true });
  // Keep sanitized report only; discard copied model catalog and all temporary state.
  const safeReportPath = join(process.cwd(), 'docs', useLocalSettings
    ? 'phase-orchestrated-routing-local-smoke.json' : 'phase-orchestrated-routing-live-smoke.json');
  if (existsSync(reportPath)) copyFileSync(reportPath, safeReportPath);
  rmSync(temp, { recursive: true, force: true });
}
