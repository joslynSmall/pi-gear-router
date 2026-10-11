# 同一会话内模型与思考深度切换对缓存的影响

调研日期：2026-10-10

> 历史调研：文中“当前实现”、task-routing 与跨回合重新评分描述对应 0.1 的早期版本，不是 0.2 的行为。当前策略见 [ADR 0002](adr/0002-single-mode-routing.md)；本文仅保留服务商缓存机制与原始调研来源，不作为现行规格。

## 摘要

缓存命中不是“同一 Pi 会话”的属性，而是提供商按其模型、端点、缓存策略和请求前缀规则计算的结果。通常可作如下判断：

1. **切换到不同模型**：通常无法复用前一模型的 KV/prompt cache。模型权重和服务端缓存空间一般按模型隔离。不能把此结论扩大为所有代理都必然这样；Magpie 的具体缓存隔离规则未公开验证。
2. **同模型改变 thinking level**：不一定等于整段缓存失效。若 effort 是独立请求参数，服务端可能仍复用相同输入前缀；若服务端把 effort/configuration 纳入渲染前缀或缓存键，就可能失效。OpenAI 官方当前明确指出 `reasoning.effort` 会改变模型侧推理指令，但支持的 configuration update 可在改变 effort 时保留之前的 prefix；这属于模型/API 能力，不应假设兼容网关完整支持。
3. **同模型、同 thinking、相同 prompt 前缀**：最有希望命中，但仍受缓存启用方式、最小 token 阈值、TTL、缓存键、路由节点粘性、工具/系统提示变化、历史消息变化等限制。
4. **对当前项目**：路由器本身在同轮工具跟进/重试中固定实际模型与 thinking，避免同一个用户回合内切换；跨用户回合则可能按新的 Jev 判决换模型或 effort。固定同轮派发有利于兼容性与潜在缓存复用，但项目没有证据证明 Magpie 当前按 session 做缓存亲和或不同 effort 共享缓存。

因此建议先做分层、配对的真实测量，再决定是否把缓存作为路由目标。最合理的算法不是“会话锁模型”，而是把缓存局部性作为经测量、受能力约束的**轻量 tie-breaker**：只有候选能力足够且缓存利益经真实数据确认时，才偏向已热模型/effort；复杂任务的最低能力要求优先于缓存复用。

## 术语与度量

### Prompt/KV cache

提供商重用此前处理过的输入前缀的计算状态，降低重复输入的预填充计算、延迟，部分服务也降低缓存输入 token 价格。它不是 Pi 本地缓存完整回答，不等于 session transcript，也不保证模型能“记住”未发送的内容。

### Cache hit rate

至少要区分两种指标：

- **Token-weighted hit ratio**：`cacheRead / (input + cacheRead)`，衡量本次输入 token 中被报告为缓存读取的占比。注意 Pi 的 Usage 中不少适配器会把 `input` 记作未缓存输入，因此需针对 provider 字段定义校验分母。
- **Request hit ratio**：有 `cacheRead > 0` 的请求数 / 总请求数。它对大量小请求与少量超长请求权重相同。

另外记录缓存写入、请求输入 token、TTFT/总时延、model/provider/effective thinking、状态码/错误、任务阶段和请求间隔。使用价格字段时单独计算，不能把 token 命中率直接等同于节省比例。代理上报的 cost 可能为零或不完整。

## 缓存复用的主要边界

缓存键和前缀匹配规则由提供商/代理最终决定。可能的隔离维度包括 provider 账号、endpoint、model、缓存 key、工具 schema、系统指令、thinking/config 参数、请求节点及 TTL。换模型一般是强隔离边界；换 provider/base URL/账号也不可假设共享缓存。

输入前缀的首个差异点之后通常不能复用后缀缓存。系统 prompt、工具描述或顺序、项目上下文、已发送的历史消息、assistant 工具调用/结果等都可能影响后续前缀。Pi 的一条会话历史可跨物理模型重建，但服务端并不会因为这些消息来自同一个 Pi session 就自动共享 KV state。

thinking/reasoning 的具体影响是 API 特定的：

- OpenAI 官方 prompt caching 文档称缓存匹配的是完整 rendered context，并列出 `model`、`tools` 和 `reasoning.effort` 等可能影响缓存前缀/缓存行为的设置；当前文档也说明支持的 configuration update 可以改变 reasoning effort 而不重写之前的 prefix。因此，应区分“后续前缀仍能命中”与“模型配置参数是否参与缓存键”。
- Anthropic 官方文档明确：缓存层次为 tools → system → messages；thinking 参数和 effort 的变化对 message cache 有模型相关失效影响，且部分模型会连带使上游 tool/system cache 失效。Anthropic 的这些规则不能直接套到 OpenAI-compatible 的 Magpie。
- Google Gemini 提供商也有独立的 implicit/explicit caching 规则，不能从其他家推断。

## 当前 Pi 与 pi-gear-router 的实现事实

### 版本和派发

当前工作环境中的 Pi coding-agent 文档描述了会话树及消息历史重建；已安装 `pi-ai` 的 OpenAI-compatible completion 适配器将 thinking/reasoning 参数放入请求，同时支持 `cacheRead` usage 归一化。`pi-gear-router` 的 `src/index.ts` 对 `reason !== "user"` 的 continuation/retry 复用实际派发 pair；新的 user turn 经 Jev 与任务路由再次选型。`src/task-routing.ts` 的状态记录模型/等级用于稳定同一任务，但明确按任务能力决策，不依据缓存命中率。

### 当前 Magpie 模型元数据

`~/.pi/agent/models.json` 的 Magpie provider 使用：

- base URL：`http://127.0.0.1:3425/v1`
- API：`openai-completions`
- 13 个自定义模型
- 当前 light/standard/heavy 分别使用 Space Bunny Free、GPT-6 Luna、GPT-6.1 Sol

这些模型元数据未声明 `promptCache` 生命周期，也未标明已验证的 cache/session-affinity compat。Pi 当前适配器中：

- `prompt_cache_key` 对官方 `api.openai.com` 在短保留模式设置，或在支持且显式启用长保留时设置；普通自定义 Magpie endpoint 的短保留模式不会因“Pi session ID”自动得到 OpenAI prompt cache key。
- session affinity header 只有模型 compatibility metadata 打开 `sendSessionAffinityHeaders` 时才加；目前 Magpie 自定义 provider/model 未声明此项。
- 适配器能从部分兼容 API usage 字段读取 `cacheRead`，但提供商是否返回可靠 usage 由网关决定。

所以当前设置下，Pi 的 session ID 不足以证明 Magpie 请求被粘到相同缓存节点或使用显式稳定缓存键。服务端仍可能按隐式前缀缓存，但需要实测。

### 已观测数据的局限

仓库/临时诊断结果中历史 live request 出现过 `cacheRead > 0`，也有大量 `cacheRead = 0`。这些运行不是严格控制的 A/B：请求文本、历史上下文长度、任务、模型、effort、间隔和调用时间不同；报告还来自不同配置/日期。因此无法从这些样本推导“切模型导致 x% miss”或“low→high 导致 cache loss”。本次没有对 Magpie 直接观察 request payload/cache key，也未查询网关实现/服务端 cache logs。

## 对路由策略的含义

### 不建议的做法

- 不要因为同一个 Pi session 就永久固定模型：它会阻止新任务使用更合适的能力，缓存收益未知。
- 不要为了 cache hit 先降 thinking 再让模型补做更多轮：重试、多轮生成及输出 token 成本可能抵消输入缓存收益。
- 不要把 cacheRead 计数当作质量、费用节省或 KV 共享的直接证明；需结合服务商价格、cacheWrite 和实际请求 token。
- 未经验证不要对 Magpie 设置 OpenAI 官方的 `prompt_cache_key`、长 TTL 或 session affinity compatibility。协议字段可能被忽略、改变路由或被代理错误处理。

### 可考虑的优化顺序

1. **先保持请求稳定**：同一 user turn 的 continuation/retry 已冻结模型和 thinking，这是合理的；尽量避免其中途换 provider/model/tools。
2. **做同条件测量**：在 Magpie 确认的同一个会话中固定模型、请求前缀和工具，分别测同模型同 effort、同模型换 effort、跨 Magpie 模型、同模型 TTL 间隔、模型切回；每条件交错重复以减少时间/节点偏差。
3. **区分不同缓存**：Jev 分类器请求与物理模型调用使用不同模型/服务路径，应分别统计，不把 Jev cache token 加入生成模型缓存率。
4. **如命中率对成本/TTFT有实质影响，做 capability-constrained stickiness**：当 Jev 结果落在能力相当的候选（例如同一物理模型的不同 effort，或经质量评测确认等价的模型）时，优先当前任务已有热模型/effort；一旦评分要求更高档或能力验证失败立即升级。仅在 TTL 内、相同 provider/account/endpoint 且统计数据支持时应用。
5. **测算缓存切换代价**：将一次缓存 miss 的未缓存输入成本与延迟差，和保持旧模型可能增加的输出/推理 token、重试率、质量退化代价一起比较；基于期望总成本，而非单独最大化 hit ratio。
6. **再决定是否实现**：如果 Magpie 隐式 cache 是按 model+prefix 且 session pinning 无效，路由器可优先稳定同一个 model；若 effort 只是配置参数且相同模型跨 effort 仍命中，effort 可以继续按区间变化；若 provider 明示跨 effort 失效，可考虑同任务下的轻量 hysteresis，但不可覆盖能力升级。

## 建议的配对实验

### 测试约束

- 先向 Magpie 网关提供方确认缓存键、TTL、模型隔离、effort 是否影响 key、节点亲和 header 和 usage 字段语义。
- 每次使用独立实验 session ID 和固定版本 prompt/tool schema；保持系统提示与对话 prefix 字节级稳定，只变动预先声明的单一变量。
- 请求要足够长，超过提供方最小缓存 token 阈值；短 `PONG` 请求不适合测缓存命中率。
- 清晰标记 warm-up（写缓存，不计 hit）、随后重复请求（计 hit）、冷却间隔和 cache expiry；交错执行组序并每组重复多次。
- 保存响应 `usage.input/cacheRead/cacheWrite`、`stopReason`、延迟、模型 ID、effort、请求 ID、时间戳；不要记录 API key 或敏感 prompt。

### A/B 矩阵

| 组 | 首次请求 | 第二次请求 | 主要隔离变量 | 目的 |
|---|---|---|---|---|
| A | M1 / medium | M1 / medium，同前缀加新尾部 | 无 | 同模型同 effort 的基线命中 |
| B | M1 / medium | M1 / high，同前缀 | thinking effort | effort 是否改变命中；分开看服务端字段和 cacheRead |
| C | M1 / medium | M2 / medium，同前缀 | 模型 | 不同模型是否隔离 cache |
| D | M1 / medium | M2 / medium，然后切回 M1 | 模型切换/复用旧缓存 | 测 M1 cache 是否仍保留及 TTL |
| E | M1 / medium | M1 / medium，改 tool schema | tools prefix | 验证工具签名变化影响 |
| F | M1 / medium | M1 / medium，在设定间隔后重复 | 时间 | 估计实际 TTL/缓存驻留 |

每组至少 10 次重复更稳妥；若缓存行为有随机节点/负载均衡，需要更多样本、固定节点或控制 affinity。以 token-weighted hit ratio、请求 hit ratio、cacheWrite 与 TTFT 分别报告置信区间，不只给单次命中。

### 诊断判读

- A 稳定命中而 C 不命中：支持 per-model cache 隔离，但仍需排除 model prompt rendering 差异。
- A 命中、B 未命中：effort 可能参与缓存键/前缀，或代理切换了请求格式；需查请求 payload/网关日志。
- A 和 B 均命中但 TTFT 有差：effort 可能不影响 prompt cache hit，却改变了模型推理计算时间。
- 使用不同模型后 D 切回 M1 仍命中：旧 M1 cache 可能仍存活；不代表 M2 复用了 M1 cache。
- cacheRead 始终为零：可能未启用、低于阈值、字段丢失、缓存冷/短 TTL、请求前缀不同、随机路由节点，或 endpoint 不支持；单凭零值无法归因。

## Claude Code 的做法：可切模型，但明确承认缓存代价

Claude Code 确实允许在会话中用 `/model` 切换模型，也可以使用 `opusplan` 在 plan mode 用 Opus、执行阶段切到 Sonnet。但这不是“模型无代价地共享缓存”：Claude Code 官方文档明确说明每个模型有自己的 prompt cache；切换模型后，下一次请求会把完整会话历史重新作为未命中输入处理。Claude Code 会在缓存仍热、切换到的模型与最近响应模型不同时提示确认；`opusplan` 每次在规划/执行间切换也会开启新的该模型缓存。

Claude Code 的重要优化是把“选择模型”和“选择 effort”拆开：

- 对绝大多数模型，切换 effort 也会导致新 cache；但文档列出 Anthropic API / Claude subscription 下的 Opus 5.5、Sonnet 5.5、Haiku 5.5、Fable 5.1，在支持的配置条件下，effort 可以改变而保留现有 cache。
- 此特例不适用于 Bedrock、Google Cloud Agent Platform、Claude apps gateway，或禁用相应 beta/特定 HIPAA 配置的环境。
- Claude Code 有 `/effort` 和 `/model` 内的 effort 控件，允许运行中改变下一请求的 effort；在会让缓存重建的情况下给出 cache warning/确认，而不是假装切换免费。
- 它还提供 `/usage` 的 prompt-cache 统计：请求数、输入 token 缓存占比、miss 数、重建时间及 warm/cold 状态；部分版本要求 v2.1.251+。

Claude Code 也用 subagent 做成本分层：subagent 可显式设 `model: haiku`，或继承主模型。它是独立 context，侧任务输出不会全部灌入主对话，能减少主对话上下文增长；但子代理仍有自己的 API 请求、cache 和 token 费用，并不是 Haiku 自动接管主会话中任意简单消息。

### 对“Haiku / Opus 动态切换”的准确解释

- **手动会话切换**：可以，`/model haiku` 和 `/model opus`；但切到另一个模型的下一请求会失去该会话在当前模型上的 cache hit。切回原模型可能在 TTL 尚未过期时再次命中原 cache，具体仍按官方行为/服务端缓存生命周期执行。
- **阶段策略切换**：`opusplan` 是内置的 Plan→Opus、执行→Sonnet 模式，证明模型阶段切换可行；但官方也明确每次切换产生新 cache。它不是 Haiku/Opus 的逐消息语义路由器。
- **按子任务分模型**：subagent 可以固定使用 Haiku，而主会话保持 Opus；这更接近隔离任务，不会在同一连续主上下文里廉价复用 Opus cache。
- **effort 动态切换**：比换模型更有机会保留缓存，但仅限特定新模型/官方连接路径。Haiku/Opus 仍是不同模型，不能借 effort 特例推断二者共享缓存。

Claude Code 给本项目的启示不是“一律固定模型”，而是：

1. 能力分级与缓存策略要拆开；对同一模型的 effort 调整可单独测量和决策。
2. 对换模型明确计入一次完整历史重读的 cold-cache 成本，在热缓存时告知/确认。
3. 用独立 subagent 隔离低风险、窄范围的探索工作，降低主上下文膨胀；同时核算子代理自己的调用费用。
4. 展示真实 cache telemetry，将缓存 miss 与模型质量/任务能力一起权衡。
5. `opusplan` 是可用的粗粒度工作阶段策略示例，但其官方设计接受模型切换和缓存重建成本。

这套 Claude Code 行为不应直接当作 Magpie 的事实。Anthropic 官方 Claude Code 文档对 Anthropic API 的缓存行为有明确实现说明；Magpie 是另一个兼容网关，必须针对它实测。

## 开源方案：哪些能在“切换”后保留缓存

先区分三个常被混用的目标：**同一模型的 KV 在不同实例间迁移**、**切回某个模型后复用该模型仍存活的 KV**、以及**在两个不同权重模型间直接传递 KV**。当前成熟开源实现覆盖前两者；没有适用于任意不同 LLM（例如 Haiku→Opus、或 Luna→Sol）的通用、精确 KV 迁移方案。

KV 是特定模型对 token 前缀执行各层 attention 后生成的 key/value 张量。模型的权重、层数、hidden/KV-head 维度、位置编码、tokenizer、量化方式、adapter 与推理实现任一不兼容，都可能使这些张量不能被另一个模型正确解释。因此“文字前缀相同”不等于“KV 可跨模型使用”。开源 KV 基础设施通常反而把 model / release 写入 namespace，防止错误复用。

### 1. 同一兼容模型跨副本共享 KV：可用，但不是跨模型

- **vLLM Automatic Prefix Caching (APC)**：缓存相同 token 前缀对应的 KV blocks，后续相同前缀请求跳过 prefill；适用于长文档多问和多轮对话。它是某一 vLLM engine/同一兼容模型的 prefix reuse，输出 token 的 decode 仍需计算。
- **SGLang Session-Aware Radix Cache**：调用方在每个请求传相同 `session_id`，服务端将对应可复用 KV 标记为该 session 的软保护对象，内存紧张时优先保留活动会话的 KV。它不重建消息历史，调用方仍要提交完整 prompt；也不让不同模型共享 KV。
- **LMCache**：能通过集中式 cache server 或 P2P，在多个 vLLM 实例之间传输同一模型的 KV；官方示例两个实例都服务 `meta-llama/Meta-Llama-3.1-8B-Instruct`，且要求一致的 `PYTHONHASHSEED` 来保持 key 一致。
- **Mooncake**：提供 KV store / transfer。官方文档把 model 作为隔离边界，要求只有 cache-compatible 的 instances 使用相同 namespace；明确建议模型权重、KV layout、量化、adapter 或推理设置改变时使用新 namespace。它适合在相同模型的 prefill/decode 副本、负载均衡或滚动部署间搬运 KV，不适合不同模型直接读同一条 KV。

因此，如果控制底层推理集群，最接近“切换后仍快”的工程方案是：将 **每个物理模型** 的 KV 独立保留/共享到它的兼容副本；路由从 M1 切到 M2 时 M2 首次仍须 prefill，但在 TTL/驱逐前切回 M1 时可以读取 M1 自己的热缓存。这是双缓存/多缓存，而不是跨模型转换。

### 2. 语义/回答缓存：可跨模型路由，但不保留 KV

**GPTCache** 是开源的 semantic response cache：对相同或相似问题直接返回已缓存的回答，以避免再次调用任意模型。此类方案可以把缓存命中后的结果交给不同模型/路由层，看起来像“换模型仍利用缓存”，但实际是跳过模型调用，不是把 A 模型的 KV 传给 B 模型。

它适合幂等、低风险、可接受旧答案的问答；不适合作为 coding agent 的默认会话缓存：完整聊天历史、当前工作目录、文件状态、工具结果、权限和用户的最新意图会使近似命中容易过期或错误。缓存键至少应包含规范化 prompt、model/参数、工具版本、租户/用户隔离与 TTL；有副作用的工具调用不能从回答缓存直接重放。

### 3. 对 pi-gear-router 的可行含义

当前项目使用托管的 Magpie OpenAI-compatible endpoint，既不运行 vLLM/SGLang，也没有 Magpie 已声明的 KV-transfer 或 cache namespace 接口。因此 LMCache、Mooncake、vLLM APC 和 SGLang Radix Cache 不能由路由器单独接入来实现跨模型 KV 复用。

可实现且风险合理的路径是：

1. 先实测 Magpie 是否已提供 per-model prefix cache，以及切回原 model 是否仍命中；若提供，这是“每模型保温”。
2. 对每一个兼容 model/effort pair 记录热度、最后使用时间和实测 cache telemetry；只把它用于满足能力约束候选之间的 tie-breaker。
3. 若将来自己部署模型，选 vLLM/SGLang 加 LMCache 或 Mooncake，实现同模型跨 pod/GPU 的 prefix/KV 共享与 cache-aware replica routing。
4. 不将 semantic answer cache 用于普通 agent continuation；仅可为明确幂等、无工具副作用、可验证的独立查询单独设计。

## 下一步建议

当前不应马上改变自动路由。先完成一项只对 Magpie 发请求、输出诊断 JSON 的受控脚本，执行上述 A–D（先确认不会携带个人会话/隐私内容），验证网关实际语义。若网关没有可观测、稳定的 cache read/write telemetry，则先向 Magpie 提供方确认，而不是加入猜测性的“cache-aware routing”。收到真实数据后，再将 cache hit/miss 和总费用/TTFT/质量一起评审，决定是否添加同任务的模型保持偏好或模型切换滞回。

## 来源

### 项目与运行时一手来源

- 当前项目路由器实现 `src/index.ts`：同用户回合 continuation/retry sticky dispatch，新的 user turn 重新决策。
- 当前项目 `src/task-routing.ts`：任务升级/降级和承诺能力；当前政策不包含缓存惩罚。
- 当前项目当前目录 `~/.pi/agent/models.json`、`~/.pi/agent/pi-gear-router/settings.json`：Magpie endpoint/model metadata 与当前 gear 配置（本机配置不提交到仓库）。
- Pi 官方缓存配置文档：<https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/settings.md> — `cacheWarming`、命中提示和启用条件。
- Pi 官方模型文档：<https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/models.md#prompt-cache-lifetimes> — 模型声明缓存寿命、model override 与 warming eligibility。
- Pi 官方实现：<https://github.com/badlogic/pi-mono/blob/main/packages/ai/src/api/openai-completions.ts>、<https://github.com/badlogic/pi-mono/blob/main/packages/ai/src/api/openai-responses.ts> — 当前本地安装版本的对应实现亦已检查，包含 prompt cache key、session affinity、thinking 参数及 cache usage 映射逻辑。实现随版本变化，应以本机 Pi 版本复核。

### 服务商一手来源

- OpenAI Prompt Caching：<https://platform.openai.com/docs/guides/prompt-caching.md> — prefix 命中、完整 rendered context、缓存门槛、影响因素、reasoning effort 与配置更新行为。
- OpenAI Reasoning：<https://platform.openai.com/docs/guides/reasoning.md> — reasoning effort 是请求参数，深度影响推理 token、延迟和成本。
- Anthropic Prompt Caching：<https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching.md> — 缓存层次、TTL、thinking/effort 变化对缓存的模型相关影响。
- Google Gemini Context Caching：<https://ai.google.dev/gemini-api/docs/caching> — Gemini implicit caching 与相似前缀建议，证明策略为服务商特定。
- Claude Code 模型配置：<https://code.claude.com/docs/en/model-config> — `/model`、Haiku/Sonnet/Opus aliases、`opusplan` 和 effort 控制。
- Claude Code Prompt Caching：<https://code.claude.com/docs/en/prompt-caching> — 每模型 cache 隔离、切模型/effort 的 cache miss、努力等级特例、TTL 与 cache 警告。
- Claude Code Costs：<https://code.claude.com/docs/en/costs> — `/usage` 的主对话 cache token 统计示例及版本要求。
- Claude Code Subagents：<https://code.claude.com/docs/en/sub-agents> — subagent 的 model inheritance、显式 Haiku 路由及独立上下文/费用。
- vLLM Automatic Prefix Caching：<https://github.com/vllm-project/vllm/blob/main/docs/features/automatic_prefix_caching.md>；实现设计：<https://github.com/vllm-project/vllm/blob/main/docs/design/prefix_caching.md> — 相同 token 前缀的同模型 KV block reuse、cache key / isolation 组成。
- SGLang Session-Aware Radix Cache：<https://github.com/sgl-project/sglang/blob/main/docs/docs/advanced_features/session_radix_cache.mdx> — 对同一模型服务的活动 session KV 做保留优先级，而非跨模型 cache。
- LMCache 跨实例 KV sharing 示例：<https://github.com/LMCache/LMCache/blob/dev/docs/source/getting_started/quickstart/share_kv_cache.rst> — 同一 served model 的 vLLM 实例间 KV 传输。
- Mooncake KV Cache Sharing and Isolation：<https://github.com/kvcache-ai/Mooncake/blob/main/docs/source/deployment/kv-cache-sharing-and-isolation.md> — model/release/request 的 namespace 隔离；模型或 KV 兼容性改变时不得混用。
- GPTCache：<https://github.com/zilliztech/GPTCache> — semantic response cache，命中时返回既有回答，不是跨模型传递 KV。

## 证据边界

没有 Magpie 的公开一手缓存规范或网关日志，因此有关 Magpie cache key、模型隔离和 thinking 参数处理的任何结论目前都只是待验证假设。本报告说明机制并提出实验设计，不声称已测出当前网关的 cache hit rate，也没有因缓存问题修改路由产品代码。
