# 实现计划：可配置分档表（bands）

Date: 2026-10-10
Status: awaiting user review before execution
Spec: [2026-10-10-configurable-bands-design.md](../specs/2026-10-10-configurable-bands-design.md)

## Header

- **Goal**: 把「调整后分数 → gear + thinkingLevel」的映射从代码常量外置到 `settings.json` 的 `bands` 字段，允许 1..16 档可变，旧配置与旧会话状态兼容。
- **Architecture**: 配置源为现有 `src/settings.ts`（单一 owner，JSON + mtime 缓存 + 校验）；`src/gears.ts` 提供纯映射函数；`src/task-routing.ts` 消费 `settings.bands` 并把分档表纳入 `policyFingerprint`。
- **Tech Stack**: TypeScript（Node 22 type-stripping）、Node 内置 `node:test`。无新增依赖。
- **Baseline / Authority Refs**: `src/types.ts`、`src/gears.ts`、`src/settings.ts`、`src/task-routing.ts`、`src/index.ts`、`README.md`、`.kiro/specs/task-aware-routing/design.md`（R5/R6.6）、`CONTEXT.md`。
- **Compatibility Boundary**: 无 `bands` 时默认 5 档行为与当前完全一致；旧 `settings.json` 与旧持久化 `committedBand` 无需迁移脚本；分档表变更使指纹变化，下一用户回合重评（预期一次性开销）。
- **TDD Route**: Mode `off`（`~/.config/aegis/config.toml`）→ Decision `skipped`；Test posture: post-change regression（无显式 strict 请求）。
- **Verification**: `npm run typecheck` && `npm test`（全绿）。

## Change Necessity

- User-visible need: 用户要自行调整分数区间与每档思考深度，且档数可变。
- No-change / non-code option: 现有代码常量无法在不改代码的情况下调整。
- Why code change: 配置源、映射函数、校验、指纹四处必须协同修改。
- Minimum change boundary: `types.ts`/`gears.ts`/`settings.ts`/`task-routing.ts`/`index.ts` + 测试 + README。
- Decision: `code-change`。

## Existence Check

- Proposed new surface: 无新 owner/文件/依赖；`bands` 复用现有 `GearSettings` 与 `settings.json` owner。
- Decision: `reuse-existing`。

## Plan-Time Complexity Check

- Artifact class: contract/config schema + cross-module.
- Target files: 5 个源文件 + 3 个测试 + README。
- Recommendation: `edit-in-place`（在现有 owner 内增删，不新增模块）。

## TDD Route Guard

```text
TDD Route:
- Mode: off
- Decision: skipped
- Strict authority: not applicable
- Strict signals: none requested
- Test posture: post-change regression
- Reason: 仓库关闭 TDD，用户未要求 strict
- Verification: npm run typecheck && npm test
```

---

## Task 1: 核心映射与配置源（types / gears / settings / task-routing / index）

**Files**
- Modify: `src/types.ts`, `src/gears.ts`, `src/settings.ts`, `src/task-routing.ts`, `src/index.ts`
- Modify (signature regression): `test/task-routing.test.mjs`

**Why**: 让映射、默认值、配置解析与指纹都改为消费 `bands`，否则行为与校验不一致。

**Impact / Compatibility**: 无 `bands` 时默认行为不变；旧状态因指纹变化会在下一次用户回合重评一次。

**Steps**

1. `src/types.ts`：把 `Band` 放宽为数字，删除 4 个阈值常量，新增 `BandSpec`/`DEFAULT_BANDS`/`MAX_BANDS`，并给 `GearSettings` 加 `bands`。

```ts
export type Band = number;
```

把末尾这段：
```ts
/** Score thresholds for the five model/thinking-level bands. */
export const LIGHT_MAX = 0.5;
export const STANDARD_MEDIUM_MAX = 1;
export const STANDARD_MAX = 1.5;
export const HEAVY_XHIGH_MIN = 1.8;
```
替换为：
```ts
/** One score band: an exclusive upper bound plus the capability it maps to. The last band omits `max`. */
export interface BandSpec {
	max?: number;
	gear: Gear;
	thinkingLevel: ModelThinkingLevel;
}

/** Default bands; `max` is the exclusive upper bound of the adjusted score, and the last band covers up to 2. */
export const DEFAULT_BANDS: readonly BandSpec[] = [
	{ max: 0.5, gear: "light", thinkingLevel: "high" },
	{ max: 1, gear: "standard", thinkingLevel: "medium" },
	{ max: 1.5, gear: "standard", thinkingLevel: "high" },
	{ max: 1.8, gear: "heavy", thinkingLevel: "high" },
	{ gear: "heavy", thinkingLevel: "xhigh" },
];

/** Guard against a malformed config producing an unbounded band table. */
export const MAX_BANDS = 16;
```

在 `GearSettings` 的 `gearBias` 之后加：
```ts
	/** Ordered score bands; the last entry omits `max`. Overrides the built-in mapping when valid. */
	bands: BandSpec[];
```

2. `src/gears.ts`：改导入、`gearForScore`、`bandForScore`、`defaultSettings`、`targetForBand`，删除 `BAND_TARGETS`。

头部 import 改为：
```ts
import { DEFAULT_BANDS, MAX_BIAS_SHIFT, type Band, type BandSpec, type Gear, type GearSettings, type GearTarget } from "./types.ts";
```

`gearForScore` 整体替换为：
```ts
export function gearForScore(
	score: number,
	gearBias: number,
	bands: readonly BandSpec[] = DEFAULT_BANDS,
): { gear: Gear; thinkingLevel: ModelThinkingLevel; adjustedScore: number } {
	const adjustedScore = clampScore(score + gearBias * MAX_BIAS_SHIFT);
	const spec = bands[bandForScore(adjustedScore, 0, bands)]!;
	return { gear: spec.gear, thinkingLevel: spec.thinkingLevel, adjustedScore };
}
```

`defaultSettings` 变为：
```ts
export function defaultSettings(): GearSettings {
	return {
		enabled: true,
		gearBias: 0,
		bands: DEFAULT_BANDS.map((band) => ({ ...band })),
		gears: structuredClone(GENERIC_DEFAULT_GEARS),
		judgeTimeoutMs: 15_000,
		taskRouting: { maxInheritedTurns: 3, downgradeWindow: 2, downgradeMargin: 0.08, minConfidence: 0.8 },
	};
}
```

`bandForScore` 与 `BAND_TARGETS` 整体替换为：
```ts
export function bandForScore(score: number, bias = 0, bands: readonly BandSpec[] = DEFAULT_BANDS): Band {
	const adjusted = clampScore(score + bias * MAX_BIAS_SHIFT);
	for (let index = 0; index < bands.length - 1; index++) {
		if (adjusted < bands[index]!.max!) return index;
	}
	return bands.length - 1;
}
```

`targetForBand` 替换为：
```ts
export function targetForBand(settings: GearSettings, band: Band): { gear: Gear; thinkingLevel: ModelThinkingLevel } {
	const spec = settings.bands[band] ?? settings.bands[settings.bands.length - 1]!;
	return { gear: spec.gear, thinkingLevel: spec.thinkingLevel };
}
```

3. `src/settings.ts`：解析并整表校验 `bands`。

import 改为：
```ts
import { DEFAULT_BANDS, MAX_BANDS, type BandSpec, type Gear, type GearSettings, type GearTarget } from "./types.ts";
```

`parseSettings` 的 return 中，在 `gears,` 之前加：
```ts
		bands: readBands(file.bands),
```

在 `readTarget` 之前新增：
```ts
function readBands(value: unknown): BandSpec[] {
	const defaults = () => DEFAULT_BANDS.map((band) => ({ ...band }));
	if (!Array.isArray(value) || value.length < 1 || value.length > MAX_BANDS) return defaults();
	const bands: BandSpec[] = [];
	for (let index = 0; index < value.length; index++) {
		const raw = value[index];
		if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return defaults();
		const record = raw as Record<string, unknown>;
		if (!GEAR_NAMES.includes(record.gear as Gear)) return defaults();
		if (typeof record.thinkingLevel !== "string" || !THINKING_LEVELS.has(record.thinkingLevel)) return defaults();
		const gear = record.gear as Gear;
		const thinkingLevel = record.thinkingLevel as BandSpec["thinkingLevel"];
		if (index === value.length - 1) {
			if (record.max !== undefined) return defaults();
			bands.push({ gear, thinkingLevel });
			continue;
		}
		const max = record.max;
		if (typeof max !== "number" || !Number.isFinite(max) || max <= 0 || max >= 2) return defaults();
		if (max <= (bands.at(-1)?.max ?? 0)) return defaults();
		bands.push({ max, gear, thinkingLevel });
	}
	return bands;
}
```

4. `src/task-routing.ts`：`validTask` 接收档数，映射传 `bands`，指纹纳入 `bands`。

- 签名与校验：
```ts
export function validTask(value: unknown, bandCount: number): TaskState | undefined {
```
把：
```ts
			|| !Number.isInteger(t.committedBand) || !finite(t.committedBand, 0, 4)
```
替换为：
```ts
			|| !Number.isInteger(t.committedBand) || t.committedBand < 0 || t.committedBand >= bandCount
```
- 调用：
```ts
	const task = validTask(previous?.task, settings.bands.length);
```
- 5 处 `bandForScore`：
  - `bandForScore(judgment.score, settings.gearBias, settings.bands)`
  - `bandForScore(task.committedRawScore, task.biasAtCommit, settings.bands)`
  - `bandForScore(task.committedRawScore, settings.gearBias, settings.bands)`
  - `bandForScore(trace.protectedScore, 0, settings.bands)`
  - `bandForScore(clampScore(clampScore(judgment.score + settings.gearBias * .4) + policy.downgradeMargin), 0, settings.bands)`
- `policyFingerprint` 的 hash 对象加一行：
```ts
		bands: settings.bands.map(band => [band.max ?? null, band.gear, band.thinkingLevel]),
```

5. `src/index.ts`：同步两个调用点。
- 状态栏表达式里的 `bandForScore(state.adjustedScore)` → `bandForScore(state.adjustedScore, 0, loadSettings().bands)`。
- `targetForBand(decision.requestedBand)` → `targetForBand(settings, decision.requestedBand)`。
- `validTask(old?.task)` → `validTask(old?.task, settings.bands.length)`。

6. `test/task-routing.test.mjs`：修 `validTask` 调用签名。
- `validTask(t)` → `validTask(t, h.settings.bands.length)`
- `assert.ok(validTask(next.task));` → `assert.ok(validTask(next.task, h.settings.bands.length));`

**Verification**
```sh
npm run typecheck
npm test
```
预期：typecheck 通过；`npm test` 中既有用例全绿（`defaultSettings()` 带默认 5 档，行为不变）。

---

## Task 2: 新增分档表行为测试

**Files**
- Modify: `test/settings.test.mjs`, `test/task-routing.test.mjs`, `test/router.test.mjs`

**Why**: 证明自定义档数、非法回退、档数变更重评与越界状态重建。

**Steps**

1. `test/settings.test.mjs` 末尾追加：
```js
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
```

2. `test/task-routing.test.mjs` 末尾追加：
```js
test('band-count change rejudges and rejects an out-of-range committed band', async () => {
  const h = setup();
  let d = await h.run(undefined, 'Complex task', 1, 1.9);
  const originalTaskId = d.task.taskId;
  h.settings.bands = [
    { max: 1, gear: 'light', thinkingLevel: 'low' },
    { gear: 'heavy', thinkingLevel: 'xhigh' },
  ];
  d = await h.run(h.state(d), 'Continue', 2, 0.2);
  assert.equal(d.trace.trigger, 'config-changed');
  assert.ok(d.trace.requestedBand <= h.settings.bands.length - 1);
  const stale = { ...h.state(d), task: { ...d.task, committedBand: 4 } };
  const next = await h.run(stale, 'Continue again', 3, 0.2);
  assert.notEqual(next.task.taskId, d.task.taskId);
  assert.notEqual(next.task.taskId, originalTaskId);
});
```

3. `test/router.test.mjs` 末尾追加：
```js
test('custom bands drive gear and thinking dispatch', async () => {
  const h = harness([0.9]);
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({ gears: h.targets, bands: [
    { max: 1, gear: 'light', thinkingLevel: 'low' },
    { gear: 'heavy', thinkingLevel: 'xhigh' },
  ] }));
  const result = await h.run();
  assert.equal(result.model.id, 'light');
  assert.equal(result.thinkingLevel, 'low');
});
```

**Verification**
```sh
npm test
```
预期：新增 3 个用例通过，总数由 65 增至 68，全绿。

---

## Task 3: 文档

**Files**
- Modify: `README.md`

**Steps**

1. 五个区间表后的一句：
```
模型选择仍是三档；五段分数用于控制思考深度。区间边界取左闭右开，最后一段包含 `2.0`。
```
改为：
```
上表是默认映射，可用 `bands` 覆盖；模型选择仍是三档，分档用于控制分数区间与思考深度。区间边界取左闭右开，最后一段包含 `2.0`。
```

2. 配置示例 JSON 在 `"gearBias": 0,` 之后插入：
```json
  "bands": [
    { "max": 0.5, "gear": "light",    "thinkingLevel": "high" },
    { "max": 1.0, "gear": "standard", "thinkingLevel": "medium" },
    { "max": 1.5, "gear": "standard", "thinkingLevel": "high" },
    { "max": 1.8, "gear": "heavy",    "thinkingLevel": "high" },
    {               "gear": "heavy",    "thinkingLevel": "xhigh" }
  ],
```

3. 在 `### gearBias` 小节前插入：
```md
### `bands`

分档表，决定「调整后分数 → 档位 + thinking level」。有序数组，下标即能力区间；前 N-1 项必须带 `max`（升序、位于 `(0,2)`），最后一项省略 `max` 并兜底到 `2.0`。长度 1..16。

省略该字段时使用默认五档。任一项非法时整表回退默认值，不做部分生效。修改分档表属于配置变更，会让下一次用户回合重新评估；已冻结的同轮派发不变。`gear` 仍须是 `gears` 中配置的 `light`/`standard`/`heavy`。
```

**Verification**
```sh
npm run typecheck
npm test
```

---

## Risks / Retirement

- 风险：`policyFingerprint` 纳入 `bands` 会让升级后首次用户回合对旧状态重评一次。已在设计验收标准 4/5 覆盖。
- 风险：`validTask` 放宽 `committedBand` 上界，由调用方传 `bandCount` 兜住；新增测试覆盖越界重建。
- Retirement：`src/types.ts` 的 4 个阈值常量与 `src/gears.ts` 的 `BAND_TARGETS` 删除，无残留引用（`grep` 验证）。
- ADR/Baseline signal：配置 schema 变更 + source-of-truth 从常量转为 `settings.json`；实现完成后回填 ADR 或基线同步。
