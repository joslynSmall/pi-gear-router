import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { defaultSettings, gearForScore } from '../src/gears.ts';
import { cloneSettings } from '../src/defaults.ts';

const dir = mkdtempSync(join(tmpdir(), 'pi-gear-settings-test-'));
process.env.PI_GEAR_ROUTER_DATA_DIR = dir;
const { loadSettings, saveSettings, SETTINGS_PATH, projectSettingsPath } = await import('../src/settings.ts');
after(() => rmSync(dir, { recursive: true, force: true }));

test('observer settings validate independent limits and preserve JSONC overlay inheritance', () => {
  writeFileSync(SETTINGS_PATH, `{// observer is opt-in\n"routingMode":"observer","observer":{"maxCallsPerTask":64,"maxTransitions":8,"maxTransportRetries":1,
    "guidance":{"enabled":false,"maxCandidates":1,"maxChars":700,"maxPerTask":12},"skills":{"enabled":false},"stageAware":false,
    "minBands":{"converge":15,"implement":0,"verify":2,"respond":1}}}`);
  const s = loadSettings();
  assert.equal(s.routingMode, 'observer');
  assert.deepEqual(s.observer, { maxCallsPerTask: 64, maxTransitions: 8, maxTransportRetries: 1, guidance: { enabled: false, maxCandidates: 1, maxChars: 700, maxPerTask: 12 },
    skills: { enabled: false }, stageAware: false, minBands: { converge: 15, implement: 0, verify: 2, respond: 1 } });
  const project = join(dir, 'observer-project'); mkdirSync(join(project, '.pi', 'pi-gear-router'), { recursive: true });
  writeFileSync(projectSettingsPath(project), JSON.stringify({ observer: { maxCallsPerTask: 23, guidance: { enabled: true, maxCandidates: 3 }, minBands: { converge: 99 } } }));
  const layered = loadSettings(project, { projectTrusted: true });
  assert.equal(layered.observer.maxCallsPerTask, 23); assert.equal(layered.observer.guidance.enabled, true);
  assert.equal(layered.observer.guidance.maxCandidates, 1); assert.equal(layered.observer.minBands.converge, 99);
  const copy = loadSettings(); copy.observer.guidance.maxPerTask = 0; assert.equal(loadSettings().observer.guidance.maxPerTask, 12);
  writeFileSync(SETTINGS_PATH, JSON.stringify({ observer: { maxCallsPerTask: 65, maxTransitions: 9, maxTransportRetries: 2, stageAware: 'yes',
    guidance: { maxCandidates: -1, maxChars: 801, maxPerTask: 13 }, minBands: { converge: -1 } } }));
  assert.deepEqual(loadSettings().observer, defaultSettings().observer);
  rmSync(SETTINGS_PATH);
});

test('invalid modes disable observer opt-in rather than inheriting it from a fallback', () => {
  const project = join(dir, 'invalid-mode-project'); mkdirSync(join(project, '.pi', 'pi-gear-router'), { recursive: true });
  writeFileSync(SETTINGS_PATH, JSON.stringify({ routingMode: 'observer' }));
  writeFileSync(projectSettingsPath(project), JSON.stringify({ routingMode: 'typo' }));
  const s = loadSettings(project, { projectTrusted: true });
  assert.equal(s.routingMode, undefined); assert.equal(s.routingModeInvalid, true);
  for (const value of [null, 7, false, [], {}]) {
    writeFileSync(SETTINGS_PATH, JSON.stringify({ routingMode: value }));
    assert.equal(loadSettings().routingModeInvalid, true); assert.equal(loadSettings().routingMode, undefined);
  }
  rmSync(SETTINGS_PATH);
});

test('untrusted or capability-unknown project cannot opt into or override observer policy', () => {
  const project = join(dir, 'observer-trust-project'); mkdirSync(join(project, '.pi', 'pi-gear-router'), { recursive: true });
  writeFileSync(SETTINGS_PATH, JSON.stringify({ gearBias: .1 }));
  writeFileSync(projectSettingsPath(project), JSON.stringify({ routingMode: 'observer', gearBias: -.5 }));
  for (const options of [undefined, { projectTrusted: false }, { projectTrusted: undefined }]) {
    const s = loadSettings(project, options); assert.equal(s.routingMode, undefined); assert.equal(s.gearBias, .1);
  }
  assert.equal(loadSettings(project, { projectTrusted: true }).routingMode, 'observer');
  writeFileSync(SETTINGS_PATH, JSON.stringify({ routingMode: 'observer', gearBias: .1 }));
  writeFileSync(projectSettingsPath(project), JSON.stringify({ routingMode: 'task', gearBias: -.5 }));
  assert.equal(loadSettings(project, { projectTrusted: false }).routingMode, 'observer');
  assert.equal(loadSettings(project, { projectTrusted: true }).routingMode, 'task');
  // No new trust behavior is imposed on the existing default task mode.
  writeFileSync(SETTINGS_PATH, '{}'); writeFileSync(projectSettingsPath(project), JSON.stringify({ gearBias: -.5 }));
  assert.equal(loadSettings(project).gearBias, -.5);
  rmSync(SETTINGS_PATH);
});

test('score boundaries, bias, and clamp select the expected tier', () => {
  for (const [score, bias, gear, thinkingLevel, adjustedScore] of [
    [0, 0, 'light', 'high', 0], [0.499, 0, 'light', 'high', 0.499],
    [0.5, 0, 'standard', 'medium', 0.5], [0.999, 0, 'standard', 'medium', 0.999],
    [1, 0, 'standard', 'high', 1], [1.499, 0, 'standard', 'high', 1.499],
    [1.5, 0, 'heavy', 'high', 1.5], [1.799, 0, 'heavy', 'high', 1.799],
    [1.8, 0, 'heavy', 'xhigh', 1.8], [2, 0, 'heavy', 'xhigh', 2],
    [0, -1, 'light', 'high', 0], [2, 1, 'heavy', 'xhigh', 2],
    [0.8, -1, 'light', 'high', 0.4], [1.1, 1, 'heavy', 'high', 1.5],
  ]) assert.deepEqual(gearForScore(score, bias), { gear, thinkingLevel, adjustedScore });
});

test('defaults and cloned settings do not share mutable gear targets', () => {
  const a = defaultSettings();
  a.gears.light.model = 'modified';
  assert.notEqual(defaultSettings().gears.light.model, 'modified');
  const b = cloneSettings(a);
  b.gears.light.thinkingLevel = 'max';
  assert.equal(a.gears.light.thinkingLevel, 'high');
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

test('workflow policy is opt-in, validates bounds, and clamps inherited bands after a band-table change', () => {
  const customBands = [
    { max: 1, gear: 'light', thinkingLevel: 'low' },
    { gear: 'heavy', thinkingLevel: 'high' },
  ];
  writeFileSync(SETTINGS_PATH, JSON.stringify({
    bands: customBands,
    workflow: {
      enabled: true, planningMinBand: 1, executionMinBand: 0, atomicExecutionMinBand: 0,
      verificationMinBand: 0, recoveryMinBand: 1, handoffMinConfidence: .9, maxTransitions: 8, maxReminderContinuations: 0,
    },
  }));
  assert.deepEqual(loadSettings().workflow, {
    enabled: true, planningMinBand: 1, executionMinBand: 0, atomicExecutionMinBand: 0,
    verificationMinBand: 0, recoveryMinBand: 1, handoffMinConfidence: .9, maxTransitions: 8, maxReminderContinuations: 0,
  });
  writeFileSync(SETTINGS_PATH, JSON.stringify({ bands: customBands, workflow: {
    enabled: 'yes', planningMinBand: 2, executionMinBand: -1, atomicExecutionMinBand: 1.2,
    verificationMinBand: '0', recoveryMinBand: 3, handoffMinConfidence: .4, maxTransitions: 9, maxReminderContinuations: 2,
  } }));
  assert.deepEqual(loadSettings().workflow, {
    ...defaultSettings().workflow, planningMinBand: 1, recoveryMinBand: 1,
  });
  assert.equal(defaultSettings().workflow.enabled, false);
  rmSync(SETTINGS_PATH);
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

test('bands configure the score mapping and fall back atomically when invalid', () => {
  const custom = [
    { max: 0.4, gear: 'light', thinkingLevel: 'low' },
    { max: 1.2, gear: 'standard', thinkingLevel: 'high' },
    { gear: 'heavy', thinkingLevel: 'xhigh' },
  ];
  writeFileSync(SETTINGS_PATH, JSON.stringify({ bands: custom }));
  assert.deepEqual(loadSettings().bands, custom);
  const bands = loadSettings().bands;
  assert.deepEqual(gearForScore(0.39, 0, bands), { gear: 'light', thinkingLevel: 'low', adjustedScore: 0.39 });
  assert.deepEqual(gearForScore(1.19, 0, bands), { gear: 'standard', thinkingLevel: 'high', adjustedScore: 1.19 });
  assert.deepEqual(gearForScore(2, 0, bands), { gear: 'heavy', thinkingLevel: 'xhigh', adjustedScore: 2 });
  for (const bad of [
    [],
    [{ gear: 'light', thinkingLevel: 'low' }, { max: 1, gear: 'standard', thinkingLevel: 'high' }],
    [{ max: 0.5, gear: 'light', thinkingLevel: 'low' }, { max: 0.4, gear: 'heavy', thinkingLevel: 'high' }, { gear: 'heavy', thinkingLevel: 'xhigh' }],
    [{ max: 2, gear: 'light', thinkingLevel: 'low' }, { gear: 'heavy', thinkingLevel: 'xhigh' }],
    [{ max: 0.5, gear: 'light', thinkingLevel: 'low' }, { max: 1, gear: 'heavy', thinkingLevel: 'xhigh' }],
    [{ max: 0.5, gear: 'nope', thinkingLevel: 'low' }, { gear: 'heavy', thinkingLevel: 'xhigh' }],
    [{ max: 0.5, gear: 'light', thinkingLevel: 'typo' }, { gear: 'heavy', thinkingLevel: 'xhigh' }],
    'not-array',
  ]) {
    writeFileSync(SETTINGS_PATH, JSON.stringify({ bands: bad }));
    assert.deepEqual(loadSettings().bands, defaultSettings().bands, JSON.stringify(bad));
  }
  rmSync(SETTINGS_PATH);
});

test('project settings override user settings field by field', () => {
  const project = mkdtempSync(join(tmpdir(), 'pi-gear-project-'));
  const projectFile = projectSettingsPath(project);
  mkdirSync(join(project, '.pi', 'pi-gear-router'), { recursive: true });
  writeFileSync(SETTINGS_PATH, JSON.stringify({
    enabled: true, gearBias: 0.2, judgeTimeoutMs: 20000,
    gears: { standard: { provider: 'user', model: 'user-standard', thinkingLevel: 'low' } },
    taskRouting: { maxInheritedTurns: 7 },
  }));
  writeFileSync(projectFile, JSON.stringify({
    gearBias: -0.5,
    bands: [{ max: 1, gear: 'light', thinkingLevel: 'off' }, { gear: 'heavy', thinkingLevel: 'max' }],
    gears: { light: { provider: 'project', model: 'project-light', thinkingLevel: 'medium' } },
    taskRouting: { downgradeWindow: 5 },
  }));
  const s = loadSettings(project);
  assert.equal(s.enabled, true);
  assert.equal(s.gearBias, -0.5);
  assert.equal(s.judgeTimeoutMs, 20000);
  assert.equal(s.gears.light.model, 'project-light');
  assert.equal(s.gears.standard.model, 'user-standard');
  assert.deepEqual(s.bands, [{ max: 1, gear: 'light', thinkingLevel: 'off' }, { gear: 'heavy', thinkingLevel: 'max' }]);
  assert.equal(s.taskRouting.maxInheritedTurns, 7);
  assert.equal(s.taskRouting.downgradeWindow, 5);
  assert.equal(loadSettings().enabled, true);
  assert.equal(loadSettings().gearBias, 0.2);
  assert.equal(loadSettings(join(project, 'absent')).gearBias, 0.2);
  writeFileSync(projectFile, JSON.stringify({ gearBias: 'bad', bands: [{ max: 9, gear: 'light', thinkingLevel: 'low' }] }));
  const invalid = loadSettings(project);
  assert.equal(invalid.gearBias, 0.2);
  assert.deepEqual(invalid.bands, defaultSettings().bands);
  rmSync(SETTINGS_PATH);
  rmSync(project, { recursive: true, force: true });
});

test('settings accept JSONC comments without corrupting strings', () => {
  writeFileSync(SETTINGS_PATH, `{
    // 行注释
    "enabled": true, /* 块注释 */
    "gearBias": -0.25,
    "gears": { "light": { "provider": "p", "model": "https://example.com/a//b", "thinkingLevel": "high" } }
  }`);
  const s = loadSettings();
  assert.equal(s.enabled, true);
  assert.equal(s.gearBias, -0.25);
  assert.equal(s.gears.light.model, 'https://example.com/a//b');
  rmSync(SETTINGS_PATH);
});

test('the shipped example.settings.json is valid and loadable', () => {
  const example = readFileSync(new URL('../example.settings.json', import.meta.url), 'utf8');
  writeFileSync(SETTINGS_PATH, example);
  const s = loadSettings();
  assert.equal(s.enabled, true);
  assert.equal(s.gears.light.provider, 'yourprovider');
  assert.equal(s.bands.length, 5);
  assert.equal(s.taskRouting.downgradeWindow, 2);
  assert.equal(s.workflow.enabled, false);
  rmSync(SETTINGS_PATH);
});
