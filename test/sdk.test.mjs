import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { createAgentSession, createCodemodeExtension, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';

// Actual Pi extension/runtime/agent loop, with only the two external-service transports replaced.
test('offline SDK loop persists task state and sees nested codemode verification failure', { timeout: 20000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-gear-sdk-'));
  process.env.PI_GEAR_ROUTER_DATA_DIR = dir;
  let session;
  try {
    const { default: router } = await import('../src/index.ts');
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ gears: Object.fromEntries(['light', 'standard', 'heavy'].map(g => [g, { provider: 'offline', model: g, thinkingLevel: 'low' }])) }));
    // Only this temporary fixture can be executed by the nested verification tool.
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'node -e "process.exit(1)"' } }));
    const runtime = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null, modelsStorePath: join(dir, 'models.json'), allowModelNetwork: false, refreshOnCreate: false });
    runtime.registerProvider('offline', { api: 'openai-responses', baseUrl: 'https://offline.invalid', apiKey: 'offline-placeholder', models: ['light', 'standard', 'heavy'].map(id => ({ id, name: id, reasoning: true, thinkingLevelMap: { low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh' }, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 10000 })) });
    let classifiers = 0, turn = 0;
    const dispatches = [], nested = [];
    runtime.classify = async (_model, input) => {
      classifiers++;
      return { stopReason: 'stop', answers: { gear: { type: 'score', score: 1.92, confidence: .95 }, ...(input.questions.relation ? { relation: { type: 'choice', choice: 'same_task', confidence: .95, probabilities: { same_task: .95, new_task: .03, uncertain: .02 } } } : {}) }, usage: { input: 42 } };
    };
    // No request can reach a real provider; both available chat entry points are replaced.
    const stream = (model, context, options) => {
      dispatches.push({ turn, model: model.id, thinking: options.reasoning });
      const invoke = turn === 2 && context.messages.at(-1)?.role === 'user';
      const message = { role: 'assistant', content: invoke ? [{ type: 'toolCall', id: 'nested-parent', name: 'codemode', arguments: { code: 'const r = await tools.bash({ command: "npm test" }); text(r.exit_code);' } }] : [{ type: 'text', text: 'Proceed with implementation.' }], api: model.api, provider: model.provider, model: model.id, stopReason: invoke ? 'toolUse' : 'stop', timestamp: Date.now(), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      const events = createAssistantMessageEventStream();
      events.push({ type: 'start', partial: message });
      events.push({ type: 'done', reason: message.stopReason, message });
      return events;
    };
    runtime.streamSimple = stream; runtime.stream = stream;
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, providerRetry: { maxRetries: 0 }, cacheWarming: { enabled: false }, packages: [] });
    const loader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, systemPrompt: 'Offline fixture.', extensionFactories: [createCodemodeExtension({ models: false }), (pi) => { router(pi); pi.on('tool_result', event => { if (event.parentToolCallId) nested.push(event); }); }] });
    await loader.reload(); assert.equal(loader.getExtensions().errors.length, 0);
    const manager = SessionManager.inMemory(dir);
    ({ session } = await createAgentSession({ cwd: dir, agentDir: dir, modelRuntime: runtime, model: runtime.getModel('offline', 'heavy'), resourceLoader: loader, settingsManager, sessionManager: manager, tools: ['bash', 'codemode'] }));
    await session.bindExtensions({ mode: 'print', onError: error => { throw new Error(error.message); } });
    await session.setModel(runtime.getModel('gears', 'auto'));
    const state = () => manager.getBranch().findLast(e => e.type === 'custom' && e.customType === 'pi.virtual-model-state')?.data.state;
    turn = 1; await session.prompt('Analyze concurrency defects then implement the payment design');
    const current = state(); assert.equal(current.phaseRoute.phase, 'implement', JSON.stringify(current.phaseRoute));
    assert.equal(classifiers, 1); assert.equal(state().task.committedBand, 4);
    const taskId = state().task.taskId;
    turn = 2; await session.prompt('继续');
    assert.equal(classifiers, 1); assert.equal(state().decision.source, 'inherited');
    assert.ok(nested.some(e => e.toolName === 'bash' && e.structuredContent?.exit_code === 1), JSON.stringify(session.messages.filter(m => m.role === 'toolResult')));
    assert.equal(manager.getBranch().filter(e => e.type === 'custom' && e.customType === 'pi-gear-router.observation').length, 1);
    assert.equal(new Set(dispatches.filter(e => e.turn === 2).map(e => `${e.model}:${e.thinking}`)).size, 1);
    turn = 3; await session.prompt('继续');
    assert.equal(classifiers, 2); assert.equal(state().decision.trigger, 'verification-failed'); assert.equal(state().task.taskId, taskId);
  } finally {
    session?.dispose(); rmSync(dir, { recursive: true, force: true });
  }
});
