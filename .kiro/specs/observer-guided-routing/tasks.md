# 会话观察与引导路由实施任务

状态：任务已批准，实施中。用户在本次会话回复“批准任务并开始实施”；需求、设计与任务均已批准。按下列依赖实施，有 fresh 验证证据才勾选。设计阶段的临时 SDK 接线探针不是正式实现或验收，不据此勾选任务。

基线：[requirements.md](requirements.md)、[design.md](design.md)；治理：[BASELINE-GOVERNANCE.md](../../../docs/aegis/BASELINE-GOVERNANCE.md)。本清单仅拆解已批准设计，不增加第二聊天判断层、统一开发方法、自动 Skill 加载或通用权限系统。

## 实施与验收约定

- 子任务以约 2–4 小时的可验证变更为目标；这是拆分尺度而非工期承诺。若实际超出，应沿测试 seam 再拆，不将关键保护延后到上线后补齐。
- 每项列出依赖、文件范围、行为与验收。完成后执行关联测试和 `npm run typecheck`；集成检查点执行全套 `npm test` 与 `git diff --check`，有 fresh 证据才勾选。
- 新测试沿用 Node `node:test` 和现有 TypeScript 加载方式；不引入无必要的测试框架。正式离线 SDK fixture 使用临时目录、内存 session、mock classifier/provider，禁止真实网络与个人凭据访问。
- 工作区已有大量未提交／未跟踪变更，实施前记录当时基线；不覆盖、回滚或将旧变更算作本任务成果。任务批准不授权 Git 提交、推送或修改个人 `~/.pi` 配置。
- 设计发现矛盾时先按治理报告 `Design Defect` 并修订审批基线，不以代码绕过；尚未验证的概率精度、Skills 匹配、方法 gate 覆盖与 provider/cache 收益不写成已验证结论。
- 观察模式持续显式 opt-in。先让纯逻辑可测试，再接运行路径；不为提前演示而只接一半保护。

## 当前实施证据

累计完成 **1.1–9.3（27/27）**。最终有界真实轨迹验证能力接受／消费／实际响应及同任务预算连续性；此前失败／partial报告保留。规格phase保留implementation审批历史；任务完成不等于默认启用、通用质量保证或已发布。**C1–C4 离线检查点通过**，observer 已以显式 opt-in 接入生产 route/context/tool；默认模式和个人配置不变，legacy 未退休。

### 本批实施（3.2–9.2）

- `src/observer-routing.ts`：纯预算预留／完成／重置、消息作用与动作级能力 reducer；同任务窗口、临时 respond、dirty/control/gate、有限继承和冷却；不新增权限字段。
- 新增 `src/observer-judge.ts`、`observer-guidance.ts`、`observer-handoff.ts`、`observer-runtime.ts`；runtime 文件组织任务3/6/8的薄 Pi adapter helpers，index 复用物理 resolve。目录只来自runtime，公开输入和guide/carry有界，Jev-only一次主观察＋独立handoff，普通continuation/retry sticky。
- 旧 route/guard/handoff/reminder/status/工具激活统一 resolved mode；explicit legacy／冲突仍保留旧保护。observer不消费旧协议或制造新回合。SDK fixture允许宿主虚拟catalog placeholder用于真实resume/fork；既有session harness改为像Pi一样允许多个同名handler，避免错误覆盖事实handler。
- 正式离线测试覆盖budget并发／持久失败／取消／fork祖先预留、有限事实、目录／explicit-only／有界输入／strict parser、纯多轮与生成轨迹、guide、handoff、mode矩阵、生产SDK同轮provider／外部权限／工具error replacement／retry／steering／reload/tree/fork/resume/compaction／耗尽。最新 `npm run typecheck`、`npm test` **263/263**（日志 `/tmp/pi-observer-complete-offline.log`）；生产SDK＋budget连续3次 **31/31**，`git diff --check`通过；新SDK无真实fetch。
- README、JSONC示例、CONTEXT及 [验证记录](../../../docs/observer-guided-routing-verification.md)已同步配置／迁移／隐私／A1–A20追溯；早期证据保留历史身份。
- 真实smoke默认仅打印计划；离线测试验证默认不联网、认证预检查失败时安全分类／清理。用户已许可联网，实际上限6次Jev/4次chat，执行5次Jev/3次Sol-high，strict有效5/5，当前最大20问题有效；无read工具时目录不可见，source methodGate置信不足拒绝交接，accepted/consumed均未发生。不是完整真实验收，9.3不勾选；详见报告。
- 本批基线 `/var/folders/39/0wt_dlq12_qcs0fjw149978c0000gn/T/pi-observer-batch3-before.json`：仅本批计划范围原文件变化；其他已有脏文件及个人auth/models/router settings SHA-256不变，没有删除旧文件、提交或推送。治理复核 aligned，scope: architecture；未知gate／precision／质量／cache限制保留。

### 历史：第一批 SDK 与第二批契约

- 新增 `test/helpers/observer-sdk-fixture.mjs`：真实 Pi SDK/runtime、合成目录与三个 physical targets、可控 classifier/mock stream、内存或临时持久 session、确定性 deferred/abort、公开接口的 reduced-capability／append-error adapter；禁止真实 fetch，默认关闭 retry、provider retry、cache warming 与 catalog network。不读取个人认证文件。
- 新增 `test/observer-sdk-contract.test.mjs`：30 项契约测试，涵盖 route→state→普通 context→同轮 provider、system/tool 声明、toolCall/result 配对、steer/follow-up/continuation/retry、metadata 与 explicit-only、forced prompt／后置目录变更／indirect reader、projection/context edit/compaction、tree/fork/resume/reload、pending、abort、迟到 classifier、transform/handled 和缺少公开 SDK 能力。
- Fresh 验证：`npm run typecheck` 通过；`npm test` **151/151** 通过（基线 121＋新增 30）；单独执行 `node --test test/observer-sdk-contract.test.mjs` 连续 3 次，各 **30/30** 通过；`git diff --check` 通过。全部 mock 调用的 `networkCalls=0`，没有扩展错误。
- 相对实施前 SHA-256 基线，原有文件仅四个 observer 规格文件变化（审批／生命周期和本段任务记录）；已有生产源码、既有测试、个人 router/settings/auth/models 文件 hash 未变。新增两个正式测试文件；临时 session/Skill/空认证存储在 fixture 清理时移除，fetch 与环境变量恢复。
- SDK 细节：Pi 可创建空的临时 `auth.json`，因此自检验证其内容为空且最终删除，不以文件存在误报凭据泄漏；宿主在 session restore 前提供虚拟模型 catalog entry，bind 后由真实扩展 route 接管，恢复测试明确覆盖这一宿主契约。
- 限制：测试中的 probe 不是 observer 策略实现；reduced adapter 只提供缺能力 seam，不证明生产降级已实现。网络封锁与 synthetic classifier 不证明 Jev 概率精度、21 问题容量、推荐质量或收益。后置 `context_with_system` 可改写 provider 可见目录，load order 限制已正式测试，不能将捕获快照当作最终全局可见性保证。
- 治理复核：**aligned，scope: architecture**。本批仅增加测试 seam；owner、业务权限、方法审批、legacy 生命周期及默认配置未改变，无新增聊天判断层或运行 owner。

### 第二批：状态、模式与 source identity

- 新增 `src/observer-routing.ts` 和 observer 类型：版本化白名单解析、不可变快照、完整 envelope／输入／packet／guide 的 Unicode 与 UTF-8 byte 预算、纯 JSON／有限数组／深度校验和稳定 digest。未知字段不传播，accessor/toJSON 不调用；旧／未知状态只能按独立匹配的真实 source 提取 physical pair，不恢复旧业务阶段或 acceptance。持久化 observation 不能靠 valid 标签绕过 strict 概率规则。
- `src/gears.ts`／`src/settings.ts`：observer 默认参数与显式 opt-in、唯一模式决策表、冲突 legacy 优先和 invalid-mode 诊断；独立引导／Skills／stageAware 开关；floor 超过当前 band 表时映射最高 band并记录 clampedFloors，不降到 light。fingerprint 归 observer 纯策略模块所有，包含模式、协议版本、策略、bands／targets 和预算；不反向让基础 gears 依赖 observer reducer。未启用 observer 时既有 task/legacy fingerprint 不变。
- observer 涉及的项目 router override 只有 `projectTrusted:true` 才应用；缺少 trust 能力不视为授权。task/legacy 既有 overlay 保留。invalid mode 特意不继承 user 的 observer opt-in，回到旧 flag 兼容 owner并诊断。配置函数已提供 trust 参数，实际 Pi 消费者接线留到 6.2。
- `src/observation.ts` 新增显式注册的 `createObserverIdentityTracker`，尚未由生产入口调用：绑定真实持久 user entry 的完整本地 content digest（不受外发裁剪影响），同时保存 projected public source 与投影 digest；raw input 只递增 epoch，不解释批准。复验 branch/session/input epoch、真实最新 user、投影、policy/catalog、mode/model、pending 和 abort，正常诊断追加不因 leaf 增长误判；不读取 abandoned branch补证据。
- 新增 `test/observer-state.test.mjs`（15项）、`test/routing-mode.test.mjs`（4项）、`test/observer-identity.test.mjs`（9项），扩展 `test/settings.test.mjs`（3项）。identity 包含真实 SDK delayed-route＋steering 和 reload 测试，不以单纯 mock 函数调用替代接线验收。
- Fresh 验证：`npm run typecheck` 通过；`npm test` **182/182** 通过（上一批151＋本批31）；identity 测试连续3次，各 **9/9** 通过；`git diff --check` 通过。离线 SDK测试 networkCalls=0。
- 第二批开始时已记录独立 SHA-256 基线；本批仅修改 `src/{types,settings,gears,observation}.ts`、`test/settings.test.mjs` 和本任务记录，并新增上述四个源／测试文件。既有其他脏文件未改，个人 settings/auth/models hash 未变，没有 Git 提交／推送。
- 治理复核：**aligned，scope: architecture**。纯契约与 Pi source adapter 分工明确；没有新增聊天 owner、开发方法机、权限批准或 legacy retirement。observer 仍未接入 route/guard/tool/status；C1 不是 C3/C4或发布验收。调用 reservation、budget reducer、Jev adapter、引导及 handoff 尚未实现。

### 当前完成证据与联网边界

用户已明确许可真实网络测试；两次有界合成smoke均已执行，计划事前公布，临时认证清理、个人文件hash不变。默认测试不联网；不发送真实用户任务数据，不为通过降低阈值，不循环重跑。

第二次 `--visible-catalog`：6次Jev/3次主模型，83字段strict格式有效、runtime推荐抵达provider；独立readiness的ready/scope/clarity/methodGate可信，但capability confidence0.37<0.80，拒绝降档。后续解释临时respond到light/low，持续任务需求保留。报告 `passed:false`，独立保存首次报告；不是全部真实验收。

最终9.3已完成：[专项诊断](../../../docs/observer-capability-diagnostic.md)保留8call四组对照。仅补全评分锚点且更新fingerprint，不裁掉真实请求/gate、不放宽0.80。v2生产第一次已消费但发现ledger回退transition，复核标partial；owner/SDK红绿回归后最终 `--budget-fix` 6Jev/3chat三阶段全部true，83字段valid，Sol-high→Luna-high仅一band，随后解释保留taskBand2/transitions1。累计本系列31Jev/12chat；新报告独立保存、个人hash不变／临时认证清理。语义精度／gate／召回／长轨迹／费用限制保留。

迟到usage已补默认deadline／取消两类回归：同源分支只记录stale accounting、一次usage、保留attempts，branch/runtime变化不写新branch；迟到结果不改变route/acceptance。mode往返不能复活pending；显式Skill选择不推荐替代候选。fresh类型／全套263／syntax／diff及3次SDK-budget31复跑通过；ledger单调预算回归红绿通过。

## 实施任务

- [x] 1. 固化 Pi SDK 接线与上下文契约

- [x] 1.1 建立可复用的离线 SDK fixture
  - 依赖：无；任务批准后开始。
  - 范围：新增 `test/helpers/observer-sdk-fixture.mjs`、`test/observer-sdk-contract.test.mjs`；复用 `test/sdk.test.mjs` 的公开 SDK 构造方式，不依赖临时 `/tmp` 脚本。
  - 提供合成 Skill 资源、多个 physical targets、可控 classifier 结果与延迟、mock stream、内存 session 和统一事件／派发记录；显式禁止真实 fetch，禁用 retry/cache warming/catalog network 默认行为。
  - fixture 不读取个人认证；清理 session、临时文件与环境变量，确保失败路径也清理；支持工具 continuation 与排队消息，不把 mock 输出当作业务模型能力证据。
  - 验收：fixture 自检和相关既有 SDK 测试通过；networkCalls=0，测试无个人配置写入或持久资源残留。
  - _Requirements: R7.6, R9.6, R10.5, R10.6；Design: §2.2, §11.1_

- [x] 1.2 将路由、目录与同轮 context 顺序变为正式契约测试
  - 依赖：1.1。
  - 范围：`test/observer-sdk-contract.test.mjs`，必要的合成 fixture 数据。
  - 验证 user entry 先持久化，route state 在普通 `context` 前可见；request-local custom 建议进入同次 mock provider，leading system／工具声明和 toolCall/result 配对保持不变。
  - 覆盖初始 prompt、steering、follow-up、ordinary continuation 和 retry；明确 queued steering 不重新触发 `before_agent_start`，custom/compaction 的 user-role 转换不成为真实用户 identity。
  - 覆盖 reader、indirect reader、forced prompt、目录被后置 handler 修改、`context` 无 system 的契约；不得靠读取私有 runtime 字段取得 Skill 清单。
  - 验收：断言具体事件顺序、真实 user identity、同轮建议内容及无额外自动回合，而非仅断言函数被调用。
  - _Requirements: R1.5, R3.1, R4.3, R7.1, R7.4, R9.5；Design: §2, §4.1, §5.1_

- [x] 1.3 固化分支投影、取消与恢复所需的 SDK seam
  - 依赖：1.1、1.2。
  - 范围：`test/observer-sdk-contract.test.mjs`、fixture helper。
  - 用公开 SessionManager projection／branch Interface 验证 compaction、context edit、tree/fork/resume/reload 的源条目定位与 runtime generation 更替；原始 branch 与模型可见 projection 分开。
  - 提供可确定调度的 pending input、abort、session replacement、append failure 和不完整 SDK adapter fixture，供后续路由／交接测试复用。
  - 验收：能稳定复现异步工作期间 identity 失效；active branch 之外不补取证据；缺能力时可明确降级，不靠 timing sleep 获得偶然通过。
  - _Requirements: R7.5, R9.4, R9.5, R10.2；Design: §4.1, §7.3, §11.1_

- [x] 2. 建立版本化状态与唯一模式配置

- [x] 2.1 实现 observer 数据契约与有界校验
  - 依赖：1.2。
  - 范围：`src/types.ts`、新建 `src/observer-routing.ts`，新增 `test/observer-state.test.mjs`。
  - 定义 RequestIdentity、ObserverInput、字段 validation outcome、task/turn capability、method/control/execution facts、预算、guide 和 capability event 类型；新状态为 `schema:"observer-routing", version:1`，不复用旧 workflow 含义。
  - 实现不可变白名单解析、JSON/Unicode/数组/byte 上限、稳定 digest；state≤64 KiB、完整 event≤16 KiB，含 envelope，不仅校验 packet body。
  - 旧／未知版本只允许兼容提取合法同轮 physical pair，不恢复 observer 判断或 accepted handoff；未知字段不得传播；不新建庞大的通用 schema／方法状态机。
  - 验收：边界、NaN/Infinity、非纯 JSON、原型对象、非法 profile/version、超限、旧事件及输入不变性测试通过。
  - _Requirements: R1.4, R5.6, R9.4, R9.6, R10.3；Design: §3–4, §8_

- [x] 2.2 实现 observer 设置、模式决策表与 fingerprint
  - 依赖：2.1。
  - 范围：`src/settings.ts`、`src/gears.ts`、`src/types.ts`，扩展 `test/settings.test.mjs`，新增 `test/routing-mode.test.mjs`。
  - 添加 `routingMode` 和 observer guidance/skills/stageAware/floors/budgets 配置，按设计默认值及硬上界校验；未设置 mode 保留由旧 flag 推导的行为。
  - 实现唯一 resolved mode：冲突 legacy 优先并报告；explicit legacy 即使旧 flag false 仍有一致语义；enabled=false 优先。项目 override 尊重 trust，SDK 缺少相关能力时不擅自启用项目控制。
  - fingerprint 包含 mode、schema/parser、预算、profile 与目录规则版本；保留未启用 observer 时既有 task/legacy 配置语义。越界 floor 映射最高 band并诊断，不回退 light。
  - 验收：完整决策表、JSONC overlay、非法值、缩减 bands、独立开关、trust 和 fingerprint 测试通过；不修改个人设置。
  - _Requirements: R4.7, R5.7, R9.1–R9.3, R9.7, R10.1；Design: §6.1, §8.1, §9_

- [x] 3. 接入可信源 identity、预算与公开事实

- [x] 3.1 实现 source user identity 与失效复验
  - 依赖：1.3、2.1、2.2。
  - 范围：`src/index.ts` 的薄 Pi adapter helpers、`src/observation.ts`，新增 `test/observer-identity.test.mjs`。
  - source 绑定真实持久 user entry及完整内容本地 digest；维护 input/branch/runtime epoch，不将任意 provider-visible user 文本视为用户新消息。
  - raw input只记意向；handled/transformed input不伪造授权。新排队输入保守作废 pending handoff；复验 source 是否仍在当前 branch、最新 user、model/mode、policy/catalog、signal与pending，不用全 leaf 相等阻止正常自有记录追加。
  - 验收：重复 route、context edit、正常诊断追加、manual model gap、steer/follow-up、目录/策略变化和取消都得到明确 identity 结果；不会抢占已发送请求／工具。
  - _Requirements: R2.2–R2.4, R7.1, R7.5, R9.10；Design: §2.3, §4.1_

- [x] 3.2 实现调用预留、去重与 branch-scoped 用量记录
  - 依赖：3.1。
  - 范围：`src/observer-judge.ts` 的调用 adapter、`src/observation.ts`、`src/observer-routing.ts` 的纯预算逻辑，新增 `test/observer-budget.test.mjs`。
  - 网络调用前先成功持久化 callId/evidenceKey reservation；默认每任务24、硬上界64，两类 classify共用；repeat route复用完成结果或in-flight promise，不重复扣额度／调用。
  - 分开 logical calls与transport attempts，尝试后失败／取消不返还额度；未知关系保留预算归属，可信新任务可按设计重置，耗尽后不以reload/resume或自然语言猜测绕开。
  - 过期usage不得提交routing state；source仍在当前branch时关联诊断，session/tree已切走不把旧结果写到新branch，报告accounting coverage不足。持久化／事件覆盖不足时禁用相关自动能力。
  - 验收：预留失败不调用、并发去重、取消后计数、预算边界、unknown/new task、跨branch结果与usage缺失测试通过；纯reducer不直接appendEntry。
  - _Requirements: R7.6, R9.4, R9.5, R9.9, R9.10；Design: §3, §8.1, §10_

- [x] 3.3 实现有限执行与 Skill 读取事实
  - 依赖：3.1、2.1。
  - 范围：`src/observation.ts`、`src/observer-guidance.ts` 的局部事实适配，扩展 `test/observation.test.mjs`，新增 `test/observer-facts.test.mjs`。
  - 复用已有受支持 verification command识别，只记录成功／失败等标签和来源；失败标dirty并作废旧降档候选，不在每个tool result调用Jev或自动升档。
  - 成功read命中当前runtime Skill identity记body-read-observed；可可靠关联的显式展开记explicit-expansion-observed；nested事件覆盖不足为unknown，不保存完整参数／输出。
  - gate／方法事实保留reported/observed来源；读取不证明遵循，命令成功不证明业务完成，自然语言“完成”不触发路由交接。
  - 验收：同branch来源、目录版本、nested metadata不完整、重复事实、append失败及既有task/legacy观测回归通过。
  - _Requirements: R3.7, R7.2, R8.1, R8.5, R9.6, R9.8；Design: §4.2, §5.4, §6.1, §10_

- [x] 4. 实现运行时目录、有界输入与 Jev adapter

- [x] 4.1 实现 Skill 快照、候选 identity 与有限召回
  - 依赖：1.2、2.1、3.1。
  - 范围：`src/observer-guidance.ts`，新增 `test/observer-catalog.test.mjs`。
  - 捕获 `before_agent_start.systemPromptOptions.skills`，用公开prompt helpers与允许reader格式核对可见性；普通context使用branch projection／当前prompt／route fingerprint复验，不假装event.messages有system。
  - 建立本地identity/catalogVersion/generation和短candidateId；路径/sourceInfo留本地，不自行扫描目录。剔除禁用、explicit-only、不可见、不可读、重复／过期／未知候选；保留用户显式选择。
  - 小目录全部参与，大目录按已批准Unicode词面召回，最多12项、每description384字符、元数据总计6,000字符；零匹配不随机填充。保留total/considered/omitted/规则版本和未知覆盖。
  - 验收：甲乙不同目录、空目录、重叠描述、中文/Latin排序、目录reload/cwd变化、forced prompt及后置改写通过；没有自动加载／安装／执行Skill。
  - _Requirements: R1.2, R3.1–R3.6, R9.5, R9.7；Design: §5.1–5.2_

- [x] 4.2 实现有界观察上下文与显式 Skill 请求处理
  - 依赖：3.1、3.3、4.1。
  - 范围：`src/observer-guidance.ts` 的输入构造helpers、`src/observer-routing.ts` 的纯上下文逻辑，新增 `test/observer-input.test.mjs`。
  - 合并最新请求、task anchor／changes、routing需求、gate/control、有效handoff摘要、最近公开assistant文本和有限执行事实；缺失明确标记，不伪造审批。
  - 显式命令在有可靠对应时仅外发selectedSkill和用户附带请求，不外发展开全文/location/baseDir；不能用任意正则剥离内容冒称理解完整输入，无法可靠关联时标缺失并保护降档。
  - 落实每字段限制及整体32,000 Unicode字符／64 KiB JSON，先裁剪recent/metadata/history；不发送system、thinking/signature、图像、凭据、完整工具参数输出；图像仅标nonText。
  - 验收：长文本、emoji/中文UTF-8、裁剪优先级、显式-only命令、transform输入和敏感哨兵数据测试通过；原user内容不被改写。
  - _Requirements: R1.1–R1.5, R2.3, R3.3, R6.3, R9.6, R9.7；Design: §4.2, §8.1_

- [x] 4.3 实现单次多问题 schema 与严格字段解析
  - 依赖：2.1、4.2。
  - 范围：`src/observer-judge.ts`，新增 `test/observer-judge.test.mjs`。
  - 为relation/messageEffect/work/capability/clarity/risk/clarification/methodGate和至多12个Skill bool定义criteria；无task不问relation，初次最多20、已有task最多21个questions；不引入自由system文本、grant或complete。
  - choice校验exact label set、finite `[0,1]`、chosen最大、`abs(sum-1)≤0.001`；score/boolean校验范围。保留字段confidence/probabilities与invalid原因，不统一取所有字段最小值。
  - Pi成功解析的answers可局部有效；Pi已清空answers时整体fallback，不读取raw wire补造结果。有效低置信、缺失/无效、timeout和不可用分别记录；无法可靠归类的adapter错误不猜测。
  - 验收：0.99/1.00/1.01、归一容差两侧、NaN/Infinity、非法choice、额外标签、bool、partial、unknown及usage保留测试通过；不归一化伪造概率。
  - _Requirements: R1.3, R1.4, R1.6, R6.1, R6.5, R6.6, R9.9；Design: §4.3, §8.2–8.3_

- [x] 4.4 实现一次调用 owner、deadline 与故障收束
  - 依赖：3.2、4.3。
  - 范围：`src/observer-judge.ts`，扩展adapter/budget测试。
  - 只使用 `typesafe/jev-latest` classifier，明确不开放chat observer或路由递归；adapter显式maxRetries=0，不与既有resilientFetch叠加retry。
  - 默认0、可选最多1次transport retry，共享包含auth/等待/transport的15秒配置deadline与abort；invalid、low-confidence和handoff拒绝均不隐式修复重试。
  - 记录kind/trigger/callId/elapsed/attempts与实际报告usage；取消传播，返回前复验identity；异常持久诊断只用白名单原因，不保存原始URL/响应/凭据。
  - 验收：缺模型/认证、超时、transport中断、取消、迟到结果、零usage／缺usage和无第二判断调用的测试通过。
  - _Requirements: R1.3, R1.6, R6.5, R7.6, R9.9, R9.10；Design: §8, §10_

- [x] 5. 实现纯消息作用与能力 reducer

- [x] 5.1 实现任务连续性、控制消息与等待来源
  - 依赖：2.1、3.1、3.3、4.3。
  - 范围：`src/observer-routing.ts`，新增 `test/observer-routing.test.mjs`。
  - 保留anchor与最近3次userChanges；same_task、可信new_task、uncertain/provisional分别处理；新目标不继承旧高需求、候选或handoff。
  - explain保留task／方法状态，仅改变本轮工作；pause/cancel/narrow_scope使pending失效，cancel任务inactive，新增未定范围回到收敛需求，引用或历史文本不是新授权。
  - methodGate保留source与reported标签；none_observed不清除旧等待，waiting/unknown抑制持续降档和交接但不阻塞高能力调查／独立解释；歧义批准／指代建议澄清。
  - 验收：A3/A5/A6、多意图、引用越权指令、旧gate与新用户依据的多轮轨迹通过；无统一开发阶段推进或新增权限字段。
  - _Requirements: R2.1–R2.4, R2.6, R6.3, R8.1, R8.2, R8.6；Design: §4, §6.2–6.3_

- [x] 5.2 实现动作级不确定性与 profile 下限
  - 依赖：5.1、2.2。
  - 范围：`src/observer-routing.ts`、既有band helpers，扩展纯路由测试。
  - 实现设计的choice可行集合、相关字段0.80门槛及保守共同动作；risk low/medium犹豫不否决明确调查，无效risk不阻止保守升档但不能支持降档。
  - 将 substantive requirements/design/task_plan/复杂investigate/diagnose映射converge，明确实施implement、验证verify、简单问答respond；不能因review/research排除高能力，也不能全部问答heavy。
  - 组合score、profile floor、风险与未知保护；分开requested/protected/task/turn能力。stageAware=false不用floor/交接，仍有task-aware同等保护；profile不规定工具权限。
  - 验收：A1/A7/A10/A11、默认/自定义bands、partial字段、图像、风险/clarity边界测试通过；没有业务complete或方法强制顺序。
  - _Requirements: R5.1–R5.6, R6.1–R6.4, R8.2, R8.3；Design: §6.1–6.2_

- [x] 5.3 实现有限继承、任务降档窗口与临时 respond
  - 依赖：5.1、5.2、3.2。
  - 范围：`src/observer-routing.ts`，扩展纯轨迹与预算测试。
  - 满足相同策略/目标可用/已知覆盖、无dirty/gate及未达上限才复用纯继续，默认最多3个用户回合；指代批准不能进入词面继承捷径。
  - 保留2个不同evidenceKey和0.08 margin保护；repeat/retry/继承不增加样本，临时explain/answer不污染taskBand/window，之后真实继续恢复持续工作需求。
  - 定义交接所用降档上限、至少2个新实质观察的冷却与转换计数；可信独立新任务不被旧高能力锁定，budget exhaustion仍允许主模型正常回答。
  - 验收：A4、explain→continue、重复样本、边界噪声、dirty到期重评、冷却和预算耗尽轨迹通过；无周期轮询。
  - _Requirements: R2.5, R5.4, R5.7, R7.1, R7.6；Design: §6.3, §8.1_

- [x] 6. 实现引导并接通互斥路由入口

- [x] 6.1 实现受控引导、去重与请求级投影
  - 依赖：4.1、4.2、5.1、5.2。
  - 范围：`src/observer-guidance.ts`，新增 `test/observer-guidance.test.mjs`。
  - 只用本地验证name/定位、固定原因和标签构造advisory；description原文／classifier自由文本不作为指令。有效bool≥0.70，最终最多2候选、800 Unicode字符／2 KiB。
  - 同task/effect/work/catalog/candidates/control键去重；每回合一个新guide、默认每任务6个，区分prepared/projected/response-observed；已选方法、已读／明确拒绝和被忽略的同建议不反复催促。
  - 普通context按源位置重投影同guide，保持工具配对；新user不投影旧建议；无法定位时省略并诊断，compaction必要carry摘要≤2,000字符／4 KiB，仅工作材料不含下一阶段命令。
  - 验收：恶意name/description/path、显式选择、重叠候选、retry/continuation去重、关闭引导、定位缺失和目录失效通过；不加载全文、不写system、不触发新回合。
  - _Requirements: R3.4, R3.5, R4.1–R4.7, R8.6, R9.6；Design: §5.2–5.4_

- [x] 6.2 让旧控制全部使用唯一 resolved mode
  - 依赖：2.2；与6.1可分别实施，但合入运行路径前都须验证。
  - 范围：`src/index.ts`、`src/workflow-guard.ts`、`src/workflow-handoff.ts`、`src/observation.ts`，扩展workflow handler/router/mode回归。
  - route、guard、context、reminder、status、工具激活均依赖同一个resolved mode；explicit legacy/冲突保留旧控制，observer不执行旧guard/reminder/complete reducer。
  - 旧handoff在非legacy execute层拒绝，新工具在非observer execute层拒绝，不能靠inactive/exposure代替mode校验；不alias旧accepted事件或complete packet。
  - 模式变化使旧窗口／pending失效，仅保留合法同轮physical pair；不修改既有旧规格的批准记录，不删除legacy兼容路径或外部permission机制。
  - 验收：决策表所有模式的handler注册/激活/execute、单owner、冲突diagnostic及旧task/legacy行为通过；已授权设计文档不被observer profile禁写，外部权限仍能阻断。
  - _Requirements: R8.3, R8.4, R9.2, R9.3, R10.1–R10.3；Design: §9.2–9.3_

- [x] 6.3 接入新用户观察路由与同轮引导纵向切片
  - 依赖：1.1–1.3、3.1–3.3、4.1–4.4、5.1–5.3、6.1、6.2。
  - 范围：`src/index.ts`，新增 `test/observer-router.test.mjs`、`test/observer-sdk.test.mjs`，复用既有physical resolve helpers。
  - 先处理direct/disabled/manual兼容路径，再按reason走repeat/inherit/一次observe／sticky；observer state用discriminant识别，旧state不被强制转换为新task或accepted材料。
  - 接通budget reservation、纯decision、physical availability/auth/thinking clamp、branch state保存及普通context复验投影；保持requested/protected和actual dispatch分离。
  - context不再调用Jev；ordinary continuation/retry只sticky，此切片尚不开放能力handoff。不得通过sendUserMessage/triggerTurn/settle continue补齐流程。
  - 验收：同轮guide确实进入mock provider，重复route仅一次classify；fallback、auth缺失、clamp、direct/disabled/manual无引导、SDK覆盖不足回归通过。全套离线测试通过后进入交接接线。
  - _Requirements: R1, R2, R4, R5.6, R6.5, R7.1, R7.4, R7.7, R9.2, R9.5；Design: §2.3, §3, §8–9_

- [x] 7. 实现有界显式能力交接

- [x] 7.1 实现 packet、工具 schema 与本地候选门禁
  - 依赖：2.1、3.1、5.1、5.2、6.2。
  - 范围：新增 `src/observer-handoff.ts`、`test/observer-handoff.test.mjs`。
  - 定义 `gear_capability_handoff` 为默认inactive、sequential工具；packet v1字段及text≤1,000、列表≤8、steps≤8、acceptance≤4、总8,000字符／16 KiB边界；不接收任意model/provider、complete或隐藏推理。
  - 检验source task/user、当前branch/mode/model、epoch/policy/catalog、pending/control/gate、预算及packet digest；implementation需范围/步骤/验收/validation非空、无blockingUnknowns。
  - permissionEvidence仅引用真实user且摘要不升格批准；旧授权不拓展新scope，waiting/unknown不放行，packet的none_reported不清gate；结果固定说明只交接能力。
  - 验收：非法/超限/旧版packet、伪造source、引用权限、错误model/mode、等待审批、provider工具变更后execute复验通过；无网络即可完成本地拒绝测试。
  - _Requirements: R6.3, R7.3, R7.5, R8.1, R8.2, R9.6, R10.3；Design: §7.1–7.2_

- [x] 7.2 实现一次独立 Jev readiness 与持久接受记录
  - 依赖：7.1、3.2、4.3、4.4。
  - 范围：`src/observer-handoff.ts`、`src/observer-judge.ts`，扩展handoff/adapter测试。
  - 有效候选一次classify合并readiness/scope relevance/clarity/risk/capability/methodGate，不附Skills、不调用聊天模型；相关字段≥0.80才可接受，低风险证据不可靠不得降档。
  - 完成后复验所有identity/gate/pending/signal；branch accepted event追加成功才返回accepted ID/profile/bands/digest/有限packet。拒绝、失效、invalid和append failure不留内存acceptance。
  - accepted/rejected/invalid所有路径记录实际报告usage/attempts，不重复与tool result用量计入；none_observed不作为审批证明，高风险或unknown允许保守更高能力但不机械降档。
  - 验收：ready/blocked/needs_convergence、partial、0.99无效概率、低置信、gate否决、异步steering/取消、append失败和usage缺失测试通过。
  - _Requirements: R6.1, R6.3, R6.5, R7.3, R7.5, R8.1, R9.8–R9.10；Design: §7.2, §8_

- [x] 7.3 实现下一合法 continuation 消费与一次能力转换
  - 依赖：6.3、7.2、5.3。
  - 范围：`src/observer-routing.ts`、`src/index.ts`、`src/observer-guidance.ts`，扩展router/handoff/SDK轨迹测试。
  - 只消费当前有效accepted事件及非错误source tool result；retry永不消费，ordinary continuation无有效交接保持actual pair；被外部权限拦截或结果被替换为错误不能算接受。
  - 同run降至多一个band且不低于target floor/风险/当前需求，一个source work revision只允许一个降档候选；冷却/转换预算保护，升档可到必要能力。
  - profile已消费不表示physical pair必然变化，已准备派发不表示响应完成；user/scope/mode/model/branch/catalog/wait变化先失效，compaction无法关联source则不猜测。
  - 验收：A9/A10/A16/A19、accepted但同pair、fallback、provider retry后合法续接、重复包、转换预算、carry上下文及自然结束不制造回合通过。
  - _Requirements: R5.2, R5.3, R5.6, R5.7, R7.2–R7.7, R8.5, R10.2, R10.3；Design: §6.3, §7.3_

- [x] 8. 完成诊断、恢复与安全兼容回归

- [x] 8.1 实现结构化诊断与仅 TUI 状态展示
  - 依赖：6.3、7.3。
  - 范围：`src/index.ts` 状态adapter、`src/observation.ts`，扩展 `test/status.test.mjs`，新增 `test/observer-status.test.mjs`。
  - 显示观察/复用/不确定/失败、turn profile、requested/protected及actual model/thinking/fallback、预算与coverage，分开多问题单调用和独立handoff调用。
  - Skill区分candidate/prepared/projected/read/explicit expansion/following unknown；handoff区分proposed/accepted/invalidated/consumed/physical response observed；不输出业务blocked/complete或“已批准实施”。
  - 非TUI不调用UI；缺usage/目录price=0不写免费，诊断不持久化原始服务异常/URL或敏感内容。
  - 验收：TUI/print/RPC、错误类别、mode冲突、未知覆盖、缺usage/zero price及接受未切换测试通过。
  - _Requirements: R1.6, R3.7, R5.6, R8.5, R9.5, R9.8, R9.9；Design: §8.3, §10_

- [x] 8.2 完成 branch/reload/resume/compaction 与异步结果隔离
  - 依赖：1.3、6.3、7.3、8.1。
  - 范围：`src/index.ts` 生命周期adapter，扩展 `test/session.test.mjs`、observer identity/budget/SDK测试。
  - 恢复已消费profile/taskBand/dispatch、guide去重与调用预算；reload/resume/tree/fork使未消费accepted及旧目录快照失效，不能借恢复重置预算或继承abandoned branch判断。
  - compaction同run有效identity保留状态和有界材料，源定位不足无guide/无消费；切换session后的迟到结果不写新branch，新user优先，不抢占Pi队列。
  - SDK不完整时禁用相关建议/交接并报告reduced coverage；保留同轮合法physical pair，不伪造事实。取消后的真实attempts不抹掉。
  - 验收：恢复/切换/取消矩阵及context edit、manual gap、auth/policy/catalog变化、append失败全部通过；无过期注入、跨branch接受或无限重评。
  - _Requirements: R3.6, R4.6, R7.5–R7.7, R9.4, R9.5, R9.10, R10.2；Design: §4.1, §5.3, §7.3, §8.1_

- [x] 8.3 建立 A1–A20 端到端与不变量回归
  - 依赖：8.1、8.2；前述各功能测试均通过。
  - 范围：`test/observer-sdk.test.mjs`、`test/observer-router.test.mjs`及既有task/workflow测试。
  - 将下文追溯表转为命名fixtures；分别断言Skill候选有效性与能力路由，不用一个混合评分掩盖错误。
  - 测试未授权代码／授权设计文档、外部permission阻断、Skill等待审批而Jev ready、自然结束无handoff、未读Skill、测试通过仍待验收、恶意引用与description；仅证明router未扩权，不冒称语义建议构成安全隔离。
  - 用有界生成轨迹检验repeat/retry不增样本、不消费旧协议、task/turn分离、budget单调、每请求单owner、无额外自动回合；避免引入大型通用workflow测试框架。
  - 验收：A1–A20和全部既有task/legacy离线回归通过，networkCalls=0；源码diff七维评审明确旧控制隔离而非漏留。
  - _Requirements: R1–R10；Design: §9.3, §11_

- [x] 9. 更新用户文档并交付分层验证证据

- [x] 9.1 更新配置、迁移与隐私使用文档
  - 依赖：8.3。
  - 范围：`README.md`、`example.settings.json`、`CONTEXT.md`；引用新规格迁移表，不改写旧approval历史。
  - 文档覆盖默认关闭、独立开关、legacy冲突优先、唯一owner、显式交接、降档窗口/预算、目录覆盖不足、explicit-only与推荐/读取/遵循差异。
  - 告知request/公开摘要/Skill name-description外发TypeSafe，路径/正文默认留本地；guidance关闭不等于停止观察，skills关闭停止元数据外发；截断不是脱敏、price=0不是免费、不承诺cache/费用收益。
  - 说明旧guard/reminder/complete只在legacy适用，后续删除另须批准；预算耗尽后仍可回答但需要按设计显式新session或手动调整路由，不自动安装/启用Skill。
  - 验收：示例JSON及mode行为与测试一致，文档链接有效；用户个人文件hash不变。
  - _Requirements: R3, R4.7, R8, R9, R10.1, R10.3, R10.6；Design: §9–10_

- [x] 9.2 执行完整离线验证并记录覆盖与限制
  - 依赖：9.1。
  - 范围：新增 `docs/observer-guided-routing-verification.md`，任务状态仅据实际证据更新。
  - fresh运行 `npm run typecheck`、`npm test`、新测试/脚本语法检查与 `git diff --check`；记录命令、测试数、结果及A1–A20对应证据。
  - 分别记录SDK契约、mock语义、parser有效性、推荐与路由结果；保留真实概率精度、合并schema容量、大目录召回、任意Skill gate、真实多轮/provider-cache尚未证实的限制。
  - 验收：离线检查全部通过且失败／未执行项如实记录；没有把设计阶段探针或旧联网报告当作新功能验收。observer保持opt-in。
  - _Requirements: R10.2, R10.4–R10.6；Design: §11.1–11.3_

- [x] 9.3 实现独立 opt-in smoke，并经当时许可执行有界真实验证
  - 依赖：9.2；实际 `--run` 还依赖执行时用户明确许可，不由任务批准代替。
  - 范围：新增 `test/live-observer-smoke.mjs`，结果写入 `docs/observer-guided-routing-verification.md`及有限结构化报告；默认/离线模式networkCalls=0，不由 `npm test` 自动联网。
  - 预固定非敏感多轮fixtures、不同/无/大目录、最大21问题合并schema及显式交接场景；运行前公布模型/调用次数、transport attempts、deadline和输出预算，mock expected由人工复核。临时配置/凭据结束清理，不访问实际用户任务数据。
  - 实际运行保持批准的strict概率规则与门槛，不为通过临时放宽；分别报告概率invalid比例、Skill候选召回/采纳/质量、动作/路由正确性、handoff接受/实际dispatch、latency和服务usage；不是新模型排名或节省保证。
  - 验收：脚本默认安全、隔离/清理测试及有限联网报告齐全。未获许可或服务失败时保留本项未完成和原因，不据此开放默认模式；精度契约变更须先有证据并单独审批。
  - _Requirements: R6.6, R9.6, R9.9, R10.4–R10.6；Design: §4.3, §8.2, §11.1_

## 依赖与检查点

```text
1.1 → 1.2 → 1.3             SDK契约与可控竞态fixture
      ↓
2.1 → 2.2 → 3.1 → 3.2/3.3  版本、模式、identity、预算／事实
                      ↓
4.1 → 4.2 → 4.3 → 4.4      目录、输入、Jev parser与调用owner
               ↓
5.1 → 5.2 → 5.3            任务、动作级能力、窗口
        ↓
6.1 + 6.2 → 6.3            引导＋legacy隔离→用户路由切片
7.1 → 7.2 + 6.3 → 7.3      本地候选→readiness→合法continuation消费
                  ↓
8.1 → 8.2 → 8.3 → 9.1 → 9.2 → 9.3（实际联网另需许可）
```

依赖图是简写，每项正文的依赖为准。可并行的纯文件任务也不得并行编辑共享文件；先明确owner或按顺序合入。

- **检查点 C1（1–2完成，已通过离线验证）**：SDK接线可重复，状态及mode契约成立；不接新网络或handoff。纯配置解析不代表 observer运行消费者已迁移；消费者在6.2统一接线。
- **检查点 C2（3–5完成）**：有界输入、strict parser、预算与纯轨迹成立；不开放未实现的同run换档。
- **检查点 C3（6完成）**：观察/建议纵向切片及legacy隔离通过全套离线回归；新handoff尚不激活。
- **检查点 C4（7–8完成）**：只有显式有效handoff可破sticky；恢复、竞态、外部authority与A1–A20都有离线证据。
- **检查点 C5（9完成）**：文档与分层证据齐全；真实质量／发布限制明确。任何时点都不静默启用个人配置或删除legacy保护。

## 验收场景追溯

| 场景 | 主要子任务 | 正式测试重点 |
|---|---|---|
| A1 首轮Git/文档调查 | 4.1、5.2、6.3、8.3 | review/research可converge；候选来自实际目录，无修改授权 |
| A2 不同用户/无Skills | 4.1、6.1、8.3 | 自定义名字、空目录与独立路由 |
| A3 解释当前结论 | 5.1、5.3、6.1、8.3 | task/method不重置，不续做实施 |
| A4 纯继续 | 5.3、6.3、8.3 | 有限继承，无新调用或降档样本 |
| A5 暂停/取消 | 3.1、5.1、7.3、8.3 | pending先失效，新用户优先 |
| A6 新兼容范围 | 4.2、5.1、5.2、8.3 | 旧授权不扩展；收敛/澄清 |
| A7 已授权设计文档 | 5.2、6.2、8.3 | profile不是写权限；外部权限继续生效 |
| A8 等待批准而Jev ready | 5.1、7.1、7.2、8.3 | gate有来源，ready不能清等待 |
| A9 有效能力交接 | 7.1–7.3、8.3 | 接受/消费/actual分别验证 |
| A10 高风险/假设失效 | 5.2、5.3、7.3、8.3 | 不机械降档；合法边界可升档 |
| A11 风险label犹豫 | 4.3、5.2、8.3 | 共同调查动作不被统一门槛否决 |
| A12 不合法/过期候选 | 4.1、6.1、8.2、8.3 | explicit-only、不存在、不可见、失效不注入 |
| A13 重叠/忽略建议 | 4.1、6.1、8.3 | 候选有界、去重、不催促 |
| A14 引用越权指令 | 4.2、5.1、6.1、8.3 | description/引用是数据，不成为授权 |
| A15 超时/取消/steering | 3.1、3.2、4.4、7.2、8.2、8.3 | 迟到结果无注入/acceptance，用量不抹掉 |
| A16 continuation/retry/repeat | 1.2、5.3、6.3、7.3、8.3 | physical sticky，retry不消费 |
| A17 分支/恢复/目录reload | 1.3、4.1、8.2、8.3 | active branch、目录generation、未消费失效 |
| A18 验证过但未验收 | 3.3、8.1、8.3 | 验证事实不等于业务complete |
| A19 自然结束/没读Skill | 6.1、6.2、7.3、8.3 | 无reminder／自动回合／统一流程 |
| A20 旧协议/冲突/覆盖不足 | 2.1、2.2、6.2、8.2、8.3 | 单owner、版本隔离及reduced coverage |

R1–R10 的实现与测试引用分布在每项 `_Requirements_` 中；最终报告须逐场景记录结果，不能仅凭总体测试数宣布需求全部实现。
