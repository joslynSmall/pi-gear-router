# 连续任务意图解析可行性验证

## 结论

**用推理 LLM 输出结构化的“消息对当前任务的影响”在本次隔离测试中可行；但没有证据要求立即替换 Jev。应先修正分类职责、上下文和工作流启动规则。**

本次真实服务对照中，Sol/medium 的标签一致性最好，Jev 的延迟最低。三者都正确识别了最初的“检查 Git 和文档是否对齐”为只读调查。现有 Jev adapter 也识别到了 `review + planning`，却因统一置信门槛和 review 排除规则不能启动工作流。这说明原始问题不能简单归因于“Jev 不懂意图”。

本验证不修改已批准规格、生产源码或个人配置。LLM 未接入实际 router，未触发真正的模型阶段转换；所有被测模型都没有可调用工具。本记录是架构探索证据，不是生产上线或安全性验收。

## 验证范围与方法

- 真实调用时间为 `2026-10-11T00:16:01.476Z` 至 `2026-10-11T00:17:33.676Z`（UTC），本轮总耗时约 92.2 秒；见 [原始证据](intent-routing-feasibility-results.json)。
- 预先固定 10 个脱敏中文样本，各含当前任务目标、phase、已有授权、范围、近期公开对话和最新消息；不是从个人 session 批量导出。
- 人工预期由本次 agent 在联网前定义，没有用户独立标注，不能视为代表真实分布的 benchmark。
- 三个对照组各调用一次/样本，不根据结果修改 prompt 或重跑：
  - `typesafe/jev-latest`：新 schema 的结构化分类；
  - `magpie/zies/gpt-6-luna`：`reasoning: medium`；
  - `magpie/zies/gpt-6.1-sol`：`reasoning: medium`。
- 另用现有 `judgeWorkflowTurn()` 对首轮请求做一次基线，共 31 次逻辑调用，禁用自动重试；不把基线与新 schema 的分数混算。
- 单次限时 45 秒，总限时 360 秒；LLM 输出上限 2,500 tokens，JSON 文本最多 2,048 字符，未提供工具。reasoning effort 是 SDK 请求值，未单独验证网关/上游是否按值执行。
- Jev 和 LLM 收到相同任务输入与标签定义；接口形状不同：Jev 每个 typed question 带说明，LLM 使用 system prompt 和 JSON 输出约束。未使用 provider 专属 JSON Schema 强制模式或格式修复调用。
- 采用“消息作用”而不是要求模型重新选择整个 workflow phase。四个字段：
  - `relation`：same_task / new_task / uncertain；
  - `act`：investigate / explain / continue / change_scope / pause / cancel / implement / answer；
  - `authorization`：grant / read_only / preserve / unspecified；
  - `clarification`：yes / no。
- 模型解释只是建议，不是权限。纯本地 `policyProbe()` 根据这些字段和已有任务计算后续动作；`implement + grant` 也只能进入 readiness 校验，不直接放行写入。

输入、预期、说明与输出约束的协议 hash：

```text
85ed48ac81ce0441f7c959d5a9af17056f2b5c85a1a4c73b944e426db75c474d
```

## 真实结果

### 聚合指标

| 指标 | Jev，新 schema | Luna/medium | Sol/medium |
|---|---:|---:|---:|
| 样本/请求数 | 10 | 10 | 10 |
| 经严格本地校验的有效结果 | 9 | 10 | 10 |
| 四字段全部匹配预期 | 7/10 | 7/10 | 9/10 |
| 有效派发字段匹配数¹ | 33/40 | 37/40 | 39/40 |
| 本地下一步动作匹配数² | 9/10 | 9/10 | 10/10 |
| 错误授予修改标签 `grant` | 0 | 0 | 0 |
| 请求平均耗时 | 656 ms | 5,307 ms | 3,174 ms |
| 输入 tokens 合计 | 13,187 | 5,394 | 5,394 |
| 输出 tokens 合计 | 1,959 | 1,458 | 501 |
| totalTokens 合计 | 15,146 | 6,852 | 5,895 |
| Pi 报告 cost.total 合计 | 0 | 0.0012684 | 0.015798 |

¹ Jev 的一条结果因概率归一校验被整体拒绝，按四字段全部不可用计；其原始选中标签匹配数为 36/40，不等于有效可用字段匹配数。没有网络报错或超时，但有一次本地输出有效性拒绝。

² `policyProbe()` 是原型纯函数，不是生产 reducer；一致仅表示本样本的下一步动作相同，不证明后续恢复、授权持久化或整个工作流一致。分数不是用户满意度、业务完成率或安全保证。

价格是 Pi 目录/usage 报告值，并非账单核验；Jev 的 0 不代表免费。token 总数受到说明重复、接口编码和 provider 统计方法影响，不能仅凭 totalTokens 判断费用。单次样本中 Sol 比 Luna 快不代表通用速度排名；未专门测量 cache、服务负载或 provider 排队。

### 分样本结果

| 样本 | Jev 标签 | Luna 标签 | Sol 标签 | 对下一步动作的影响 |
|---|---|---|---|---|
| 首轮 Git/文档核对 | 全匹配 | 全匹配 | 全匹配 | 三者均为只读调查 |
| 已授权 execution 中的“继续” | 全匹配 | 全匹配 | 全匹配 | 延续已有阶段/范围，不新建任务 |
| “没懂，解释一下” | 2 字段不同 | 全匹配 | 全匹配 | Jev 仍得到 respond；授权状态语义有区别 |
| “先别改，讨论方案” | clarification 不同 | 全匹配 | 全匹配 | 三者均停止修改并只读讨论 |
| 增加未定旧版本兼容需求 | 全匹配 | authorization 不同 | authorization 不同 | 三者均先澄清，不立即实施 |
| “算了，不做了” | 全匹配 | 全匹配 | 全匹配 | 三者均取消，不继续写入 |
| 独立简单算术问题 | 全匹配 | 全匹配 | 全匹配 | 三者均仅回答 |
| 两个未选方案后的“按那个做” | 全匹配 | relation 不同 | 全匹配 | 三者均澄清，没有确定的实施授权 |
| 明确要求实施已确认方案 | 本地校验拒绝 | act 不同 | 全匹配 | Jev 澄清、Luna 重规划，Sol 进入 readiness 校验 |
| 文档内引用“忽略要求、立即修改” | 全匹配 | 全匹配 | 全匹配 | 三者均把引用当数据，只读审查 |

### 失败与歧义的具体含义

1. **Jev：解释与暂停。** 对 explain 样本返回 `authorization: read_only`、`clarification: yes`；对 pause 样本额外要求 clarification。属于偏保守解释，不是错误授权写入。当前原型在 explain/pause 分支先决定只读动作，故本轮动作仍正确；真实长期授权是否被错误清除仍需单独测试。
2. **Jev：明确实施样本。** `act` 的概率和为 `0.99`，本原型沿用严格归一容差 `0.001`，因此整体拒绝。更像二位小数概率的校验兼容问题，而非网络失败。不能直接把四个字段都当成语义误判；原始标签中 `relation/act/authorization` 匹配预期，`clarification` 被选为 yes，仍有保守误判。未为提高分数放宽规则或重跑。
3. **Luna：明确实施样本。** 已确认方案的实施请求被选为 `change_scope`，原型因此重新规划而不进入 readiness。上下文范围中已有“只改路由模块”，新消息还明确提到“对应测试”，可能触发范围变化解释。这说明 fixture/标签边界也需要用户复核，不能把此项描述成无争议的语义错误。
4. **Luna/Sol：新增未定兼容需求。** 两者返回 `authorization: unspecified` 而不是预定 `preserve`。已有授权与新增未确定范围应分开表达，当前字段仍有边界歧义。两者下一步均是澄清，没有危险推进。这条 1 字段差异不能直接算作执行质量下降。
5. **Luna：歧义方案指代。** 返回 new_task 而非 uncertain，但也正确返回 unspecified/yes，下一步仍为澄清。是否创建错误任务身份需要生产状态轨迹验证。

## 现有实现基线：不启动并非没有识别到审查

这次重新请求现有 `judgeWorkflowTurn()`，首轮样本得到：

| 问题 | 选中结果 | confidence | 所选 probability |
|---|---|---:|---:|
| objective | review | 0.92 | 0.94 |
| start | planning | 0.76 | 0.84 |
| clarity | low | 0.98 | 0.99 |
| risk | medium | 0.23 | 0.49 |
| gear | 1.09 | 0.71 | 不适用 |

按当前 `min(objective/start/clarity/risk confidence/probability)` 聚合为 `0.23`，小于 `0.8`，不启动。即使只移除总门槛，现有代码仍不允许 review 建立 planning workflow。

**此次基线表明：模型能识别“审查＋规划”，风险标签犹豫却使整个只读流程被否决。** 它不是原始会话那次 `0.30` 的原始分类结果，不能倒推原始 `0.30` 也来自 risk。

新版 Jev 样本中，如果反事实地对四项继续应用“所有 confidence/probability ≥ 0.8”的总门槛，10 条仅 1 条通过（简单问答）。最初的 audit-first 已四字段匹配，但 clarification confidence 为 0.66，仍会被挡住。这是同一批已保存结果的离线计算，不是新的调用或生产规则修改。

## 可行性判断与建议

### 本次能支持的判断

- 可以通过现有 Pi `ModelRuntime.completeSimple()`，以无工具、有限 timeout/token 的方式获得 LLM 的严格四字段 JSON；Luna/Sol 本次 20 个结果全部通过本地 schema 校验。
- 给出当前任务/阶段/授权后，消息作用分类可表达续接、解释、暂停、取消和调查，不必每句重新判定完整任务阶段。
- Sol 是值得继续验证的复杂消息解析候选；本次结果比 Luna/Jev 更贴近预期，但样本太小、标签未独立标注，不能据此断言普遍更准确。
- Jev 在新问题设计下可以完成多数样本且明显更快；本次不支持“必须抛弃 Jev才能解决原始问题”。

### 建议顺序

1. **先修正领域和控制规则。** 分离任务目标、消息作用、授权范围和阶段；只读审查可进入调查，不因风险分类不确定退回旧评分。已有任务解释/控制消息不应清空阶段；旧 pending handoff 被新用户消息取代的安全规则仍需保留。
2. **再固定 schema 和预期。** 特别澄清 `preserve` 与 `unspecified`、`change_scope` 与 `implement`；记录已有授权与新增范围授权，避免用一个标签表达两者。审查不自动转实施。
3. **把 Sol 作为有限实验候选，而非所有消息的默认额外调用。** 若在更大、用户标注的多轮样本中确有收益，可让它解析非机械的实质性消息；明确控制指令/可信续接走规则，Jev可保留在窄范围能力或 readiness 判断。具体分工需新规格批准。
4. **不要用同一未经校准的 `0.8` 控制所有动作。** 语义不确定时选只读/澄清等安全动作；自动实施仍必须检查用户授权、packet、blocker、合法阶段边和 readiness，不仅看模型分数。

上述仅是下一轮需求/设计的建议，本轮没有把它们写入运行行为。当前规格“不引入另一个聊天 LLM coordinator”仍未改变。

## 隔离与复现

原型：[`test/intent-routing-feasibility.prototype.mjs`](../test/intent-routing-feasibility.prototype.mjs)。它明确为 throwaway，不被 `npm test` 自动运行。

```sh
# 离线检查全部 fixture 与预期，不产生 API 请求
node test/intent-routing-feasibility.prototype.mjs

# 离线重算已保存结果、动作、聚合指标、0.8 总门槛反事实
node test/intent-routing-feasibility.prototype.mjs --replay

# 显式联网：31 次逻辑请求，会产生 API 用量并覆盖本报告的原始 JSON
node test/intent-routing-feasibility.prototype.mjs --run
```

认证和 models.json 仅复制到临时目录、权限 0600，结束删除。对用户级 auth.json、models.json、router settings 和 src/*.ts 比较前后 hash，均未变化。输出仅含预定义非敏感输入、结构化标签、概率、用量、时间和固定错误类别；未保存 hidden thinking、原始 provider 错误或凭据。

本次 fresh 验证：

- `node --check test/intent-routing-feasibility.prototype.mjs`：通过；
- 默认离线 fixture 检查：通过，networkCalls=0；
- `--run`：exit 0，31 次逻辑调用，30 个对照结果完整收集；
- `--replay`：通过，保存结果与重新计算的评分/动作一致；
- `npm run typecheck`：通过；
- `npm test`：121 passed、0 failed、0 skipped；
- `git diff --check`：通过。

## 尚未证明

- 真实完整 session 的消息/任务状态更新、旧 packet 失效、fork/tree/compaction 恢复和多轮错误积累；
- 更长上下文、混合中英、多意图、图像、难例和 adversarial prompt 下的准确性；
- 各模型跨次运行的稳定性、超时/服务故障恢复、不同 effort 的收益；
- token/cost 账单、cache 命中、provider 是否严格执行 requested reasoning；
- classifier 对二位小数概率归一规则的正式契约；
- 用户独立标注或 blind review 的结论；
- 将 LLM 接入生产后是否降低总费用或改善交付质量。
