# pi-gear-router

为 [Pi](https://pi.dev) 提供按用户任务动态切换的三档模型路由，由 [TypeSafe Jev](https://typesafe.ai) 评估当前请求。

在 Pi 中选择虚拟模型 `gears/auto`，路由器会维护**当前任务下一步工作的能力需求**。实质性新要求需要评估；明确的纯文本“继续”可有限继承已有模型和 thinking，不把短句误当成简单任务。独立新任务清空旧任务难度。同轮工具跟进与失败重试始终保持实际派发，不在执行中切模型。

Jev 输出连续 `0..2` 分数，路由按五个区间同时选择模型档位和 thinking level：

| 调整后分数 | 模型档位 | thinking level |
|---|---|---|
| `0.0 ≤ score < 0.5` | light | high |
| `0.5 ≤ score < 1.0` | standard | medium |
| `1.0 ≤ score < 1.5` | standard | high |
| `1.5 ≤ score < 1.8` | heavy | high |
| `1.8 ≤ score ≤ 2.0` | heavy | xhigh |

上表是默认映射，可用 `bands` 覆盖；模型选择仍是三档，分档用于控制分数区间与思考深度。区间边界取左闭右开，最后一段包含 `2.0`。

## 为什么分三档

只在便宜和昂贵模型之间选择，会把常规重构、调试和实现工作挤进两个不合适的档位。中间档承接大部分工程任务；昂贵模型留给确实需要更强能力的请求。

分类器评估的是“能正确完成本次任务的最低能力档位”，而不是笼统的“这个话题有多难”。近期对话仅用于理解指代和后续意图，独立的新任务不应继承上一轮的难度。

## 安装

需要 Pi 1.1.0 或更高版本，以及模型供应商的有效凭据。

```sh
export TYPESAFE_API_KEY="apikey_..."
pi auth check --provider typesafe
pi install /path/to/pi-gear-router
pi --model gears/auto
```

Pi 已内置 `typesafe/jev-latest` 分类器目录项，不需要单独在 `models.json` 注册。

若要默认选用路由，在 `~/.pi/agent/settings.json` 中设置：

```json
{
  "defaultProvider": "gears",
  "defaultModel": "auto",
  "enabledModels": ["gears/**", "yourprovider/**"]
}
```

`enabledModels` 会过滤启动及模型轮换列表。如果已经配置它，需要将 `gears/**` 加入现有列表，不要直接覆盖其他配置。

## 配置

创建 `~/.pi/agent/pi-gear-router/settings.json`：

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
  "judgeTimeoutMs": 15000,
  "taskRouting": {
    "maxInheritedTurns": 3,
    "downgradeWindow": 2,
    "downgradeMargin": 0.08,
    "minConfidence": 0.8
  },
  "gears": {
    "light":    { "provider": "yourprovider", "model": "cheap-model-id",    "thinkingLevel": "high" },
    "standard": { "provider": "yourprovider", "model": "balanced-model-id", "thinkingLevel": "medium" },
    "heavy":    { "provider": "yourprovider", "model": "frontier-model-id", "thinkingLevel": "high" }
  }
}
```

三个档位可以跨供应商，但应按实际能力递增配置。`src/defaults.ts` 提供 Anthropic Haiku / Sonnet / Opus 的通用默认值，以及本地 Magpie 网关的示例配置。

配置文件缺失、JSON 损坏或部分字段不合法时使用默认值。目标的 provider/model 不能为空；thinking level 允许 `off`、`minimal`、`low`、`medium`、`high`、`xhigh` 和 `max`。最终等级还会按物理模型支持的范围裁剪。

配置按文件元数据缓存，修改后在下一次路由调用时重新读取；返回值彼此隔离，不共享可变默认对象。本轮已选定的物理模型不会因为配置文件被修改而在工具跟进中变化。

### 项目级配置

除用户级文件外，可在项目里放 `<项目根>/.pi/pi-gear-router/settings.json`，与用户级配置按字段合并：项目文件里出现的字段覆盖用户级，未出现的继承用户级；`gears` 按档位合并，`bands` 数组整体替换；非法字段回落到用户级值。修改后同样在下一次路由调用时重新读取。

读取**不检查项目信任状态**：只要文件存在就生效。因此不要在不信任的仓库中随意运行带此文件的 Pi，先检查其内容。

### `enabled`

默认 `true`。设为 `false` 时不调用 Jev：优先沿用最近实际使用的物理模型及 thinking level，没有历史模型时使用 `standard`（不可用时再尝试其他配置档位）。

这不是恢复“之前手动选中的模型”的操作：当前选择仍是 `gears/auto`。如果要完全退出虚拟模型路由，请用 Pi 的 `/model` 选择物理模型。重新启用后，新的用户请求会重新评估。

### `bands`

分档表，决定「调整后分数 → 档位 + thinking level」。有序数组，下标即能力区间；前 N-1 项必须带 `max`（升序、位于 `(0,2)`），最后一项省略 `max` 并兜底到 `2.0`。长度 1..16。

省略该字段时使用默认五档。任一项非法时整表回退默认值，不做部分生效。修改分档表属于配置变更，会让下一次用户回合重新评估；已冻结的同轮派发不变。`gear` 仍须是 `gears` 中配置的 `light`/`standard`/`heavy`。

### `gearBias`

在原始分数上增加 `gearBias × 0.4`，再将结果限制在 `0..2`。然后按分档表一起选择模型档位和思考深度：

| 值 | 效果 |
|---|---|
| `-1` | 最多降低 0.4 分，更偏向低成本档位 |
| `0` | 不调整分类器结果 |
| `+1` | 最多提高 0.4 分，更偏向高能力档位 |

这不是强制所有任务进入某一档。轻任务经常进入 standard 时可以试 `-0.3`；困难任务被低估时可以试 `+0.3`。

### `judgeTimeoutMs`

默认 15 秒。分类调用会增加首 token 前的等待时间；超时会降级，不阻塞同一轮的后续工具调用。实际延迟取决于分类器服务。

### `taskRouting`

| 参数 | 默认 | 合法范围 | 用途 |
|---|---|---|---|
| `maxInheritedTurns` | 3 | 整数 0..10 | 连续免评估回合上限；第四次续接重新评估 |
| `downgradeWindow` | 2 | 整数 2..8 | 降档所需的近期可信、不同上下文样本数 |
| `downgradeMargin` | 0.08 | 0..0.15 | 降档目标边界的保护裕量 |
| `minConfidence` | 0.8 | 0.5..1 | 评分及关系确认门槛，不等同于准确率 |

省略时用默认值，无效字段逐项回退。`maxInheritedTurns: 0` 关闭跨轮免评估，但保留窗口降档保护。

只有有效任务、可用且未降级的保存派发、相同配置和无待重评原因时，以下完整纯文本可继承（允许一个结束标点，忽略首尾空格和大小写）：

```text
继续 / 继续吧 / 继续处理 / 继续处理这个问题
按刚才的方案继续 / 按这个方案继续 / 按方案继续
continue / please continue / go on
```

“好的”“谢谢”“继续，另外增加权限校验”、图片附件、不明确指代不命中继承。继承不产生新评分或窗口样本。分类失败、低置信度、关系不明、配置改变、验证失败、结项提示、手动模型 gap 或观测缺失需要重评。

有任务背景时，同一次 Jev 请求评估 `gear` 和 `relation`（同任务 / 新任务 / 不确定）。同任务的新高需求立即升级；降低必须有满窗口：先取原始分数最大值，应用一次偏置，再加降档裕量，最后映射目标区间。独立新任务直接按新需求选档。关系不明时取旧承诺能力和新需求的较高者，仅作为本轮临时派发。

相同上下文重复低分不能推进降档；提前复核仍没有新证据时，保留高档并退回有限继承，避免每轮无限重复问 Jev。去重最多保留 32 个 key，样本最多 8 个，不保证无限历史或统计独立性。

### thinking level

选择 `gears/auto` 时，thinking level 由请求能力区间决定：可能是本轮判决、窗口保护后的承诺能力或可信继承，而不总等于最新评分的直接映射。Pi 的 `/thinking` 不覆盖自动路由；手动选择物理模型时仍使用 Pi 原生行为。配置的 `thinkingLevel` 用于没有有效判决、没有保存等级或 `direct` 等后备情况；已有请求等级会传给降级候选，再按实际模型支持范围裁剪。工具跟进和重试沿用实际派发等级。

## 路由时机

| 场景 | 是否评估 Jev | 行为 |
|---|---|---|
| 实质性新用户请求，包括 steering / follow-up | 是 | 评估任务关系与下一步能力，按保护规则调整 |
| 满足条件的纯文本续接 | 否 | 保持实际模型/等级，最多连续继承三轮 |
| 到期或需要复核的续接 | 是 | 一次评估；不因重复低分制造降档证据 |
| 同一用户请求重复进入路由 | 否 | 复用已保存的判决与物理模型 |
| 工具结果后的继续生成 | 否 | 优先沿用最近成功回复的实际模型和等级 |
| 失败重试，包括上下文溢出恢复 | 否 | 优先沿用失败请求的实际模型和等级 |
| 无历史模型、无状态的孤立 continuation / retry | 尝试一次 | 判断后保存结果或兜底 |
| 压缩摘要、扩展直接模型调用 | 否 | 启用时走 light，不写入本轮状态 |
| 路由被禁用 | 否 | 沿用历史模型，无历史时使用 standard |

路由状态写入当前 session 分支的 `pi.virtual-model-state`。去重依据用户消息的稳定 entry ID 和内容摘要，不依赖消息数量；没有 session entry 的 SDK 调用使用消息时间戳和内容摘要。因此压缩、恢复和 `/tree` 导航本身不调用 Jev；新用户回合再判断能否继承。旧版本没有有效 task 时重建任务，旧同轮派发仍可使用。任务状态随当前分支恢复，不从其他分支寻找替代。

成功判决和分类失败的兜底都会保存，避免 Jev 超时后在每次工具跟进中反复调用。保存内容包括：

- `turnId`：本次用户回合标识，与跨轮 `task.taskId` 不同；
- `gear`：最终选择的档位；
- `dispatch.thinkingLevel`：本次分数区间最终选择的 thinking level（或物理模型支持等级裁剪后的值）；
- `score` / `adjustedScore` / `confidence`：分类结果；没有有效结果时分数为 `-1`、置信度为 `0`；
- `inputTokens`：有效判决报告的输入 token 数；无有效判决时为 `0`，不代表失败调用一定没有产生费用；
- `fallback` / `fallbackReason`：是否兜底及原因；
- `dispatch`：实际物理模型与 thinking level，供同轮复用；
- `task`：版本化、有界任务锚点、承诺能力、窗口、继承计数和分支观测 cursor；
- `decision`：判决/继承/兜底来源、关系、触发原因、请求区间、保护分数和分类失败原因。

`gear` 是实际档位，`decision.requestedBand` 是所需能力；物理目标不可用或等级裁剪不会改写任务需求。`score` 是最新真实评分，hold 时不伪造旧高分。继承沿用原分数和来源，本轮 `inputTokens=0`。

### 失败与降级边界

- 分类器缺失、缺少密钥、超时或结果无效：已有上一轮派发记录时优先保留该物理模型，否则使用上一轮档位或 `standard`。下一次新的用户请求再尝试 Jev。连接失败（`fetch failed`）不受 Pi 的 provider 重试覆盖（该重试只处理带 HTTP 状态码的错误），因此在本插件的传输层于同一 `judgeTimeoutMs` 窗口内有界重试（最多 2 次、指数退避）。失败原因（`stopReason`／错误摘要）写入 `decision.judgeFailure` 并显示在状态栏，便于区分超时、代理或鉴权问题。
- 目标模型不在目录、没有配置凭据或是另一个虚拟模型：依次尝试 `目标档 → standard → light → heavy → 历史物理模型`，重复档位只检查一次。
- 所有候选都不可用：抛出包含真实配置路径的错误；没有可用物理模型时无法继续生成。
- 已配置凭据不保证远端服务可用。实际 provider 网络错误、限流等由 Pi 的请求及重试机制处理，本扩展没有实现自动故障转移或同轮升级。
- 用户取消请求时尊重取消，不将取消变成新的 fallback 判决。

## 选择模型

不能仅凭价格认定一个模型适合 light 档。强推理的便宜模型在高 effort 下可能耗尽预算却不输出答案。light 档默认请求 `high`，与五个能力区间一致；请用真实任务验证所选模型，必要时在 `settings.gears.light` 中把 thinking level 调低。

`src/defaults.ts` 记录了本地 Magpie 网关的八项任务测量：space-bunny-free 在 high 下曾耗尽输出预算，在 low 下回答正常；Luna 与 Sol 都通过任务，但延迟不同。该测量只说明那次网关测试的表现，不代表通用模型排名或路由效果保证。

## 设计与限制

基于 Pi 的 [虚拟模型机制](https://pi.dev/docs/latest/virtual-models)，而不是 `before_agent_start` 中全局调用 `pi.setModel()`。Pi 保持虚拟选择，实际模型只作用于当前请求；原生 footer 显示选择与派发，例如：

```text
(gears) auto • high → zies/gpt-6-luna • high
```

状态栏通过 Pi 的 `ctx.ui.setStatus()` 追加到原生 footer，不会覆盖其他扩展。支持新判决、周期评估、降档复核、`沿用 Jev 1.92 · 续接 2/3`、降档保护、关系不明及 fallback。会话启动和 tree 导航恢复对应分支结果，关闭时清除显示；仅 TUI 使用 UI。Jev 返回分数与置信度，不展示内部推理过程。

思路参考 MIT 项目 [pi-gearshift](https://github.com/iharuya/pi-gearshift)，保留最低能力档位的判题目标与偏置方式，但使用 Pi 内置 `classify()`，不额外依赖 TypeSafe SDK。

已知限制：

- 关系识别仍可能错误。有限继承是保守白名单，不是完整语义识别；初值尚未按真实轨迹校准。减少分类次数不保证总费用下降，保护高档可能更贵。
- 公开分类输入最多包含当前请求 16,000、任务锚点 4,000、近期变更 3,000、三条助手文字合计 3,000 个 Unicode 字符。字符预算不等于 token 上限或秘密脱敏；不发送 thinking、原始工具输出/参数、图片数据。纯图兜底，图文不获得免评估资格。
- 执行观测只识别明确 Bash 验证失败及其嵌套事件，命令需为允许的 npm/pnpm/yarn 验证脚本或 `npx tsc --noEmit`。复杂 shell、缺少退出码或不一致 metadata 不推断失败。marker 仅存任务/回合和失败类型，不存命令、路径或输出；执行失败只触发下一用户回合重评，不直接升级。
- 第一版仅维护当前任务，不提供任务栈或同轮升级。没有事件/append 能力的 SDK adapter 或观测写入失败会保守重评，不能声称完整执行监测。
- SDK 消息未落入 session 时，时间戳和内容均相同的请求无法区分；常规 Pi session 使用独立 entry ID。
- 不提供价格表、节省金额统计或分类器费用核算。状态中的 token 数只用于诊断。
- 档位切换可能损失 provider 的 prompt cache；同轮固定模型有助于缓存和 thinking 签名兼容，但不保证跨轮缓存命中。

## 开发与验证

```sh
npm install
npm run typecheck
npm test
```

测试使用 Node 内置测试框架和原生 TypeScript 支持，需要 Node 22.18+ 或其他默认支持 TypeScript stripping 的版本。测试不请求真实 Jev 或物理模型服务；包含实际 Pi `SessionManager` 的压缩和分支状态测试，配置写入临时目录，不修改个人 Pi 设置。

### 真实服务联网验证

手动运行（不包含在 `npm test` 中，会产生真实 API 用量）：

```sh
node test/live-smoke.mjs --run
# 只验证普通功能实现任务：
node test/live-smoke.mjs --run --standard-only
# 复杂任务 → 续接 → 同任务阶段变化 → 独立新任务：
node test/live-smoke.mjs --run --task-aware
```

脚本使用个人 Pi 的模型配置与凭据，在临时目录复制凭据与路由设置，创建内存会话，只启用 read 工具。每轮限时、模型输出最多 6,000 tokens，禁用自动重试和缓存预热。结束后删除临时凭据，保留不含密钥的诊断报告。测试检查新用户任务调用次数、派发状态、非空模型响应和工具跟进的一致性，不评估生成代码的完整正确性。

历史联网结果见 [联网验证记录](docs/live-verification.md)，它们早于任务感知算法，不能作为新策略的真实准确率或费用证明。本次任务感知实现只做离线验证，见 [实现验证](docs/task-aware-routing-verification.md)。

## 许可证

MIT，见 [LICENSE](LICENSE)。
