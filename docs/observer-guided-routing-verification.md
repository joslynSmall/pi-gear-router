# Observer 路由验证记录

> 历史记录说明：下文的只读 tool guard 验证描述当时实现，不代表当前权限策略。现已按用户确认移除 task 计划／修订与 legacy planning／recovery 的工具拦截及 shell 白名单；阶段仅提示工作重点，所有工具权限交给 Pi 及已有权限扩展。路由交接、验证事实与有界 reminder 保留。

## 状态与证据边界

需求、设计、任务已批准；observer 为显式 opt-in，默认仍为 task。此记录描述本次实现，不把早期 seam 探针、旧 workflow 联网报告或可行性对照当作新功能验收。

最新离线执行：`npm run typecheck`、`npm test`、`node --check test/live-observer-smoke.mjs`、`node test/live-observer-smoke.mjs`、`git diff --check`。类型检查、脚本语法与 diff 检查通过；**263/263** 离线测试通过（执行日志 `/tmp/pi-observer-complete-offline.log`）；生产SDK＋budget连续3次 **31/31**（`/tmp/pi-observer-complete-repeat-{1,2,3}.log`）。此前258及3次30/30属于锚点／ledger修正前历史验证。默认 smoke 只输出计划，不读取个人认证、不联网。正式 SDK fixtures 全局封锁 fetch，networkCalls=0。

## 实现与测试 seam

- `src/observer-routing.ts`：纯 JSON 契约、预算与 turn/task/capability reducer；不 append 或联网。
- `src/observer-judge.ts`：Jev-only schema/strict parser、统一 deadline/transport owner、持久 reservation 与过期 accounting。
- `src/observer-guidance.ts`：运行时目录、有限召回、公开有界输入、受控 advisory 和 carry projection；不加载正文。
- `src/observer-handoff.ts`：新协议工具、本地门禁、独立 readiness、持久接受；不是权限系统。
- `src/observer-runtime.ts`：从 `src/index.ts` 抽出的 Pi 接线 helpers，集中 trust-aware settings、生命周期、context 与 branch adapter；不定义另一套方法流程。index 复用既有 physical availability/auth/thinking/fallback。
- task／legacy 原有 owner 保留；guard/handoff/reminder/activation/status 与 route 使用 resolved mode。不会静默退休旧保护。

## A1–A20 追溯

表中的“通过”是指定离线 fixtures／mock labels 下的行为，不是 Jev 意图准确率或通用安全保证。

| 场景 | 证据 | 结果／边界 |
|---|---|---|
| A1 Git／文档调查 | observer-routing、observer-sdk | converge 下限、同轮有界候选，无授权字段；通过 |
| A2 不同用户／无 Skills | observer-catalog、observer-sdk A2/A12 | 自定义名称、空目录不伪造候选；通过 |
| A3 解释 | observer-routing explain→continue | task/method/窗口不重置，临时 respond；通过 |
| A4 纯继续 | observer-routing、observer-sdk literal | 无新 classify/样本，有限继承；通过 |
| A5 暂停／取消 | observer-routing、identity、SDK delayed handoff | control 清候选，异步输入使旧结果失效；通过 |
| A6 新兼容范围 | observer-routing A6/A10 | converge、候选过期，旧范围无新增权限；通过 |
| A7 设计文档写入 | observer-sdk A7/A18、permission probes | profile 不禁写，外部权限可拦截；通过 |
| A8 Skill wait＋ready | observer-handoff、observer-sdk A8 | source wait 否决，不发 readiness／不清等待；通过 |
| A9 有效交接 | observer-sdk capability | 独立 classify、持久 accepted、非错误工具结果＋合法 continuation 消费一次；通过 |
| A10 安全实现／失败 | observer-routing、handoff、facts | 高风险不机械降档，failed fact dirty；通过 |
| A11 risk low/medium 犹豫 | observer-routing common investigation | 不取所有字段 confidence 最小值；通过 |
| A12 无效／过期候选 | observer-catalog、guidance、SDK explicit | explicit-only 不推荐，命令关联不外发正文／路径；通过 |
| A13 重叠／忽略 | observer-guidance、catalog | ≤2 候选，持久去重，无催促；通过 |
| A14 恶意引用／description | observer-input、guidance | 哨兵不作为 guide 命令，不生成权限；不是脱敏保证 |
| A15 timeout/cancel/steering | observer-judge、budget、identity、SDK | 总 deadline、过期 result 不路由、同分支 accounting；通过 |
| A16 continuation/retry/repeat | observer-router、SDK retry | 不新增观察、retry 不消费；通过 |
| A17 branch/reload/compaction | SDK contract、identity、SDK A17/reload | 当前 branch 证据，pending 不恢复；SDK seam 与生产测试分开 |
| A18 验证不等于业务完成 | observer-facts、SDK A7/A18 | 仅 verification 标签，无 complete reducer；通过 |
| A19 自然结束／没读 Skill | observer-sdk ordinary/no handoff | 无新回合／reminder，建议不强制读取；通过 |
| A20 旧协议／mode／reduced | observer-state、routing-mode、router、既有 workflow | 版本隔离，缺 source fallback，旧回归通过 |

补充 bounded generated trajectories：26 回合验证 task/turn 分离、独立 evidence 去重、临时解释保持 taskBand、retry 不观察。不是所有可能轨迹的形式化证明。

## 概率、调用与恢复

choice 概率不归一化，exact labels、finite `[0,1]`、chosen 最大、sum 容差 **0.001**。测试覆盖 0.99/1.01、NaN、extra labels、missing/partial/adapter-cleared answers。一个 invalid risk 不否决独立保守调查，但不支持降档。

主要观察最多 19（无 task）／20（有 task）问题，包括至多12个 Skill bool，低于已批准20/21上限；显式交接独立6问题。初次调用前持久 reservation，两类共用预算，默认24 logical calls。默认 transport retry0、最多1、总 deadline15秒、provider maxRetries0。失败／取消不返额，迟到结果不能跨 branch 写 usage 或 acceptance。reload 恢复预算不是重置入口。

## 架构复核

治理分类：**aligned，scope: architecture**（最终 diff 仍须结合已有脏文件分批核对）。抽出 observer-runtime 是 Pi adapter helpers 的组织方式，不增加方法／审批 owner。

七维：resolved mode 单 owner；纯契约依赖稳定 helpers；packet/events/schema 独立版本；无 chat cascade；策略不反向依赖 Pi adapter；legacy 明确保留且 observer 隔离；新增复杂度只承担观察、预算、来源和受控能力交接，不新增通用开发阶段机。未擅自提交／推送或改个人配置。

## 真实验证计划与未证实项

`test/live-observer-smoke.mjs` 默认离线。用户此前已允许真实网络测试；实际执行仍先公布模型、calls/attempts/deadline/输出上限。只发送合成任务，临时配置／复制凭据结束清理，报告不保留 prompt/工具正文、原始服务异常或密钥。

已按该有界计划执行新 smoke，结果见 [`observer-guided-routing-live-smoke.json`](observer-guided-routing-live-smoke.json)。实际 **5次 Jev／5 attempts、3次 Sol-high主模型请求**，无 retry。个人auth/models/router settings SHA-256不变，临时认证已删除。此前两次 auth预检查停止时网络calls均为0；后确认 Pi1.1同步snapshot漏掉classifier-only环境凭据，改为同deadline内公开异步provider auth并补离线回归。

本次是 **partial 探索证据，不是完整真实验收通过**：

- 5/5 Jev stop、strict字段有效；本轮0个 invalid-probabilities，不能推导服务精度契约。延迟291–1032ms，平均568.8ms；报告usage共12,165 tokens、目录cost=0不代表免费。
- runtime首轮investigate→converge、requested2/protected3、Sol-high。宿主只允许handoff工具、无reader，因此runtime Skills不可见，无推荐；这是正确缺覆盖路径，不是生产推荐质量。
- 首轮 methodGate=none_observed但confidence0.71<0.80，本地记录unknown wait；主模型虽尝试交接，本地拒绝，**readiness未调用、accepted/consumed/physical-response事件均未发生**。不放宽门槛以获得降档。
- explain字段与relation可信，但clarity置信0.66、selected p0.77未达门槛；turn profile respond，持续taskBand／实际protected3保持。先前口头提到“评分不足”不精确，直接证据是clarity不足，不是score（score0.07/confidence0.88）。
- 独立alternate-directory2候选、无Skills0候选、大目录上限12候选／当前20问题均输出valid；相关review候选概率0.96、无关0.05–0.07。大目录同时做原生召回和最大schema容量输入；报告的12个synthetic候选是容量fixture，不冒称由30项自动召回12个。
- 3次主模型响应均正常，传输链路通过，但报告 `passed:false`，原因是未观察到真实能力交接消费。该报告早于最终恢复/accounting细化，不代表最终diff的发布验收。

### 第二次：可见合成目录与独立 readiness

用户回复继续后，先跑fresh离线，再事前公布相同上限；执行 `node test/live-observer-smoke.mjs --run --visible-catalog`。报告独立保存为 [`observer-guided-routing-visible-smoke.json`](observer-guided-routing-visible-smoke.json)，首次结果不覆盖。read只能访问临时合成Skill文件，fixture guard拒绝其他路径，不能写入或执行代码。

- 实际 **6次Jev／6attempts、3次chat**，无retry；5次主要观察（含3个独立目录fixture）＋1次独立readiness。83字段均valid，0 invalid／missing；latency254–1173ms、平均671.5ms，Jev报告18,590 tokens。price=0不是免费保证。
- runtime初次19问题、12个可见候选，调查profile converge、requested1/protected3、Sol-high；同轮controlled guide真实进入provider，continuation重投影但不增加classify。
- **proposed→独立readiness→invalidated**：ready confidence0.98、scope/clarity/methodGate均1.00；capability score0.6/confidence0.37，未达已批准0.80门槛，所以拒绝能力降低。accepted/consumed/physical-response均false，报告passed:false、transportPassed:true；脚本退出码1，没有把完整验收标为成功。
- 解释回合 relation/explain/clarity/score可信：turn respond、requested/protected0、实际space-bunny/low；taskBand仍保持原持续需求，未把整体任务降为light。评分低而置信高与readiness评分置信低是不同事实。
- alternate2候选建议相关项、none0无推荐；大目录原生召回total30/considered12/omitted18，同时最大schema20问题valid。人工合成预期写在plan.expected；报告separate capacityFixture，不能把容量输入当完整召回质量。
- 个人文件hash不变、临时认证清理；两次实际联网总 **11次Jev／6次chat**，另两次预检查0calls。没有自动第三轮或聊天observer。

线上上限仍为每次6classify／6attempts、4chat，每次2,000输出tokens、classifier15秒、chat45秒、总150秒。offline mock capability交接可接受/消费不替代两次线上未消费事实。**当时任务9.3保留未完成**；下文专项诊断及最终复验才补齐真实消费，不追溯改写两次失败报告，也不默认启用observer。

### 收尾 accounting 与隔离

native adapter忽略abort而迟到时，统一deadline先返回timeout或传播cancel；迟到usage经独立accounting callback回owner。同branch/source只追加一次stale call-result（attempts不返还），树／session／runtime已换则不写新branch、通知coverage unknown。迟到answers不能返回新决策或acceptance；正常及时结果不走late callback，避免双计。mode关闭再开启使pending永久失效，不因source/policy恢复相同而复活；显式Skill选择不外发替代候选、不推荐替换。`observer-budget`覆盖timeout与cancel late usage，生产SDK覆盖steering、cancel、tree/fork/resume/compaction与budget继承。

### 专项诊断与最终真实验收

见 [专项诊断](observer-capability-diagnostic.md)及其独立JSON：8次Jev/0chat、四组两次，不接入生产。详细锚点提高这个fixture的score confidence至0.88，但其他相关字段仍不足，不能声称仅靠修改评分必然接受。

基线内补全handoff能力锚点，contract fingerprint追加 `handoff-anchors-v2`，保持原六字段、输入、0.80与strict概率。锚点v2首次生产报告真实accepted/consumed/response，却发现同任务transition计数回退，已复核标partial并保留。owner/SDK红绿回归修复旧transport ledger覆盖较新transition/guide/exhaustion状态，无基线/阈值改动。

最后 [`observer-guided-routing-budget-fix-smoke.json`](observer-guided-routing-budget-fix-smoke.json)：6Jev/6attempts、3chat，83/83valid，无retry；独立readiness capability0.02/confidence0.97，其他必需字段均可信。Sol-high converge/protected3→下一合法continuation Luna-high implement/protected2，仅下降一band；实际accepted/consumed/physical-response均true。后续same_task explain到space-bunny/low，持续taskBand2及transitions1不变，预算1→2→3。

最终passed:true/budgetContinuity:true，任务9.3证据补齐。仅合成fixture、工具受限，无工作区实现或审批。不同/空/大目录分开报告，最大当前schema20问题；设计21是上界不是凭空添题。合计本系列31Jev/12chat（另两次auth预检查0calls），个人hash不变、临时认证清理。无需chat observer或进一步循环补测。

最终离线checks包含诊断/smoke默认与缺auth清理测试、脚本syntax、JSON报告与Markdown本地链接检查；最后一次真实smoke之后未再联网。个人配置仍未启用observer。成功合成轨迹不证明任意Skill gate、概率校准、大目录召回、长轨迹或费用收益，opt-in限制保留。

工作区按batch3 SHA-256隔离核对：除了本批列明源码／测试／文档，既有脏文件未动，个人auth/models/router settings三个SHA-256均未变，无丢失基线文件、Git提交或推送。JSONC示例通过生产loadSettings在临时目录解析核对，默认task、legacy false与dormant observer预算/floor保持一致；未安装额外解析依赖。

最终七维治理复核：**aligned，scope: architecture**。call owner只拥有transport账目，不回退route消费的transition/guide/exhaustion；问题锚点契约显式fingerprint更新；Pi adapter→纯策略/契约依赖不变。未新增方法/审批owner、聊天cascade或权限机制，legacy按模式隔离保留、无静默退休。诊断原型与真实报告有界且独立opt-in，失败历史不改成通过；新增复杂度用于既有契约证据与已复现预算缺陷，不增加运行时判断链。

以下仍是发布限制：真实 probability precision 契约、schema有效输出率、大目录语义召回、任意 Skill gate 检测、真实长轨迹、provider/cache 和费用收益。mock 推荐结果不等于真实推荐质量；cost=0／usage缺失不意味着免费。真实服务失败或严格概率被拒绝不通过临时放宽规则“修复”。
