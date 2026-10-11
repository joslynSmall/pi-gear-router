import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const dir = mkdtempSync(join(tmpdir(), 'gear-router-'));
process.env.PI_GEAR_ROUTER_DATA_DIR = dir;
const { default: extension } = await import('../src/index.ts');
after(() => rmSync(dir, { recursive: true, force: true }));
const physical = id => ({ provider: 'offline', id, api: 'openai-responses', reasoning: true,
  thinkingLevelMap: { off: 'off', minimal: 'minimal', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' } });
const user = (content, timestamp = 1) => ({ role: 'user', content, timestamp });
function harness(verdicts = [{ score: 1.9, confidence: .9 }], config = {}) {
  const gears = Object.fromEntries(['light', 'standard', 'heavy'].map(g => [g, { provider: 'offline', model: g, thinkingLevel: g === 'heavy' ? 'high' : g === 'standard' ? 'medium' : 'low' }]));
  const settings = { gears, ...config };
  const save = () => writeFileSync(join(dir, 'settings.json'), JSON.stringify(settings)); save();
  let route, state, clock = 0;
  const handlers = new Map(), commands = new Map(), branch = [], calls = [], statuses = [], notifications = [], dialogs = [], missing = new Set(), noAuth = new Set();
  extension({ on: (name, fn) => handlers.set(name, fn), registerCommand: (name, fn) => commands.set(name, fn),
    appendEntry: (customType, data) => branch.push({ type: 'custom', id: `entry-${++clock}`, customType, data }),
    registerVirtualModel: definition => { route = definition.route; } });
  const ctx = { cwd: dir, mode: 'tui', hasUI: true, model: { provider: 'gears', id: 'auto' }, isProjectTrusted: () => false,
    ui: { theme: { fg: (_tone, text) => text }, setStatus: (_key, text) => statuses.push(text), notify: (text, tone) => notifications.push({ text, tone }),
      confirm: async (...args) => { dialogs.push(args); return true; } }, sessionManager: { getBranch: () => branch },
    modelRegistry: { find: (_provider, id) => missing.has(id) ? undefined : physical(id), hasConfiguredAuth: model => !noAuth.has(model.id),
      getModelOfType: () => ({}), classify: async (_m, input, options) => { calls.push({ input, options }); const v = verdicts[Math.min(calls.length - 1, verdicts.length - 1)];
        return v ? { stopReason: 'stop', answers: { gear: { type: 'score', ...v } }, usage: { input: 42 } } : { stopReason: 'error', answers: {} }; } },
  };
  const run = async (text = 'task', options = {}) => {
    const messages = options.messages ?? [user(text, ++clock)];
    const result = await route({ reason: 'user', state, thinkingLevel: 'xhigh', messages, ...options }, ctx);
    if (result.state) { state = result.state; branch.push({ type: 'custom', id: `state-${++clock}`, customType: 'pi.virtual-model-state', data: { provider: 'gears', modelId: 'auto', state } }); }
    return result;
  };
  return { run, route: (r) => route(r, ctx), ctx, commands, handlers, branch, calls, statuses, notifications, dialogs, missing, noAuth, settings, save, state: () => state };
}

test('only first plan turn is judged; unrelated tasks and continuation text keep the pair', async () => {
  const h = harness();
  assert.equal((await h.run()).model.id, 'heavy');
  for (const text of ['继续', '解释一下', '独立简单改名', '新需求很困难']) assert.equal((await h.run(text)).model.id, 'heavy');
  assert.equal(h.calls.length, 1);
  assert.equal(h.state().dispatch.thinkingLevel, 'high');
  assert.equal(h.calls[0].input.state.phase, 'plan');
  assert.deepEqual(Object.keys(h.calls[0].input.questions), ['gear']);
});

test('confidently ordinary plan uses standard; low confidence and Jev failure use heavy', async () => {
  for (const [v, id] of [[{ score: 1.49, confidence: .8 }, 'standard'], [{ score: .1, confidence: .79 }, 'heavy'], [null, 'heavy']]) {
    const h = harness([v]); assert.equal((await h.run()).model.id, id);
    if (!v) assert.equal(h.state().judgeFailed, true);
  }
});

test('candidate needs dialog confirmation; accepted switch is judged once and stays stable', async () => {
  const h = harness([{ score: 1.9, confidence: .9 }, { score: 1.1, confidence: .9 }]);
  await h.run();
  const r = await h.run('好的，开始实现');
  assert.equal(r.state.phase, 'implement'); assert.equal(r.model.id, 'standard'); assert.equal(r.thinkingLevel, 'medium');
  assert.equal(h.dialogs.length, 1); assert.equal(h.calls.length, 2); assert.equal(h.calls[1].input.state.phase, 'implement');
  await h.run('开始实现'); await h.run('继续'); assert.equal(h.calls.length, 2); assert.equal(h.dialogs.length, 1);
});

test('declined, cancelled, ordinary, and negated messages never change phase or judge', async () => {
  const h = harness(); await h.run(); h.ctx.ui.confirm = async () => false;
  for (const text of ['开始实现', '请确认需求', '不要开始实现', 'do not start implementing', '解释一下', '继续']) await h.run(text);
  assert.equal(h.state().phase, 'plan'); assert.equal(h.calls.length, 1);
});

test('without dialog UI keywords do not imply approval; explicit command still works', async () => {
  const h = harness([null]); h.ctx.hasUI = false; h.ctx.mode = 'print'; await h.run('开始实现');
  assert.equal(h.state().phase, 'plan');
  await h.commands.get('gear-phase').handler('implement', h.ctx);
  assert.equal(h.state().phase, 'plan');
  const r = await h.run('继续'); assert.equal(r.state.phase, 'implement'); assert.equal(r.model.id, 'standard');
  assert.equal(h.calls.length, 2);
});

test('high-confidence hard implementation holds original plan gear, not automatic escalation', async () => {
  for (const initial of [1.1, 1.9]) {
    const h = harness([{ score: initial, confidence: .9 }, { score: 1.9, confidence: .9 }]);
    const plan = (await h.run()).model.id; const impl = await h.run('开始实现');
    assert.equal(impl.model.id, plan);
  }
});

test('phase command applies next user turn, restores original plan gear, and does not leak into continuation', async () => {
  const h = harness([{ score: 1.9, confidence: .9 }, { score: 1, confidence: .9 }]); await h.run();
  await h.commands.get('gear-phase').handler('implement', h.ctx);
  const count = h.branch.length;
  await h.run('', { reason: 'continuation', previous: { model: physical('heavy'), thinkingLevel: 'high' } });
  assert.equal(h.state().phase, 'plan'); assert.equal(h.branch.length, count); assert.equal(h.calls.length, 1);
  await h.run('继续'); assert.equal(h.state().phase, 'implement'); assert.equal(h.calls.length, 2);
  await h.commands.get('gear-phase').handler('plan', h.ctx); await h.run('重新讨论');
  assert.equal(h.state().phase, 'plan'); assert.equal(h.state().gear, 'heavy'); assert.equal(h.calls.length, 2);
  await h.commands.get('gear-phase').handler('implement', h.ctx); await h.run('继续'); assert.equal(h.calls.length, 3);
});

test('duplicate, invalid and read-only commands do not classify or append', async () => {
  const h = harness(); await h.run(); const length = h.branch.length;
  for (const [name, arg] of [['gear-phase', 'plan'], ['gear-phase', 'invalid'], ['gear-phase', ''], ['gear-status', '']]) await h.commands.get(name).handler(arg, h.ctx);
  assert.equal(h.branch.length, length); assert.equal(h.calls.length, 1);
  assert.deepEqual(h.commands.get('gear-phase').getArgumentCompletions('im'), [{ value: 'implement', label: 'implement' }]);
});

test('continuations/retries preserve actual pair; routing failure retry prefers saved current pair', async () => {
  const h = harness(); await h.run();
  const previous = { model: physical('other'), thinkingLevel: 'low' }, failed = { model: physical('failed'), thinkingLevel: 'medium' };
  assert.equal((await h.run('', { reason: 'continuation', previous })).model.id, 'other');
  assert.equal((await h.run('', { reason: 'retry', previous, failed })).model.id, 'failed');
  assert.equal((await h.run('', { reason: 'retry', previous })).model.id, 'heavy');
  assert.equal(h.calls.length, 1);
});

test('same-turn route is idempotent including dialog decline', async () => {
  const h = harness(); const messages = [user('开始实现', 7)]; h.ctx.ui.confirm = async (...args) => { h.dialogs.push(args); return false; };
  await h.run('', { messages }); const second = await h.run('', { messages });
  assert.equal(second.state, undefined); assert.equal(h.calls.length, 1); assert.equal(h.dialogs.length, 1);
});

test('light is only fallback after standard AND heavy, and recovered targets do not oscillate', async () => {
  const h = harness([{ score: 1, confidence: .9 }]); h.missing.add('standard');
  assert.equal((await h.run()).model.id, 'heavy');
  h.missing.clear(); assert.equal((await h.run('继续')).model.id, 'heavy');
  const h2 = harness(); h2.noAuth.add('heavy'); h2.noAuth.add('standard');
  assert.equal((await h2.run()).model.id, 'light'); assert.equal(h2.state().fallback, true);
});

test('lost availability resolves again, config changes take effect only on next user turn', async () => {
  const h = harness(); await h.run(); h.missing.add('heavy'); assert.equal((await h.run()).model.id, 'standard');
  h.settings.gears.heavy.model = 'new-heavy'; h.save();
  assert.equal((await h.run('', { reason: 'continuation', previous: { model: physical('standard'), thinkingLevel: 'medium' } })).model.id, 'standard');
  assert.equal((await h.run()).model.id, 'new-heavy'); assert.equal(h.calls.length, 1);
});

test('all gears unavailable use historical physical model or report actionable error', async () => {
  const h = harness(); for (const g of ['light', 'standard', 'heavy']) h.missing.add(g);
  const r = await h.run('task', { previous: { model: physical('manual'), thinkingLevel: 'low' } }); assert.equal(r.model.id, 'manual');
  h.noAuth.add('manual');
  await assert.rejects(h.run('task'), /no authenticated physical model.*settings.json/);
});

test('virtual targets cannot be dispatched and physical thinking is clamped', async () => {
  const h = harness(); h.ctx.modelRegistry.find = (_p, id) => id === 'heavy' ? { ...physical(id), api: 'pi-virtual' } : { ...physical(id), reasoning: false };
  const r = await h.run(); assert.equal(r.model.id, 'standard'); assert.equal(r.thinkingLevel, 'off');
});

test('disabled and direct routes do not classify or change phase state', async () => {
  const h = harness([], { enabled: false }); assert.equal((await h.run()).model.id, 'standard'); assert.equal(h.state(), undefined); assert.equal(h.calls.length, 0);
  const direct = harness(); const result = await direct.run('', { reason: 'direct' });
  assert.equal(result.model.id, 'standard'); assert.equal(result.state, undefined); assert.equal(direct.calls.length, 0);
});

test('old observer state resets to plan; compatible task phase is retained without judgment', async () => {
  const h = harness(); const old = { version: 1, mode: 'observer', dispatch: { provider: 'offline', model: 'standard', thinkingLevel: 'medium' } };
  assert.equal((await h.run('task', { state: old })).state.phase, 'plan');
  const h2 = harness(); const oldTask = { gear: 'standard', fallback: false, phaseRoute: { version: 1, phase: 'implement', revising: true, planGear: 'heavy', implementGear: 'standard' } };
  assert.equal((await h2.run('task', { state: oldTask })).state.phase, 'implement'); assert.equal(h2.calls.length, 0);
});

test('already-aborted and in-flight cancellation never commit a new decision', async () => {
  const h = harness(); const abort = new AbortController(); abort.abort();
  await assert.rejects(h.run('task', { signal: abort.signal }), { name: 'AbortError' }); assert.equal(h.calls.length, 0);
  const later = new AbortController(); h.ctx.modelRegistry.classify = async () => { later.abort(); return { stopReason: 'aborted', answers: {} }; };
  await assert.rejects(h.run('task', { signal: later.signal }), { name: 'AbortError' }); assert.equal(h.state(), undefined);
});

test('does not register any tools, guidance/context or workflow lifecycle hooks', () => {
  const h = harness(); assert.deepEqual([...h.handlers.keys()].sort(), ['model_select', 'session_shutdown', 'session_start', 'session_tree']);
});

test('TUI reports evaluation, phase, actual model/thinking and failure, clears on manual selection', async () => {
  const h = harness([null]); await h.run();
  assert.ok(h.statuses.some(s => s?.includes('评估中'))); assert.match(h.statuses.at(-1), /计划.*offline\/heavy.*high.*Jev 不可用/);
  h.ctx.model = physical('manual'); h.handlers.get('model_select')({}, h.ctx); assert.equal(h.statuses.at(-1), undefined);
});

test('queued commands can be cancelled/superseded before a user turn, and status reports pending', async () => {
  const h = harness(); await h.run();
  await h.commands.get('gear-phase').handler('implement', h.ctx);
  await h.commands.get('gear-phase').handler('', h.ctx); assert.match(h.notifications.at(-1).text, /下一条消息切换到实现/);
  await h.commands.get('gear-phase').handler('plan', h.ctx); await h.run('继续');
  assert.equal(h.state().phase, 'plan'); assert.equal(h.calls.length, 1);
  const count = h.branch.length; await h.commands.get('gear-phase').handler('plan', h.ctx); assert.equal(h.branch.length, count);
});

test('command before first turn enters implementation with one classification', async () => {
  const h = harness(); await h.commands.get('gear-phase').handler('implement', h.ctx);
  const r = await h.run('执行已确认的方案'); assert.equal(r.state.phase, 'implement'); assert.equal(h.calls.length, 1); assert.equal(h.dialogs.length, 0);
});

test('disabled mid-session neither consumes pending commands nor calls Jev', async () => {
  const h = harness(); await h.run(); await h.commands.get('gear-phase').handler('implement', h.ctx);
  h.settings.enabled = false; h.save(); await h.run('继续');
  assert.equal(h.state().phase, 'plan'); assert.equal(h.calls.length, 1); assert.match(h.statuses.at(-1), /路由已关闭/);
  await h.commands.get('gear-status').handler('', h.ctx); assert.match(h.notifications.at(-1).text, /路由已关闭/);
  h.settings.enabled = true; h.save(); await h.run('继续'); assert.equal(h.state().phase, 'implement'); assert.equal(h.calls.length, 2);
});

test('RPC dialog is supported and print keywords never invoke a dialog', async () => {
  const h = harness(); h.ctx.mode = 'rpc'; await h.run(); await h.run('开始实现');
  assert.equal(h.state().phase, 'implement'); assert.equal(h.dialogs.length, 1); assert.equal(h.statuses.length, 0);
});

test('manual model selection is reported honestly by read-only status', async () => {
  const h = harness(); await h.run(); h.ctx.model = physical('manual');
  await h.commands.get('gear-status').handler('', h.ctx); assert.match(h.notifications.at(-1).text, /手选物理模型；路由未运行/);
});

test('non-TUI modes never use terminal status UI; shutdown clears only TUI', async () => {
  const h = harness(); h.ctx.mode = 'rpc'; await h.run(); assert.equal(h.statuses.length, 0);
  h.ctx.mode = 'tui'; h.handlers.get('session_start')({}, h.ctx); assert.match(h.statuses.at(-1), /计划/);
  h.handlers.get('session_shutdown')({}, h.ctx); assert.equal(h.statuses.at(-1), undefined);
});
