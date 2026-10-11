import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { defaultSettings } from '../src/defaults.ts';
const dir = mkdtempSync(join(tmpdir(),'gear-settings-'));
process.env.PI_GEAR_ROUTER_DATA_DIR = dir;
const { loadSettings, SETTINGS_PATH, projectSettingsPath } = await import('../src/settings.ts');
after(() => rmSync(dir,{recursive:true,force:true}));
const put = value => writeFileSync(SETTINGS_PATH, typeof value === 'string' ? value : JSON.stringify(value));

test('defaults and cached settings are independent copies', () => {
  put({}); const a=loadSettings(), b=loadSettings(); a.gears.heavy.model='modified';
  assert.deepEqual(b,defaultSettings()); assert.deepEqual(loadSettings(),defaultSettings());
});
test('retired fields ignored without altering supported gear targets', () => {
  put({routingMode:'observer',workflow:{enabled:true},observer:{skills:{enabled:true}},taskRouting:{},gearBias:1,bands:[],gears:{standard:{provider:'p',model:'s',thinkingLevel:'high'}}});
  const s=loadSettings(); assert.deepEqual(Object.keys(s).sort(),['enabled','gears','judgeTimeoutMs']);
  assert.equal(s.gears.standard.model,'s'); assert.equal(s.enabled,true);
});
test('malformed/partial settings and invalid targets fall back field-by-field', () => {
  for (const v of ['not json','null','[]',{}, {enabled:'false',judgeTimeoutMs:-1,gears:{heavy:{provider:'',model:'x',thinkingLevel:'high'}}}]) {
    put(v); assert.deepEqual(loadSettings(),defaultSettings());
  }
  put({judgeTimeoutMs:1e30}); assert.equal(loadSettings().judgeTimeoutMs,15000);
  put({enabled:false,judgeTimeoutMs:123,gears:{light:{provider:'p',model:'l',thinkingLevel:'minimal'}}});
  assert.equal(loadSettings().enabled,false); assert.equal(loadSettings().judgeTimeoutMs,123); assert.equal(loadSettings().gears.light.thinkingLevel,'minimal');
});
test('JSONC preserves URLs, quotes, slash sequences inside strings', () => {
  put('// comment\n'+JSON.stringify({gears:{heavy:{provider:'https://example/*x*/',model:'a"b',thinkingLevel:'high'}}}).replace('"gears"','/* block */ "gears"'));
  assert.equal(loadSettings().gears.heavy.provider,'https://example/*x*/'); assert.equal(loadSettings().gears.heavy.model,'a"b');
});
test('project overlay requires explicit trust and inherits user fields', () => {
  put({enabled:false,judgeTimeoutMs:999,gears:{standard:{provider:'p',model:'user',thinkingLevel:'medium'}}});
  const project=join(dir,'project'); mkdirSync(join(project,'.pi','pi-gear-router'),{recursive:true});
  writeFileSync(projectSettingsPath(project),JSON.stringify({enabled:true,judgeTimeoutMs:-1,gears:{heavy:{provider:'p',model:'project',thinkingLevel:'high'}}}));
  for(const options of [undefined,{}, {projectTrusted:false}]) assert.equal(loadSettings(project,options).enabled,false);
  const s=loadSettings(project,{projectTrusted:true}); assert.equal(s.enabled,true); assert.equal(s.judgeTimeoutMs,999); assert.equal(s.gears.standard.model,'user'); assert.equal(s.gears.heavy.model,'project');
});
test('external rewrites, deletion and re-creation refresh the cache without writing files', () => {
  put({enabled:false}); assert.equal(loadSettings().enabled,false); put({enabled:true}); assert.equal(loadSettings().enabled,true);
  rmSync(SETTINGS_PATH); assert.deepEqual(loadSettings(),defaultSettings()); put({judgeTimeoutMs:777}); assert.equal(loadSettings().judgeTimeoutMs,777);
  const before=readFileSync(SETTINGS_PATH,'utf8'); loadSettings(); assert.equal(readFileSync(SETTINGS_PATH,'utf8'),before);
});
test('shipped JSONC configuration example is loadable', () => {
  put(readFileSync(new URL('../example.settings.json',import.meta.url),'utf8')); const s=loadSettings();
  assert.equal(s.enabled,true); assert.equal(s.gears.standard.provider,'yourprovider'); assert.equal(s.judgeTimeoutMs,15000);
});
