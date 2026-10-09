import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { defaultSettings, gearForScore } from '../src/gears.ts';
import { cloneSettings } from '../src/defaults.ts';

const dir = mkdtempSync(join(tmpdir(), 'pi-gear-settings-test-'));
process.env.PI_GEAR_ROUTER_DATA_DIR = dir;
const { loadSettings, saveSettings, SETTINGS_PATH } = await import('../src/settings.ts');
after(() => rmSync(dir, { recursive: true, force: true }));

test('score boundaries, bias, and clamp select the expected tier', () => {
  for (const [score, bias, gear, thinkingLevel, adjustedScore] of [
    [0, 0, 'light', 'low', 0], [0.499, 0, 'light', 'low', 0.499],
    [0.5, 0, 'standard', 'medium', 0.5], [0.999, 0, 'standard', 'medium', 0.999],
    [1, 0, 'standard', 'high', 1], [1.499, 0, 'standard', 'high', 1.499],
    [1.5, 0, 'heavy', 'high', 1.5], [1.799, 0, 'heavy', 'high', 1.799],
    [1.8, 0, 'heavy', 'xhigh', 1.8], [2, 0, 'heavy', 'xhigh', 2],
    [0, -1, 'light', 'low', 0], [2, 1, 'heavy', 'xhigh', 2],
    [0.8, -1, 'light', 'low', 0.4], [1.1, 1, 'heavy', 'high', 1.5],
  ]) assert.deepEqual(gearForScore(score, bias), { gear, thinkingLevel, adjustedScore });
});

test('defaults and cloned settings do not share mutable gear targets', () => {
  const a = defaultSettings();
  a.gears.light.model = 'modified';
  assert.notEqual(defaultSettings().gears.light.model, 'modified');
  const b = cloneSettings(a);
  b.gears.light.thinkingLevel = 'max';
  assert.equal(a.gears.light.thinkingLevel, 'low');
});

test('malformed and partial files retain defaults; invalid levels and empty names rejected', () => {
  for (const value of ['not json', 'null', '[]']) {
    writeFileSync(SETTINGS_PATH, value);
    assert.deepEqual(loadSettings(), defaultSettings());
  }
  writeFileSync(SETTINGS_PATH, JSON.stringify({ gears: {
    light: { provider: 'test', model: 'bad', thinkingLevel: 'typo' },
    standard: { provider: ' ', model: 'empty', thinkingLevel: 'high' },
    heavy: { provider: 'test', model: 'valid', thinkingLevel: 'minimal' },
  } }));
  const s = loadSettings();
  assert.deepEqual(s.gears.light, defaultSettings().gears.light);
  assert.deepEqual(s.gears.standard, defaultSettings().gears.standard);
  assert.equal(s.gears.heavy.thinkingLevel, 'minimal');
});

test('task policy validates each field independently, including zero inheritance', () => {
  writeFileSync(SETTINGS_PATH, JSON.stringify({ taskRouting: { maxInheritedTurns: 0, downgradeWindow: 8, downgradeMargin: .15, minConfidence: 1 } }));
  assert.deepEqual(loadSettings().taskRouting, { maxInheritedTurns: 0, downgradeWindow: 8, downgradeMargin: .15, minConfidence: 1 });
  for (const value of [{ maxInheritedTurns: 1.5, downgradeWindow: 1, downgradeMargin: -.1, minConfidence: .2 }, { maxInheritedTurns: '3', downgradeWindow: 9, downgradeMargin: .16, minConfidence: null }, []]) {
    writeFileSync(SETTINGS_PATH, JSON.stringify({ taskRouting: value }));
    assert.deepEqual(loadSettings().taskRouting, defaultSettings().taskRouting);
  }
  const copy = loadSettings(); copy.taskRouting.maxInheritedTurns = 8;
  assert.equal(loadSettings().taskRouting.maxInheritedTurns, 3);
});

test('cache refreshes on external changes, save, deletion and re-creation; callers get independent objects', () => {
  saveSettings(defaultSettings());
  const a = loadSettings();
  a.gears.standard.model = 'mutated';
  assert.notEqual(loadSettings().gears.standard.model, 'mutated');
  const changed = defaultSettings();
  changed.enabled = false;
  changed.gears.standard.model = 'changed';
  writeFileSync(SETTINGS_PATH, JSON.stringify(changed));
  assert.equal(loadSettings().enabled, false);
  assert.equal(loadSettings().gears.standard.model, 'changed');
  saveSettings(defaultSettings());
  assert.equal(loadSettings().enabled, true);
  rmSync(SETTINGS_PATH);
  assert.deepEqual(loadSettings(), defaultSettings());
  writeFileSync(SETTINGS_PATH, JSON.stringify(changed));
  assert.equal(loadSettings().enabled, false);
});
