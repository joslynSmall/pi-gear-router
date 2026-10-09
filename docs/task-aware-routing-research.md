# 任务难度维护：可复用方案调研与算法细化

本文保留设计前对路由项目、控制算法和本仓库接口的调研及数值实验，不把这些历史结果作为运行实现证据。窗口方案随后已获批准并实现；正式细节以 [设计规格](../.kiro/specs/task-aware-routing/design.md) 为准，离线证据见 [实现验证](task-aware-routing-verification.md)。未联网证明真实任务质量或收益，不修改个人 Pi 配置，也不新增运行依赖。

## 结论

推荐继续复用 Jev 做语义评估，复用 Pi 的分支状态和同轮派发机制，在外面增加一个小型任务决策模块：

> 任务连续性门控 → 有限续接复用 → 事件/周期重评 → 快速升级、稳定降级。

稳定降级优先采用 **Kubernetes HPA 的滚动最大值稳定窗口思想**，而不是同时叠加指数加权平均、连续降档计数和复杂切换代价模型。

第一版建议：最近两次可信、同任务的有效判决构成窗口；升级立即响应本次判决；降档使用窗口最大值，并保留目标区间的安全裕量。明确续接没有新判决，不更新这个窗口。

这是对先前 `α=0.7` 暂定方案的简化；用户已确认这个方向，需求参数已更新。没有找到可以不加适配就完整解决本项目需求的现成 TypeScript 包；这不等于证明所有项目都没有类似实现。

## 一、核查过的现有方案

### 1. pi-gearshift：复用评分目标，不解决跨轮任务状态

核查版本：`25fdd5cdb8e9949ec29f8d1966316501b06b0efb`。

源码在 `before_agent_start` 里逐轮调用 Jev，随后使用 `score + gearBias × 0.4` 选择三档。最近上下文最多十条，排除工具与 thinking，没有当前任务难度状态、续接免评估或降档稳定窗口。[S1]

可复用：最低足够能力的评分目标、三档模型配置、偏置方式。本仓库已借鉴这些内容，继续沿用即可，不需要再接一套 TypeSafe SDK 或另一个同时切模型的扩展。

### 2. vLLM Semantic Router：最接近的会话感知保护层

核查版本：`c4f8be25f745523eda12b8ef7bab17a9573d1fd6`。

版本化 `session_aware` 文档和 `SessionAwareSelector.Select()` 源码都把基础选择与连续性保护分开。源码检查工具循环和不可迁移上下文的硬锁，再评估任务方向变化、空闲、缓存与切换成本。[S2][S3]

当前 Router Learning 的 Protection 也区分基础判决、提议模型和最终模型；Progress Gate 使用有身份的有限证据窗口，区分缺失证据、基础设施失败和质量反馈，并支持观察模式。[S4]

可复用机制：

- 基础难度评估与切换保护分别负责一件事。
- 工具循环不随意切模型。
- 新任务/方向变化解除历史连续性约束。
- 保留判决来源、候选与实际派发，便于回放。
- 缺失证据不是成功，传输层输出不是质量证明。

不直接接入：项目使用 Go 路由服务和独立配置/经验存储；完整选择器还需要模型质量差、缓存价格、剩余轮次等数据。本项目没有经过校准的对应数据，不能把 Jev 的 `0..2` 分数当作效用/美元收益来套用它的切换代价公式。[S3][S4]

注意：源码先运行基础选择，再执行保护，不能据此宣称它自动实现了本项目的“连续三轮不调用 Jev”。这里复用的是职责划分，不是整个流程的等价替换。

### 3. RouteLLM：能力路由和离线校准可参考，但不解决“继续”

核查版本：`0b64fdafe049e596a3f5657c219329f24af24198`。

`Controller._get_routed_model_for_completion()` 明确使用 `messages[-1]["content"]`，注释说明当前路由训练使用首轮数据，多轮路由仍需研究。项目主要预测强/弱两个模型之间的偏好胜率，并提供阈值校准和评估。[S5]

可复用：用真实请求轨迹校准路由阈值、比较质量与成本，而不是只观察高档调用比例。

不直接接入：它不会维护本项目的任务身份，也不直接覆盖三个模型档位与五个 thinking 组合；Python、训练权重和部分路由的 embedding 依赖不能替代当前 Jev 接口。论文或 README 的节省比例不是本项目的节省保证。

### 4. Aurelio Semantic Router：语义意图匹配，不等于任务难度维护

核查了官方 README 和稳定 `v0` 树；其核心把请求编码为向量并匹配配置的路由话语。官方 README 还区分稳定 0.x 与开发中的 1.x。[S6]

可复用：以后若有充足任务样本，可以评估本地语义续接判定。

不直接接入：单独编码“继续”缺少指代对象；主题相似也不意味着能力需求不变。引入编码器和路由样本，并不能免掉任务状态及作用域判断。

### 5. EWMA：先前加权公式就是成熟算法，不是新算法

NIST 给出的指数加权移动平均为：[S7]

```text
E_t = α × J_t + (1 − α) × E_(t−1)
```

公式可以直接复用，但它本身不知道任务身份、不能产生尚未观测的分数，也不能减少分类器调用。高分突变可能被历史低分拖慢；要避免错误升级延迟，还得添加非对称控制。

第一版不建议让 EWMA 再叠加窗口和确认计数。`α=0.7` 不是 NIST 为 LLM 路由推荐的值，也没有本项目校准依据。

### 6. Kubernetes HPA：直接借鉴“升得快、降得稳”

官方文档解释降容使用稳定窗口内的最高建议值，并说明默认升级没有稳定等待窗口。源码 `stabilizeRecommendationWithBehaviors()` 确实分别处理升降方向，并用 `max` 计算降级稳定建议。[S8]

可复用：升级看最新需求，降低资源时保留一段历史高需求，避免反复撤掉再补回。

适配差异：HPA 使用时间窗口和持续指标，本项目使用**有效判决样本窗口**。用户回合稀疏且数量少，不能原样照搬五分钟参数；工具次数也不能充当需求观测次数。

这是一种控制策略借鉴，不是说 LLM 难度和 CPU 指标拥有相同统计性质。

### 7. ADWIN 和 XState：暂不作为运行依赖

River 的 ADWIN 比较两个子窗口的均值变化，带有显著性、最小窗口和预热设置。它适合持续数据流，不会理解“继续”的指代，也不能在没有新的复杂度观测时发现语义变化。少量、稀疏、相关的 Jev 判决不足以直接获得其统计保证。[S9]

XState 提供成熟的状态机、纯迁移和持久化快照机制，可以承载更复杂的状态图，但不提供任务难度估计。当前 Pi 已拥有 JSON 分支状态；少量确定性迁移可以用纯 reducer 实现，暂不再引入 actor 生命周期。[S10]

## 二、推荐算法

### 1. 两种计数必须分开

- 用户回合：用于控制最多连续复用多少次。
- 有效判决样本：用于稳定窗口，只在一次真实、可信 Jev 判决后更新。

“继续”被复用三轮，只增加复用计数，不制造三条相同判决。工具跟进、重试、同一用户回合重复路由，两种计数都不增加。

### 2. 最小状态

以下是待实现的设计形状，名称可在编码阶段调整：

```ts
interface TaskState {
  schemaVersion: 1;
  taskId: string;
  anchorRequest: string;         // 有界任务原始需求
  recentUserChanges: string[];   // 有界实质性需求变更
  committedBand: 0 | 1 | 2 | 3 | 4;
  committedScore: number;        // 支撑当前承诺档位的真实原始分数
  judgments: Array<{
    turnId: string;
    evidenceKey: string;         // 需求/公开进展/观测的内容指纹
    rawScore: number;
    confidence: number;
  }>;
  inheritedTurns: number;
  continuity: "confirmed" | "uncertain";
  pendingReassessment: boolean;
  reassessmentReason?: string;
  settingsFingerprint: string;
  observationCursor?: string;    // 分支 entry ID，不用 messages.length
}
```

外层保留现有 `turnId`、`dispatch` 和 fallback 信息；新增决策来源及当前判决/窗口/承诺档位诊断。估计的需求、承诺档位和实际 dispatch 三者分开，物理模型不可用或等级裁剪不降低需求估计。

`committedScore` 用于诊断和关系不明时的保守基线，不参与窗口平均。不得为了保持档位而伪造一个 Jev 分数。

### 3. 是否调用 Jev

先处理 `direct`、禁用、同轮重复和工具跟进/重试，保持当前安全规则。对于新的用户回合，仅在以下条件全部成立时免评估：

```text
已有有效、连续性确认的任务状态
且最近决策不是分类失败/目标降级/禁用的 fallback
且当前为严格匹配的纯文本明确续接
且没有新执行信号、降档待确认或未知上下文
且路由配置指纹未改变
且原物理模型仍可用
且 inheritedTurns < maxInheritedTurns
```

初始 `maxInheritedTurns=3`，第四个明确续接回合重评。设为零则关闭跨轮免评估，但仍保留同轮去重。

白名单不包括“好的”“嗯”“谢谢”，这些可能是确认、结束或普通应答。包含“继续”同时增加条件、带图片/其他非文本输入、用户主动纠正或无法确定指代的消息，一律进入重评。

免评估是保守优化，不是对任意短消息的理解能力。无法确认任务还在进行时，宁可评估。用户已明确结束任务或最近公开回复出现疑似结项信号时，可以保守地触发重评；助手的“完成了”只用于阻止盲目复用，不能作为任务确实成功或立即降档的证明。结项提示识别规则需在设计评审列出，不能承诺自动识别所有完成状态。

### 4. Jev 评估内容

无历史任务时只需需求评分；有历史时在一次 `classify()` 中包含两个问题：

- `relation`: `same_task` / `new_task` / `uncertain`。
- `gear`: 对下一步实际工作所需最低能力给 `0..2` 分数。

第一版不再额外依赖一个“阶段已完成”标签自动降档。同任务阶段变简单，由接下来的低需求判决通过窗口确认。

输入预算建议以 Unicode 字符计：当前请求最多 16,000；任务锚点最多 4,000；近期实质性用户变更与公开回复总共最多 6,000；结构化执行观测最多 1,000。每个预算独立上限，不能通过多条观测无限增长。

排除 thinking、图片 payload、原始工具输出和工具参数。新增加的执行观测不包含路径、命令全文、连接串或配置内容。用户/助手公开文本仍可能包含敏感内容，不能宣称通用文本截断等于秘密脱敏。

建议不把历史数字评分直接放入 Jev 输入，避免评分锚定；历史数字由本地保护算法使用。Jev 通过任务锚点、近期要求和公开执行信息理解续接。

标签、分数、置信度和返回 stopReason 必须验证。可信门槛可先用 `minConfidence=0.8` 作为实验初值，同时用于关系确认和降低能力的证据准入；不把 confidence 当成已校准的正确率。

### 5. 核心升降档公式

令 `B(s)` 为现有五区间映射，`g` 为 gearBias，`δ` 为降档裕量。所有历史窗口保存原始分数，偏置在决策时应用一次：

```text
A(s) = clamp(s + 0.4 × g, 0, 2)
本次建议档位 = B(A(J_t))
```

#### 新任务

关系可信地确认为新任务，或者没有可用任务历史：

```text
清空上一任务历史
committedBand = B(A(J_t))
建立新 taskId
窗口 = [J_t]（只有达到可信门槛才作为降档样本）
```

新任务不需要等待两次低分。一次可信的新任务判断足以解除旧任务的高档保持。

#### 同任务升级

```text
如果 B(A(J_t)) > committedBand：
    committedBand = B(A(J_t))
    committedScore = J_t
    窗口重新从 [J_t] 开始
```

升级不平均、不等待窗口填满。有效但低置信度的高分可以保守升级，但标记待重评，不能建立免评估资格或作为降档证据。

#### 同任务稳定与降级

只有任务关系和本次评分都达到可信门槛时，追加到最近 `W` 个样本；初始 `W=2`。同一用户回合只追加一次。同一需求/公开进展/结构化观测的内容指纹没有变化时，重复请求分类器也不增加降档证据；明确续接文本的等价表达及时间戳、计数等元数据不算实质性新证据。需要内容指纹而非仅凭 turnId 证明两次观察不同。

```text
M_t = max(最近 W 个可信、同任务的真实分数)
候选降档 = B(clamp(A(M_t) + δ, 0, 2))

如果窗口已满且候选降档 < committedBand：
    committedBand = 候选降档
    committedScore = 窗口内最大分数对应的真实分数
否则：
    保持 committedBand
```

初始 `δ=0.08`。加裕量只用于降低能力的保护，不是第二次 gearBias；不把它显示成 Jev 原始评分。

用 `B(A(M)+δ)` 而不是只比较当前区间的下边界，是为了在跨多个区间降档时也保护目标边界。例如两次 `0.99` 不从 heavy 直接跳到 medium，而先稳定在 standard/high；要进 medium，窗口最高调整后分数必须严格低于 `0.92`。

“降档待确认”的定义：最新可信建议的带裕量档位低于当前承诺档位，但窗口仍阻止下降。此时下一用户回合必须重评，不再免评估三轮。最新判决已经回到当前档位附近时，不无意义地继续追问分类器。

低置信度、关系不明、分类失败、配置版本改变都会清空降档窗口并要求重评，不能把跨越不确定时期的低分称为连续确认。任何新的高分会进入窗口或重新建立升级基线，打断降档进程。内容未变化的高分可以更新升级/保持基线，但不能因为重复低分而推进降档窗口。这种内容去重不是统计独立性保证；同任务的不同进展也可能高度相关。

保留最近真实判决，即使暂时不降档；不将 held dispatch 当作新样本写回窗口。

### 6. 关系不明与失败

- 关系不明：只对本轮保守选择 prior committedBand 与本次有效建议的较高者；不把本次分数混入已确认任务窗口，不把 provisional 任务登记为新任务。下一用户回合重评。
- 关系不明时的临时高档不是下一任务永久下限；下一次可信的新任务判断可以直接重置。持续无法判断会增加高档成本，这是保守策略的已知取舍。
- Jev 无效/不可用：沿用当前已存在的 fallback 规则，清空降低能力证据，下一用户回合重新尝试。不允许把失败状态作为“继续”的免评估依据。
- 用户取消：不提交新的计数、窗口或判决。
- 模型配置、偏置、窗口或上下文策略变更：下一新用户回合重评并重建窗口；同轮工具跟进仍保持实际物理派发。

## 三、执行观测如何接入

Pi 的 `tool_result` 事件提供 `structuredContent`、`isError`、`input` 和嵌套调用的 `parentToolCallId`；工具结果消息本身不保证持久保存完整 structuredContent。当前类型里 `nestedCalls` 只包含有界的调用名称、参数、状态和错误摘要，不包含结果。[S11]

因此不能沿用“只看 `details.exitCode === 0`”的采集方法，也不能把 codemode 的顶层成功视为所有子命令成功。

建议：

1. 在可用的工具结果事件中读取已支持工具的结构化状态，识别保守白名单中的验证命令；不解释任意工具输出。
2. 失败验证只生成 `verification-failed` 重评标记，不增加分数。
3. 持久化只存 `taskId`、`turnId`、`toolCallId`、类别和时间，排除命令全文、参数和结果。
4. 嵌套调用按自己的 ID 去重，不同时把父结果重复计为同一失败；每个用户回合最多保留一个聚合重评标记，控制分支增长。
5. 使用分支 custom entry 和 entry ID 游标恢复观测。只处理当前 taskId 的标记；旧任务或其他分支的失败不能触发当前任务升级。
6. 历史记录只含不完整 nestedCalls 或无法识别验证命令时，状态记为未知，不推断验证通过。重评上限是兜底，不保证检出所有任务语义变化。

第一版的颗粒度是**用户回合级自适应**：可以在执行中标记变化，下一用户路由重评；不是每个工具返回都换模型。长回合内即时升级仍是独立、未批准的能力。

## 四、数值推演结果

做了不访问 Jev、不导入路由器、不修改配置的公式级推演。以下连续分数假设来自不同、有效进展观测；内容去重和任务关系识别未在这个数值实验里实现。使用 `W=2`、`δ=0.08`、可信门槛 `0.8`、bias=0：

| 轨迹 | 承诺档位结果 |
|---|---|
| `1.92 → 1.70 → 1.68` | xhigh → xhigh → heavy/high |
| `1.92 → 1.79 → 1.78 → 1.81` | 一直 heavy/xhigh，不因边界小波动降档 |
| `0.70 → 1.92` | standard/medium → heavy/xhigh，立即升级 |
| `1.92 → 1.65 → 1.90 → 1.65 → 1.65` | 最后一次才降为 heavy/high，高分打断低分窗口 |
| `1.92 → 0.99 → 0.99` | xhigh → xhigh → standard/high，目标边界也有裕量 |
| 新任务 `0.15` | light/low，不继承旧任务高分 |

另核查：低置信度打断降档证据；三轮继承后第四轮重评；继承不增加样本。

对五种 bias 和 `0..2` 的 0.01 步长两点分数网格，共检查 202,005 组：结果在五档范围内；当前有效建议所需的升级不被历史抑制。

这些只验证公式的一部分性质，不验证 Jev 是否正确理解任务，不代表统计显著性、实际质量、真实成本或完整生命周期集成已经通过。两次判决往往相关，窗口不是“两次独立实验”的概率保证。

## 五、代码复用与改动面

| 保留/复用 | 原因 |
|---|---|
| `src/judge.ts` 的 Pi classify 调用 | 无需第二套 SDK；增加同调用关系问题和上下文预算即可 |
| `src/gears.ts` 五区间与 bias | 稳定窗口只决定承诺档位，不改变模型目录 |
| `src/index.ts` 同轮去重、真实 dispatch、fallback、取消 | 已有正确的安全基础，不另起一个全局切模型扩展 |
| Pi virtual-model JSON branch state | 已支持恢复、压缩和树导航，不再增加独立数据库 |
| `ctx.ui.setStatus()` | 继续追加状态，不替换原生 footer |

新增一个任务决策模块即可，建议接口为“输入旧状态与当前事实 → 返回 inherit 或 judge；输入判决 → 返回新状态与承诺档位”。语义调用作为注入依赖，纯状态迁移单独测试。无需引入 Python 服务、embedding、ADWIN 或 XState。

同任务 held/inherited 决策优先保留原实际派发；已降级的目标不建立免评估资格。物理可用性检查仍由现有选择逻辑负责。

状态栏需明确：`沿用`、`重评`、`降档保护`、`fallback`。例如原始判决 `1.70`、窗口最高分 `1.92`、最终 heavy/xhigh 可以同时成立，不能让 UI 误称本轮 Jev 给了 `1.92`。

## 六、与前一版需求草案的关系

调研阶段未修改审批状态；用户随后确认以下简化，已同步至 `.kiro/specs/task-aware-routing/requirements.md`。设计评审进一步核查具体迁移规则：

- 用窗口稳定代替强制 EWMA，不默认开放 `α`。
- 用 `W=2` 统一表示近期历史与两次低需求支持，不再维护另一套 `lowerConfirmations` 计数。
- 暂不实现“仅凭阶段标签立即降档”的旁路；新任务可以立即重置，同任务按窗口安全降低。
- 不引入没有价格/质量数据的缓存收益评分。以后若要按总费用优化，再复用 vLLM 的切换收益/代价框架并校准。

这些会影响 R5 的机制表述和拟定参数，但不改变核心验收目标：复杂任务续接保持深度、新任务不受污染、必要升级不延迟、降档可解释且不会无限锁死。

需求、设计、实现任务仍分别需要人审。本次是调研与候选细化，没有改路由运行代码。

## 七、落地前验证

- 回放真实任务轨迹，人工标注任务关系和下一阶段最低能力，而不是只标注最后一句话。
- 覆盖明确续接、增加要求、插入独立问题、长期不确定、完成后追问、重评失败、目标降级、配置变更、取消和分支恢复。
- 比较当前逐轮判决、固定任务档位、EWMA 与推荐窗口策略。
- 先满足误降档/任务质量要求，再比较调用量、主模型用量、切换次数、首 token 延迟与总费用；没有费用信息时明确记为未知。
- 在同一请求上反复调用 Jev 不是新的任务证据，不能用重复采样冒充阶段变化。
- 运行已有 typecheck 和单元测试；为新模块增加轨迹及性质测试。
- 真正联网验证前修正 `test/live-smoke.mjs` 扩展包装器对 `pi.on` 的转发。旧联网结果不能证明新策略有效。

## 来源

[S1] pi-gearshift 官方源码：[routing.ts](https://github.com/iharuya/pi-gearshift/blob/25fdd5cdb8e9949ec29f8d1966316501b06b0efb/src/routing.ts)，[README](https://github.com/iharuya/pi-gearshift/blob/25fdd5cdb8e9949ec29f8d1966316501b06b0efb/README.md)。

[S2] vLLM Semantic Router 官方版本化 [Session Aware 文档](https://github.com/vllm-project/semantic-router/blob/c4f8be25f745523eda12b8ef7bab17a9573d1fd6/website/versioned_docs/version-v0.3/tutorials/algorithm/selection/session-aware.md)。

[S3] vLLM Semantic Router 官方源码：[session_aware.go](https://github.com/vllm-project/semantic-router/blob/c4f8be25f745523eda12b8ef7bab17a9573d1fd6/src/semantic-router/pkg/selection/session_aware.go)，[session_aware_scoring.go](https://github.com/vllm-project/semantic-router/blob/c4f8be25f745523eda12b8ef7bab17a9573d1fd6/src/semantic-router/pkg/selection/session_aware_scoring.go)。

[S4] vLLM 官方 [Protection 文档](https://github.com/vllm-project/semantic-router/blob/c4f8be25f745523eda12b8ef7bab17a9573d1fd6/website/docs/tutorials/learning/protection.md)，[protection 源码](https://github.com/vllm-project/semantic-router/blob/c4f8be25f745523eda12b8ef7bab17a9573d1fd6/src/semantic-router/pkg/extproc/router_learning_protection.go)。该项目采用 Apache-2.0；直接移植源码需要遵循其许可证与归属要求，不能按本仓库 MIT 不加说明地复制。

[S5] RouteLLM 官方 [Controller 源码](https://github.com/lm-sys/RouteLLM/blob/0b64fdafe049e596a3f5657c219329f24af24198/routellm/controller.py)，[README](https://github.com/lm-sys/RouteLLM/blob/0b64fdafe049e596a3f5657c219329f24af24198/README.md)，原论文 [RouteLLM: Learning to Route LLMs from Preference Data](https://arxiv.org/abs/2406.18665)。结论来自源码/README，不依赖本文未复现的论文性能结果。

[S6] Aurelio Semantic Router 官方 [README](https://github.com/aurelio-labs/semantic-router/blob/main/README.md)，稳定分支 [semantic router 源码](https://github.com/aurelio-labs/semantic-router/blob/35bacee0eeabfdbc75a8478581ca07ec1f4050dd/semantic_router/routers/semantic.py)。本文语义匹配结论来自 README，稳定源码树用于确认版本路径；没有声称检查了所有实现。

[S7] NIST/SEMATECH 官方统计手册：[EWMA Control Charts](https://www.itl.nist.gov/div898/handbook/pmc/section3/pmc324.htm)。

[S8] Kubernetes 官方 [HPA 稳定窗口](https://kubernetes.io/docs/tasks/run-application/horizontal-pod-autoscale/#stabilization-window)，官方源码 [stabilizeRecommendationWithBehaviors](https://github.com/kubernetes/kubernetes/blob/ef06af9b9d09e8dc0eb1cc0768b0b542f35549bb/pkg/controller/podautoscaler/horizontal.go#L1256-L1316)。

[S9] River 官方 [ADWIN 源码与参数说明](https://github.com/online-ml/river/blob/d32e2800df067f4e7419e69dfa6a273ad1eadb27/river/drift/adwin.py)。

[S10] XState 官方 [README](https://github.com/statelyai/xstate/blob/da4c74efa441dd3a4c1d9835c42c3d1f87cdcaba/README.md)，[持久化文档](https://stately.ai/docs/persistence)。

[S11] 已安装 Pi 文档与类型：`docs/virtual-models.md`、`docs/codemode.md`、`node_modules/@earendil-works/pi-ai/dist/types.d.ts` 的 `NestedToolCalls` / `ToolResultMessage`，`node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts` 的 `ToolResultEventBase`。本仓库 `src/index.ts`、`src/judge.ts`、`src/gears.ts` 用于核查现有行为。
