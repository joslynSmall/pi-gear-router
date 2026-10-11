# 会话观察与引导路由技术设计

状态：设计已批准。用户已回复“批准设计”，随后回复“批准任务并开始实施”；按 [实施任务](tasks.md) 开始开发。本文件仍为设计基线，尚未实现或验证的内容不因批准而视为完成；不修改个人设置。

## 1. 设计结论与职责

本版选择 **Jev 单次主要观察＋本地路由决策＋请求级候选提示**。不增加聊天 LLM coordinator，不把 Pi 会话改造成统一开发阶段机。

- **Pi** 拥有用户队列、资源发现、project trust、会话树、工具执行和请求生命周期。
- **观察路由模块** 拥有任务连续性、消息作用解释、能力需求、候选引导及派发记录。
- **用户、项目及已选 Skill** 拥有工作方法、审批、实际操作范围和业务验收。
- **主模型及权限扩展** 继续承担遵守真实指令、读取方法和操作权限检查。观察器不授予权限，也不是安全过滤器。

需求依据：[requirements.md](requirements.md)。治理依据：[BASELINE-GOVERNANCE.md](../../../docs/aegis/BASELINE-GOVERNANCE.md)。探索证据：[intent-routing-feasibility.md](../../../docs/intent-routing-feasibility.md)。

本设计以 Pi `1.1.0` 的导出契约和本地实现为依据；`package.json` 的 `>=1.1.0` 不是对所有未来版本接线顺序的验证。实施时用契约测试确认兼容版本，不能依赖私有字段。

## 2. Pi 接线事实与设计选择

### 2.1 已核实的事实

| 事实 | 本地依据 | 设计影响 |
|---|---|---|
| `before_agent_start` 在初始 user entry 创建之前触发，提供结构化 `systemPromptOptions.skills` | `coding-agent/dist/core/agent-session.js:1591–1629`、`extensions/types.d.ts:712–725` | 此处捕获目录，不在此处用未持久化的 user identity 接受路由结果 |
| queued steering 扩展后排队，不重新触发 `before_agent_start` | `agent-session.js:1690–1747` | 目录快照可用于同 run steering；消息判断仍在 route，而非只在 run 开始 |
| user message 先持久化；`prepareRequest` 路由并保存 `pi.virtual-model-state` 后，才执行请求级 context transform | `pi-agent-core/dist/agent-loop.js:114–147,260–267`；`agent-session.js:438–492` | Jev 结果能指导同一请求；不需要额外消息回合 |
| `context` 只暴露非 system 消息，Pi 恢复 prompt/tool state；`context_with_system` 由扩展承担完整 prompt | `extensions/runner.js:1006–1070` | 选择普通 `context`，不接管 system prompt／工具声明 |
| custom context message 转为 provider 的 user-role 文本 | `coding-agent/dist/core/messages.js:82–110` | 该文字必须自述为建议数据，不能伪装成新的用户请求／系统指令 |
| Skill 清单含 `disableModelInvocation`，禁用／trust 已由 Pi loader 解析；无内置 Skill 阶段机 | `core/skills.d.ts`、`resource-loader.js:621–641` | 不自行扫描目录；显式-only 不参加自动建议 |
| 当前扩展 context 没有通用 `resourceLoader.getSkills()` 方法 | `extensions/types.d.ts:215–257,1230–1310` | 不能假设每次 route 都能获取最新资源对象 |
| direct 没有 branch state；retry 有 failed physical pair；route state 在 provider 请求失败后仍存在 | Pi `docs/virtual-models.md` | direct 无观察；retry 不消费交接；准备派发不等于已回答 |

Pi 官方文档位于安装包的 `docs/{virtual-models,extensions,skills,sdk,configuration,settings,packages}.md`。实现路径仅为本次研究定位，不是待接入的私有 API。

### 2.2 离线接线探针

本次用临时脚本 `/tmp/pi-gear-observer-seam-probe.mjs` 创建真实 `AgentSession`，使用合成 Skill 清单、内存 session、mock physical provider、合成未使用认证值，禁止 `globalThis.fetch`。脚本不加入生产代码，也不充当功能测试。

观测顺序：

```text
input → before_agent_start → route:user → context → mock provider
input → before_agent_start → route:user → context → mock provider
                              input:steer → route:user → context → mock provider
```

结果：3 次 mock physical 请求、2 次 `before_agent_start`、3 次 user route；每次 context 都能读到新 route state；建议进入同次 provider 输入；leading system 保留；未持久化额外 user/custom message；networkCalls=0、extensionErrors=0。

这只证明接线可行，不证明真实 Jev 推荐质量、取消竞态、reload/tree 恢复、权限行为或新模式完成实施。以上仍须正式测试。

### 2.3 请求时序

```text
input                    记录输入 epoch、显式 Skill 意向；不改写输入
before_agent_start       捕获当前运行时 Skill 快照及有效期，不调用 Jev
真实 user entry          Pi 创建并持久化
route                    根据 reason、branch、消息 identity 构造有界输入
  ├─ direct/disabled     原有兼容语义；无观察、无引导、无交接
  ├─ retry               failed → previous → saved pair；不消费交接
  ├─ continuation        sticky；仅消费有效显式能力交接
  └─ user                继承或一次 Jev 观察 → 本地策略 → physical resolve
route state              Pi 在当前 branch 保存已校验 JSON
context                  本地复验、投影建议／必要交接摘要；不再调用 Jev
provider                 仅收到 physical model/thinking
message_end/tool_result  记录实际响应／有限执行事实，不立即换档
agent_settled            只通知；绝不追加 reminder 或 continue
```

`context_with_system`、`before_provider_request` 均不作为新观察入口。读取目录、观察、接受交接和注入都不得调用 `sendUserMessage()`、`triggerTurn:true` 或返回 `continue:true`。

## 3. 模块结构与 Interface

选择少量深模块，而不是把每个分类字段拆成一个 owner。`src/index.ts` 只适配 Pi 事件和虚拟模型，不复制策略。

| Module（拟定路径） | Interface 与职责 | 不负责 |
|---|---|---|
| `src/observer-routing.ts` | `decideObserverRoute(input, observe, signal)`；纯状态更新、任务连续性、动作不确定性、窗口和交接消费；返回 decision/state/effects | 不联网、不操作工具、不读取 Skill 文件 |
| `src/observer-judge.ts` | `observeTurn(input, options)` / `checkCapabilityHandoff(input, options)`；classifier adapter、字段校验、调用预算及 usage | 不决定权限／业务阶段，不生成自由引导文本 |
| `src/observer-guidance.ts` | `captureCatalog(event, ctx)` / `projectGuidance(messages, state, snapshot)`；目录 identity、候选复验、受控模板和读取事实适配 | 不扫描目录、不加载 Skill 正文、不修改 system prompt |
| `src/observer-handoff.ts` | 注册 `gear_capability_handoff`；有界 schema、本地事件追加、异步结果复验 | 不批准规格，不写工作区，不自动 continuation |
| 既有 `gears.ts` / physical resolve | score→band、目标与认证可用性、thinking 裁剪、fallback | 不解释方法或审批 |
| 既有 `observation.ts` | 公开工具事实和当前 branch adapter；扩展覆盖诊断 | 不将工具成功等价为业务验收 |

外部主 seam 是 `decideObserverRoute` 的小 Interface。branch adapter 与内存测试 adapter 使用相同输入/输出；联网 classifier 是唯一外部判断 adapter。依赖方向为 Pi adapter → 路由策略 → 数据契约／bands，不能让纯策略读取 Pi runtime。

```typescript
interface ObserverRouteInput {
  reason: "user" | "continuation" | "retry"; // direct/disabled 在 Pi adapter 提前返回
  identity: RequestIdentity;
  previous?: ObserverStateV1;
  context: ObserverInput;          // 已裁剪，无 system、hidden thinking、图像
  facts: BranchObservationFacts;
  handoffs: CapabilityEvent[];     // 当前分支、已校验的新协议
  settings: ObserverPolicy;
}
interface ObserverRouteDecision {
  retainPhysicalPair: boolean;
  requestedBand?: number;
  protectedBand?: number;
  state?: ObserverStateV1;
  effects: BoundedDiagnostic[];    // adapter 负责写入；不是主模型执行命令
}
```

上述为设计契约草图，不是声称已导出的运行类型。异常取消向上传播；分类失败返回数据结果；未知字段不透传到下一状态。

## 4. 数据模型：分开事实、解释与控制

### 4.1 RequestIdentity

使用持久化的真实 user entry，而非 classifier 输入中的“最后一个 user”：Pi 的 custom／compaction 文本也可能被转换为 user role。

```typescript
interface RequestIdentity {
  sessionId: string;
  userEntryId: string;
  userContentDigest: string;       // 完整内容本地 hash；不外发路径／正文之外资料
  inputEpoch: number;             // runtime 内，每次新输入递增
  branchEpoch: number;            // tree/session/reload/mode gap 时递增
  policyFingerprint: string;
  catalogVersion?: string;
}
```

异步开始/完成分别校验 current session、源 user entry 是否仍在当前 branch、最新 user identity、选择仍为 `gears/auto`、mode、策略、目录版本、epoch、abort 和 pending messages。不能简单要求 leaf ID 相等，因为 Pi 可在期间追加正常事实／自有诊断；应复验相关源条目和失效事件。

原始 `input` 只能记录候选输入意向：它可能被后续扩展 transform/handled。控制事实最终绑定被 Pi 接收并持久化的实际 user entry。任何新增排队输入均保守使未消费交接过期，即使暂不解释内容；不抢占 Pi 正在执行的工具和已发送请求。

### 4.2 有界观察输入

```typescript
interface ObserverInput {
  schema: "observer-input-v1";
  request: string;
  task?: { id: string; anchor: string; userChanges: string[] };
  routing?: { persistentProfile: CapabilityProfile; taskBand: number };
  methodObservations: ReportedMethodFact[];
  controlFacts: ControlFact[];
  activeHandoff?: BoundedHandoffSummary;
  recentPublicAssistant: { sourceEntryId: string; text: string }[];
  executionFacts: ExecutionFact[];
  skills: { candidates: ExternalSkillMetadata[]; total: number; coverage: string };
  missing: string[];
  nonTextInput: boolean;
}
```

- 任务 anchor 保持来源，新增需求进入 `userChanges`，不由 Jev 自由重写为“已批准的新目标”。
- 方法阶段仅记录来源明确的外部事实：`stageLabel`、`waitingFor`、source entry 和 `reported/observed`。主模型公开“等待批准”可由同次 Jev 返回 gate 解释，绑定提供的 source entries，并标为 `reported`，不能冒称是 Pi 的审批事实。无可靠来源则 `unknown`；不解析任意 Markdown 生成审批机。
- `controlFacts` 中 pause/cancel/narrow_scope 与 source user 关联；classifier 解释是 advisory。它们控制的是本扩展的继承、交接和引导，不是工具权限放行表。
- 公开事实仅为本地允许的失败、成功、读取状态等标签；不外发完整工具参数/输出、system prompt、Skill 正文或原始 provider 错误。
- 显式 `/skill:name` 已被 Pi 展开时，外发输入以本地识别的 `selectedSkill` identity 和用户附带请求表示，不默认发送正文或 location/baseDir。没有可靠 expansion 对应时，使用缺失标记，不能靠正则任意剥离用户内容后冒称完整理解。
- 图像只传 `nonTextInput:true`；涉及图像的低档候选不得据此降档。

### 4.3 Jev 输出

一次主要 classify 使用 typed questions，不要求生成任意 JSON 文本、任意路径或自由自然语言 summary。

| 字段 | 类型／枚举 | 消费者 |
|---|---|---|
| `relation` | choice: `same_task / new_task / uncertain`；无 task 时不询问 | 任务身份；未知关系不覆写旧任务 |
| `messageEffect` | choice: `request_work / continue / explain / change_scope / pause / cancel / clarify_reference` | 本轮作用；不包含 grant |
| `work` | choice: `investigate / requirements / design / task_plan / implement / verify / diagnose / answer / unknown` | profile 与本轮工作需求；不是方法阶段机 |
| `capability` | score `0..2` 与 confidence | 既有 bands 的需求量 |
| `clarity` | choice: `clear / unresolved / unknown` | 降档保护；不作为全部 profile 开关 |
| `risk` | choice: `low / medium / high / unknown` | 能力下限保护，不用于权限授予 |
| `clarification` | bool probability | 有界澄清建议 |
| `methodGate` | choice: `waiting / none_observed / unknown` | 公开上下文的等待解释；waiting/unknown 阻止交接，不代表批准 |
| `skill_0..skill_N` | 候选每项一个 bool probability，至多 12 项 | 同次观察的候选相关度；不是 Skill 已加载事实 |

初次无task最多20个问题，已有task最多21个问题。这是设计上界，不是已证实的Jev服务容量；真实验证需测量该合并schema的输入开销与有效输出率，不能拿此前四字段原型结果替代。

每个 choice 保留 `choice`、`confidence`、全 probabilities 和字段 validation status。顶层 outcome 为 `valid / partial / invalid / unavailable / aborted`，另记 `timeout / transport / invalid-shape / invalid-probabilities / missing-field`。Pi adapter 将协议错误折叠为 `stopReason:error` 时，只有能确定解析阶段的错误归入 invalid；其余标记 `service-or-adapter-error`，不猜测。

禁止 `authorization:grant`、`phase:complete`、自由 `systemInstruction`、模型指定文件路径。任务 scope 和 approval 不能由 classifier 输出直接升格为事实。

### 4.4 持久化状态

观察模式的 route state 使用 `schema:"observer-routing"`、`version:1`，不复用旧 `workflow.version:1` 的含义。

```typescript
interface ObserverStateV1 {
  schema: "observer-routing";
  version: 1;
  turn: PersistedTurnIdentity;
  task?: ObserverTask;
  capability: {
    persistentProfile: CapabilityProfile;
    turnProfile: CapabilityProfile;
    requestedBand: number;
    protectedBand: number;
    taskBand: number;
  };
  dispatch: PhysicalPair;              // 选定派发；真实响应另有 Pi assistant message
  observation?: ValidatedObservationSummary;
  activeHandoff?: AcceptedCapabilityHandoff;
  guidance?: BoundedGuidanceRecord;
  budget: TaskBudget;
  diagnostics: CoverageAndDecisionTrace;
}
```

`persistentProfile` 与 `turnProfile` 分开：复杂实施里的 explain 可以本轮 respond，但不把任务 band 或方法状态永久改低。用户下一条纯继续回到已有任务需求，不将 explain 的低 score 加入任务降档样本。

branch custom event 使用新的 `pi-gear-router.capability.v1`；包含候选、接受、失效、消费的 ID/hash/source identity 和有限 packet。`pi-gear-router.observer.v1` 记录调用／建议／公开事实摘要。持久化一个不可变快照而不是读取 abandoned branch 来“补齐”证据。总 state ≤64 KiB、单 event ≤16 KiB；不允许 Date、NaN、函数、原型对象或未知字段扩散。

## 5. Skills 目录与引导

### 5.1 目录来源、identity 与可见性

1. 从 `before_agent_start.systemPromptOptions.skills` 复制只读快照。不得编辑该数组或再次使用 `loadSkills()` 搜索个人目录。
2. 当前 event 反映注册顺序中之前的改动，不保证之后扩展不再修改。route 使用完整 request transcript及导出的 system helpers 检查当前有效结构化 `skills` section；与已捕获快照通过 Pi `formatSkillsForPrompt` 的允许 reader 变体核对。普通 context 没有 system 消息，复验必须使用当前 branch projection、`ctx.getSystemPrompt()` 和该次 route 保存的可见性 fingerprint，不能从 `event.messages` 假装获得完整 prompt。不解析 arbitrary prose 为另一个目录。
3. forced/custom prompt、后置 context handler 重写目录、没有 reader 或无法证明可见性时，覆盖为 `unknown/partial`；禁用对应自动推荐，不影响能力路由。context 复验只保证本 handler 当时的状态，不能保证别的后置扩展不会改写；文档说明 load order 限制。
4. 本地 identity 为 hash(name、filePath、description、disableModelInvocation、sourceInfo、cwd)。catalogVersion 为有序有效目录 hash 加 runtime 资源 generation；reload、session/cwd/tree 变化清空快照，下一可靠捕获前不建议。
5. 外发只使用短 `candidateId`、name、裁剪 description。candidateId 绑定本次 catalogVersion；paths/baseDir/sourceInfo 全部留在本地。模型不负责给出文件路径。
6. 本地检查 candidate 仍存在、未禁用、自动可见、文件可读取且在 runtime 已解析集合内。来源与 trust 沿用 Pi；不因存在文件就宣称脚本运行环境已就绪。
7. 同名 collision 采用 Pi 保留的结果，不重新选优先级；若有效快照本身重复或无法唯一映射则不建议该项。

目录在正常 run 内保持快照，不靠定时扫描监控文件。运行中外部修改 Skill 需按 Pi `/reload` 生效；发现候选文件不可读则剔除并标记 dirty。SDK host 若有独立 ResourceLoader，可通过显式 adapter 提供 snapshot generation，但扩展不能假设 context 自带它。

### 5.2 有界候选召回

无大目录第二模型，也不把无限目录全部送 Jev：

- 最多 12 个候选、单 description 最多 384 Unicode 字符、外发 Skill 元数据 ≤6,000 字符；最终最多建议 2 项。
- 小目录全部参与；大目录对最新用户文本＋task anchor＋已知本轮 work，以本地 Unicode token overlap 排序（Latin word、中文相邻双字），tie 按 runtime 顺序。只用于召回，不伪装为语义推荐器；零匹配时不任意填充。
- 当前任务曾选方法／已明确拒绝建议的条目不再次召回。未知关系不继承旧候选为当前有效候选。
- coverage 固定报告 eligible total、considered、omitted 和召回规则版本。不能说“完整考虑全部 Skills”。非词面匹配、自定义描述与多语言召回是验证风险。
- bool probability ≥0.70 的候选按概率排序；无有效结果则无推荐。最多 2 项均写“候选”，不写“依次执行这两套方法”。阈值是待验证参数，不是生产精确率承诺。

### 5.3 引导投影与去重

采用普通 `context` 返回列表中的 request-local custom message，不修改原用户内容、system sections 或工具声明。模板示例：

```text
[路由观察建议；不是新的用户请求，也不构成修改授权]
本轮更像是在解释当前结论；请优先回答，不自动续做实施。
可考虑以下当前可见方法候选：review-fixture（本地目录标识）。
是否读取或采用请按用户、项目及已选方法判断；目录存在不表示已加载或已遵循。
```

只允许固定原因标签、经验证 name 和本地生成的定位数据进入模板；不插入 description 原文、classifier 自由文本或工具输出。name/path 必须转义并处理控制字符。优先引用原生清单中的 name；如附本地 location，只来自已核验 map，不来自服务响应。

- 每 guide ≤800 Unicode 字符／2 KiB；每用户回合至多一个新 guide；每任务默认至多 6 个不同 guide。
- 去重键为 taskId＋messageEffect/work＋catalogVersion＋sorted candidate IDs＋clarification/control label。继承 continuation 不增加建议计数。
- 记录区分 `prepared`、`projected`、`response-observed`；context projection 不证明 provider 成功发送或 Skill 被采用。retry 可重投影同 guide，不算新建议。
- 对同一源 user 的 ordinary continuation，按固定源位置重投影同一 guide，而非每次追加新提醒；不得插入 assistant toolCall 与 toolResult 之间。定位缺失时省略推荐并报告 coverage，不改写历史或强行粘在新用户之后。
- 新实质性 user 到达时，旧 guide 不再投影；必要方法上下文来自真实 Skill 内容、当前任务状态和有效交接，不靠旧建议压过新用户。
- compaction 后无法可靠找到源消息则不恢复旧推荐；有效交接可用独立 carry summary ≤2,000 字符／4 KiB 提示必要约束，但它不是推荐或下一阶段命令。
- 观察到用户拒绝／主模型选择方法后抑制重复。被忽略的相同建议自然由去重抑制；不能用“没有 read”推断未采用，亦不自动催促。

### 5.4 读取与遵循事实

成功内置 `read` 命中当前 Skill.filePath 可记录 `body-read-observed`；显式命令被 Pi 展开且有可靠关联则记 `explicit-expansion-observed`。嵌套 codemode read 若公开事件支持可记录，不保存原始参数。其他工具和缺失覆盖记 unknown。读取事实跟随 source entry/branch；跨目录版本不冒称新正文已读。始终显示“遵循未知”，不把 read 当执行确认。

## 6. 消息作用与能力路由策略

### 6.1 能力 profile（不是流程阶段）

| Profile | 当前工作 | 默认 band 下限（默认五档） |
|---|---|---|
| `converge` | 需求收敛、实质设计、任务规划、复杂调查／审查／诊断 | 3，heavy/high |
| `implement` | 范围与验收已明确的实施 | 1，standard/medium |
| `verify` | 实际验证工作；复杂失败转为 converge 需求 | 1，standard/medium |
| `respond` | 简单问答／解释／状态说明 | 0，仍受本轮 score 和复杂性保护 |

work=investigate/diagnose 不必每次 heavy：实质复杂工作或存在关键未知取 converge；简单事实查询可以 respond。review/research 不再排除 converge。profile 只能提高配置下限，不规定读写工具、不规定文档名或执行顺序。

stageAware=false 时仍可观察／建议，但不使用 profile floors、能力交接或 profile 转换；沿用 task-aware 能力保护的同等规则。guidance=false 或 skills=false 不影响观察路由本身。

重要公开执行事实（例如已支持验证命令失败）只标记 dirty：它使纯继续不能无判断继承、使旧降低能力候选过期；下一实质用户观察或显式能力交接再评估，不在普通工具 continuation 自动调用 Jev或升档。无显式交接仍保持本轮实际 pair。

### 6.2 字段级与动作级不确定性

默认关系提交／降档语义门槛为 0.80，取相关字段自身 confidence 与 selected probability；不是所有字段最小值。

- choice 的可行集合：保留各 probability ≥0.15 的标签，按降序继续添加直到累积至少 0.80；chosen 总在集合中。若字段自身 confidence <0.50 则集合取全部标签。
- 多个 work 标签若都指向 converge，可采取共同能力动作，不必判定到底是 design 还是 requirements。risk low/medium 的不确定不会否决已明确调查。
- work 有效支持 substantive converge，但 risk 无效时，可以提高能力，不接受降档。任何涉及 downshift 的字段无效、未知／高风险可能性、unclear scope/reference 或 nonText 都 hold。
- confidence/probability 是服务报告数据，不是经校准的真实正确率。集合规则是本地保守政策，需轨迹验证；不把阈值当数学安全证明。

| 动作 | 必要可靠证据 | 不可靠时 |
|---|---|---|
| 开启独立新 task | relation=new_task 的相关字段可信；或第一条有效真实请求 | 旧 task 不覆写；本轮独立 provisional 判断，不继承候选/交接 |
| 提高能力／调查 | 有效 capability 或共同 converge 工作解释 | 可提高／保持，不生成实施授权 |
| 推荐 Skill | 当前有效目录＋该候选有效 bool 概率 | 无推荐，不阻塞路由 |
| 本轮解释回应 | explain/answer 当前作用可信且无复杂需求；保持任务身份 | 维持原能力或建议澄清 |
| 同任务降低能力 | capability、relation、work/clarity/risk 所需证据可靠＋降档窗口 | 保持；不靠风险 label 的低置信推断低风险 |
| 同 run 换档 | 显式新协议交接＋本地 accepted＋下一合法 continuation | sticky；自然文本无效 |
| 新增权限／规格批准／业务完成 | 不属于本模块 | 永远不能由观察输出产生 |

暂停／取消／范围收紧：明确用户控制或 classifier 的保守控制解释均立即废弃本扩展旧交接，清降档窗口；只暂停观察路由推进，不调用 `ctx.abort()` 作为通用工具权限 enforcement。cancel 使旧任务 inactive；“先别改，讨论”保留任务但本轮 converge，不自动实施。控制解释未知可发澄清；不能撤销已经发送请求或已发生副作用。

### 6.3 连续性、降档与防振荡

- trusted same_task 继续维护 anchor 和最近 3 次 userChanges；新增未定范围使旧 packet 失效且提高／维持收敛能力，旧 user 授权不拓展到新范围。
- literal continuation 仅匹配现有有界短句白名单；有效 task、policy、dispatch、已知事实覆盖、无 dirty/gate、未到上限才继承。最大继承 3 个用户回合，继承不调用 Jev、不增加 score 样本。
- “按那个做”、批准指代、缺上下文的“继续”不能从词面白名单直接转实施；有等待审批事实时强制观察／澄清，不将短句当清除 gate。
- gate=waiting 或 unknown 只抑制能力交接／持续工作降档，不禁止本轮高能力调查；独立解释的临时respond能力仍按相关本轮证据判断，不清除等待。gate=none_observed 只表示未观察到等待，不表示审批通过；不能删除已有 source gate。只有新的真实用户内容与相应来源被核对后才能使旧等待失效；存在歧义则继续澄清。
- 保留现有 taskRouting 的 2 个不同 evidenceKey 降档窗口、0.08 margin；重复 route、transport retry、provider retry 和继承都不增加窗口。first/new task 不受旧高能力锁定。
- taskBand 表示持续工作需求；explain/answer 可临时更低，但 taskBand/window 不变。临时 responder 的实际 pair在本轮仍 sticky；之后真实继续恢复 taskBand。
- 实施用户新回合有可信、明确的工作变化时走降档窗口；同 run 接受交接可绕过旧 converge 窗口，但只降低 **至多一个 band**，且不得低于目标 floor/风险需求/当前 capability。不能一包从最高降到 light，也不能连发同 packet 逐级降档。
- 升档可跳到必要下限；接受交接后的降档冷却为至少 2 个新实质性用户观察，除非真实 scope/profile 再次变化。每任务最多 4 次同 run capability transitions。
- requestedBand、protectedBand、physical dispatch 分别记录。fallback 不改写 task demand；目标缺失／认证变化时复用现有 physical resolve，不谎称 profile 已达到。
- bands 顺序沿用用户声明的能力顺序，不声称任意自定义物理模型间存在已测量能力关系。下限索引超界时映射到最高可用 band并诊断；不回退到 light。

## 7. 显式能力交接

### 7.1 新工具与 packet

使用新名称 `gear_capability_handoff`，注册为默认 inactive、sequential 的直接工具，只在 observer＋stageAware＋gears/auto＋enabled 下激活。无论工具 exposure 是否被其他扩展改变，execute仍验证model/mode/identity，不仅靠可见性控制。legacy 继续使用旧 `gear_workflow_handoff`，新模式不激活旧工具且旧execute拒绝非legacy mode，不能 alias 旧 `complete` 到新能力协议。

packet 的语义为“下一请求所需能力与已收敛材料”，不是“推进项目方法阶段”。

```typescript
interface CapabilityPacketV1 {
  version: 1;
  taskId: string;
  sourceUserEntryId: string;
  nextWork: "converge" | "implement" | "verify";
  goal: string;
  scope: string[];
  nonGoals: string[];
  decisions: { decision: string; rationale: string }[];
  steps: { change: string; acceptance: string[] }[];
  constraints: string[];
  validation: string[];
  risks: string[];
  blockingUnknowns: string[];
  methodGate: "none_reported" | "waiting" | "unknown";
  permissionEvidence: { userEntryId: string; summary: string }[];
  reason: "work-converged" | "complexity-increased" | "verification-work";
}
```

每文本 ≤1,000 字符，列表 ≤8，steps ≤8、每 acceptance ≤4；整个 packet ≤8,000 Unicode 字符且 ≤16 KiB。只接受纯 JSON、枚举和白名单字段；`taskId/userEntryId` 验证存在于当前分支。不接受命令权限声明、隐藏推理、任意 model/provider 指定或 `complete`。

### 7.2 验证与接受

1. 本地验证 observer mode、model selection、源 task/turn、policy/catalog identity、预算和 packet；waiting/unknown gate、已知暂停／取消、pending 输入、失效 source 拒绝。implementation 还要求范围、步骤、验收、validation 非空、blockingUnknowns 空。
2. permissionEvidence 必须引用当前 task 的真实 user entry；摘要只是模型陈述，不写入“正式批准”事实。历史授权不能覆盖新增 scope。若需用户批准且没有新用户依据，拒绝能力交接。无法证明项目审批满足时主模型仍必须核对真实指引，不能凭 `none_reported` 绕过审批。
3. 对有效候选做 **一个独立 Jev classify**，合并 `readiness`（ready/needs_convergence/blocked）、scope relevance、clarity、risk 和 capability；无 Skills 问题、无聊天二次判断。readiness/相关 scope/clarity 的相关字段需 ≥0.80；降档还需低风险解释可靠，高风险／关键未知不降档。风险不确定可以接受升档建议，不能接受降档。
4. 调用后重新检验 identity、pending 输入、gate、signal 和预算，事件持久化成功才返回 accepted。不能靠自然语言声称 accepted。append 失败返回拒绝，不留仅内存 acceptance。
5. 工具 result 返回 accepted ID、目标 profile、requested/protected band、packet digest、有限有效 packet；明确“只改变后续能力，不批准实施”。usage 在成功、拒绝、invalid result 路径都按实际报告记录，不能仅 accepted 才计费。
6. local acceptance 验证的是能力材料一致性，不是通用项目审批证明。主模型／权限机制仍为外部 authority；未公开的方法状态覆盖为 unknown。同一交接 classify 也询问 `methodGate`，waiting/unknown 与本地 source gate 均可否决；模型 packet 的 `none_reported` 不能单独清掉旧等待。该限制写入用户文档和安全测试，不冒称可以检测所有 Skill gate。

### 7.3 消费、失效与恢复

- 仅下一合法 ordinary continuation 可消费，retry 永不消费。必须有当前 source tool result 的非错误完成事实；工具明确拒绝或被权限扩展拦截不能产生 accepted。
- 一个 source work revision 只允许一个降档候选；accepted 可能只改变 profile而保持相同 physical pair，诊断分开 candidate/accepted/consumed/response observed。
- user 输入、scope/control 变化、手选模型 gap、mode/policy/catalog 变化、waiting、新 branch/runtime generation 均使 pending 失效。预算耗尽保持能力，不设置业务 blocked，不阻止正常回答。
- retry 保留 failed physical pair；retry 成功后的合法 continuation 可重新核对尚未失效的候选。aborted/error 没有自动 continuation，不能为了消费而创造新回合。
- compaction 在同 run、同 identity 下保留能力候选与有界材料；若 source/tool result 无法可靠关联则拒绝消费。Pi 路由后 compaction 不重判模型，context 只复验引导和 carry summary。
- reload/resume/tree/fork 可以恢复已消费 profile、taskBand、dispatch、去重和调用预算，但保守失效未消费 accepted event；需新显式交接，不将 fork 历史 acceptance 当新分支授权。
- 旧 workflow accepted event 永不由 observer reducer 消费。方法完成／主模型自然结束没有任何 complete gate 或 reminder。

## 8. 预算、概率契约与故障

### 8.1 已批准的默认参数与硬上界

以下为设计默认值，不是实测最优或费用保证。延续需求：Jev `typesafe/jev-latest`、新模式默认关闭、不增加第二判断模型。

| 项目 | 默认／硬上界 |
|---|---|
| 外发最新 request | 16,000 Unicode 字符；显式 Skill 展开按 4.2 处理 |
| task anchor / userChanges | 4,000；最近 3 条，总计 3,000 字符 |
| 近期公开 assistant | 最近 2 条，每条 ≤1,000 字符；只取 text block |
| method/control/facts/handoff summaries | 合计 ≤4,000 字符；有限枚举、来源和摘要 |
| Skill metadata | ≤12 项、description ≤384、总计 ≤6,000 字符 |
| 整个 classifier 输入 | ≤32,000 Unicode 字符且 UTF-8 JSON ≤64 KiB；优先保留 request/控制/缺失标记，先裁剪 recent、元数据、历史摘要 |
| Jev 逻辑调用 | 每真实实质性用户回合 ≤1；每显式交接候选 ≤1；每任务默认 24，硬上界 64（两种调用共用） |
| 自动 transport retry | 默认 0；可选 1，硬上界 1；计入 transport attempts |
| 整次调用 deadline | 沿用 judgeTimeoutMs=15 秒；含 auth、等待和 transport，不允许每 retry 重置总 deadline |
| capability transitions | 默认 4，硬上界 8／任务 |
| 新 guide | ≤1／用户回合，≤6／任务（硬上界 12） |
| state / event | ≤64 KiB / ≤16 KiB；窗口、seen keys 和摘要均有上界 |

任务预算耗尽后可以继续当前 dispatch并诊断，不反复调用，不偷偷建立新的 taskId 绕开上限。预算未耗尽时，只有可信独立用户新目标才能重置任务预算；unknown relation 保留预算所有者。耗尽后同一session不再免费猜测自然语言new_task以重置：用户需显式建立新session，或自行切换/关闭路由；reload/resume不是预算重置入口。

逻辑调用在联网前以 callId/evidenceKey 预留当前 branch 的预算记录，transport attempts 由同一 owner计数；完成／失败／过期只更新诊断，不返还已经尝试的额度。初次未知task用source user identity建立临时预算归属，之后只在trusted new_task时重置。并行工具候选通过sequential handoff和预留记录去重；重复route复用同一已完成结果或in-flight promise，不重复付款。联网依赖callback先提交reservation再调用classify，纯reducer不自己appendEntry。

取消／目录变化后的usage记录不能提交过期routing state；若source仍在当前branch可追加关联callId的诊断。若session/tree已切走，不能把旧结果append到新branch：原branch的reservation保留attempted，完成usage只能通知runtime诊断并标记accounting coverage不足，不能伪装为没有调用或跨branch写入旧判断。没有恢复预算/完整事件能力的 SDK adapter 禁用自动交接和重复引导，报告 reduced coverage。

provider 自带 retry 与 `resilientFetch()` 不叠加：observer adapter 显式 `maxRetries:0`，可配置的一次 transport retry 由同一 attempt owner 控制总 deadline/abort。无效输出、低置信或拒绝交接不自动修复重试。

### 8.2 概率精度契约

现有 prototype 在合计 `0.99` 时被 `0.001` 容差拒绝。Pi TypeSafe adapter 只检查 finite number，没有声明舍入位数或保证 probability sum，也未自动归一化。本次没有拿到服务的正式精度契约。

设计选择：

- 初版 parser **保留严格 `abs(sum-1) ≤0.001`**，exact label set、每值 `[0,1]`、chosen 不小于最大值（仅机器 epsilon 容差），confidence/score finite 且在范围内。
- 不改造／重归一 probabilities，不根据单个 `0.99` 样本把容差改成 `0.01`，不把失效字段解释成语义低置信。
- 对Pi成功返回的answers，只拒绝本地失效字段：有效 capability/converge 判断可参与保守升档；无有效低风险等证据时不降档／接受实施交接。choice 无效不影响独立 bool Skill 概率，但候选仍需本地验证。若Pi协议parser已经因一个shape错误清空全部answers，则整体fallback并保留解析错误类别；不读取原始wire响应补造部分结果。
- 更宽容的 provider-specific 精度规则须有服务文档／响应契约证据及边界测试，版本化 parser/policyFingerprint 后审批。未证实前保持 strict，并报告受影响字段比例。

这一方案可安全实施，但可能降低自动交接覆盖。若真实协议持续因舍入被拒绝，它是放开实测之前的发布评审项，不以“换模型”或伪造概率解决。

### 8.3 错误行为

| 场景 | 路由／引导行为 |
|---|---|
| classifier missing/auth/timeout/transport | 保持可信 physical pair，否则原有 fallback；不生成假观察建议；下个合适实质用户回合重评 |
| partial / invalid fields | 只消费仍有效的非扩权动作；相关降档字段失效则 hold |
| valid low confidence | 保存语义不确定性；共同调查动作可采用，必要时澄清 |
| signal aborted | 丢弃未提交观察/acceptance，传播取消；已发生 attempts/usage仍有界记录 |
| 期间新输入／模式／目录变化 | 不提交过期决策/guide/acceptance；sticky；下一合法用户请求判断 |
| target unavailable / thinking clamped | 既有 resolve/fallback；分别显示 protected demand 与 effective physical pair |
| 无有效目录／未知 prompt／候选不可读 | 无 Skill 推荐；模型路由继续，coverage明确 |
| append/state validation 失败 | 不接受新交接，不声称已记录；兼容 dispatch并诊断 |
| budget exhausted | hold、无新网络／重复引导；正常主模型工作不被阻断 |

任何 classify failure 均不把原始异常文本/URL/响应正文保存到持久诊断。错误类别映射为白名单＋短原因，不泄漏凭据。

## 9. 配置、互斥与退休计划

### 9.1 配置形状

保留 `enabled`、gears、bands、bias、taskRouting、judgeTimeoutMs。新增：

```json
{
  "routingMode": "observer",
  "workflow": { "enabled": false },
  "observer": {
    "guidance": { "enabled": true, "maxCandidates": 2, "maxChars": 800 },
    "skills": { "enabled": true },
    "stageAware": true,
    "minBands": { "converge": 3, "implement": 1, "verify": 1, "respond": 0 },
    "maxCallsPerTask": 24,
    "maxTransitions": 4,
    "maxTransportRetries": 0
  }
}
```

没有 `routingMode` 时按现有 `workflow.enabled` 推导 `legacy-workflow` 或 `task`。observer **不是默认值**；只有显式 observer mode 且 legacy 关闭才启用。Jev identity 初版固定为 classifier，暂不开放 chat observer 配置，以免递归到 gears/auto。

### 9.2 模式决策表

| 配置 | 有效 owner |
|---|---|
| enabled=false | disabled，无观察/引导/交接；原 disabled/direct语义 |
| 未设置 mode，workflow.enabled=false | task，保留现有行为 |
| 未设置 mode，workflow.enabled=true | legacy-workflow，保留旧 guard/reminder/complete |
| mode=observer，workflow.enabled=false | observer，启用本设计 |
| mode=observer，workflow.enabled=true | **冲突：legacy-workflow 优先**，明确诊断 observer 未启动；不静默拆保护 |
| mode=task，workflow.enabled=true | 冲突：legacy-workflow优先并诊断；关闭 legacy 后才 task |
| mode=legacy-workflow | legacy owner，即使旧 flag false 也须明确显示该模式启用旧保护 |
| mode 无效 | 不启用 observer；按旧 flag 保留兼容 owner，显示 invalid-mode |

模式解析是唯一 owner 的代码 seam：guard、handoff、status、route、工具 exposure 都使用同一个 resolved mode；不能各自读取不同 boolean。整体 enabled、手选 physical、direct 优先抑制新 observer。配置用户/项目 overlay 沿用现有规则；observer 模式对项目 router override 必须尊重 `ctx.isProjectTrusted()`，不擅自启用未信任项目控制。

### 9.3 旧行为的适用与替代

旧规格和 approval 记录保留为 legacy 的权威与历史证据，不伪造重新批准。以下标注只在 **observer mode** 生效，设计批准并实施后才改变代码：

| 旧阶段编排需求 | observer 替代／退休 | legacy |
|---|---|---|
| R1.1–R1.5 objective/start 与统一启动门槛 | 本设计 §4/§6；按消息作用和动作证据，不设统一 workflow启动开关 | 保留 |
| R1.6 每回合强制重判 | §6.3 有限继承，任何新用户仍使旧交接失效 | 保留 |
| R2 profile 与能力下限 | §6.1–6.3 能力 profile；保留 sticky/可用性保障，无 phase 权限含义 | 保留 |
| R3 planning/recovery 全面只读 | observer 不注册／不执行旧 phase-specific guard；外部权限与真实用户约束不变 | 保留 |
| R4/R5 workflow packet/交接 | §7 新名称/版本/事件，只交接能力；旧事件不 alias | 保留 |
| R6 settle reminder/blocked | 完全不使用；没有新 owner 来自动催促 | 保留 |
| R7 固定实施→验证→恢复→complete | §6/§7 允许工作能力变化，无强制顺序，无业务 complete | 保留 |
| R8 branch/cancel/disabled/direct | §2/§4/§7/§8 保留保障；pending事件更保守失效 | 保留 |
| R9 phase footer/配置 | §9/§10 新诊断，不展示业务 blocked/complete | 保留 |

初版保留 legacy 作为明确的短期兼容分支；不同时运行两个 owner。后续删除 legacy 必须另有迁移通知、用户配置检查、保护替代评审和独立批准，本版不预定静默删除日期。

`src/workflow-*` 保留在 legacy 路径，新路径不得调用旧 consume/reminder/complete reducer。旧状态可用于同轮 saved physical pair；新实质用户回合才创建 observer state。observer→legacy/task 也不翻译方法阶段，仅复用 physical pair；政策 fingerprint 含 mode/parser/budgets/profile/catalog规则版本，跨模式窗口和 pending packet 失效。

## 10. 隐私与可观测性

- 新模式文档显式告知：用户请求、任务公开摘要和选入的 Skill name/description 会发往 TypeSafe；不默认外发 Skill paths、正文、hidden thinking、system prompt、credential/config敏感字段、完整工具数据或图像。
- `observer.skills.enabled:false` 可禁用元数据外发与 Skill 建议，仍保留路由；guidance关闭不等于停止观察服务调用；overall disabled不产生观察用量。
- 本地状态的用户片段/packet同样可能含敏感信息，使用既有 session 存储，不额外导出全量日志。截断/白名单不构成通用脱敏保证。
- 每逻辑调用记录 kind=turn/handoff、trigger、call ID、elapsedMs、attempts、stopReason类别、field validity、usage presence；一个多问题 classify 计一次。handoff 的独立 classify计另一调用。
- usage完整保留服务报告值；missing、catalog price 0 或合成 mock usage不能显示“免费”，不据此承诺节省。
- TUI footer 展示 `观察/复用/不确定/失败`、turn profile、requested/protected band、actual model/thinking、fallback、覆盖/预算；非 TUI只保留结构化摘要，不访问 UI。
- Skill: candidate/prepared/projected/body-read-observed/explicit-expansion-observed/following-unknown；交接: proposed/accepted/invalidated/consumed/physical-response-observed。不能将 accepted→implement 说成“已批准实施”，不能将验证成功说成业务 complete。

## 11. 验证策略与需求追溯

### 11.1 测试层次

1. **纯 Interface 轨迹测试**：内存 adapter与branch adapter提供相同输入，验证 task/turn/profile 分离、字段不确定性、窗口、预算和有界 JSON；性质测试覆盖不新增权限、不消费旧协议、retry恒定等不变量。
2. **Jev adapter离线测试**：每字段缺失、exact label set、0.99/1.00/1.01、容差两侧、NaN/Infinity、选中非最大项、confidence边界；invalid不同于low-confidence；usage即使拒绝仍记录。
3. **资源与建议测试**：用户甲/乙不同目录、空目录、显式-only、重复名、不可读路径、forced prompt、后置资源改写、12项裁剪、目录版本变化、注入转义与恶意 description；无扫描／自动read／安装。
4. **真实 SDK＋mock provider**：初始/steer/followUp/continuation/retry顺序；同次引导抵达provider、无新回合、system/工具声明保留、工具配对、模型手选 gap、run结束不催促；补齐本次 seam探针未覆盖项。
5. **事件竞态与恢复**：观察／交接期间 steering、cancel、branch/reload、auth变化、pending message、append失败；新用户优先，无过期 guide/acceptance。compaction保留状态但无法定位源时不猜测消费。
6. **模式回归**：现有全部离线测试在task/legacy下保持；observer中旧guard/reminder/complete无效且外部权限仍可阻断；冲突只运行legacy owner；不修改个人settings。
7. **有界真实验证（另需当时许可）**：临时配置、人工核对多轮非敏感fixtures、明确最大calls/attempts与deadline，不调用chat第二判断层。分别报告推荐召回/采纳与能力路由结果、invalid概率比例、延迟和实际报告usage；不将小样本推广为准确率或费用结论。

计划使用现有 `npm run typecheck`、`npm test` 和 `git diff --check`；真实脚本须独立显式opt-in，默认测试不联网。

### 11.2 覆盖映射

| 需求 | 设计位置 | 验收 |
|---|---|---|
| R1 | §2–4、§8 | A1、A15、A20 |
| R2 | §4、§6 | A3–A6 |
| R3 | §5 | A2、A12、A13、A17 |
| R4 | §2.3、§5.3、§10 | A13–A15、A19 |
| R5 | §6–7 | A1、A7、A9、A10 |
| R6 | §4.3、§6.2、§8 | A11、A15 |
| R7 | §2.3、§4.1、§7、§8 | A5、A9、A15–A17、A19 |
| R8 | §1、§7.2、§9.3 | A7、A8、A14、A18、A19 |
| R9 | §4.4、§8–10 | A12、A15–A17、A20 |
| R10 | §9.3、§11 | A1–A20＋全部既有兼容回归 |

### 11.3 设计评审结果与实施门禁

当前判断：需求与已批准设计方向 aligned；当前源码仍是 task/legacy实现，没有将其标成对已批准旧基线的 Implementation Drift。新 observer runtime尚不存在。任务已单独批准并进入实施；改写运行行为仍须遵守本设计的模式隔离与任务验收要求。

七维检查：单一 resolved mode owner；策略与Pi seam分离；新字段/工具/事件显式版本化；无第二LLM cascade；依赖指向纯契约；旧控制按mode退休而非漏留；不增加通用方法阶段机、审批机或全局权限系统。是否达到复杂度净减要求需在实施diff评审时重新检查，不能用设计承诺代替证据。

设计与任务均已批准，按任务依赖安排实现。实施风险的先后顺序：

1. 正式 SDK 接线/竞态/恢复契约测试，确认资源可见性与guide定位规则。
2. 新 schema＋strict概率校验＋动作级策略离线轨迹；核对审批/授权描述没有越权。
3. 模式解析和legacy隔离迁移，再接入建议与能力交接。
4. 经许可的真实Jev Skill匹配和多轮换档验证；未达到证据条件保持opt-in。

尚未证实：服务概率舍入契约、大目录召回、任意Skill方法gate观测、真实多轮组合质量、provider/cache收益及所有后置扩展兼容性。严格parser、覆盖降级和外部authority原则使这些未知不被伪装为已验证功能。
