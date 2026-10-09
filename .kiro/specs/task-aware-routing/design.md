# 任务感知路由设计

状态：设计及后续任务已获用户批准，已进入实现验证。目标算法保持本设计；实现证据及尚未联网校准的限制见 [实现验证](../../../docs/task-aware-routing-verification.md)。

## 1. 决策与复用

采用“任务连续性＋有限继承＋滚动最大值降档保护”。继续使用 Jev、现有三档物理模型、五段能力映射和 Pi virtual-model 分支状态，不引入 Python 服务、embedding、数据库、XState 或 ADWIN。

算法来源、适配理由与限制见 [调研记录](../../../docs/task-aware-routing-research.md)。职责划分借鉴 vLLM 会话感知保护，稳定降档借鉴 Kubernetes HPA；不是直接复制两者源码，也不移植其未经本项目校准的收益/代价参数。

第一版保持用户回合级调整：工具结果可产生重评信号，但不触发同轮模型切换。当前任务仅保留一个；插入独立问题后再回到旧任务，需要结合历史重新评估，不实现多任务栈。

### 改动影响

- 从“每条新用户消息评估”变为“每个需要判决的新用户回合评估”，仍保证一次路由判决尝试后同轮复用。
- 新增 taskId、有限状态、决策来源与观测 marker，旧 session 不需迁移文件或重开。
- 输入有界但比原先 256 字符/条的历史更充足；单次分类 token 和多问题耗时可能增加。
- 保守保持高档可能增加物理模型费用；不以 Jev 次数下降保证总成本下降。
- 默认关闭跨轮继承的方法是 `maxInheritedTurns: 0`；这不关闭窗口保护。`enabled:false` 保留原本整体绕过行为。

## 2. 模块接口与职责

```text
index.ts：Pi route / 生命周期 / 物理可用性 / footer
  ├─ task-routing.ts：任务决策模块
  │    └─ 注入 judge.ts：一次 Jev 请求（真实 adapter / 测试 adapter）
  ├─ observation.ts：只读执行观测与分支 marker
  └─ gears.ts、settings.ts：现有分数映射与配置
```

任务决策模块是一个小接口、深实现的 module：调用方不需要自行拼装窗口、确认计数或平均值。Jev 是外部依赖，真实与测试 adapter 跨同一个 seam。内部纯迁移不执行 I/O。

```ts
type BranchFacts = {
  coverage: "known" | "unknown";
  nextCursor?: string;
  verificationFailed: boolean;
  completionHint: boolean;
  manualModelGap: boolean;
  contextMissing: boolean;
};

type TaskDecisionInput = {
  turnId?: string;
  messages: readonly Message[];   // 当前路由实际收到的会话
  previous?: GearState;
  settings: GearSettings;         // 有效策略与偏置，来自配置 adapter
  policyFingerprint: string;
  facts: BranchFacts;
  savedDispatchUsable: boolean;
};

type TaskDecision = {
  task?: TaskState;
  requestedBand?: Band;
  retainSavedDispatch: boolean;
  judgment?: GearJudgment;       // 本轮有效分数；关系及调用信息保留在 trace
  trace: DecisionTrace;
};

async function decideTask(
  input: TaskDecisionInput,
  judge: (context: JudgeInput, signal?: AbortSignal, trigger?: string) => Promise<JudgeOutcome>,
  signal?: AbortSignal,
): Promise<TaskDecision>;
```

结果包含候选 task 状态、请求 band、`retainSavedDispatch`、当前判决和诊断。模块不写 session、不选 provider、不画 UI。`index.ts` 解析物理派发、最后检查取消，再返回新 state；只有返回的状态由 Pi 提交。旧对象永不原地修改。

`direct`、禁用、同轮去重、工具跟进和 retry 在入口处理，不调用任务模块。没有历史的孤立 continuation 仍按现有规则评估一次，但不把它计为继承用户回合。

## 3. 配置与固定版本

在现有设置中增加可选 `taskRouting`，旧文件省略时自动使用默认值，不写个人文件：

```json
{
  "taskRouting": {
    "maxInheritedTurns": 3,
    "downgradeWindow": 2,
    "downgradeMargin": 0.08,
    "minConfidence": 0.8
  }
}
```

| 参数 | 合法范围 | 默认 | 意义 |
|---|---|---|---|
| maxInheritedTurns | 整数 0..10 | 3 | 连续继承用户回合上限 |
| downgradeWindow | 整数 2..8 | 2 | 需要的近期可信、不同观测样本数 |
| downgradeMargin | 有限数 0..0.15 | 0.08 | 降档边界裕量 |
| minConfidence | 有限数 0.5..1 | 0.8 | 关系确认及降低能力样本门槛 |

无效字段逐项退默认；不从文件加载任意正则或脚本。沿用深拷贝和元数据缓存。阈值是待校准的工程参数，不把 confidence 当成准确率。

`policyFingerprint` 是规范 JSON 的 SHA-256：enabled、gearBias、三个目标、judgeTimeoutMs、四个 taskRouting 参数、分类模型 ID、算法/提示/预算版本。文件格式或 mtime 单独变化不作语义配置变化。物理目录能力改变不在此指纹里，由每次 model lookup 和 clamp 处理。

每轮按当前配置和目录校验 saved dispatch；若恢复后的 clamp 结果不再等于保存等级，下一新用户回合不得免评估。同轮则由 Pi 实际请求的受支持等级约束，不承诺目录变动后仍能执行已消失的等级。

## 4. 持久状态与兼容

外层保留现有 `GearState` 字段和含义，并增加可选版本状态：

```ts
type Band = 0 | 1 | 2 | 3 | 4;
type Sample = {
  turnId: string;
  evidenceKey: string;
  rawScore: number;
  confidence: number;
};

type TaskState = {
  version: 1;
  taskId: string;
  anchor: string;
  userChanges: string[];
  continuity: "confirmed" | "uncertain";
  committedBand: Band;
  committedRawScore: number;
  biasAtCommit: number;
  samples: Sample[];
  seenEvidenceKeys: string[];
  lastJudgment: Sample;
  inheritedTurns: number;
  review?: { evidenceKey: string; expedited: boolean };
  requireRejudge: boolean;
  policyFingerprint: string;
  observationCursor?: string;
};

type DecisionTrace = {
  source: "judged" | "inherited" | "fallback";
  trigger: string;
  relation?: "same_task" | "new_task" | "uncertain";
  relationConfidence?: number;
  relationProbability?: number;
  usageReported?: boolean;
  action: "new-task" | "upgrade" | "hold" | "downgrade" | "uncertain" | "inherit" | "fallback" | "config-remap";
  classifierAttempted: boolean;
  scoreTurnId?: string;
  requestedBand?: Band;
  windowMaxRaw?: number;
  protectedScore?: number;
  provisionalBand?: Band;
};
```

新增外层 `task?`、`decision?`，不改变现有 provider/modelId/customType。`gear` 仍记录最终实际 gear；`decision.requestedBand` 才是请求能力。

- 新判决：`score` 是本次真实分数，`adjustedScore=A(score)`，不能因 hold 改成旧高分。
- 继承：保留最近有效原分数及来源 turnId，本轮 inputTokens 为 0，source=inherited；lastJudgment 不新增样本。
- 失败：本轮 score/adjustedScore=-1、confidence=0、source=fallback，task 中可保留旧基线作为背景，但禁止继承。
- 降档裕量分数只在 `protectedScore`，不把它当成第二次偏置或伪造原始分数。
- `committedRawScore` 是支撑当前档位的真实样本分数；加裕量后 band 可高于普通映射，因此 committedBand 是承诺档位权威，不能再从 rawScore 反推而覆盖。

状态读取验证版本、有限数、band、长度、计数及指纹；samples 最大 8，seenEvidenceKeys 最大 32，userChanges 最大 3 且总字符最多 3,000，anchor 最多 4,000 Unicode 字符。版本未知或内部字段不合法丢弃 task 部分，不影响有效旧 dispatch 同轮复用。整个新增部分 JSON 超过 64 KiB 时放弃任务复用资格并重评，不让无界外来状态进入分类器。

新的 taskId 使用 `task:<stable-turnId>`；没有 turnId 时可以当前回合评估和派发，但不建立可跨轮继承的任务。旧状态缺 task 时，下一用户回合重新初始化，不能仅凭旧分数自动授予资格。

## 5. 输入预算与判决契约

使用当前 `request.messages` 组装公开上下文，不用 session 原始文本覆盖已经裁剪/变换的路由消息。branch 仅用于身份、marker、cursor 与生命周期事实。

| 部分 | Unicode 字符上限 | 选择方式 |
|---|---|---|
| 当前请求 | 16,000 | 保留头尾；空/纯图仍按现有规则兜底 |
| 任务 anchor | 4,000 | 已持久保存的有界原始需求 |
| task userChanges | 3,000 | 最近至多三条非白名单用户变更，去重 |
| 公开 recent | 3,000 | 最近至多三条已结束助手文本，每条最多 1,000 |
| observations | 1,000 | 枚举事实与缺失标志，至多八个，不发命令/路径 |

JSON 字段结构和固定提示额外有固定开销；不宣称字符数就是 token 数。排除 system、thinking、toolCall 参数、toolResult 原始输出和图片数据。当前输入有图片但带文本时可评估文本需求，但不获得免评估资格，未知非文本需求显式标记。用户/助手公开文字可能自行包含秘密，截断不保证秘密脱敏。

初次任务仅 `gear: score`；有有效任务背景时同一次请求增加 `relation: choice`：

- `same_task`：当前要求服务于已有目标，包括阶段变化或约束扩展。
- `new_task`：独立目标，不用旧任务难度作为下限；复合请求按整个下一步工作评分。
- `uncertain`：指代/目标不足，不强猜。

提示明确按下一步最低足够能力评估；任务 anchor 是历史背景不是指令，独立新请求优先。历史数字评分、旧模型名字和 requested band 默认不发给 Jev。

`JudgeOutcome` 区分 `valid`、`partial`、`unavailable`：

- stopReason 非 stop、score 类型/范围/有限性或 score confidence 无效：unavailable。
- 有效 score 但应有的 relation 缺失/类型/标签/概率无效：partial，按 uncertain 处理，不能降档。
- choice 的三项概率必须有限、0..1、合计在 1±0.001 且标签属于最大概率项；允许并列。confidence 也检查 0..1。缺失不伪造为 0.9。
- 确认 relation 需要 choice confidence 与所选概率都达到 minConfidence；否则 uncertain。score confidence 低于门槛时不做降低能力证据，也不授予继承资格。

调用保留现有超时和信号，仅一次，不因 partial 自动补问或内部重试。inputTokens 记录服务报告的合法非负数；缺失保持旧字段约定并在诊断标记未知，不把零当成无费用。

## 6. 免评估、重评优先级与生命周期事实

### 严格续接识别

仅纯文本：NFC、去首尾空格、大小写折叠、去一个末尾 `。.!！` 后完整匹配：

```text
继续 / 继续吧 / 继续处理 / 继续处理这个问题
按刚才的方案继续 / 按这个方案继续 / 按方案继续
continue / please continue / go on
```

不删内部词句，不允许逗号后附加要求，不把任何短句视作续接。“好的”“谢谢”“嗯”“完成”“continue and ...”不匹配。识别算法版本纳入指纹。

### 重评原因优先级

无有效任务/身份 → 配置改变 → 分类/派发失败历史 → 模型或等级变化 → 未处理 marker/上下文缺失 → 新结项提示 → 关系/评分不可信 → 新实质性请求 → 降档复核 → 复用额度到期。

同一回合可记录多个 reason，主 reason 取上述优先级。只有所有禁止条件都不存在、saved dispatch 仍可用时允许 inherit。继承计数只在返回新状态时加一；任何实际重评将计数重置为零，包括 partial/failure，但这些失败不会取得继承资格。

### 结项提示

只看上次 cursor 之后、当前用户之前的新公开文本，完整行匹配有限词表：`任务已完成`、`全部完成`、`已完成`、`task complete`、`all done`，允许一个结束标点；或上个用户完整表达 `这个任务结束`、`不用继续了`、`结束这个任务`、`stop this task`。

这是保守重评提示，不是成功证明。它只消费一次，同一旧回复不得每轮重触发。句子中“尚未完成”、代码段里的文字不匹配；初版不解析任意完成叙述。连续性确认可在下一实际判决恢复。

branch cursor 使用最后已检查 entry ID；ID 不在当前分支时上下文记未知，重评而不是扫描其他分支。压缩本身不更换 taskId，anchor 仍在状态内；缺少足够公开文本时不得凭摘要任意补造执行证据。

手动切物理模型后的工作视为 continuity gap。扫描 cursor 后 model_change，若出现非 gears/auto，下一用户回合重评并清空降低能力窗口，即使后来又切回 auto；单独手工 `/thinking` 不改变自动规则。

## 7. 观测内容去重

`evidenceKey` 对有界的实际分类内容做 SHA-256，包含当前任务作用域、上下文版本、anchor、当前规范请求、最近实质性用户变更、公开 recent、结构性观察。当前白名单续接规范成固定 `CONTINUE`；非白名单请求保留实际有界内容，不能漏掉本次新增要求。

计算 key 在调用前完成；userChanges 只在可信 same_task 后提交当前实质性请求，new_task 改建 anchor，uncertain 不把新要求登记成确认的旧任务变更。判决样本保存本次真实输入对应 key，不在返回后用已修改状态重算冒充原输入。新任务按新作用域清空 key 历史；首次后的上下文变化只代表观测不同，不是完成证明。

排除 turnId、时间戳、计数、entry ID、原数字分数、当前模型和周期原因；否则“多过了一轮”会制造新证据。结构事件内容以枚举类别和状态表示，不以随机 ID 增加内容差异。

维护最近 32 个 seenEvidenceKeys（自最近一次可信任务建立/不确定重置后）；在 seen 列表或样本窗口中重复的 key 不追加新样本。上下文内容不同只是可区分观察，不承诺语义进展或统计独立。32 条之外的历史不能保证无限期去重，记录这个有界限制。

同 key 得到更高 score 时，替换该 key 在窗口中的 score 为 max，允许立即升级，不推进样本计数；得到更低 score 不替换旧样本，不推进降档。latest judgment 仍记录真实返回值，不隐藏波动。

公开输出发生变化可能形成新 key，但不直接证明完成或允许降低；仍需可信 relation、score、满窗口和裕量。缺失观测或截断边界变化不自动算作可靠新内容：上下文版本/覆盖未知时先重建资格。

## 8. 核心更新公式与迁移顺序

令 `A(s)=clamp(s+0.4×gearBias,0,2)`，`B(s)` 为现有五段映射，越大代表越高能力。所有窗口样本保存原始 Jev 分数，bias 不写回样本。

### 判决迁移表

| 输入结果 | 请求能力 | 任务状态 |
|---|---|---|
| 无可用 task + 有效 score | B(A(J)) | 新 task；可信评分才允许继承/样本 |
| 可信 new_task | B(A(J)) | 新 taskId、清空旧窗口与变更，即使比分数低也直接执行 |
| same_task + 当前更高 band | B(A(J)) | 立即升级；可信时新窗口 [J]，否则清空并待重评 |
| same_task + 可信同/低 band | 稳定窗口处理 | 保存真实观测，按下述保护降低 |
| 关系 uncertain/partial | max(旧 committedBand, B(A(J))) | 原任务基线不改为临时新任务，窗口清空；provisionalBand 仅本轮 |
| same_task + 低 score confidence 且未升级 | 旧 committedBand | 不降低、清空窗口、下一用户重评 |
| unavailable | 现有实际派发兜底 | score=-1；窗口清空、禁止继承、下一用户重评 |

可信新任务但评分低置信度时可按它独立选模型，但不继承/降档；不能因此把旧 task 难度再次混进已确认新目标。初次任务有效 score 也不凭模型自述额外强制 heavy。

配置改变与手工模型 gap 都保留 anchor、清空窗口并重评，但不作为低分立即降档的旁路。same_task 继续按新可信窗口降低；new_task 才直接重置。relation 不可信时保留旧承诺档位作本轮保守派发并继续重评。

偏置改变需要另行处理：状态另外保存 `biasAtCommit`。如果 committedBand 与旧 `B(committedRawScore + 0.4×biasAtCommit)` 一致，则以同一真实基线按新 bias 映射重建承诺档位；如果旧档位因裕量保护高于该映射，保持旧档位等待新窗口，不将裕量误当真实分数。新基线不新增 Jev 样本。用户配置导致的直接重映射显式记 config-remap，不冒充任务被证实变简单。目标模型/窗口参数改变没有这种分数旁路。

执行 gap、上下文/marker 未知也不直接降档；清空样本后先建立新的可信窗口。

### 同任务可信样本处理

清空窗口事件同时清 seenEvidenceKeys 与 review，开始新的可信观测时期，但保留 lastJudgment 的来源用于显示；lastJudgment 不自动成为新时期样本。不确定时期过去后仍需要至少 W 个不同上下文的可信判决才能下降。

1. 执行未知、可信验证失败或连续性 gap 先清空降档样本，不重置 taskId。
2. 若当前建议高于旧 committedBand，立即升级并重建窗口，不等 W。
3. 否则按 key 更新/追加，裁剪到最近 W 个可信、不同 key。
4. 满窗口后：

```text
M = max(samples.rawScore)
protected = clamp(A(M) + downgradeMargin, 0, 2)
candidate = B(protected)
nextBand = min(oldCommittedBand, candidate)
```

不足窗口时 nextBand=oldCommittedBand。`min` 防止裕量本身制造升级；真正升级只由本次有效需求驱动。降低时 committedRawScore 取窗口最大样本，保留来源；拒绝降低也保留样本，不把旧 high band 写成新分数。

候选可跨多段下降，所有目标边界都加裕量。例如两次 0.99 的 protected=1.07，最多降到 standard/high，不越过 1.0 边界进入 medium。没有额外“每轮只降一档”参数。

### 提前复核与无新证据退避

最新可信 `B(clamp(A(J)+δ)) < nextBand` 时设置 `review={evidenceKey,expedited:true}`，下一用户回合重评一次。

- 复核内容为新 key：更新窗口，若仍需支持则为新 key 设置 expedited。
- 复核是相同/已见 key 的低分：不推进窗口；改成 expedited=false，保持高档，允许下一合法续接按三轮额度复用。
- 后续出现新观测 key：已有 review 再激活复核；实质性用户请求本来就重评。
- 周期重评即使无新 key 也可执行，但不能增加降档样本。
- 高分、成功降到最新受保护建议、不确定/失败/新任务：按对应规则移除或重建 review。

这避免 pending 状态在证据不变时把每个“继续”都变成 Jev 调用，也不靠重复询问凑两次确认。窗口不会按时间、工具次数或继承次数自动衰减。

## 9. 执行观测 adapter

第一版只支持真实 Pi `bash` 工具的明确验证失败，不解析任意工具或 MCP 输出。使用 tool_result 的 input 和 structuredContent，不依赖 details.exitCode；父 codemode 成功不等于子命令成功。

验证命令严格识别：按 ASCII 空格分词，接受 `npm test`、`npm run <script>`、`pnpm [run] <script>`、`yarn [run] <script>`，script 仅为 `test|lint|typecheck|check|build|compile|validate|verify`；另外接受 `npx tsc --noEmit`。尾部 token 仅允许 `[A-Za-z0-9_./:=,+-]+`，不得把第二个执行器 token 当参数；这是命令识别启发式，不是 shell 解释器或测试正确性证明。

拒绝 tab/换行、引号、重定向、单独管道、分号、变量替换、反引号、括号、后台符及未允许字符；先按纯 `&&` 分割，必须每一段均为上述验证形式且非空才识别。链中有 `git status`、`cd` 或其他未知段就记未知，不能推断失败来自测试。只增加 `verify-command-v1` 固定解析规则，复杂 shell 不为提高覆盖率而猜测。

structuredContent 必须是对象、exit_code 为有限整数：非零与 isError 一致时记 verification-failed；零但 isError=true 或字段缺失则未知，不读输出猜退出码。超时/取消/执行异常没有明确 exit_code 时不称为测试失败。识别参数仅本地使用，不保存命令全文。

执行事件绑定当时最新虚拟状态的 taskId、turnId，且 `ctx.model` 的当前选择必须是 gears/auto（实际 dispatch 是物理模型，不属于 gears）。嵌套 ID 独立识别并按 turnId 聚合；在 handler 中同步检查 branch 是否已有 marker 后 append，避免并行工具重复写。

```text
customType: pi-gear-router.observation
{ version:1, taskId, turnId, kind:"verification-failed" }
```

每个用户回合最多一个失败 marker，append 前复查有效活动状态与取消。marker 不是判决，不改 score，不请求自动继续，也不改工具结果。没有持久原始命令、路径、输出、连接串或秘密。

新用户 route 消费当前 taskId 且 cursor 之后的 marker，清空降低能力窗口后重评；新任务不接收旧任务 marker。已实际发生且已存的事件不因之后用户取消而删除；评估取消不会消费 cursor，所以下一次仍可看到。观测写入失败只禁用该观测、保守重评，不阻断工具执行。

SDK 没有事件/append 能力时 facts 标记 coverage=unknown，只保留路由消息公开文本，不假装采集完整；不能建立与 TUI 相同的可靠执行监测承诺。

## 10. 派发、故障与提交

任务结果决定的是请求 band：通过已有 gearTarget/resolveGear 查物理模型并裁剪 thinking。

- inherit/hold 且旧 dispatch 可用、指纹一致、不是 degraded/provisional 派发且对应当前请求 band：保持实际 pair；升级/降级/new-task/config-remap 解析新 band。若上一轮 uncertain 临时使用更高 pair，本轮恢复确认后不能把临时高档当永久 committed dispatch。
- uncertain 用临时 provisionalBand 派发，不写成原任务 committedBand，下一回合可解除临时高档。
- 目标消失或无 auth：沿用现有配置候选顺序，记录实际 gear 与 target-unavailable，task 需求不降低，但继承资格失效。
- 同轮目标突然消失时沿用原有替换机制，不重调 Jev；替换尽量使用已请求等级，不恢复为当前手工 `/thinking`。
- 所有目标不可用：保留现有 actionable error，不伪造成功状态。
- 禁用保存 disabled 状态且不带可继承 task；恢复时重新评估。
- 取消：调用前、分类后、物理解析后检查 signal；不写新的 state 或自增，恢复旧 footer。Pi 返回 route 后的取消可能发生在 Pi 已提交状态之后，不能承诺撤回框架已完成的提交。

route 状态提交由 Pi 管理；任务模块不另行 append virtual-model-state，避免双写。观测 marker 使用另一 customType，不能把 marker 冒充最新路由判决。

## 11. 生命周期与显示

- session_start/session_tree 从当前 branch 最新匹配 provider=gears、modelId=auto 的 virtual state 恢复 footer。
- session_shutdown 清 footer 和临时 adapter 状态；不清持久 task。
- 每次新用户 route 用 request.state，不用全局 latest task；临时缓存只可按 sessionId/turnId 识别，不能跨分支作为权威。
- 压缩后 task anchor 和 cursor 仍在 branch；缺失 cursor 就保守重评；不得以 messages.length 推断用户轮次。
- 不支持从“当前分支没有任务状态”扫描全 session 其他分支找替代。

显示示例：

```text
Jev 1.92 → heavy/xhigh → …
沿用 Jev 1.92 · 续接 2/3 → heavy/xhigh → …
Jev 重评中…（周期）
Jev 1.70 · 降档保护 → heavy/xhigh → …
Jev 0.90 · 关系不明 → heavy/xhigh → …
Jev 不可用 · fallback → …
```

仍只用 setStatus，不增加完整推理展示。主题渲染时应用，不把 ANSI 写到状态里；非 TUI 不调用 UI。

## 12. 测试与需求追溯

| 范围 | 验收/要求 | 测试方式 |
|---|---|---|
| 续接与有限复用 | A1–A3、A11、R2/R3 | 注入计数 classifier，检查真实调用数、pair、计数 |
| 新任务与能力变更 | A4–A7、R1/R5 | task trajectories、五边界及 bias 的性质测试 |
| 结项和执行信号 | A8/A9、R3/R4 | 真实形状事件、嵌套结果、未知退出码、重复 marker |
| 失败与取消 | A10/A15、R6 | partial/invalid/timeout/Abort，冻结输入验证不变性 |
| 去重与退避 | A16/A17、R5 | 相同 key、等价 continue、seen key 回访、不增长窗口 |
| 会话与配置 | A12/A13、R6 | 实际 SessionManager、压缩/tree/fork/reload、配置指纹 |
| 非文本与诊断 | A14、R4/R7 | image+text、纯图、footer、非 TUI |

性质：新任务不携带旧窗口；当前有效升级不被保护抑制；同任务因观测降档不低于 `B(A(M)+δ)`；继承没有新样本；duplicate route 无额外状态写；未取消提交均为可序列化有界值；物理降级不改 committedBand。

边界数值测试使用十进制阈值附近的精确表示/误差容限，按现有左闭右开映射，不增加私自四舍五入。测试必须分别检查 band 和物理 clamp 后等级。

联网验证只在人工批准后使用临时配置、限时限量任务；先修复 live-smoke 对 pi.on 的转发。验证复杂任务＋续接＋新任务＋同任务阶段变化，报告调用、决策、实际派发与缺失费用。人工标注任务关系/最低能力，用相同轨迹比较逐轮路由、固定任务、EWMA 和窗口，不用旧联网结果证明新算法。

## 13. 设计审核结论范围

本设计已明确公式、样本准入、反复调用退避、接口、预算、配置范围、marker、兼容和提交规则。用户已批准设计并授权后续阶段按顺序完成，无需再次询问。

实现接口的小幅整合：`TaskDecisionInput.settings` 包含有效策略与偏置，返回有效 `GearJudgment`，关系诊断仍在 trace；注入分类器额外接收可选 trigger，只用于 pending footer，不加入分类内容或 evidenceKey。观测写入失败用 SessionManager 身份的 WeakSet 标记未知覆盖，不把缓存用作任务权威。这些不改变业务判决规则。

离线测试不能证明真实 Jev 关系准确率、输出质量或费用收益。运行服务联网验证仍需单独批准及限量执行；不通过放宽证据或跳过取消检查来让测试通过。
