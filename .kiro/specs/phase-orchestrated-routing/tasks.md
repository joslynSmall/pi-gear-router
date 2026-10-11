# 阶段编排模型路由实现任务

状态：实现已完成离线和受限真实 protocol 验证；7.3 于 2026-10-10 在临时隔离配置下完成 planning→execution→verification→complete。默认 0.8 阈值的 provider 校准仍需另行评估。实施顺序遵循“纯数据与安全边界 → Jev/工具 → Pi 生命周期 → router 集成 → 文档与真实验证”。完成每项后运行该项关联测试；不要在未完成前置项时提前改写 `src/index.ts` 的派发语义。

## 1. 建立工作流配置、领域类型与持久状态校验

- [x] 1.1 定义 workflow 配置、phase、objective、packet、event 和 trace 类型
  - 在 `src/types.ts` 增加 `WorkflowSettings`、`WorkflowObjective`、`WorkflowPhase`、`WorkflowProfile`、各类 `WorkflowPacket`、`WorkflowEvent`、`WorkflowState` 与 workflow decision/trace 类型。
  - 将可选 `workflow?: WorkflowState` 纳入 `GearState`；保留现有 `TaskState v1` 和 `GearState` 字段兼容，不迁移或误读旧 workflow 状态。
  - 以明确版本号、有限 string/array/byte 预算表达所有可持久化状态；不在 state/event 中保存 hidden thinking、凭据、完整工具输出或完整 shell 命令。
  - 在 `src/workflow-routing.ts` 创建 `validWorkflowState()`、`validWorkflowEvent()`、packet digest 与可重用的长度/JSON budget guard；未知 version、未知字段、超限字段均不可进入自动流程。
  - 新增 `test/workflow-routing.test.mjs`：覆盖有效状态、旧/未知版本、JSON 序列化、字段/字节上限、非法 phase、非法 event、packet digest 稳定性和不修改输入对象。
  - _Requirements: R8.1, R8.2, R9.5, R4.4, R4.5_

- [x] 1.2 增加 workflow JSONC 配置与安全默认值
  - 在 `src/defaults.ts` / `src/gears.ts` 添加 `workflow.enabled=false`、各 phase floor、`handoffMinConfidence`、`maxTransitions`、`maxReminderContinuations` 默认值及 profile-to-band helper。
  - 扩展 `src/settings.ts`，使用户级/项目级 JSONC 解析和层叠能独立校验 `workflow`；band index 必须落在当前 `bands` 长度范围内，非法字段继承上层安全值。
  - 将 workflow protocol/config version 纳入 `policyFingerprint()`；保持 workflow 关闭时既有 fingerprint 与 task-aware 行为的语义稳定性。
  - 扩展 `test/settings.test.mjs` 与 `test/task-routing.test.mjs`：默认 opt-in、合法覆盖、非法值回退、band 数变化、fingerprint 变化和 workflow 关闭的兼容性。
  - _Requirements: R2.1–R2.5, R9.3, R9.4, R8.5_

## 2. 实现纯 workflow reducer 与阶段能力计算

- [x] 2.1 实现 branch event 折叠与合法阶段转换表
  - 在 `src/workflow-routing.ts` 实现从当前 branch 的 `pi-gear-router.workflow` custom entries 提取/校验事件的函数；只使用当前 active branch，按 event identity 去重。
  - 实现 `planning→execution`、`execution→verification|recovery`、`verification→recovery|complete`、`recovery→execution` 的白名单；拒绝跳转、重复消费、来源 phase 不匹配、过期 source turn、未知 event 与超过 transition budget 的 event。
  - 将 accepted handoff 仅折叠成下一个可消费 transition，不让 rejected/reminder/blocked event 直接派发物理模型。
  - 实现 user supersession：真实新 user turn 到来时，使旧 workflow 未消费 packet 无资格自动启动；不删除原始 branch event。
  - 扩展 `test/workflow-routing.test.mjs`：transition table、fork/tree branch isolation 的 event input、重复 handoff、user supersession、transition budget 和 blocked semantics。
  - _Requirements: R5.4–R5.6, R6.5, R7.6, R8.1, R8.4_

- [x] 2.2 实现 profile/risk/atomic 条件到 requested band 的纯决策
  - 在 reducer 中实现 phase floor、score band、high-risk floor 和 execution atomic eligibility 的组合；将 requested capability 与最终 physical fallback 分离。
  - 只在 `execution + clarity=high + risk=low + accepted execution packet scope/acceptance 完整` 时允许采用 `atomicExecutionMinBand`；其他 execution 保持 `executionMinBand`。
  - 将 accepted handoff 时确定的 requested band 写入 transition trace；对非接受事件保持原 profile/能力承诺，不产生伪造 Jev score。
  - 在纯测试中覆盖默认五 band、缩减 band 表、低/高风险、低/高 score、atomic/non-atomic、workflow disabled 及目标不可用时 desired band 不受污染。
  - _Requirements: R2.1–R2.5, R5.6, R9.2_

## 3. 扩展 Jev 判定并保持 workflow 关闭兼容

- [x] 3.1 增加新用户回合的 workflow intent/start 分类适配器
  - 在 `src/judge.ts` 扩展现有单次 `classify()` 请求：workflow 启用时，结合已有 `gear`/`relation` 一并请求 `objective`、`start`、`clarity` 和 `risk` choices。
  - 定义严格答案解析：choice 标签、概率归一、选择标签概率、confidence、score 范围和 usage 都必须验证；部分/无效答案不能启动或推进 workflow。
  - `deliver + planning`、`deliver + execution`、`plan_only`、`research_only`、`review` 与 `question` 必须有明确 classifier criteria；历史任务仅作背景，当前 user request 始终优先。
  - workflow 关闭时保留原 `judgeTask()` questions、结果类型和行为，避免改变已有 task-aware 测试结果。
  - 扩展 `test/judge.test.mjs`：完整 workflow verdict、partial、invalid label/probability、低置信、timeout/abort/transport retry、workflow disabled 和 bounded input。
  - _Requirements: R1.1–R1.5, R8.3_

- [x] 3.2 实现 handoff readiness Jev adapter
  - 在 `src/judge.ts` 或新增小型 `src/workflow-judge.ts` 中实现 handoff validation classify adapter；输入仅包含有界 phase/objective、packet、task 摘要和结构化 validation facts。
  - 要求一次调用返回 `delivery`、`readiness`、`risk` 和 `capability`；严格区分 accepted、rejected、unavailable 和 aborted。
  - 统一处理 classifier usage，以便 handoff tool 将其写入 result usage 与可观测 trace；不得对同一 handoff 进行隐式第二次分类。
  - 测试 readiness/blocked/needs-convergence、低 confidence、错误概率、usage 缺失、timeout、cancel 和敏感原始工具输出未进入 classifier input。
  - _Requirements: R5.1–R5.3, R5.6, R9.5_

## 4. 实现受验证的 `gear_workflow_handoff` 工具

- [x] 4.1 定义 TypeBox packet schema 与本地 handoff 校验
  - 新建 `src/workflow-handoff.ts`，使用 Pi/`pi-ai` TypeBox 工具定义 `gear_workflow_handoff`；工具必须 `executionMode: "sequential"`。
  - 为 execution、verification、recovery、completion packet 定义 discriminated input schema，并复用第 1 项的本地 Unicode/数组/总字节限制。
  - 从当前有效 workflow phase 推导合法 target phase，不接受模型自报 source phase；校验 packet kind、必填 scope/change/acceptance、execution blockers、completion remaining issues、transition budget 和当前 `gears/auto` 上下文。
  - 定义无副作用、可渲染的成功/失败 structured content；拒绝时使用 `isError:true` 且给出有限、可行动原因。
  - 编写 `test/workflow-handoff.test.mjs`：所有 packet variant、字段缺失、超限、非法转换、blocker、budget、legacy/invalid state、无 virtual model 和取消。
  - _Requirements: R4.1–R4.7, R5.1, R7.5_

- [x] 4.2 接入 readiness、branch event 与可消费 accepted handoff
  - 在 tool 的本地验证后调用 handoff readiness adapter；只有所有 acceptance 条件满足才 append `accepted-handoff` custom event。
  - 对 rejected readiness append `handoff-rejected` event，不改变 route state；unavailable/abort 时不写 acceptance，且不能让 reminder/continuation 误以为交接成功。
  - 使用真实 tool call identity、workflow/source turn、packet digest 生成 handoff ID；成功 result 返回 handoff ID、目标 phase、requested band、digest 和 packet，classifier usage 计入 tool result。
  - 以 mock Pi extension API / registry 测试 accepted event 的确切形状、rejection、不消费旧 event、classifier usage、append failure 的 fail-closed 行为和 branch-scoped identity。
  - _Requirements: R4.5–R4.7, R5.2–R5.6, R8.3_

## 5. 实现阶段指令、只读防护和一次提醒

- [x] 5.1 注入稳定的 phase instruction 与 accepted packet 上下文
  - 新建 `src/workflow-guard.ts`，注册/实现 `context_with_system` handler helper：保留原 leading system message，插入 extension-owned phase instruction 与当前 active packet 的有界 JSON。
  - 为 planning、execution、verification、recovery 分别生成稳定的行为约束；明确 packet 是工作材料、自然语言不具 transition authority、何时应调用 handoff tool。
  - 只在 phase/packet digest 变化时改变注入文本；workflow disabled、非 `gears/auto` 或无有效 workflow 时不改 context。
  - 为 transformer 写结构测试：leading system message、重复请求稳定性、packet 截断/标识、legacy state、branch packet 隔离。
  - _Requirements: R4.6, R2.6, R9.1, R9.5_

- [x] 5.2 实现 planning/recovery 的 fail-closed tool guard
  - 在 `workflow-guard.ts` 注册 `tool_call` handler；planning/recovery 时阻止 `edit`、`write`。
  - 实现小而明确的只读 bash/powershell parser，只允许设计文档指定的独立 `pwd`、`ls`、`find`、`rg`/`grep`、受限只读 git 子命令；拒绝 pipe、redirect、变量扩展、subshell、命令连接和所有未知选项/子命令。
  - 对其他工具仅允许 `gear_workflow_handoff` 与已明确 `readOnlyHint === true` 的工具；未知 annotation、destructive/open-world 工具和 nested calls 一律 block。
  - block reason 必须指导模型继续调研、调用 handoff 或说明 blocker；execution 中不得阻止原本允许的工具及既有 permission flow。
  - 新增 `test/workflow-guard.test.mjs`：edit/write、只读 shell 正反例、git 写命令、MCP/custom annotation、nested call、handler exception fail-closed、execution bypass。
  - _Requirements: R3.1–R3.5, R8.5_

- [x] 5.3 实现 `agent_before_settle` 的单次 reminder 与 blocked event
  - 基于 effective workflow event/state、run outcome、`context.canContinue`、pending user message、abort/retry/compaction 状态实现纯 eligibility helper。
  - planning/recovery deliver workflow 首次无 handoff 自然结束时，返回一个 `reminder` custom entry、一个 `display:false` custom message 和 `continue:true`；message 仅要求继续调研、提交 handoff 或报告 blocker。
  - reminder 达到 1 后 append `blocked` event 且不 continue；任何 error/abort/pending user message/plan_only/research_only/accepted-or-rejected-in-flight 情况都不提醒。
  - 测试一次提醒、第二次 blocked、identity 去重、branch 恢复、queued user priority、abort/error/retry/compaction 不触发及 workflow disabled。
  - _Requirements: R6.1–R6.5, R7.6, R8.3_

## 6. 接入 validation facts 与 phase-aware router

- [x] 6.1 扩展 observation 为 workflow-scoped validation facts
  - 在 `src/observation.ts` 复用已有严格 verification command 识别器，增加当前 workflow ID/turn ID 范围内的 `validation: passed|failed` custom events；仅保存 command kind，不保存完整命令/输出。
  - 保留既有 `verification-failed` observation 的行为；验证失败不会立即升级，但 completion handoff 必须读取至少一个同 workflow、当前 branch 的 validation passed fact。
  - 缺失/append 失败/不完整 nested metadata 均保守为未知，不把 exit=0 以外的内容当作成功。
  - 扩展 `test/observation.test.mjs`：pass/fail、去重、task/workflow branch scope、无状态、append failure、completion fact 查询和现有验证失败回归。
  - _Requirements: R7.1–R7.2, R7.5, R8.1, R9.5_

- [x] 6.2 在 `src/index.ts` 接入 workflow-first route 顺序
  - 注册 handoff tool、guard/context/reminder handlers 与现有 observations；确保 extension reload/session lifecycle 不重复注册或使用 stale runtime state。
  - 在保留 direct、disabled、同 user turn 去重、retry sticky、ordinary continuation sticky 的前提下，插入 workflow reducer：只有未消费 accepted event 的紧接 continuation 可换 target profile；retry 永不消费 handoff。
  - 对新 `reason:"user"` 调用 workflow turn classification，建立/继续/退出/supersede workflow；不可用或不适用时调用现有 `decideTask()`，不改变原 fallback 语义。
  - 将 workflow requested band 与现有 `resolveGear()`、target availability、thinking clamp、dispatch、fallback、turnId 和 `GearState` 写入逻辑连接；physical fallback 不得篡改 workflow desired band/phase。
  - 将 footer 扩展为 phase/handoff/reminder/blocked/recovery 可读状态，仍使用 `ctx.ui.setStatus()` 且仅在 TUI。
  - 扩展 `test/router.test.mjs`、`test/status.test.mjs` 与 `test/session.test.mjs`：planning→accepted execution、ordinary continuation/retry sticky、rejected/forged/consumed event、user supersession、target unavailable、workflow disabled、status、reload/resume/fork/tree/compaction。
  - _Requirements: R1.1–R1.6, R2.1–R2.7, R5.4–R5.6, R8.1–R8.5, R9.1–R9.2_

## 7. 文档、完整验证与受限真实 smoke

- [x] 7.1 更新用户文档与配置示例
  - 更新 `README.md`、`example.settings.json`、`CONTEXT.md`：解释 opt-in workflow、phase profiles、planning/recovery 只读、handoff tool、一次 reminder、transition budget、physical cache miss 边界和用户 steering 优先级。
  - 记录 workflow 状态/任务状态的领域术语，明确它不实现跨模型 KV 转移，且 `light` 不是全部 implementation 的默认。
  - 不修改用户本机 `~/.pi` 配置，除非用户再次明确要求启用 workflow。
  - _Requirements: R2, R3, R4, R6, R9.3–R9.5_

- [x] 7.2 运行完整离线验证并记录证据
  - 运行 `npm run typecheck`、`npm test`、`node --check test/live-smoke.mjs`、`git diff --check`。
  - 新建/更新 `docs/phase-orchestrated-routing-verification.md`，记录测试数量、覆盖场景、未验证的真实模型/缓存结论及任何环境限制；不将 mock adapter 结果描述成实际 Jev/Magpie 质量证明。
  - _Requirements: R8.3, R9.5_

- [x] 7.3 经用户确认后执行有限联网 workflow smoke
  - 2026-10-10：在临时隔离目录和临时 `workflow.enabled:true` 配置中，真实 Jev/Magpie 完成 `planning→execution→verification→complete`，含 3 次 accepted handoff、受控 `npm test` 产生的 passing validation fact，以及实际 heavy/high→standard/medium 物理派发切换。
  - smoke 为验证 protocol 链路，临时使用 `handoffMinConfidence:0.5` 与 standard execution floor；未修改用户配置。默认 `0.8` 的真实 provider 校准不由这次运行证明。
  - 仅在用户明确允许、workflow opt-in 配置明确启用后，使用隔离 session 和无敏感 prompt 请求真实 Jev 与配置的 Magpie models。
  - 记录 planning dispatch、只读 guard、handoff acceptance/rejection、execution dispatch、Jev usage、停止/取消/fallback；不执行实际破坏性文件或网络操作。
  - 将结果附加到 `docs/phase-orchestrated-routing-verification.md`，清楚区分真实 observed 结果、失败/限制和未证明的 prompt-cache 语义。
  - _Requirements: R1–R9（运行环境验证）_

## 依赖关系与实施检查点

```text
1.1 → 1.2 → 2.1 → 2.2
                 ↘
                   3.1 → 3.2 → 4.1 → 4.2
                                      ↘
                       5.1 → 5.2 → 5.3 → 6.1 → 6.2 → 7.1 → 7.2 → 7.3
```

- 第 2 项完成前不得让 router 消费 handoff event。
- 第 4 项完成前不得自动切换 phase/model。
- 第 5.2 项完成前不得开放 workflow opt-in，因为 planning/recovery 的只读承诺尚未强制。
- 第 6.2 项完成后仍默认 `workflow.enabled=false`；第 7.3 需要用户在当时单独确认。
