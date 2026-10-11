import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createAgentSession, createAgentSessionRuntime, createSyntheticSourceInfo,
  DefaultResourceLoader, defineTool, ModelRuntime, SessionManager, SettingsManager,
} from '@earendil-works/pi-coding-agent';
import { createAssistantMessageEventStream, Type } from '@earendil-works/pi-ai';

export const FIXTURE_PROVIDER = 'observer-fixture';
export const FIXTURE_ROUTER = 'observer-fixture-router';
export const FIXTURE_MODEL = 'auto';

export function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

/** A deterministic scheduling seam: no sleeps, and an aborted test cannot hang a run. */
export async function waitForGate(gate, signal) {
  signal?.throwIfAborted();
  if (!signal) return gate.promise;
  let onAbort;
  try {
    return await Promise.race([gate.promise, new Promise((_resolve, reject) => {
      onAbort = () => reject(signal.reason);
      signal.addEventListener('abort', onAbort, { once: true });
    })]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

/** Public-surface test adapter for reduced hosts and durable-write failures. */
export function fixtureCapabilities(pi, ctx, { missingContext = [], missingSession = [], appendError } = {}) {
  const sessionManager = Object.fromEntries(['getSessionId', 'getLeafId', 'getBranch', 'getEntry',
    'getEntries', 'buildSessionProjection', 'getCwd', 'getSessionFile'].filter(name =>
    !missingSession.includes(name) && typeof ctx.sessionManager[name] === 'function').map(name =>
    [name, ctx.sessionManager[name].bind(ctx.sessionManager)]));
  const context = { ...ctx, sessionManager };
  for (const name of missingContext) delete context[name];
  return { ctx: context, api: { appendEntry(type, data) {
    if (appendError) throw appendError;
    return pi.appendEntry(type, data);
  } } };
}

export const zeroUsage = () => ({
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});
export const userMessage = text => ({ role: 'user', content: text, timestamp: Date.now() });
export function latestFixtureState(manager) {
  return manager.getBranch().findLast(entry => entry.type === 'custom'
    && entry.customType === 'pi.virtual-model-state'
    && entry.data?.provider === FIXTURE_ROUTER && entry.data?.modelId === FIXTURE_MODEL)?.data.state;
}

let fixtureActive = false;
/**
 * Actual Pi runtime; only network-facing classify/chat transports are mocked.
 * No production router policy lives here. Callers supply route/extension/reply behavior.
 * Tests using the global fetch/env guard must be sequential within one Node worker.
 */
export async function createObserverSdkFixture(t, options = {}) {
  assert.equal(fixtureActive, false, 'SDK fixtures sharing process globals must not overlap');
  const directory = mkdtempSync(join(tmpdir(), 'pi-observer-sdk-'));
  fixtureActive = true;
  const originalFetch = globalThis.fetch;
  const envBefore = process.env.PI_GEAR_ROUTER_DATA_DIR;
  process.env.PI_GEAR_ROUTER_DATA_DIR = directory;
  let networkCalls = 0, closed = false, runtime, generation = 0;
  const sessions = [], apiByGeneration = new Map();
  const trace = [], requests = [], classifierCalls = [], extensionErrors = [];
  globalThis.fetch = async () => {
    networkCalls++;
    throw new Error('Network is forbidden in the offline SDK fixture');
  };
  const fixture = {
    directory, trace, requests, classifierCalls, extensionErrors, apiByGeneration,
    get runtime() { return runtime; },
    get session() { return runtime.session; },
    get manager() { return runtime.session.sessionManager; },
    get generation() { return generation; },
    get networkCalls() { return networkCalls; },
    get closed() { return closed; },
    async dispose() {
      if (closed) return;
      closed = true;
      try {
        await runtime?.session.abort();
        await runtime?.dispose();
      } finally {
        for (const session of sessions) session.dispose();
        globalThis.fetch = originalFetch;
        if (envBefore === undefined) delete process.env.PI_GEAR_ROUTER_DATA_DIR;
        else process.env.PI_GEAR_ROUTER_DATA_DIR = envBefore;
        rmSync(directory, { recursive: true, force: true });
        fixtureActive = false;
      }
    },
    assertClean() {
      assert.equal(networkCalls, 0);
      assert.deepEqual(extensionErrors, []);
      // Pi may materialize its empty credential store even when all keys are runtime-only.
      if (existsSync(join(directory, 'auth.json'))) {
        assert.deepEqual(JSON.parse(readFileSync(join(directory, 'auth.json'), 'utf8')), {});
      }
    },
  };
  // Register cleanup before any awaited setup, including setup failures.
  t.after(async () => {
    await fixture.dispose();
    assert.equal(networkCalls, 0, 'An offline test attempted real network access');
  });
  try {
    const skillSpecs = options.skills ?? [{ name: 'review-fixture', description: 'Investigate repository changes' },
      { name: 'explicit-fixture', description: 'Explicit-only method', disableModelInvocation: true }];
    const skills = skillSpecs.map(spec => {
      const baseDir = join(directory, 'skills', spec.name);
      const filePath = join(baseDir, 'SKILL.md');
      mkdirSync(baseDir, { recursive: true });
      writeFileSync(filePath, `---\nname: ${spec.name}\ndescription: ${spec.description}\n---\n\nSYNTHETIC_BODY_${spec.name}\n`, { mode: 0o600 });
      return { ...spec, filePath, baseDir, disableModelInvocation: spec.disableModelInvocation ?? false,
        sourceInfo: createSyntheticSourceInfo(filePath, { source: 'sdk' }) };
    });
    fixture.skills = skills;
    const createRuntime = async ({ cwd, agentDir, sessionManager, sessionStartEvent }) => {
      let currentGeneration;
      const modelRuntime = await ModelRuntime.create({
        authPath: join(directory, 'auth.json'), modelsPath: null,
        modelsStorePath: join(directory, 'catalog.json'), allowModelNetwork: false, refreshOnCreate: false,
      });
      modelRuntime.registerProvider(FIXTURE_PROVIDER, {
        api: 'openai-responses', baseUrl: 'https://offline.invalid/v1', apiKey: 'synthetic-unused-key',
        models: ['light', 'standard', 'heavy'].map(id => ({ id, name: id, reasoning: true,
          thinkingLevelMap: { off: 'off', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh' },
          input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 4096 })),
      });
      modelRuntime.classify = async (model, context, classifyOptions) => {
        const call = { model: { provider: model.provider, id: model.id }, context: structuredClone(context), generation: currentGeneration };
        classifierCalls.push(call);
        return options.classify ? options.classify(call, classifyOptions, fixture)
          : { stopReason: 'stop', answers: { capability: { type: 'score', score: 1, confidence: .95 } }, usage: zeroUsage() };
      };
      const stream = (model, context, streamOptions) => {
        const events = createAssistantMessageEventStream();
        const call = { index: requests.length + 1, generation: currentGeneration,
          model: { provider: model.provider, id: model.id }, thinkingLevel: streamOptions?.reasoning ?? 'off',
          messages: structuredClone(context.messages) };
        requests.push(call);
        trace.push({ type: 'provider', index: call.index, generation: currentGeneration });
        const message = { role: 'assistant', api: model.api, provider: model.provider, model: model.id,
          content: [], stopReason: 'pending', timestamp: Date.now(), usage: zeroUsage() };
        events.push({ type: 'start', partial: structuredClone(message) });
        queueMicrotask(async () => {
          try {
            const reply = await options.reply?.(call, streamOptions?.signal, fixture);
            streamOptions?.signal?.throwIfAborted();
            Object.assign(message, { content: [{ type: 'text', text: 'Synthetic fixture response' }], stopReason: 'stop' }, reply);
            if (message.stopReason === 'error' || message.stopReason === 'aborted') {
              events.push({ type: 'error', reason: message.stopReason, error: message });
            } else {
              events.push({ type: 'done', reason: message.stopReason, message });
            }
          } catch (error) {
            Object.assign(message, { stopReason: streamOptions?.signal?.aborted ? 'aborted' : 'error',
              errorMessage: streamOptions?.signal?.aborted ? 'Fixture aborted' : String(error) });
            events.push({ type: 'error', reason: message.stopReason, error: message });
          } finally {
            events.end(message);
          }
        });
        return events;
      };
      modelRuntime.streamSimple = stream;
      modelRuntime.stream = stream;
      const settingsManager = SettingsManager.inMemory({
        compaction: { enabled: false }, retry: { enabled: false, ...(options.retry ?? {}) },
        providerRetry: { maxRetries: 0 }, cacheWarming: 'off', packages: [],
      });
      const instrumentation = pi => {
        currentGeneration = ++generation;
        apiByGeneration.set(currentGeneration, pi);
        for (const name of ['input', 'before_agent_start', 'context', 'context_with_system',
          'tool_call', 'tool_result', 'agent_before_settle', 'agent_settled', 'session_start', 'session_shutdown', 'session_tree']) {
          pi.on(name, (event, ctx) => {
            trace.push({ type: name, generation: currentGeneration, reason: event.reason,
              streamingBehavior: event.streamingBehavior, prompt: event.prompt,
              pending: ctx.hasPendingMessages(), sessionId: ctx.sessionManager.getSessionId() });
          });
        }
        pi.registerTool(defineTool({ name: 'fixture_ping', label: 'Fixture Ping', description: 'Read-only synthetic fixture tool',
          annotations: { readOnlyHint: true }, parameters: Type.Object({}),
          async execute(_id, _params, signal) {
            signal?.throwIfAborted();
            return { content: [{ type: 'text', text: 'Synthetic ping result' }], details: { synthetic: true } };
          } }));
        if (options.route) pi.registerVirtualModel({ provider: FIXTURE_ROUTER, id: FIXTURE_MODEL,
          name: 'Synthetic Observer Router', thinkingLevels: ['off', 'medium', 'high'],
          async route(request, ctx) {
            trace.push({ type: 'route', reason: request.reason, generation: currentGeneration });
            return options.route(request, ctx, fixture);
          } });
      };
      const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager,
        noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
        systemPrompt: 'Synthetic offline SDK fixture; no real work requested.',
        skillsOverride: () => ({ skills, diagnostics: [] }),
        extensionFactories: [instrumentation, ...(options.extensions ?? [])],
      });
      await resourceLoader.reload();
      assert.deepEqual(resourceLoader.getExtensions().errors, []);
      // Runtime host makes the virtual catalog entry available before SDK session restore.
      // Extension binding replaces this placeholder with the context-aware route callback.
      if (options.route) modelRuntime.registerVirtualModel({ provider: FIXTURE_ROUTER, id: FIXTURE_MODEL,
        name: 'Synthetic Observer Router', thinkingLevels: ['off', 'medium', 'high'],
        route() { throw new Error('Fixture router was used before extension binding'); } });
      for (const target of options.virtualPlaceholders ?? []) modelRuntime.registerVirtualModel({ ...target,
        route() { throw new Error('Fixture virtual placeholder used before extension binding'); } });
      const result = await createAgentSession({ cwd, agentDir, modelRuntime, settingsManager, resourceLoader, sessionManager,
        sessionStartEvent, thinkingLevel: 'high', tools: options.tools ?? ['read', 'fixture_ping'],
        ...(sessionManager.buildSessionProjection().model ? {} : { model: modelRuntime.getModel(FIXTURE_PROVIDER, 'heavy') }) });
      sessions.push(result.session);
      return { ...result, services: { cwd, agentDir, modelRuntime, settingsManager, resourceLoader, diagnostics: [] }, diagnostics: [] };
    };
    const manager = options.persisted
      ? SessionManager.create(directory, join(directory, 'sessions')) : SessionManager.inMemory(directory);
    runtime = await createAgentSessionRuntime(createRuntime, { cwd: directory, agentDir: directory, sessionManager: manager });
    const bind = async session => {
      await session.bindExtensions({ mode: 'print', onError: error => extensionErrors.push(error) });
    };
    runtime.setRebindSession(bind);
    await bind(runtime.session);
    if (options.route) await runtime.session.setModel(runtime.services.modelRuntime.getModel(FIXTURE_ROUTER, FIXTURE_MODEL));
    return fixture;
  } catch (error) {
    await fixture.dispose();
    throw error;
  }
}
