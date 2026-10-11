import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatSkillsForPrompt, createSyntheticSourceInfo } from '@earendil-works/pi-coding-agent';
import { captureCatalog, selectCatalogCandidates, validateCatalogVisibility, matchExplicitSkill } from '../src/observer-guidance.ts';
function fixture(t, count = 2) {
  const dir = mkdtempSync(join(tmpdir(), 'observer-catalog-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const skills = Array.from({ length: count }, (_, i) => {
    const filePath = join(dir, `${i}.md`); writeFileSync(filePath, 'SECRET_BODY');
    return { name: `method-${i}`, description: i === 0 ? '审查测试代码变化' : 'Review repository changes', filePath, baseDir: dir,
      disableModelInvocation: false, sourceInfo: createSyntheticSourceInfo(filePath, { source: 'sdk' }) };
  });
  const prompt = skills => [{ role: 'system', content: '', sections: { skills: `<skills>\n${formatSkillsForPrompt(skills, 'read').trim()}\n</skills>` }, timestamp: 1 }];
  return { skills, prompt, dir };
}

test('catalog derives only runtime resources, excludes explicit-only/duplicate/unreadable candidates, and exports no paths', t => {
  const f = fixture(t, 4); f.skills[1].disableModelInvocation = true; f.skills[2].name = f.skills[0].name;
  rmSync(f.skills[3].filePath);
  const catalog = captureCatalog(f.skills, f.dir, 1);
  const selected = selectCatalogCandidates(catalog, f.prompt(f.skills), 'Review changes');
  assert.equal(selected.coverage, 'partial'); assert.equal(selected.candidates.length, 0);
  assert.ok(!JSON.stringify(selected.candidates).includes(f.dir));
  assert.ok(!JSON.stringify(catalog).includes('SECRET_BODY'));
});

test('visible catalog metadata remains valid only for matching structured/current prompt and generation', t => {
  const f = fixture(t), catalog = captureCatalog(f.skills, f.dir, 1), messages = f.prompt(f.skills);
  const selected = selectCatalogCandidates(catalog, messages, 'Review');
  assert.equal(selected.candidates.length, 2); assert.equal(selected.coverage, 'known');
  assert.equal(validateCatalogVisibility(catalog, messages, selected.visibilityFingerprint), true);
  assert.equal(validateCatalogVisibility(catalog, [{ role: 'system', content: 'forced', timestamp: 1 }], selected.visibilityFingerprint), false);
  assert.notEqual(catalog.version, captureCatalog(f.skills, f.dir, 2).version);
  assert.notEqual(catalog.version, captureCatalog(f.skills, f.dir + '/other', 1).version);
  assert.equal(selectCatalogCandidates(catalog, f.prompt([]), 'Review').candidates.length, 0);
  assert.ok(!JSON.stringify(selected.candidates).includes(f.dir));
});

test('explicit-only expansion requires matching raw command, current metadata and actual SDK wrapper', t => {
  const f=fixture(t,1);f.skills[0].disableModelInvocation=true;const c=captureCatalog(f.skills,f.dir,1),s=f.skills[0];
  const message={role:'user',content:`<skill name="${s.name}" location="${s.filePath}">\nReferences are relative to ${s.baseDir}.\n\nSECRET_BODY\n</skill>\n\nSynthetic request`};
  assert.deepEqual(matchExplicitSkill(c,'/skill:method-0 Synthetic request',message),{identity:c.entries[0].identity,name:'method-0',request:'Synthetic request'});
  assert.equal(matchExplicitSkill(c,undefined,message),undefined); assert.equal(matchExplicitSkill(c,'/skill:other Synthetic request',message),undefined);
  assert.equal(matchExplicitSkill(c,'/skill:method-0 different',message),undefined);
  assert.ok(!JSON.stringify(matchExplicitSkill(c,'/skill:method-0 Synthetic request',message)).includes('SECRET'));
});

test('large directories use deterministic Latin/Chinese overlap, bounded metadata and no random zero-match filling', t => {
  const f = fixture(t, 30), catalog = captureCatalog(f.skills, f.dir, 1), messages = f.prompt(f.skills);
  assert.equal(selectCatalogCandidates(catalog, messages, '不相关目标').candidates.length, 0);
  const selected = selectCatalogCandidates(catalog, messages, '审查测试');
  assert.equal(selected.candidates[0].name, 'method-0'); assert.equal(selected.candidates.length, 1);
  const latin = selectCatalogCandidates(catalog, messages, 'Review repository');
  assert.equal(latin.candidates.length, 12); assert.equal(latin.omitted, 18);
  assert.ok([...JSON.stringify(latin.candidates)].length <= 6000);
});
