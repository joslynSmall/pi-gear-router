// THROWAWAY PROTOTYPE: does Pi's main model load the right SKILL.md on its own, without any router hint?
// Baseline for deciding whether Jev Skill recommendation adds value. Not imported by production code.
// Run: node test/skill-baseline-feasibility.prototype.mjs [--run]
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, getAgentDir } from '@earendil-works/pi-coding-agent';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const JEV_RESULTS = join(ROOT, 'docs', 'skill-recommendation-feasibility-results.json');
const OUTPUT = join(ROOT, 'docs', 'skill-baseline-feasibility-results.json');
const MAX_REQUESTS_PER_CASE = 2, CASE_TIMEOUT_MS = 180000, TOTAL_TIMEOUT_MS = 1500000;
const BLOCK_REASON = 'This tool is disabled in this evaluation. Do not retry it; continue without it.';
const hash = value => createHash('sha256').update(value).digest('hex');
const agentDir = getAgentDir();

// Identical fixtures and gold labels as the Jev run, fixed before that run.
const jev = JSON.parse(readFileSync(JEV_RESULTS, 'utf8'));
const cases = jev.cases;
// Read-only use of the router's own JSONC parser; the user's file is hash-checked below.
const { loadSettings } = await import('../src/settings.ts');
const gear = loadSettings().gears.standard;
const prompt = c => (c.context ? `背景：${c.context}\n\n${c.request}` : c.request);

const privateFiles = ['auth.json', 'models.json', 'models-store.json', 'settings.json', 'pi-gear-router/settings.json'];
const privateHashes = () => Object.fromEntries(privateFiles.map(f => [f, existsSync(join(agentDir, f)) ? hash(readFileSync(join(agentDir, f))) : null]));
const sourceHashes = () => Object.fromEntries(readdirSync(join(ROOT, 'src')).sort().map(f => [f, hash(readFileSync(join(ROOT, 'src', f)))]));
const before = privateHashes(), sourceBefore = sourceHashes();
const temp = mkdtempSync(join(tmpdir(), 'pi-skill-baseline-'));
const report = { version: 1, startedAt: new Date().toISOString(), jevProtocolHash: jev.protocolHash,
  protocol: { model: `${gear.provider}/${gear.model}`, thinkingLevel: gear.thinkingLevel, maxRequestsPerCase: MAX_REQUESTS_PER_CASE, caseTimeoutMs: CASE_TIMEOUT_MS,
    tools: 'Pi default (read, bash, edit, write); read limited to project and Skill files; bash/edit/write blocked; stop after the first Skill read', retries: 0 },
  rows: [], requestCount: 0 };

let cur, skills = [];
const skillOf = p => skills.find(s => p === s.filePath || p.startsWith(s.baseDir + sep));
function describeCall(event) {
  if (event.toolName === 'read') {
    const p = resolve(ROOT, String(event.input?.path ?? '').replace(/^~(?=\/|$)/, homedir()));
    const skill = skillOf(p);
    if (skill) return { tool: 'read', skill: skill.name };
    return p.startsWith(ROOT + sep) ? { tool: 'read', project: relative(ROOT, p) } : { tool: 'read', outside: true };
  }
  if (event.toolName === 'bash') {
    const command = String(event.input?.command ?? '');
    const skill = skills.find(s => command.includes(s.baseDir) || command.includes(`skills/${s.name}/`));
    return { tool: 'bash', ...(skill ? { skill: skill.name } : {}), command: command.slice(0, 100) };
  }
  return { tool: event.toolName };
}
// Observation-only probe: records tool intent, executes only project-file reads, and ends the run
// (without another model request) once a Skill read is attempted or the request cap is reached.
const probe = pi => {
  pi.on('before_provider_request', () => { cur.requests++; report.requestCount++; });
  pi.on('tool_call', event => {
    const call = describeCall(event);
    cur.calls.push(call);
    if (call.skill && !cur.skills.includes(call.skill)) cur.skills.push(call.skill);
    if (cur.skills.length || cur.requests >= MAX_REQUESTS_PER_CASE) {
      cur.stopped ??= cur.skills.length ? 'skill-read' : 'request-cap';
      return { block: true, reason: 'Evaluation complete.', terminate: true };
    }
    if (call.tool === 'read' && call.project) return;
    return { block: true, reason: BLOCK_REASON };
  });
};

function score(c, read) {
  const fp = read.filter(s => !c.acceptable.includes(s));
  return c.acceptable.length ? { hit: read.some(s => c.acceptable.includes(s)), firstHit: c.acceptable.includes(read[0]), falsePositives: fp }
    : { noneCorrect: read.length === 0, falsePositives: fp };
}

try {
  for (const file of ['auth.json', 'models.json']) {
    assert.ok(existsSync(join(agentDir, file)), `Missing local ${file}`);
    copyFileSync(join(agentDir, file), join(temp, file)); chmodSync(join(temp, file), 0o600);
  }
  const runtime = await ModelRuntime.create({ authPath: join(temp, 'auth.json'), modelsPath: join(temp, 'models.json'), modelsStorePath: join(temp, 'catalog.json'), allowModelNetwork: false, refreshOnCreate: false });
  const model = runtime.getModel(gear.provider, gear.model);
  assert.ok(model, `Model unavailable: ${gear.provider}/${gear.model}`);
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, providerRetry: { maxRetries: 0 }, cacheWarming: { enabled: false }, packages: [] });
  // Real Skill discovery and context files (AGENTS.md); no installed extensions, only the probe.
  const loader = new DefaultResourceLoader({ cwd: ROOT, agentDir, settingsManager, noExtensions: true, extensionFactories: [probe] });
  await loader.reload();
  skills = loader.getSkills().skills;
  const visible = skills.filter(s => !s.disableModelInvocation).map(s => s.name).sort();
  assert.deepEqual(visible, [...jev.catalogNames].sort(), 'Visible Skill catalog differs from the Jev run');
  const open = async () => {
    const { session } = await createAgentSession({ cwd: ROOT, agentDir, modelRuntime: runtime, model, thinkingLevel: gear.thinkingLevel, resourceLoader: loader, settingsManager, sessionManager: SessionManager.inMemory(ROOT) });
    await session.bindExtensions({ mode: 'print', onError: error => { if (cur) cur.extensionError = String(error?.message ?? error).slice(0, 160); } });
    return session;
  };
  const probeSession = await open();
  const system = probeSession.systemPrompt;
  report.systemPrompt = { chars: system.length, hash: hash(system), skillsListed: (system.match(/<skill>/g) ?? []).length, hasContextFiles: system.includes('AGENTS.md'),
    tools: probeSession.getActiveToolNames?.() ?? probeSession.agent?.state?.tools?.map(t => t.name) };
  probeSession.dispose();
  if (!process.argv.includes('--run')) {
    console.log(JSON.stringify({ mode: 'offline-plan', networkCalls: 0, model: report.protocol.model, thinking: gear.thinkingLevel, cases: cases.length,
      maxRequests: cases.length * MAX_REQUESTS_PER_CASE, systemPrompt: report.systemPrompt, visibleSkills: visible.length }));
    console.log('Live run: node test/skill-baseline-feasibility.prototype.mjs --run');
  } else {
    const deadline = Date.now() + TOTAL_TIMEOUT_MS;
    for (const c of cases) {
      assert.ok(Date.now() < deadline, 'Total timeout');
      cur = { id: c.id, calls: [], skills: [], requests: 0 };
      const session = await open(), started = Date.now();
      const timer = setTimeout(() => { cur.timedOut = true; session.abort(); }, CASE_TIMEOUT_MS);
      try { await session.prompt(prompt(c)); } catch (error) { cur.error = String(error?.message ?? error).slice(0, 160); } finally { clearTimeout(timer); }
      const assistants = session.messages.filter(m => m.role === 'assistant');
      const usage = assistants.reduce((u, m) => ({ input: u.input + (m.usage?.input ?? 0), output: u.output + (m.usage?.output ?? 0), cacheRead: u.cacheRead + (m.usage?.cacheRead ?? 0), cost: u.cost + (m.usage?.cost?.total ?? 0) }), { input: 0, output: 0, cacheRead: 0, cost: 0 });
      const last = assistants.at(-1);
      const textOut = assistants.flatMap(m => m.content.filter(p => p.type === 'text').map(p => p.text)).join(' ').replace(/\s+/g, ' ');
      const jevRow = jev.rows.find(r => r.id === c.id && r.arm === 'choice-all');
      const row = { ...cur, durationMs: Date.now() - started, lastStopReason: last?.stopReason, providerError: last?.errorMessage ? String(last.errorMessage).slice(0, 160) : undefined,
        usage, text: textOut.slice(0, 160), ...score(c, cur.skills), jevChoice: jevRow?.rec };
      report.rows.push(row);
      console.log(JSON.stringify({ id: row.id, ms: row.durationMs, req: row.requests, skills: row.skills, calls: row.calls.map(x => x.skill ? `${x.tool}:${x.skill}` : x.project ? `read:${x.project}` : x.command ? `bash:${x.command.slice(0, 40)}` : x.tool), hit: row.hit, noneCorrect: row.noneCorrect, jev: row.jevChoice, stop: row.stopped ?? row.lastStopReason, err: row.providerError ?? row.error }));
      session.dispose();
      if ((row.lastStopReason === 'error' || row.error || row.timedOut) && report.rows.length === 1) throw new Error(`Preflight failed: ${row.providerError}`);
    }
    const pos = report.rows.filter(r => 'hit' in r), neg = report.rows.filter(r => 'noneCorrect' in r);
    const median = xs => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
    report.summary = { positiveHit: `${pos.filter(r => r.hit).length}/${pos.length}`, positiveFirstHit: `${pos.filter(r => r.firstHit).length}/${pos.length}`,
      noneCorrect: `${neg.filter(r => r.noneCorrect).length}/${neg.length}`, falsePositiveReads: report.rows.reduce((n, r) => n + r.falsePositives.length, 0),
      errors: report.rows.filter(r => r.providerError || r.error || r.timedOut).length, requestCapWithoutSkill: report.rows.filter(r => r.stopped === 'request-cap').length,
      medianMs: median(report.rows.map(r => r.durationMs)), inputTokens: report.rows.reduce((n, r) => n + r.usage.input, 0), outputTokens: report.rows.reduce((n, r) => n + r.usage.output, 0),
      costTotal: +report.rows.reduce((n, r) => n + r.usage.cost, 0).toFixed(4) };
    report.completed = report.rows.length === cases.length;
  }
} catch (error) {
  report.failure = String(error?.message ?? error).slice(0, 200); process.exitCode = 1;
} finally {
  rmSync(temp, { recursive: true, force: true });
  report.finishedAt = new Date().toISOString();
  report.isolation = { temporaryDirectoryRemoved: !existsSync(temp), privateFilesUnchanged: JSON.stringify(before) === JSON.stringify(privateHashes()),
    productionSourcesUnchanged: JSON.stringify(sourceBefore) === JSON.stringify(sourceHashes()), sessionPersisted: false };
  if (process.argv.includes('--run')) writeFileSync(OUTPUT, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ summary: report.summary, isolation: report.isolation, requestCount: report.requestCount, failure: report.failure }));
  if (!report.isolation.privateFilesUnchanged) process.exitCode = 1;
}
