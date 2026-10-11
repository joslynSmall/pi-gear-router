import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const dir = mkdtempSync(join(tmpdir(), 'pi-gear-status-test-'));
process.env.PI_GEAR_ROUTER_DATA_DIR = dir;
const { default: extension } = await import('../src/index.ts');
after(() => rmSync(dir, { recursive: true, force: true }));
const model = (id) => ({ provider: 'test', id, api: 'openai-responses', reasoning: true });
const user = { role: 'user', content: 'test task', timestamp: 1 };

function setup({ mode = 'tui', judgeFails = false } = {}) {
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({ gears: {
    light: { provider: 'test', model: 'light', thinkingLevel: 'low' },
    standard: { provider: 'test', model: 'standard', thinkingLevel: 'medium' },
    heavy: { provider: 'test', model: 'heavy', thinkingLevel: 'high' },
  } }));
  let route;
  const handlers = new Map();
  extension({ on: (event, handler) => { handlers.set(event, handler); return () => handlers.delete(event); },
    registerVirtualModel: (definition) => { route = definition.route; } });
  const statuses = [];
  const branch = [];
  const ctx = { mode, ui: { theme: { fg: (_color, text) => text }, setStatus: (key, text) => statuses.push({ key, text }) },
    sessionManager: { getBranch: () => branch },
    modelRegistry: {
      find: (_provider, id) => model(id), hasConfiguredAuth: () => true,
      getModelOfType: () => ({}),
      classify: async () => judgeFails ? { stopReason: 'error', answers: {} }
        : { stopReason: 'stop', answers: { gear: { type: 'score', score: 0.76, confidence: 0.8 } } },
    },
  };
  return { route, handlers, statuses, ctx, branch, setRoute(fn) { route = fn; } };
}

test('TUI status shows pending then Jev score, gear and physical model', async () => {
  const h = setup();
  let resolve;
  h.ctx.modelRegistry.classify = () => new Promise((r) => { resolve = r; });
  const activeRoute = (() => {
    let route;
    extension({ on: () => () => {}, registerVirtualModel: (d) => { route = d.route; } });
    return route;
  })();
  const pending = activeRoute({ reason: 'user', thinkingLevel: 'high', messages: [user] }, h.ctx);
  assert.deepEqual(h.statuses.at(-1), { key: 'pi-gear-router', text: 'Jev 评估中…' });
  resolve({ stopReason: 'stop', answers: { gear: { type: 'score', score: 0.76, confidence: 0.8 } }, usage: { input: 22 } });
  const result = await pending;
  assert.equal(result.model.id, 'standard');
  assert.match(h.statuses.at(-1).text, /路由 计划 · standard · Jev 0\.76 → standard\/medium → test\/standard/);
});

test('fallback, disabled, restore and shutdown status are marked or cleared', async () => {
  const h = setup({ judgeFails: true });
  let route;
  extension({
    on: (event, handler) => { h.handlers.set(event, handler); return () => h.handlers.delete(event); },
    registerVirtualModel: (d) => { route = d.route; },
  });
  const result = await route({ reason: 'user', thinkingLevel: 'high', messages: [user] }, h.ctx);
  assert.match(h.statuses.at(-1).text, /路由 计划 · heavy · Jev 不可用 → heavy\/high fallback → test\/heavy/);
  h.branch.push({ type: 'custom', customType: 'pi.virtual-model-state', data: { provider: 'gears', modelId: 'auto', state: result.state } });
  const start = h.handlers.get('session_start');
  await start({ type: 'session_start' }, h.ctx);
  assert.match(h.statuses.at(-1).text, /Jev 不可用/);
  await h.handlers.get('session_shutdown')({ type: 'session_shutdown' }, h.ctx);
  assert.equal(h.statuses.at(-1).text, undefined);
  assert.equal(result.state.fallback, true);
});

test('non-TUI modes never invoke UI status methods', async () => {
  const h = setup({ mode: 'print' });
  h.ctx.ui.setStatus = () => { throw new Error('UI is unavailable in print mode'); };
  let route;
  extension({ on: () => () => {}, registerVirtualModel: (d) => { route = d.route; } });
  const result = await route({ reason: 'user', thinkingLevel: 'high', messages: [user] }, h.ctx);
  assert.equal(result.model.id, 'standard');
});
