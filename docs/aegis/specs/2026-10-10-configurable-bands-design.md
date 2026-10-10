# 可配置分档表（bands）设计

Date: 2026-10-10
Status: design-approved (chat) — 本文件待用户复核后进入实现计划
Owner: `src/gears.ts` + `src/settings.ts`（配置契约）；`src/types.ts`（`Band` 与默认值）

## 1. 目标与范围

把「调整后分数 → 档位 + thinking level」的映射从代码常量外置到 `settings.json` 的 `bands` 字段，并允许档位数量可变。

**在范围内**

- 分数阈值可配。
- 每档的 `gear` 与 `thinkingLevel` 可配。
- 档位数量 1..16 可变。
- 旧 `settings.json`、旧持久化会话状态兼容。

**非目标**

- YAML 配置（已决定沿用 JSON）。
- `MAX_BIAS_SHIFT`（0.4）配置化。
- 新增物理档位（`gears` 仍只认 `light`/`standard`/`heavy`）。
- 改变任务路由算法（继承、窗口、降档、关系判定语义不变）。

## 2. 现状（证据）

- `src/types.ts`: `LIGHT_MAX=0.5`、`STANDARD_MEDIUM_MAX=1`、`STANDARD_MAX=1.5`、`HEAVY_XHIGH_MIN=1.8`、`MAX_BIAS_SHIFT=0.4`；`Band = 0|1|2|3|4`。
- `src/gears.ts`: `BAND_TARGETS`（固定 5 项）、`bandForScore()`、`targetForBand()`、`gearForScore()`、`defaultSettings()`。
- `src/task-routing.ts`: `bandForScore` ×3、`validTask` 把 `committedBand` 限制在 0..4、`policyFingerprint` 未含分档表。
- `src/index.ts`: `bandForScore`（状态栏降档保护判断）、`targetForBand`。
- `src/settings.ts`: 现有 JSON 解析（逐字段回退 + mtime 缓存）；无 `bands` 字段。
- `README.md`: 五个区间表 + 配置示例。

## 3. 配置契约

```json
{
  "enabled": true,
  "gearBias": 0,
  "bands": [
    { "max": 0.5, "gear": "light",    "thinkingLevel": "high" },
    { "max": 1.0, "gear": "standard", "thinkingLevel": "medium" },
    { "max": 1.5, "gear": "standard", "thinkingLevel": "high" },
    { "max": 1.8, "gear": "heavy",    "thinkingLevel": "high" },
    {               "gear": "heavy",    "thinkingLevel": "xhigh" }
  ],
  "gears": { "light": { }, "standard": { }, "heavy": { } },
  "taskRouting": { }
}
```

语义：

- 有序数组，下标即 `Band`（`0..N-1`）。
- 前 N-1 项必须带 `max`，升序；第 `i` 档覆盖 `[bands[i-1].max, bands[i].max)`。
- 最后一项省略 `max`，兜底 `(前一项 max, 2.0]`。
- 默认 `DEFAULT_BANDS` 与原 5 档完全一致，因此无配置时行为不变。

## 4. 校验（`src/settings.ts`）

采用**整表原子回退**：`bands` 缺失或任一非法 → 整表用 `DEFAULT_BANDS`。不复用逐字段回退，因为分档表是单一连贯单位，半截生效比回退更危险。

规则：

1. 必须是数组，长度 `1..MAX_BANDS(16)`。
2. 每项必须是对象，`gear ∈ {light,standard,heavy}`，`thinkingLevel` 在现有允许集合内。
3. 非末项：`max` 为有限数字、`0 < max < 2`，且严格大于前一项 `max`（首项大于 0）。
4. 末项：不得带 `max`。

## 5. 兼容与不变量

- `Band` 从联合字面量放宽为 `number`。
- `validTask(value, bandCount)`：`committedBand` 必须是 `0 <= x < bandCount` 的整数，否则整个任务判为无效，按新判决重建。
- `policyFingerprint` 纳入 `bands`（`max`/`gear`/`thinkingLevel`/档数）。任何分档表变更 → `config-changed` → 下一用户回合重评并清窗口（R6.6）。副作用：升级后所有旧状态指纹不匹配，会在下一次用户回合各重评一次，属预期。
- 阈值严格递增、末档兜底 2.0、`gear` 必存在于 `gears`。
- `gearBias × 0.4` 仍只应用一次。
- 同轮物理派发冻结规则不变。

## 6. 影响面

| 文件 | 改动 |
|---|---|
| `src/types.ts` | `Band = number`；新增 `BandSpec`、`DEFAULT_BANDS`、`MAX_BANDS`；`GearSettings.bands`；删除 4 个阈值常量 |
| `src/gears.ts` | `bandForScore(score,bias,bands)`、`targetForBand(settings,band)`、`gearForScore(...,bands)`、`defaultSettings().bands` |
| `src/settings.ts` | 解析 + 整表校验 `bands` |
| `src/task-routing.ts` | `bandForScore` 传 `settings.bands`；`validTask(value, bandCount)`；fingerprint 纳入 `bands` |
| `src/index.ts` | `targetForBand(settings, band)`、状态栏 `bandForScore` 传 bands、`validTask(old?.task, settings.bands.length)` |
| `README.md` | 区间表标注为默认值；新增 `bands` 字段说明与约束 |
| `test/settings.test.mjs` | 新增自定义档数/非法回退用例 |
| `test/task-routing.test.mjs` | `validTask` 传档数；新增档数变更重评用例 |
| `test/router.test.mjs` | 新增自定义 bands 派发用例 |

## 7. 验收标准

1. 无 `bands` 配置时行为与当前完全一致（`score 0.2 → light/high` 等）。
2. 自定义 3 档配置能正确映射并派发到对应 `gear`/`thinkingLevel`。
3. 非法 `bands`（长度 0、非递增、`max≥2`、末项带 `max`、非法 gear/level）→ `loadSettings().bands` 等于默认值。
4. 档位数减少后，旧 `committedBand` 越界的状态判为无效并重建；不会向 `targetForBand` 传越界下标。
5. 分档表变化会让 `policyFingerprint` 改变，触发重评。
6. `npm run typecheck` 与 `npm test` 全绿。

## 8. 风险与 ADR 信号

- **旧状态重评一次性开销**：指纹含 `bands` 后，升级首次用户回合会重评。可接受，且有界。
- **`validTask` 校验放宽**：`committedBand` 由 `0..4` 放宽为 `0..bandCount-1`，仍拒绝负数与非整数，越界由调用方传 `bandCount` 兜住。
- **ADR 信号**：配置源（settings.json）新增 schema 字段、`source-of-truth` 从代码常量转为配置、compat 边界（旧状态/旧配置）——实现完成后应回填 ADR 或基线同步。

## 9. 基线引用

- `src/types.ts`, `src/gears.ts`, `src/settings.ts`, `src/task-routing.ts`, `src/index.ts`, `README.md`
- `.kiro/specs/task-aware-routing/design.md`（R5、R6.6）
- `CONTEXT.md`（能力区间、派发术语）
