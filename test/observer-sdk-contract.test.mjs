import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { test as nodeTest } from 'node:test';
import { formatSkillsForPrompt } from '@earendil-works/pi-coding-agent';
import { getCurrentSystemMessage, getCurrentSystemPrompt, getCurrentTools, Type } from '@earendil-works/pi-ai';
import {
  createObserverSdkFixture, deferred, fixtureCapabilities, FIXTURE_PROVIDER, latestFixtureState,
  userMessage, waitForGate,
} from './helpers/observer-sdk-fixture.mjs';

const test = (name, run) => nodeTest(name, { timeout: 10000 }, run);
const physical = ctx => ctx.modelRegistry.find(FIXTURE_PROVIDER, 'heavy');
const toolReply = { content: [{ type: 'toolCall', id: 'fixture-ping-1', name: 'fixture_ping', arguments: {} }], stopReason: 'toolUse' };
const textOf = message => typeof message.content === 'string' ? message.content
  : message.content.filter(block => block.type === 'text').map(block => block.text).join('\n');
const rawUsers = manager => manager.getBranch().filter(entry => entry.type === 'message' && entry.message.role === 'user');
const routes = fixture => fixture.trace.filter(event => event.type === 'route');

// Test-only routing/injection probe: deliberately not the planned observer implementation.
function contractProbe(records, { guide = true } = {}) {
  return {
    route(request, ctx) {
      const source = rawUsers(ctx.sessionManager).at(-1);
      const pair = request.failed ?? request.previous;
      records.push({ reason: request.reason, sourceId: source?.id,
        requestUsers: request.messages.filter(m => m.role === 'user').map(textOf),
        receivedState: request.state, failed: request.failed, previous: request.previous,
        routeSystem: getCurrentSystemMessage(request.messages) });
      return { model: pair?.model ?? physical(ctx), thinkingLevel: pair?.thinkingLevel ?? 'high',
        state: { sourceUserId: source?.id, count: (request.state?.count ?? 0) + 1 } };
    },
    extensions: [pi => {
      pi.on('before_agent_start', (event, ctx) => {
        records.push({ event: 'before_agent_start', usersBefore: rawUsers(ctx.sessionManager).length,
          skills: structuredClone(event.systemPromptOptions.skills) });
      });
      pi.on('context', (event, ctx) => {
        const state = latestFixtureState(ctx.sessionManager);
        records.push({ event: 'context', state, hasSystem: event.messages.some(m => m.role === 'system'),
          source: rawUsers(ctx.sessionManager).at(-1)?.id });
        if (!guide) return;
        // Fixed position after the source user, never between a tool call and its result.
        const lastUser = event.messages.findLastIndex(m => m.role === 'user');
        assert.ok(lastUser >= 0);
        const advisory = { role: 'custom', customType: 'fixture.advisory',
          content: `[Synthetic advisory; not a new task] source=${state.sourceUserId}`, display: false, timestamp: 1 };
        return { messages: [...event.messages.slice(0, lastUser + 1), advisory, ...event.messages.slice(lastUser + 1)] };
      });
    }],
  };
}

async function probeFixture(t, options = {}) {
  const records = [];
  const probe = contractProbe(records, options);
  const fixture = await createObserverSdkFixture(t, { ...options, route: probe.route,
    extensions: [...probe.extensions, ...(options.extensions ?? [])] });
  return { fixture, records };
}

test('SDK fixture blocks network, mocks classifiers, and restores globals on idempotent cleanup', async t => {
  const fetchBefore = globalThis.fetch;
  const envBefore = process.env.PI_GEAR_ROUTER_DATA_DIR;
  const f = await createObserverSdkFixture(t);
  assert.notEqual(globalThis.fetch, fetchBefore);
  assert.equal(process.env.PI_GEAR_ROUTER_DATA_DIR, f.directory);
  const model = f.runtime.services.modelRuntime.getModelOfType('classifier', 'typesafe', 'jev-latest');
  const answer = await f.runtime.services.modelRuntime.classify(model, { state: {}, questions: {} });
  assert.equal(answer.answers.capability.score, 1);
  assert.equal(f.classifierCalls.length, 1);
  await f.session.prompt('Synthetic self-check');
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].model.id, 'heavy');
  f.assertClean();
  await f.dispose(); await f.dispose();
  assert.equal(existsSync(f.directory), false);
  assert.equal(globalThis.fetch, fetchBefore);
  assert.equal(process.env.PI_GEAR_ROUTER_DATA_DIR, envBefore);
});

test('physical targets and thinking choices are controlled entirely by the test route', async t => {
  const f = await createObserverSdkFixture(t, { route: (_request, ctx) => {
    const id = rawUsers(ctx.sessionManager).length === 1 ? 'light' : 'standard';
    return { model: ctx.modelRegistry.find(FIXTURE_PROVIDER, id), thinkingLevel: 'medium' };
  } });
  await f.session.prompt('Synthetic light target');
  await f.session.prompt('Synthetic standard target');
  assert.deepEqual(f.requests.map(call => [call.model.id, call.thinkingLevel]), [['light', 'medium'], ['standard', 'medium']]);
  f.assertClean();
});

test('classifier failure is injectable and cleanup does not require a successful response', async t => {
  const f = await createObserverSdkFixture(t, { classify: () => { throw new Error('Synthetic classifier failure'); } });
  const model = f.runtime.services.modelRuntime.getModelOfType('classifier', 'typesafe', 'jev-latest');
  await assert.rejects(f.runtime.services.modelRuntime.classify(model, { state: {}, questions: {} }), /Synthetic classifier failure/);
  assert.equal(f.classifierCalls.length, 1);
  f.assertClean();
  await f.dispose();
  assert.equal(existsSync(f.directory), false);
});

test('fixture setup failure restores fetch/env and cleans the temporary directory', async t => {
  const fetchBefore = globalThis.fetch;
  const envBefore = process.env.PI_GEAR_ROUTER_DATA_DIR;
  await assert.rejects(createObserverSdkFixture(t, { extensions: [() => { throw new Error('synthetic setup failure'); }] }));
  assert.equal(globalThis.fetch, fetchBefore);
  assert.equal(process.env.PI_GEAR_ROUTER_DATA_DIR, envBefore);
  // A subsequent setup proves the worker-level single-fixture lock was released too.
  const f = await createObserverSdkFixture(t);
  f.assertClean();
});

test('real user entry and fresh route state precede same-request ordinary context guidance', async t => {
  const { fixture: f, records } = await probeFixture(t);
  await f.session.prompt('Investigate synthetic changes');
  assert.equal(records.find(r => r.event === 'before_agent_start').usersBefore, 0);
  const routed = records.find(r => r.reason === 'user');
  const transformed = records.find(r => r.event === 'context');
  assert.equal(transformed.hasSystem, false);
  assert.equal(transformed.source, routed.sourceId);
  assert.deepEqual(transformed.state, { sourceUserId: routed.sourceId, count: 1 });
  assert.deepEqual(f.trace.filter(e => ['input', 'before_agent_start', 'route', 'context', 'provider'].includes(e.type)).map(e => e.type),
    ['input', 'before_agent_start', 'route', 'context', 'provider']);
  const request = f.requests[0];
  assert.equal(request.messages[0].role, 'system');
  assert.ok(getCurrentSystemPrompt(request.messages).includes('Synthetic offline SDK fixture'));
  assert.deepEqual(getCurrentTools(request.messages).map(tool => tool.name).sort(), ['fixture_ping', 'read']);
  assert.equal(textOf(request.messages.at(-1)), `[Synthetic advisory; not a new task] source=${routed.sourceId}`);
  assert.equal(f.manager.getBranch().filter(e => e.type === 'custom_message').length, 0);
  assert.equal(rawUsers(f.manager).length, 1);
  assert.equal(f.requests.length, 1, 'No extra run was manufactured to deliver guidance');
  f.assertClean();
});

test('tool continuation reuses source identity and request-local guide without breaking tool pairing', async t => {
  const { fixture: f, records } = await probeFixture(t, { reply: call => call.index === 1 ? toolReply : undefined });
  await f.session.prompt('Synthetic work with ping');
  assert.deepEqual(routes(f).map(r => r.reason), ['user', 'continuation']);
  assert.equal(records.filter(r => r.reason).at(-1).sourceId, records.find(r => r.reason).sourceId);
  const second = f.requests[1].messages;
  const assistantIndex = second.findLastIndex(m => m.role === 'assistant');
  assert.equal(second[assistantIndex + 1].role, 'toolResult');
  assert.equal(second[assistantIndex + 1].toolCallId, 'fixture-ping-1');
  for (const call of f.requests) assert.equal(call.messages.filter(m => textOf(m).startsWith('[Synthetic advisory')).length, 1);
  assert.deepEqual(f.requests.map(r => [r.model.id, r.thinkingLevel]), [['heavy', 'high'], ['heavy', 'high']]);
  assert.equal(rawUsers(f.manager).length, 1);
  f.assertClean();
});

for (const behavior of ['steer', 'followUp']) {
  test(`queued ${behavior} gets a new real-user route, not another before_agent_start`, async t => {
    const entered = deferred(), release = deferred();
    const { fixture: f, records } = await probeFixture(t, { reply: async (call, signal) => {
      if (call.index === 1) { entered.resolve(); await waitForGate(release, signal); return behavior === 'steer' ? toolReply : undefined; }
    } });
    const run = f.session.prompt('Initial synthetic work');
    try {
      await entered.promise;
      assert.equal(await f.session[behavior](`New ${behavior} constraint`), 'queued');
      assert.ok(f.trace.some(e => e.type === 'input' && e.streamingBehavior === behavior));
    } finally { release.resolve(); }
    await run;
    await f.session.waitForIdle();
    assert.equal(f.requests.length, 2);
    assert.deepEqual(routes(f).map(r => r.reason), ['user', 'user']);
    assert.equal(records.filter(r => r.event === 'before_agent_start').length, 1);
    const sourceIds = records.filter(r => r.reason).map(r => r.sourceId);
    assert.notEqual(sourceIds[0], sourceIds[1]);
    assert.equal(rawUsers(f.manager).length, 2);
    assert.ok(textOf(f.requests[1].messages.findLast(m => m.role === 'user')).includes(sourceIds[1]));
    f.assertClean();
  });
}

test('automatic retry reports failed physical pair while retaining branch route state', async t => {
  const { fixture: f, records } = await probeFixture(t, { retry: { enabled: true, maxRetries: 1, baseDelayMs: 0 },
    reply: call => call.index === 1 ? { stopReason: 'error', content: [], errorMessage: '503 service unavailable (synthetic)' } : undefined });
  await f.session.prompt('Synthetic retry probe');
  await f.session.waitForIdle();
  assert.deepEqual(routes(f).map(r => r.reason), ['user', 'retry']);
  const retry = records.find(r => r.reason === 'retry');
  assert.equal(retry.failed.model.id, 'heavy');
  assert.equal(retry.failed.thinkingLevel, 'high');
  assert.equal(retry.failed.message.stopReason, 'error');
  assert.deepEqual(retry.receivedState, { sourceUserId: retry.sourceId, count: 1 });
  assert.equal(f.requests.length, 2);
  assert.deepEqual(f.requests.map(r => [r.model.id, r.thinkingLevel]), [['heavy', 'high'], ['heavy', 'high']]);
  assert.equal(records.filter(r => r.event === 'before_agent_start').length, 1);
  f.assertClean();
});

test('provider-visible custom user text does not replace the true source user entry', async t => {
  const { fixture: f, records } = await probeFixture(t, { extensions: [pi => {
    pi.on('before_agent_start', () => ({ message: { customType: 'fixture.background', content: 'Not a user-authored request', display: false } }));
  }] });
  await f.session.prompt('Actual user request');
  const route = records.find(r => r.reason);
  assert.deepEqual(route.requestUsers, ['Actual user request', 'Not a user-authored request']);
  assert.equal(rawUsers(f.manager).length, 1);
  assert.equal(route.sourceId, rawUsers(f.manager)[0].id);
  assert.equal(f.manager.getBranch().filter(e => e.type === 'custom_message').length, 1);
  f.assertClean();
});

test('runtime skills advertise metadata only and omit explicit-only from automatic prompt selection', async t => {
  const { fixture: f, records } = await probeFixture(t);
  await f.session.prompt('Synthetic catalog probe');
  const snapshot = records.find(r => r.event === 'before_agent_start').skills;
  assert.equal(snapshot.length, 2);
  assert.equal(snapshot.find(s => s.name === 'explicit-fixture').disableModelInvocation, true);
  const system = records.find(r => r.reason).routeSystem;
  assert.equal(system.sections.skills, `<skills>\n${formatSkillsForPrompt(snapshot, 'read').trim()}\n</skills>`);
  assert.ok(system.sections.skills.includes('review-fixture'));
  assert.ok(!system.sections.skills.includes('explicit-fixture'));
  assert.ok(!getCurrentSystemPrompt(f.requests[0].messages).includes('SYNTHETIC_BODY_'));
  assert.ok(!f.manager.getBranch().some(e => e.type === 'message' && e.message.role === 'toolResult' && e.message.toolName === 'read'));
  f.assertClean();
});

test('explicit-only skill commands expand normally without becoming an automatic recommendation', async t => {
  const f = await createObserverSdkFixture(t);
  await f.session.prompt('/skill:explicit-fixture explain synthetic method');
  const sourceText = textOf(rawUsers(f.manager)[0].message);
  assert.ok(sourceText.includes('SYNTHETIC_BODY_explicit-fixture'));
  assert.ok(sourceText.endsWith('explain synthetic method'));
  assert.ok(!getCurrentSystemPrompt(f.requests[0].messages).includes('explicit-fixture'));
  f.assertClean();
});

test('indirect file reader still advertises Skills without requiring a directly declared read tool', async t => {
  const { fixture: f, records } = await probeFixture(t, { extensions: [pi => {
    pi.registerTool({ name: 'fixture_reader', label: 'Indirect reader', description: 'Synthetic indirect reader',
      parameters: Type.Object({}), prepareLoadout: () => ({ hiddenDeclarations: ['read'] }),
      execute: async () => ({ content: [{ type: 'text', text: 'not executed' }], details: {} }) });
  }], tools: ['read', 'fixture_ping', 'fixture_reader'] });
  await f.session.prompt('Synthetic indirect catalog probe');
  const snapshot = records.find(r => r.event === 'before_agent_start').skills;
  assert.equal(records.find(r => r.reason).routeSystem.sections.skills,
    `<skills>\n${formatSkillsForPrompt(snapshot, 'indirect').trim()}\n</skills>`);
  assert.ok(!getCurrentTools(f.requests[0].messages).some(tool => tool.name === 'read'));
  f.assertClean();
});

test('without a reader, a runtime Skill snapshot is not proof that Skills are model-visible', async t => {
  const { fixture: f, records } = await probeFixture(t, { tools: ['fixture_ping'] });
  await f.session.prompt('Synthetic no-reader probe');
  assert.equal(records.find(r => r.event === 'before_agent_start').skills.length, 2);
  assert.equal(records.find(r => r.reason).routeSystem.sections.skills, undefined);
  assert.ok(!getCurrentSystemPrompt(f.requests[0].messages).includes('review-fixture'));
  f.assertClean();
});

test('later before_agent_start handler can change the directory after a snapshot was captured', async t => {
  const { fixture: f, records } = await probeFixture(t, { extensions: [pi => {
    pi.on('before_agent_start', event => { event.systemPromptOptions.skills = []; });
  }] });
  await f.session.prompt('Synthetic changed-directory probe');
  assert.equal(records.find(r => r.event === 'before_agent_start').skills.length, 2);
  assert.equal(records.find(r => r.reason).routeSystem.sections.skills, undefined);
  f.assertClean();
});

test('forced prompt differs from structured route transcript and must be checked via current prompt', async t => {
  const currentPrompts = [];
  const { fixture: f, records } = await probeFixture(t, { extensions: [pi => {
    pi.on('before_agent_start', () => ({ systemPrompt: 'Synthetic forced prompt WITHOUT a Skill directory' }));
    pi.on('context', (_event, ctx) => { currentPrompts.push(ctx.getSystemPrompt()); });
  }] });
  await f.session.prompt('Synthetic forced prompt probe');
  assert.ok(records.find(r => r.reason).routeSystem.sections.skills.includes('review-fixture'));
  assert.deepEqual(currentPrompts, ['Synthetic forced prompt WITHOUT a Skill directory']);
  assert.equal(getCurrentSystemPrompt(f.requests[0].messages), currentPrompts[0]);
  assert.equal(f.requests[0].messages[0].role, 'system');
  f.assertClean();
});

test('a later context_with_system transform can change provider input after a router/context snapshot', async t => {
  const { fixture: f, records } = await probeFixture(t, { extensions: [pi => {
    pi.on('context_with_system', event => ({ messages: event.messages.map(m => m.role === 'system'
      ? { ...m, sections: { ...m.sections, skills: null } } : m) }));
  }] });
  await f.session.prompt('Synthetic load-order limitation probe');
  assert.ok(records.find(r => r.reason).routeSystem.sections.skills.includes('review-fixture'));
  assert.ok(!getCurrentSystemPrompt(f.requests[0].messages).includes('review-fixture'));
  f.assertClean();
});

test('projection preserves source identity for edits/omissions and separates compaction from raw history', async t => {
  const f = await createObserverSdkFixture(t);
  const manager = f.manager;
  const first = manager.appendMessage(userMessage('Original source'));
  const second = manager.appendMessage(userMessage('Retained source'));
  manager.appendCustomEntry('fixture.state', { selected: 'original' });
  manager.appendContextEdit(second, { content: 'Projected content' });
  let projection = manager.buildSessionProjection();
  const edited = projection.entries.find(e => e.sourceEntry.id === second);
  assert.equal(textOf(edited.messages[0]), 'Projected content');
  assert.equal(textOf(manager.getEntry(second).message), 'Retained source');
  manager.appendContextEdit(second, null);
  projection = manager.buildSessionProjection();
  assert.deepEqual(projection.entries.find(e => e.sourceEntry.id === second).messages, []);
  // Move back to second to leave context edits on an abandoned branch before compaction.
  manager.branch(second);
  const compaction = manager.appendCompaction('Synthetic summary, not a new user request', second, 100);
  projection = manager.buildSessionProjection();
  assert.ok(manager.getBranch().some(e => e.id === first));
  assert.ok(!projection.entries.some(e => e.sourceEntry.id === first));
  assert.equal(projection.entries.find(e => e.sourceEntry.id === compaction).messages.at(-1).role, 'compactionSummary');
  assert.equal(projection.entries.find(e => e.sourceEntry.id === second).messages[0].role, 'user');
  assert.ok(!manager.getBranch().some(e => e.type === 'context_edit'));
  f.assertClean();
});

test('tree navigation restores only the active branch state, while raw entries retain abandoned facts', async t => {
  const { fixture: f } = await probeFixture(t, { guide: false });
  await f.session.prompt('Synthetic root');
  const root = f.manager.getLeafId();
  const rootState = latestFixtureState(f.manager);
  await f.session.prompt('Synthetic branch to abandon');
  const abandonedUser = rawUsers(f.manager).at(-1).id;
  const result = await f.session.navigateTree(root, { summarize: false });
  assert.equal(result.cancelled, false);
  assert.deepEqual(latestFixtureState(f.manager), rootState);
  assert.ok(f.manager.getEntries().some(e => e.id === abandonedUser));
  assert.ok(!f.manager.getBranch().some(e => e.id === abandonedUser));
  assert.ok(f.trace.some(e => e.type === 'session_tree'));
  await f.session.prompt('Synthetic alternate');
  assert.equal(latestFixtureState(f.manager).count, rootState.count + 1);
  assert.equal(f.manager.buildSessionProjection().messages.filter(m => m.role === 'user').length, 2);
  f.assertClean();
});

test('reload replaces extension contexts while persisted branch state survives', async t => {
  const contexts = [];
  const { fixture: f } = await probeFixture(t, { guide: false, extensions: [pi => {
    pi.on('session_start', (_event, ctx) => { contexts.push(ctx); });
  }] });
  await f.session.prompt('Synthetic before reload');
  const state = latestFixtureState(f.manager), before = f.generation;
  const oldApi = f.apiByGeneration.get(before);
  await f.session.reload();
  assert.equal(f.generation, before + 1);
  assert.throws(() => oldApi.appendEntry('fixture.stale', {}), /reload|active|invalid|stale/i);
  assert.throws(() => contexts[0].sessionManager.getBranch(), /reload|active|invalid|stale/i);
  assert.deepEqual(latestFixtureState(f.manager), state);
  await f.session.prompt('Synthetic after reload');
  assert.equal(latestFixtureState(f.manager).count, state.count + 1);
  assert.ok(f.trace.some(e => e.type === 'session_start' && e.reason === 'reload'));
  f.assertClean();
});

test('fork/new runtime replacements change session identity and invalidate old session capabilities', async t => {
  const contexts = [];
  const { fixture: f } = await probeFixture(t, { guide: false, extensions: [pi => {
    pi.on('session_start', (_event, ctx) => { contexts.push(ctx); });
  }] });
  await f.session.prompt('Synthetic root');
  const root = f.manager.getLeafId(), state = latestFixtureState(f.manager), firstId = f.session.sessionId;
  await f.session.prompt('Synthetic abandoned suffix');
  const abandoned = rawUsers(f.manager).at(-1).id;
  assert.equal((await f.runtime.fork(root, { position: 'at' })).cancelled, false);
  assert.notEqual(f.session.sessionId, firstId);
  assert.deepEqual(latestFixtureState(f.manager), state);
  assert.ok(!f.manager.getBranch().some(e => e.id === abandoned));
  assert.throws(() => contexts[0].hasPendingMessages(), /reload|active|invalid|stale/i);
  const forkId = f.session.sessionId;
  assert.equal((await f.runtime.newSession()).cancelled, false);
  assert.notEqual(f.session.sessionId, forkId);
  assert.equal(latestFixtureState(f.manager), undefined);
  assert.ok(f.trace.some(e => e.type === 'session_start' && e.reason === 'fork'));
  assert.ok(f.trace.some(e => e.type === 'session_start' && e.reason === 'new'));
  f.assertClean();
});

test('resume from a temporary persisted session restores virtual selection and only that branch state', async t => {
  const { fixture: f } = await probeFixture(t, { guide: false, persisted: true });
  await f.session.prompt('Synthetic session to resume');
  const file = f.session.sessionFile, id = f.session.sessionId, state = latestFixtureState(f.manager);
  assert.ok(file.startsWith(f.directory));
  await f.runtime.newSession();
  assert.equal((await f.runtime.switchSession(file)).cancelled, false);
  assert.equal(f.session.sessionId, id);
  assert.deepEqual(latestFixtureState(f.manager), state);
  await f.session.prompt('Synthetic resumed request');
  assert.equal(latestFixtureState(f.manager).count, state.count + 1);
  assert.ok(f.trace.some(e => e.type === 'session_start' && e.reason === 'resume'));
  f.assertClean();
});

test('queued input during an awaited route is visible as pending without preempting that request', async t => {
  const entered = deferred(), release = deferred(), snapshots = [];
  const f = await createObserverSdkFixture(t, { route: async (request, ctx) => {
    if (snapshots.length === 0) {
      snapshots.push({ source: rawUsers(ctx.sessionManager).at(-1).id });
      entered.resolve(); await waitForGate(release, request.signal);
      snapshots[0].pending = ctx.hasPendingMessages();
      snapshots[0].sourceAfter = rawUsers(ctx.sessionManager).at(-1).id;
    }
    return { model: physical(ctx), thinkingLevel: 'high' };
  } });
  const run = f.session.prompt('Synthetic slow observation');
  try {
    await entered.promise;
    await f.session.steer('Synthetic new control');
  } finally { release.resolve(); }
  await run; await f.session.waitForIdle();
  assert.equal(snapshots[0].pending, true);
  assert.equal(snapshots[0].sourceAfter, snapshots[0].source);
  assert.equal(f.requests.length, 2);
  assert.deepEqual(routes(f).map(r => r.reason), ['user', 'user']);
  f.assertClean();
});

test('abort during an awaited route prevents provider dispatch and new route-state persistence', async t => {
  const entered = deferred(), never = deferred();
  const f = await createObserverSdkFixture(t, { route: async (request, ctx) => {
    entered.resolve(); await waitForGate(never, request.signal);
    return { model: physical(ctx), thinkingLevel: 'high', state: { mustNotPersist: true } };
  } });
  const run = f.session.prompt('Synthetic cancellable observation');
  await entered.promise;
  await f.session.abort();
  await run;
  assert.equal(f.requests.length, 0);
  assert.equal(latestFixtureState(f.manager), undefined);
  assert.equal(f.session.isIdle, true);
  f.assertClean();
});

test('abort during a mocked provider stream produces an aborted response and no automatic continuation', async t => {
  const entered = deferred(), never = deferred();
  const f = await createObserverSdkFixture(t, { reply: async (_call, signal) => {
    entered.resolve(); await waitForGate(never, signal);
  } });
  const run = f.session.prompt('Synthetic cancellable response');
  await entered.promise; await f.session.abort(); await run;
  const response = f.manager.getBranch().findLast(e => e.type === 'message' && e.message.role === 'assistant').message;
  assert.equal(response.stopReason, 'aborted');
  assert.equal(f.requests.length, 1);
  assert.equal(f.session.isIdle, true);
  f.assertClean();
});

test('append failure is reproducible through a test-only API adapter, not private session mutation', async t => {
  let failures = 0;
  const { fixture: f } = await probeFixture(t, { guide: false, extensions: [pi => {
    // Explicit test seam for later reservation/acceptance failure cases.
    pi.on('before_agent_start', (_event, ctx) => {
      const adapter = fixtureCapabilities(pi, ctx, { appendError: new Error('Synthetic append failure') });
      try { adapter.api.appendEntry('fixture.reservation', { attempted: true }); } catch { failures++; }
    });
  }] });
  await f.session.prompt('Synthetic persistence-failure probe');
  assert.equal(failures, 1);
  assert.ok(!f.manager.getBranch().some(e => e.customType === 'fixture.reservation'));
  f.assertClean();
});

test('transformed and handled inputs never manufacture source identities from raw input', async t => {
  const { fixture: f, records } = await probeFixture(t, { extensions: [pi => {
    pi.on('input', event => event.text === 'Synthetic handled' ? { action: 'handled' }
      : { action: 'transform', text: 'Synthetic persisted transform' });
  }] });
  await f.session.prompt('Synthetic raw input');
  assert.deepEqual(records.find(r => r.reason).requestUsers, ['Synthetic persisted transform']);
  assert.equal(textOf(rawUsers(f.manager)[0].message), 'Synthetic persisted transform');
  await f.session.prompt('Synthetic handled');
  assert.equal(f.requests.length, 1);
  assert.equal(rawUsers(f.manager).length, 1);
  assert.equal(routes(f).length, 1);
  f.assertClean();
});

test('compaction provider-user conversion retains the compaction source, not a new user identity', async t => {
  const { fixture: f, records } = await probeFixture(t, { guide: false });
  await f.session.prompt('Synthetic old context');
  const retained = f.manager.appendMessage(userMessage('Synthetic retained context'));
  f.manager.appendCompaction('Synthetic compacted summary', retained, 100);
  f.session.refreshContext();
  await f.session.prompt('Synthetic actual new request');
  const routed = records.filter(r => r.reason).at(-1);
  assert.ok(routed.requestUsers.some(text => text.includes('Synthetic compacted summary')));
  assert.equal(routed.sourceId, rawUsers(f.manager).at(-1).id);
  assert.equal(textOf(rawUsers(f.manager).at(-1).message), 'Synthetic actual new request');
  const projection = f.manager.buildSessionProjection();
  assert.ok(projection.messages.some(m => m.role === 'compactionSummary'));
  assert.ok(!projection.messages.some(m => m.role === 'user' && textOf(m) === 'Synthetic old context'));
  f.assertClean();
});

test('classifier completion after session replacement cannot append using the captured old API', async t => {
  const entered = deferred(), release = deferred(), contexts = [];
  const f = await createObserverSdkFixture(t, {
    classify: async (_call, _options, fixture) => {
      entered.resolve(); await release.promise;
      return { stopReason: 'stop', answers: { capability: { type: 'score', score: 1, confidence: .95 } } };
    }, extensions: [pi => {
      pi.on('session_start', (_event, ctx) => { contexts.push({ ctx, pi }); });
    }],
  });
  const old = contexts[0], oldId = old.ctx.sessionManager.getSessionId();
  const model = f.runtime.services.modelRuntime.getModelOfType('classifier', 'typesafe', 'jev-latest');
  const work = f.runtime.services.modelRuntime.classify(model, { state: {}, questions: {} });
  try {
    await entered.promise;
    await f.runtime.newSession();
    assert.notEqual(f.session.sessionId, oldId);
  } finally { release.resolve(); }
  assert.equal((await work).answers.capability.score, 1);
  assert.throws(() => old.pi.appendEntry('fixture.late-usage', {}), /reload|active|invalid|stale/i);
  assert.throws(() => old.ctx.sessionManager.getBranch(), /reload|active|invalid|stale/i);
  assert.ok(!f.manager.getBranch().some(e => e.customType === 'fixture.late-usage'));
  f.assertClean();
});

test('reduced public SDK adapter exposes missing projection/pending/trust explicitly', async t => {
  const captures = [];
  const f = await createObserverSdkFixture(t, { extensions: [pi => {
    pi.on('before_agent_start', (_event, ctx) => {
      const adapter = fixtureCapabilities(pi, ctx, { missingSession: ['buildSessionProjection'],
        missingContext: ['hasPendingMessages', 'getSystemPrompt', 'isProjectTrusted'] });
      captures.push(adapter.ctx);
      adapter.api.appendEntry('fixture.limited-host', { coverage: 'partial' });
    });
  }] });
  await f.session.prompt('Synthetic reduced host');
  assert.equal(captures[0].sessionManager.buildSessionProjection, undefined);
  for (const name of ['hasPendingMessages', 'getSystemPrompt', 'isProjectTrusted']) assert.equal(captures[0][name], undefined);
  assert.equal(typeof captures[0].sessionManager.getBranch, 'function');
  assert.ok(f.manager.getBranch().some(e => e.customType === 'fixture.limited-host'));
  f.assertClean();
});
