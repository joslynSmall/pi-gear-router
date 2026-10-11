# 阶段编排模型路由验证记录

> 历史记录说明：下文的只读 tool guard 验证描述当时实现，不代表当前权限策略。现已按用户确认移除 task 计划／修订与 legacy planning／recovery 的工具拦截及 shell 白名单；阶段仅提示工作重点，所有工具权限交给 Pi 及已有权限扩展。路由交接、验证事实与有界 reminder 保留。

日期：2026-10-11  
范围：`phase-orchestrated-routing` 的离线实现验证，以及一次隔离、受限的真实 Jev/Magpie protocol smoke。

## 结论范围

本记录证明 TypeScript 类型检查、mock/offline Pi 生命周期测试，以及一次真实 provider 的隔离协议链路。它不证明 Jev 在真实业务请求上的总体分类/置信度校准、Magpie 的普遍可用性、费用、时延或 prompt/KV cache 行为。

`workflow.enabled` 默认保持 `false`。以下 2026-10-10 的真实 protocol smoke 仅在临时目录副本中启用 workflow，未修改用户级 `~/.pi/agent/pi-gear-router/settings.json`；2026-10-11 经用户授权的本机启用记录见后文。该 smoke 使用临时 `handoffMinConfidence: 0.5`（配置允许的最低值）以及 standard/medium execution floor：前者用于在已观察到真实 Jev choice calibration 低于默认 0.8 的前提下验证协议链路，后者用于避开已知不稳定的 light provider。它不是默认 0.8 配置在真实 provider 上的校准通过证明。

## 已验证命令

| 命令 | 结果 | 证据 |
|---|---|---|
| `npm run typecheck` | 通过 | `tsc --noEmit` exit 0 |
| `npm test` | 通过 | Node test runner：121 passed、0 failed、0 skipped |
| `node --check test/live-smoke.mjs` | 通过 | exit 0 |
| `node --check test/live-workflow-smoke.mjs` | 通过 | exit 0 |
| `node test/live-workflow-smoke.mjs --run` | 通过 | 真实 Jev/Magpie：planning → execution → verification → complete；3 个 accepted handoff、1 个 passing validation fact、无 extension error 或 physical fallback。 |
| `git diff --check` | 通过 | exit 0，无空白错误 |

## 离线覆盖摘要

### 状态、配置与 reducer

- workflow 配置默认 opt-in、band 下标范围、置信门槛、转换/提醒预算及 JSONC 分层回退；
- workflow state、packet、event 的版本、未知字段、长度、数组、JSON 字节预算、digest 与 phase/profile/active packet/accepted transition trace 一致性；
- 合法转换表：`planning→execution`、`execution→verification|recovery`、`verification→recovery|complete`、`recovery→execution`；
- accepted event 的来源回合/phase、一次消费、transition budget（含 budget-exhausted blocked）、重复/伪造/过期 event、本地重验 readiness/packet/completion evidence，以及 user supersession；
- phase floor、high-risk floor、atomic execution 条件。atomic/light 只对完整 accepted execution packet 生效，不是全部 execution 的默认。

### Jev adapters 和 handoff

- workflow turn 单次 classifier 请求：gear、objective、start、clarity、risk，且在已有 task 时合并 relation；
- 严格检查 score、choice label、probability 归一、selected probability、confidence 与 usage；
- workflow 启动与 handoff acceptance 的置信门槛只评估 workflow 语义 choice 的 selected-label confidence/probability；capability score 仍须有效、仅用于选择 band，低 score calibration 不会错误否决可信 workflow；
- workflow 字段无效时可把已验证的 gear score 交还给既有 task-aware fallback，但不会建立 workflow；
- handoff readiness 单次 classifier 请求：delivery、readiness、risk、capability；
- packet TypeBox/local 校验、blocker、completion evidence、错误 phase、错误 model、取消、classifier unavailable、低 readiness、重复 handoff 与 append-only accepted/rejected event；execution/verification/recovery/complete packet 都要求有界且有实际内容；
- tool result 的 structured content 及 classifier input usage。

### Pi 生命周期、安全边界和派发

- `context_with_system` 在原 leading system message 后插入稳定 phase instruction 与 bounded active packet；
- planning/recovery 下 `edit`、`write`、副作用 shell、未知/MCP 工具 fail-closed；验证了只读内置工具、显式只读 annotation、registry 查询异常、execution 放行；
- shell grammar 覆盖 `pwd`、有限 `ls`、path-only `find`、有限 `rg`/`grep`、只读 git，并拒绝 pipe、redirect、expansion、`find -exec/-delete`、git 写命令和未知选项；
- `agent_before_settle` 首次 reminder continuation、第二次 blocked、error/pending message 抑制；
- workflow validation facts 仅保存 workflow/turn、passed/failed、命令类别；不保存命令全文或输出，且保留原有 task verification-failed observation。连续相同命令结果去重；失败后修复并再次通过会保留新事实；completion 要求当前 active user turn 的最后一个验证事实为 `passed`；
- opt-in route：planning dispatch、accepted planning→execution、execution→verification、verification→complete、终态持久化、用户重新规划 supersession；非文本输入即使收到有效 classifier verdict 也不会启动 v1 workflow；branch event 输入隔离，以及 target 不可用时只降级 physical dispatch、保留 workflow phase/requested band；
- ordinary continuation/retry sticky、retry 不消费 handoff、伪造/过期 event 无权切换、手选 model-change 后未消费 handoff 失效、workflow disabled task-aware fallback；
- handoff tool 默认不 active，只有 `workflow.enabled:true` 的 agent run 才进入 active tool set，避免默认关闭时变更模型 tool declaration/prompt-cache 前缀；
- TUI 覆盖 handoff 提交中/接受/拒绝或不可验证状态，以及 session tree 恢复后从 branch `blocked` event 折叠出的 blocked 状态。

## 真实联网 workflow smoke（2026-10-10 UTC）

运行 `node test/live-workflow-smoke.mjs --run`。认证与模型 catalog 复制到临时目录；临时 settings 启用 workflow，使用 `handoffMinConfidence:0.5` 与 standard/medium execution floor；临时 session 只处理一个无敏感的 TypeScript normalizer fixture。结束时删除临时认证、模型 catalog、session 和 fixture，仅保留脱敏诊断：`docs/phase-orchestrated-routing-live-smoke.json`。用户级配置、业务项目和业务数据均未修改。

实际观察（通过运行）：

- 真实 `typesafe/jev-latest` 完成 4 次分类：1 次 workflow start、3 次 handoff readiness；每次 `stopReason=stop`，报告 usage 共 5,308 tokens。上游 cost 字段为 0，**不**代表账单金额。
- start judgment 是 `deliver + planning + high clarity + low risk`；choice confidence/probability 的最小值为 0.5，因此临时阈值 0.5 允许建立 planning workflow。能力 score confidence 较低，但它只决定 band，不再误作 workflow intent/readiness 的否决条件；此语义有独立回归测试。
- planning 实际 dispatch 到 `magpie/zies/gpt-6.1-sol` / `high`，只调用 `read`；模型提交结构化 planning→execution packet。
- 真实 Jev readiness 接受 planning→execution；下一 continuation 实际切换到 `magpie/zies/gpt-6-luna` / `medium`。execution 在临时目录写入唯一 fixture 文件并运行受控的 `npm test`。
- validation observation 只持久化 `passed` 和命令类别；真实 execution→verification 与 verification→complete handoff 也均经独立 Jev readiness 接受。最终依次观察 `planning`、`execution`、`verification`、`complete`；共 3 个 accepted handoff、1 个 passing validation fact、零 extension error、零 physical fallback、零 aborted/error assistant request。
- planning/recovery tool guard 的严格写入拦截分支由离线 handler 测试覆盖。本次真实模型遵守 phase instruction、未在 planning 主动调用写工具，因此本次不把它表述为真实 block 观察。

这是真实阶段派发、独立 readiness、handoff 消费、物理 model/thinking 切换、execution validation 与 completion gate 的 protocol 证据；不外推为默认阈值的 provider 校准或任意真实项目的效果。

## 本机安装与启用验证（2026-10-11）

经用户授权，在 `~/.pi/agent/pi-gear-router/settings.json` 添加 workflow 配置：`enabled:true`、`handoffMinConfidence:0.8`、`atomicExecutionMinBand:1`，其余阶段下限/预算使用安全默认值；保留既有 bands、gear targets 和 taskRouting。备份为同目录的 `settings.json.bak.20261011-073838`。

- `pi list` 确认本机通过本地 package 路径加载当前源码，无需重复安装；`pi --offline --no-mcp --list-models gears` 确认识别 `gears/auto`。
- `loadSettings()` 确认本机配置有效，保持 0.8 门槛和 standard 原子执行下限。
- `node test/live-workflow-smoke.mjs --run --local-settings` 使用原样复制的本机配置，不覆盖门槛，诊断单独写到 `docs/phase-orchestrated-routing-local-smoke.json`。真实 Jev 正常返回，但 start/risk confidence 为 0.72/0.69，低于 0.8，因此没有建立 workflow；普通 task-aware dispatch 随后选择 light，物理请求 `stopReason:error`。该次完整 workflow smoke **未通过**，未自动降低门槛或替换用户模型。
- 从临时空目录启动真实 Pi CLI，加载本机 package/config，经 `gears/auto` 完成无工具的 React/TypeScript stale-response review，exit 0、非空回答、无 stderr 加载错误。这证明安装后的真实请求路径可用，不证明所有 physical targets 可用。
- 使用伪终端启动实际 Pi TUI，分别恢复合成 planning/execution session state；捕获到 `工作流 planning` 和 `工作流 execution` 状态行。此项不请求模型，证明已安装扩展的状态栏恢复/渲染接线，不是新的真实阶段切换证据，也未做逐像素或窄终端布局验收。

当前配置启用了保守 workflow；真实请求未达到门槛时仍走普通 task-aware routing。已经运行的 Pi 进程需 `/reload` 或重启才能加载新扩展源码。

## 工作流未启动原因的显示验证（2026-10-11）

在 `GearState` 新增 display-only `workflowDiagnostic`：仅保存版本、固定原因标签和可选的语义 confidence/当轮门槛，不保存请求正文或工具输出，也不参与路由与 handoff acceptance。状态栏区分低置信、分类不可用/不完整、非文本、review/question、无需阶段编排和直接执行条件不足。旧状态缺少诊断时提示 `工作流待评估：新请求生效`；关闭 workflow 时保持原有显示。

- 先执行新增回归测试，确认缺少诊断/旧状态提示的用例失败；实现后全量 121 个测试通过。
- 回归覆盖 diagnostic branch persistence/tree 恢复、ordinary continuation sticky、合法 phase 优先、关闭 workflow 隐藏旧 phase，以及 malformed diagnostic 不显示任意持久文本或非有限数值。
- 从临时目录用伪终端启动实际已安装 Pi TUI，分别恢复合成旧状态、低置信状态和 review 状态；三次均捕获到对应的完整诊断文字。此项未调用真实模型，不作为新 workflow/provider 验证。
- 用户持久配置和 `0.8` 门槛未修改；更新后的显示需 `/reload` 或重启加载。

## 未验证与限制

- 已观察到一次真实 deliver workflow 和完整 phase 链路，但这不能代表 Jev 在不同任务类别上的 objective/start/readiness 准确性或 confidence calibration；默认 `handoffMinConfidence:0.8` 在本次真实 fixture 的 choice 输出下不会启动/接受所有阶段；
- 真实 planning 阶段没有主动调用写工具，因此本次未观测 tool guard 返回 block；该 fail-closed 分支仍以离线 Pi lifecycle/handler 测试为证据；
- 该执行模型仅完成临时 toy fixture，不能代表任意生产项目中 phase prompt/packet 的执行质量；
- 未测量任何 provider 的 cache read/write、TTL、模型隔离、thinking-level cache compatibility 或跨模型 KV 转移；本项目不实现后者；
- `test/live-smoke.mjs` 的普通/task-aware 路径不是 workflow acceptance 证据；本文件所述 `live-workflow-smoke` 是受限 protocol 验证；
- 测试适配 Pi 1.1.x 声明的 extension API。升级 Pi 时应复跑全部离线测试及受限真实 smoke。

## 后续真实验证建议

1. 以临时复制设置和隔离 session 收集一组非敏感 delivery fixture，分别报告默认 0.8 和明确临时阈值下的 start/handoff acceptance；
2. 单独做一次无副作用的 planning write-call probe，以记录 guard 的真实 `block` result，且在 guard 失效时立刻中止并删除临时目录；
3. 保持不修改个人持久配置、不访问业务数据，并将真实 provider 观察与缓存推断严格区分。
