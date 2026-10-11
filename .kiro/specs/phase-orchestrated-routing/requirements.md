# 阶段编排模型路由需求

状态：需求草案，待审阅。

## 目标

在保留 `gears/auto` 单一用户选择的前提下，为**交付型用户请求**自动编排同一个 agent run 内的阶段：先以高能力模型完成调研、发散、规格、设计和任务收敛；在已形成可执行交接包时，无需等待下一条用户消息，自动切换到较低成本、较稳定的实现模型和思考深度；遇到复杂失败或设计假设失效时，再受控地升级到高能力恢复阶段。

本特性不是尝试跨物理模型迁移 KV cache。阶段切换可能导致一次 prompt-cache miss；能力正确性、明确交接和可验证性优先于未经证明的缓存收益。

## 已确认的产品决策

1. `planning` 和 `recovery` 默认只读：高能力模型在交接到 implementation 前不能直接修改工作区。
2. 当交付型 planning run 自然结束却没有提交有效交接时，系统允许自动追加**一次**提醒 continuation；仍没有有效交接即停止自动推进，并显示原因。
3. 只有经验证并接受的显式交接，才能打破一个用户请求内普通 continuation/retry 的物理模型与 thinking sticky 规则。
4. 本特性是独立于现有 `task-aware-routing` 的新工作流层。原有跨用户回合的任务身份、能力保护、fallback、分支恢复和物理目标可用性规则继续适用。

## 术语

- **工作流（workflow）**：由一条交付型用户请求发起、可在一个 agent run 内跨多个模型阶段推进的受控过程。
- **阶段（phase）**：`planning`、`execution`、`verification`、`recovery`、`complete` 或 `blocked`。
- **交接包（handoff packet）**：规划/恢复模型提交给后续阶段的有界结构化事实，不包括其隐藏推理。
- **接受的交接（accepted handoff）**：通过本地结构校验并由 Jev 独立确认下一阶段可安全开始的交接。
- **普通 continuation**：工具结果后的下一次模型请求；没有接受交接时必须沿用本轮实际 physical model/thinking。
- **交接 continuation**：由接受交接显式触发、允许换到目标阶段模型的下一次模型请求。

## 前置条件与范围

- 当前项目已经以 Pi virtual model 实现 `gears/auto`，每个 route 可保存 JSON state，且 Pi 可在 `turn_end` / `agent_before_settle` 追加 entries 与请求一次 continuation。
- 当前项目已经支持实际物理派发冻结、Jev 分类、task-aware 状态、验证失败 observation 和 session branch 恢复。
- 本特性不增加外部运行服务、数据库、第二个聊天模型或未验证的 provider cache header。
- 本特性不修改用户全局 Pi 设置、凭据、Magpie 服务端或文件系统之外的资源。
- v1 仅对 router 已能处理的文本工作流自动编排；图像/非文本用户输入、未知上下文或分类不可用时采用保守不自动交接路径。

## R1：工作流意图和启动

### 用户故事

作为使用 `gears/auto` 的开发者，我希望路由器理解一条请求的最终意图是否是交付，而非只按字面难度选模型，以便在一条交付请求内自动经过高推理规划和经济执行阶段。

### 验收条件

1. WHEN 收到新的用户请求 THEN 系统 SHALL 在单次 Jev 分类中判断用户目标至少是 `deliver`、`plan_only`、`research_only`、`review` 或 `question`，并同时判断当前阶段所需最低能力。
2. WHEN 用户目标为 `deliver` AND 请求存在实质性未知、发散设计、规格收敛或高风险决策 THEN 系统 SHALL 从 `planning` 以规划 profile 开始运行。
3. WHEN 用户目标为 `deliver` AND 请求范围明确、风险低且无需规划 THEN 系统 SHALL 可以从 `execution` profile 开始，而不强制产生 planning 阶段。
4. WHEN 用户目标为 `plan_only` 或 `research_only` THEN 系统 SHALL 不因完成设计/研究自动进入执行或修改工作区。
5. WHEN 初始分类缺失、无效、低置信或上下文不支持自动编排 THEN 系统 SHALL 保留现有保守 task-aware routing，而不生成自动 continuation。
6. WHEN 用户在一个 workflow 内提交 steering 或 follow-up 新请求 THEN 系统 SHALL 将用户消息优先于未开始的自动阶段；它必须重新判断任务关系和工作流意图，不能继续过期的自动交接。

## R2：阶段 profile 与模型选择

### 用户故事

作为开发者，我希望高推理仅用于消除不确定性，而明确实施自动降到合适的模型/思考深度，以降低不必要的高档模型使用和阶段内抖动。

### 验收条件

1. WHEN workflow 处于 `planning` THEN 系统 SHALL 使用至少为 heavy/high 的规划能力下限；Jev 的更高需求可提升到已配置的更高 band。
2. WHEN 接受 `planning → execution` 交接 THEN 系统 SHALL 在下一次模型请求切换到至少 standard/medium 的执行 profile，除非风险、交接内容或当前 Jev 判断要求更高能力。
3. WHEN execution 子任务同时被确认原子、范围明确、低风险且可验证 THEN 系统 MAY 按配置使用 light/low；它不得把全部 execution 默认降为 light。
4. WHEN workflow 处于 `verification` THEN 系统 SHALL 默认使用至少 standard/medium，并根据测试失败、风险或诊断需要升级。
5. WHEN workflow 处于 `recovery` THEN 系统 SHALL 使用至少 heavy/high。
6. WHEN 无接受的阶段交接 THEN 系统 SHALL 让普通 tool continuation 和 retry 沿用本轮实际 dispatched model/thinking。
7. WHEN 目标物理模型不可用或不支持目标 thinking level THEN 系统 SHALL 复用现有可用性检查/裁剪/fallback；它不得把 physical fallback 误写为降低的 workflow 能力需求。

## R3：规划和恢复阶段的只读约束

### 用户故事

作为开发者，我希望规划和恢复阶段先形成可审计方案，而不是让高模型在尚未收敛时修改工作区。

### 验收条件

1. WHEN workflow phase 为 `planning` 或 `recovery` THEN 系统 SHALL 阻止 `edit`、`write` 及其他已知文件修改工具调用。
2. WHEN planning/recovery 阶段调用可能产生工作区副作用的 `bash` / `powershell` 命令 THEN 系统 SHALL 阻止该调用，除非命令被严格识别为只读检查。
3. WHEN 阻止一次写入/副作用工具调用 THEN 系统 SHALL 向模型返回清晰、可行动的错误，要求继续调研、提交交接，或向用户说明 blocker；它不得静默丢弃调用。
4. WHEN workflow 进入 `execution` THEN 系统 SHALL 恢复原有的工具权限和用户既有的 permission/approval 机制；本特性不得绕过它们。
5. WHEN workflow 为直接执行的低风险任务 THEN 系统 SHALL 不施加 planning/recovery 只读约束。

## R4：结构化交接包

### 用户故事

作为执行模型，我希望获得短小、明确且可验证的交接信息，以便不用从完整规划过程或隐藏推理中重新猜测约束。

### 验收条件

1. WHEN planning 或 recovery 模型判断下一阶段可以推进 THEN 系统 SHALL 提供一个专用 `gear_workflow_handoff` 模型工具，用于提交结构化交接包。
2. 交接包 SHALL 至少包含：目标、非目标、已决定的关键决策及理由、按顺序的执行步骤、每步范围和验收条件、约束、验证命令/方法、风险以及未解决问题。
3. 交接包 SHALL 明确列出 `blockingUnknowns`；它不为空时不得直接进入 execution。
4. 系统 SHALL 对 packet 的每个字段、数组长度、总字节数、步骤数量和纯 JSON 形状设置有界限制，避免无限状态和隐藏推理转储。
5. 系统 SHALL 将接受 packet 的摘要/哈希及阶段转换所需的最小结构化数据持久化在当前 session branch；它不得持久化模型隐藏 thinking。
6. WHEN 执行模型收到已接受交接 THEN 系统 SHALL 在其请求上下文中包含明确的交接包和下一阶段指令。
7. WHEN 交接包结构无效 THEN 系统 SHALL 以工具错误拒绝它、保持当前阶段和模型，并说明缺少/无效的字段。

## R5：独立 readiness 验证与受控换模型

### 用户故事

作为用户，我希望不是由规划模型单方面决定降档，而由独立规则和 Jev 确认计划已经足以实施。

### 验收条件

1. WHEN `gear_workflow_handoff` 收到结构有效的 `planning → execution` 或 `recovery → execution` packet THEN 系统 SHALL 使用 Jev 在同一个验证调用中判断至少包括目标是否为 deliver、执行是否 ready、是否存在关键 blocker、风险和对目标阶段所需的最低能力。
2. WHEN Jev 的结果有效、置信度达到配置门槛、目标为 deliver、`executionReady` 为真且没有关键 blocker THEN 系统 SHALL 接受交接。
3. WHEN Jev 判定需要更多收敛、存在 blocker、目标不是 deliver 或置信度不足 THEN 系统 SHALL 拒绝交接，保持 planning/recovery profile，并以有界理由告知当前模型。
4. WHEN 交接被接受 THEN 系统 SHALL 只在紧接的交接 continuation 中打破 sticky 并切换 physical model/thinking；其他 continuation/retry 的 sticky 规则不变。
5. WHEN 已接受交接因取消、provider failure、session tree 切换、compaction recovery 或用户消息而未实际启动目标阶段 THEN 系统 SHALL 不错误宣称目标阶段已完成；后续请求必须从可恢复的持久状态重新决定。
6. 系统 SHALL 记录交接提出、接受/拒绝、来源/目标阶段、实际派发、Jev 置信度和有界原因，供 status 与测试回放使用。

## R6：无交接时的有界提醒

### 用户故事

作为用户，我希望一个交付型规划请求不会因为模型忘记调用交接工具而悄然结束，但也不希望系统无限自动续写。

### 验收条件

1. WHEN 一个 `deliver` workflow 在 planning/recovery 阶段自然到达 `agent_before_settle` AND 没有接受/拒绝中的交接、没有待处理用户消息、没有取消或运行错误 THEN 系统 SHALL 追加一次 phase-specific custom reminder，并请求一个 continuation。
2. 该 reminder SHALL 要求当前模型仅做三者之一：提交有效 handoff、说明不可解决的 blocker、或在仍需调研时继续调研；它不得直接授权写入。
3. WHEN 同一 phase/workflow 已经发送过一次此类 reminder THEN 系统 SHALL 不再自动 continuation，而是以 `blocked` 或 `planning-incomplete` 状态结束并在 footer/记录中说明原因。
4. WHEN agent 已 aborted、发生错误、存在 pending user messages、正在 retry/compaction recovery 或用户意图是 plan_only/research_only THEN 系统 SHALL 不追加自动提醒 continuation。
5. 自动提醒 SHALL 有 workflow/phase/turn identity 去重；reload、resume、fork 和 tree navigation 不得让同一分支无限重复提醒。

## R7：执行、验证与恢复

### 用户故事

作为用户，我希望执行模型可完成明确实现和验证；当出现真正需要重新推理的问题时系统自动回到高模型，而不是让低模型在错误设计上重复尝试。

### 验收条件

1. WHEN execution 模型提交实现结果并进入验证 THEN 系统 SHALL 能通过接受的 `execution → verification` handoff 或明确阶段事实选择 verification profile；v1 不得仅依据自然语言“完成了”判定验收通过。
2. WHEN 支持的验证命令失败 THEN 系统 SHALL 记录失败事实；失败本身不得立即等价为 heavy，但它必须阻止错误完成状态。
3. WHEN execution/verification 模型提交结构有效的 `execution → recovery` handoff，且 Jev 或本地风险规则确认存在设计假设失效、复杂诊断或关键未知 THEN 系统 SHALL 在下一交接 continuation 升级到 recovery profile。
4. WHEN recovery 模型形成新的可执行交接并获接受 THEN 系统 SHALL 自动切回 execution profile。
5. WHEN 验收条件已满足且没有未解决 blocker THEN 系统 SHALL 允许 workflow 进入 `complete`，不再自动追加 continuation。
6. 系统 SHALL 设置可配置且有上界的阶段转换预算；超过预算时 SHALL 停止自动阶段推进，保留当前上下文并报告需要用户/高模型介入，防止 high/low 振荡循环。

## R8：分支、取消、兼容与失败

### 验收条件

1. WorkflowState、accepted handoff 和 reminder 计数 SHALL 为 JSON 可序列化状态，随 Pi 当前 session branch 保存，并在 reload、resume、fork、compaction 与 tree navigation 中仅恢复对应分支状态。
2. WHEN 读取到旧的 GearState/task-aware v1 状态 THEN 系统 SHALL 保留同轮 physical dispatch；下一适合的新用户请求才建立 workflow 状态，不能把旧状态误解释为已接受交接。
3. WHEN routing/Jev/handoff validation 不可用、超时、取消或返回无效结果 THEN 系统 SHALL 保留现有 fallback 安全性：不伪造 acceptance、不自动切换阶段、不无限续接。
4. WHEN 用户切换离开 `gears/auto` 后再切回 THEN 系统 SHALL 不把手选模型输出误当作接受的 workflow phase transition。
5. `enabled:false`、direct request、手动模型选择、既有 authentication 检查和现有 task-aware routing SHALL 保持兼容。
6. 所有 workflow 自动 continuation SHALL 遵守 Pi 已有队列顺序；它不得抢占用户 steering/follow-up。

## R9：可观测性与配置

### 验收条件

1. TUI footer SHALL 区分 `planning`、`handoff 提交中`、`handoff 已接受`、`execution`、`verification`、`recovery`、`blocked` 和 fallback；它必须显示实际物理模型/有效 thinking level。
2. 状态信息 SHALL 说明切换原因，例如 `已接受 planning→execution 交接` 或 `recovery：验证失败后设计假设未决`；它不得把未接受 packet 表示为切换成功。
3. 配置 SHALL 支持独立启停工作流编排、规划/执行/验证/恢复能力下限、交接验证置信门槛、每 workflow 最大阶段转换数及自动提醒上限；非法配置回退安全默认。
4. 默认配置 SHALL 将 workflow 编排关闭或处于明确 opt-in 状态，直到本项目针对真实模型与工作流完成验证；开启时用户可审阅所有默认限制。
5. router SHALL 记录足以离线回放的无敏感决策摘要、阶段、触发原因、Jev usage、实际派发和转换计数；它不得记录 API key、hidden thinking 或完整工具输出。

## 非目标

- 不在不同物理模型之间直接迁移 KV cache。
- 不以 prompt cache hit 为压倒能力/质量约束的路由目标。
- 不引入另一个聊天 LLM 作为 workflow coordinator；Jev 仅做结构化分类和 readiness 判断。
- 不在 planning/recovery 阶段默认允许修改工作区。
- 不替换 Pi 的权限系统、MCP 权限、现有工具审批或用户明确的模型选择。
- 不承诺从任意自然语言输出可靠提取结构化计划；自动切换只接受显式 handoff tool。
- 不在 v1 支持并行多代理、跨 session 编排或自动发布/部署。

## 验收场景

| ID | 场景 | 预期 |
|---|---|---|
| A1 | 用户提出高不确定性交付需求 | Jev 判为 deliver/planning；Sol/high（或配置的 planning profile）只读调研。 |
| A2 | 规划模型提交完整且无 blocker 的 planning→execution packet | Jev 独立接受；下一 continuation 自动切 Luna/medium；执行模型拿到 packet。 |
| A3 | packet 缺少验收步骤或含 blocker | 工具拒绝；保持 planning、Sol/high 和只读限制。 |
| A4 | planning 模型自然结束但未 handoff | 自动提醒一次并继续；第二次仍无 handoff 时停止并标记 blocked。 |
| A5 | planning 模型调用 write/edit | 调用被阻止，返回可行动原因；工作区不变。 |
| A6 | execution 模型普通工具调用后 continuation | 沿用 Luna/medium；不重新切换。 |
| A7 | execution 验证失败但为简单类型错误 | 记录失败；不自动宣称 complete，也不必然切 Sol。 |
| A8 | 执行模型提交已确认复杂设计冲突的 execution→recovery handoff | 下一 continuation 自动升至 Sol/high；恢复阶段只读。 |
| A9 | recovery 产生新 packet 并获接受 | 自动切回 Luna/medium 执行。 |
| A10 | 用户在自动 reminder 前插入 steering/follow-up | 用户消息优先；不执行过期 reminder/handoff。 |
| A11 | handoff validation 超时/取消 | 保持当前阶段和实际模型；无 acceptance 和无自动循环。 |
| A12 | 分支 fork/tree/resume 后 workflow 状态 | 各分支只看到自己的 packet、阶段和 reminder 计数。 |
| A13 | exceeded transition budget | 停止自动推进，记录/显示 budget blocker，不无限 high↔medium。 |
| A14 | workflow 编排关闭 | 保留既有 task-aware 路由与同轮 sticky 行为。 |

## 开放问题

无阻塞开放问题。以下是设计阶段必须固定的默认值而非产品方向：

- planning/recovery、execution、verification 的具体 band floor；
- `execution → verification` 是否也必须经模型 handoff，还是能使用严格结构化验证事实；
- phase transition budget 和自动 reminder budget 的初始数值；
- 在非 TUI 模式中如何以 session event/JSON 日志表现 blocked 原因；
- workflow 的 opt-in 默认名称和 settings JSONC 形状。
