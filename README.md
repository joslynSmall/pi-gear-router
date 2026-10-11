# pi-gear-router

为 [Pi](https://pi.dev) 提供三档模型路由。选择 `gears/auto`，由 [TypeSafe Jev](https://typesafe.ai) 评估工作所需能力，本地规则决定实际模型与思考深度（thinking level）。

- **默认保持稳定**：task 模式分计划／实现两段，用户明确确认后才允许阶段切换；后续评分不自动换模。
- **按需启用观察**：observer 区分持续任务需求与本轮需求，可推荐 Skill，并通过显式能力交接调整后续派发。
- **不接管权限**：路由阶段、Skill 建议和交接均不批准实施，也不限制工具调用；权限仍由 Pi 及已有权限扩展处理。

## 快速开始

需要 **Pi 1.1.0+**、TypeSafe 凭据，以及目标模型供应商的有效凭据。

### 1. 安装扩展

```sh
export TYPESAFE_API_KEY="apikey_..."
pi auth check --provider typesafe
pi install /path/to/pi-gear-router
```

Pi 已内置 `typesafe/jev-latest`，不需要额外安装 TypeSafe SDK 或在 `models.json` 注册分类器。

### 2. 配置三个档位

创建 `~/.pi/agent/pi-gear-router/settings.json`，将以下占位值替换为 Pi 中已配置、已鉴权的物理模型：

```json
{
  "routingMode": "task",
  "workflow": { "enabled": false },
  "gears": {
    "light":    { "provider": "yourprovider", "model": "cheap-model-id",    "thinkingLevel": "low" },
    "standard": { "provider": "yourprovider", "model": "balanced-model-id", "thinkingLevel": "medium" },
    "heavy":    { "provider": "yourprovider", "model": "frontier-model-id", "thinkingLevel": "high" }
  }
}
```

三个档位应按实际能力递增，可以跨供应商。内置目标为 Anthropic Haiku / Sonnet / Opus，见 [`src/defaults.ts`](src/defaults.ts)。示例将 light 设为 `low`；便宜的强推理模型在高 thinking 下可能耗尽输出预算，需用真实任务验证，不能只按价格选档。

配置支持 `//` 与 `/* */` 注释。完整字段见 [`example.settings.json`](example.settings.json)。

### 3. 选择路由模型

```sh
pi --model gears/auto
```

已有会话可用 `/model` 选择 `gears/auto`。要退出路由，同样用 `/model` 手选物理模型。

若希望新会话默认使用路由，将以下字段合并到 **Pi 自身的** `~/.pi/agent/settings.json`：

```json
{
  "defaultProvider": "gears",
  "defaultModel": "auto"
}
```

若已设置 `enabledModels`，把 `gears/**` 加入现有列表，不要覆盖其他模型配置。

## 选择路由模式

| 模式 | 适用需求 | 换档依据 |
|---|---|---|
| **`task`（默认）** | 计划与实现分开，避免按每条消息频繁换模 | 用户明确确认开始实现；各阶段内保持档位稳定 |
| **`observer`（显式开启）** | 按任务与本轮工作调整能力，并提供可选 Skill 建议 | 新用户请求的可信观察；同一轮执行中使用能力交接 |
| **`legacy-workflow`（旧模式，保留）** | 使用已有的规划、执行、验证、恢复阶段编排 | 经验证的工作流交接 |

模式互斥，不叠加运行。未指定 `routingMode` 时，`workflow.enabled:false` 使用 task，`true` 使用 legacy。显式 task／observer 与 `workflow.enabled:true` 冲突时，legacy 优先并显示 `mode-conflict`；非法模式按旧 workflow 开关回退并诊断。`enabled:false` 优先于所有模式，停止 Jev 评估。

### task：计划 → 用户确认 → 实现

```text
首次请求 → Jev 评估 → 选定计划档位
                            ↓
                   用户明确确认开始实现
                            ↓
                   选定并保持实现档位
```

1. **计划**：首次评分置信度至少为 `0.8` 且分数低于 `1.5` 时请求 standard，否则请求 heavy；实际模型仍受可用性兜底影响。
2. **实现**：用户明确要求开始实现后，允许一次阶段切换，通常请求 standard；可信评分仍为困难工作时保留计划档位。有 UI 时提供确认选项；普通问答、解释或“继续”不会仅因处于计划阶段而弹窗或推进。
3. **修订**：实现中的计划修订沿用实现档位，新的实现确认结束修订。

task 使用所选档位的 `gears.*.thinkingLevel`，不使用分数区间的 thinking，也不随后续评分或 Pi `/thinking` 自动调整。后续新请求仍可能重评任务，但**重评不等于换模**；独立新任务也不会自动把同一会话降到 light。

### observer：观察 → 能力保护 → 同轮派发

在现有路由配置中合并以下字段即可开启，不必复制全部 observer 默认值：

```json
{
  "routingMode": "observer",
  "workflow": { "enabled": false }
}
```

```text
新用户请求 → 校验当前分支与消息来源
                      ↓
           安全继承，或 Jev 一次结构化观察
                      ↓
           本地校验与能力保护 → 可选 Skill 建议
                      ↓
           同次请求派发物理模型 → 记录结果
```

Jev 判断任务关系、消息作用、下一步工作、明确程度、风险及 Skill 候选；它不是第二个执行 agent。能力状态分为 `converge`（收敛）、`implement`（实施）、`verify`（验证）、`respond`（回答），不代表项目方法阶段或操作许可。

- **纯继续**：状态有效、无待重评原因时，最多连续三轮免观察。
- **临时解释**：条件满足时，本轮可使用较低能力；持续任务需求保留，之后继续工作恢复该需求。
- **持续降档**：默认需要两条不同来源的可信观察及保护裕量。关系不明、风险未知、方法审批等待或验证失败不能支持轻率降档。
- **Skill 建议**：只来自 Pi 当前可见目录，默认每次最多两项、每任务六次；不自动读正文，不强制采用，也不因忽略建议而催促。

#### 同一轮执行中的能力交接

主模型可调用 `gear_capability_handoff` 提交目标、范围、决定、步骤、验收、验证计划、风险与阻塞项等有界材料：

```text
提交工作包 → 本地检查 → Jev 独立 readiness 判断 → 来源复验
        → accepted → 下一合法工具续接消费 → 实际模型响应
```

**接受、消费、实际响应是三个不同事实**，均不等于实施批准或业务完成。工具结果被拦截或变为错误时不能消费；重试永不消费；新输入、分支、模式或目录变化会使待消费交接失效。

同一轮执行中的交接降档每次至多一个能力区间，并受风险、能力下限与冷却规则保护。默认每任务最多四次交接转换；主观察与 readiness 共用 24 次分类调用预算，失败或取消不返额度。预算耗尽时保留派发，正常回答不因此停止；reload／resume 不重置预算或恢复待消费交接。

observer 不因自然结束、未读 Skill 或未交接而自动追加提醒或新回合。完整协议见 [observer 设计](.kiro/specs/observer-guided-routing/design.md)。

### legacy-workflow：保留旧阶段编排

显式设置 `routingMode:"legacy-workflow"`，或通过旧开关 `workflow.enabled:true` 启用：

```text
planning → execution → verification → complete
                ↑            ↓
                └── recovery ┘
```

范围明确、低风险的交付请求可直接从 execution 开始。其余阶段由 `gear_workflow_handoff` 校验工作包并调用 Jev readiness 后推进；只要求计划或调研的任务不会自动进入执行。

默认最多六次转换，planning／recovery 最多一次缺交接提醒，超限停止自动推进。complete 要求当前活动用户回合的最后一条同工作流验证事实为 passed，且完成包无剩余问题；这不是全部验收条件已满足的保证。阶段只控制路由与工作重点，**不提供只读沙箱或工具权限审批**。

## 配置要点

省略字段使用默认值；非法字段回退，配置变更在下一次路由调用时读取。同轮普通工具跟进和重试不因配置修改而重新换模。

| 字段 | 默认值 | 用途 |
|---|---|---|
| `enabled` | `true` | 关闭时不调用 Jev，优先保留已有物理派发，无历史时尝试 standard；不退出 `gears/auto` |
| `gears` | Haiku / Sonnet / Opus | 三个物理目标及各档 thinking；目标不能是另一个虚拟模型 |
| `gearBias` | `0` | `-1..1`，分数映射前加 `gearBias × 0.4`；不解除 task 阶段锁定 |
| `bands` | 五个能力区间 | observer／legacy 的分数到档位与 thinking 映射 |
| `judgeTimeoutMs` | `15000` | 分类超时，增加首 token 前等待；observer 包含认证与传输的总时限 |
| `taskRouting.maxInheritedTurns` | `3` | 连续纯继续免评估上限，`0` 关闭；observer 最多三轮 |
| `taskRouting.downgradeWindow` / `downgradeMargin` | `2` / `0.08` | 持续能力降档的证据窗口与保护裕量，不自动改变 task 锁定档位 |
| `taskRouting.minConfidence` | `0.8` | task 评分／任务关系可信门槛；observer 关键语义门槛固定 `0.8`，不代表准确率 |
| `observer.guidance.enabled` | `true` | 设为 `false` 只关闭建议，继续观察与路由 |
| `observer.skills.enabled` | `true` | 设为 `false` 停止候选 Skill 元数据外发；显式选择的 Skill 名称及附带请求仍可能参与解释 |
| `observer.stageAware` | `true` | 设为 `false` 停用能力状态下限与能力交接，保留任务连续性保护 |

**三档模型不等于三个能力区间**：同一模型档位可以配不同 thinking。默认区间如下，仅用于 observer／legacy；task 的阶段选择与 thinking 规则见上文。

| 调整后分数 | 档位 | thinking |
|---|---|---|
| `[0, 0.5)` | light | high |
| `[0.5, 1.0)` | standard | medium |
| `[1.0, 1.5)` | standard | high |
| `[1.5, 1.8)` | heavy | high |
| `[1.8, 2.0]` | heavy | xhigh |

可通过 `bands` 覆盖整表。thinking 支持 `off`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max`，实际派发按物理模型支持范围裁剪。

项目级文件为 `<项目根>/.pi/pi-gear-router/settings.json`：覆盖用户级同名字段，`gears` 按档位覆盖，`bands` 整表替换，未指定字段继承。涉及 observer 时，**所有项目级覆盖都要求 Pi 项目信任**；信任只决定配置来源，不授予工具操作权限。

## 状态与故障处理

TUI 在原生 footer 中追加路由状态，不替换 Pi 的 token、费用和上下文显示。task 显示计划／实现／修订及实际派发；observer 显示能力状态、模型、thinking 和预算，例如：

```text
路由 收敛 → gpt-6.1-sol · high ｜ 能力保护 ｜ Jev 1/24
路由 实施 → gpt-6-luna · high ｜ 交接已生效 ｜ Jev 2/24
```

observer 下输入 `/gear-status` 查看只读详情，包括持续／本轮能力、实际派发、交接状态、预算及有限 Skill 观测。命令不调用 Jev、不追加会话记录、不修改配置。RPC 支持通知；print／JSON 不使用终端 UI。

- **普通工具跟进与重试**：沿用实际模型及 thinking；只有有效交接能在合法续接边界改变路由。
- **Jev 不可用或结果无效**：优先保留已有派发；首次请求由当前模式保守选档，再检查可用性。
- **目标不可用**：依次尝试目标档、standard、light、heavy、历史物理模型，重复档位只检查一次。全部不可用时无法生成并报错。
- **物理服务失败**：凭据已配置不代表服务可用；网络错误、限流等由 Pi 请求／重试机制处理，本扩展不做自动服务故障转移。

状态与事件跟随当前会话分支，跨压缩和恢复保留；不从其他分支补充依据。恢复记录不代表待消费交接仍有效。

## 安全、隐私与效果边界

- **路由不是授权**：计划／修订及 legacy planning／recovery 均不拦截工具调用。用户要求、项目指引、已选 Skill 的审批和权限扩展仍需遵守；未公开的方法等待不能保证识别。
- **Jev 是外部服务**：会收到最新请求及有界任务／公开上下文；observer 还可发送 Skill 名称、描述和交接材料。observer 不默认外发 Skill 正文、路径、system、隐藏思考、图像数据或完整工具输出，但请求和材料本身可能含秘密，**截断不是脱敏**。
- **观测不等于验收**：只记录支持的验证命令和有限公开事实；读过 Skill 不代表遵循，验证 passed 不代表业务完成，缺失观测不代表没有风险。
- **不保证省钱或缓存命中**：分类增加调用与等待，能力保护可能保留高档；切换模型／thinking 可能重建 prompt cache，不支持跨模型 KV/cache 迁移。usage 缺失或目录价格为零都不代表免费。

## 开发与文档

```sh
npm install
npm run typecheck
npm test
```

测试需要支持原生 TypeScript stripping 的 Node 版本，建议 Node 22.19+。离线测试使用临时目录，不修改个人 Pi 设置，不调用真实模型服务。

联网 smoke 独立于 `npm test`，会产生真实 API 用量，需获得联网许可后手动执行。`node test/live-observer-smoke.mjs` 默认只输出计划，传 `--run` 才执行。

| 文档 | 内容 |
|---|---|
| [完整配置示例](example.settings.json) | 各模式参数与注释 |
| [领域术语](CONTEXT.md) · [两阶段决策](docs/adr/0001-two-phase-routing.md) | 任务、阶段、能力、交接及默认模式的取舍 |
| [observer 设计](.kiro/specs/observer-guided-routing/design.md) | 来源、预算、Skill 建议与能力交接契约 |
| [observer 验证](docs/observer-guided-routing-verification.md) · [状态栏验证](docs/observer-statusline-verification.md) | 离线与有界合成联网证据、未证实项 |
| [task 验证](docs/task-aware-routing-verification.md) · [legacy 验证](docs/phase-orchestrated-routing-verification.md) · [早期联网记录](docs/live-verification.md) | 历史实现证据，不代表当前全部行为或通用准确率／费用保证 |

基于 Pi 的[虚拟模型机制](https://pi.dev/docs/latest/virtual-models)，不修改 Pi 核心；最低足够能力的判题目标与偏置方式参考 [pi-gearshift](https://github.com/iharuya/pi-gearshift)。

## 许可证

[MIT](LICENSE)。
