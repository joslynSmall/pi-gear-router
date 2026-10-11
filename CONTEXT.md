# 任务感知模型路由

这里描述跨对话回合执行用户目标时的能力需求。任务持续性与最新消息的字面复杂度不是同一概念。

## 领域语言

**用户回合（User turn）**：
一条用户消息及其发起的执行，包括工具跟进和重试。一个新用户回合不一定是一个新任务。
_避免混称_：任务、判决样本。

**任务（Task）**：
一个可以跨多个用户回合持续处理的用户目标。同一会话中的独立新目标是新任务。
_避免混称_：会话、用户回合。

**任务阶段（Task stage）**：
任务中当前要求处理的那部分工作。同一任务的不同阶段可以需要不同能力。
_避免混称_：整个任务的永久难度。

**能力需求（Capability demand）**：
正确完成下一步工作所需的最低模型能力和思考深度，不是最新消息的长度或语言难度。
_避免混称_：消息难度。

**判决（Judgment）**：
分类器实际作出的能力需求评估，必要时也包括任务关系。复用旧判决不是一次新评估。
_避免混称_：继承样本。

**继承决策（Inherited decision）**：
明确续接时沿用有效任务决策而不请求新的分类器判决。
_避免混称_：新判决、失败兜底。

**重评（Reassessment）**：
因新信息、不确定性或复用资格到期而进行的新判决。
_避免混称_：分数自动衰减。

**能力区间（Capability band）**：
模型档位与思考深度组成的五种有序能力组合。同一模型档位内部的思考深度变化也是能力区间变化。
_避免混称_：模型档位。

**承诺能力（Committed capability）**：
任务路由保护后决定采用的能力区间。它可能暂时高于最新判决建议，但不改变最新判决本身。
_避免混称_：原始评分、实际模型能力。

**观测上下文（Observation context）**：
作出判决时可见的任务要求、公开执行信息及结构化事实。内容不同不等于任务真的取得进展，也不等于统计独立。
_避免混称_：成功证明、独立实验。

**派发（Dispatch）**：
实际用于执行的物理模型与其支持的思考等级。模型不可用或能力裁剪时，它可能不同于请求的能力组合。
_避免混称_：请求能力区间。

## legacy 阶段编排领域语言

本节只用于 `legacy-workflow` owner，不是 observer 的方法／权限定义。legacy 尚未退休；新旧 owner 互斥。

**工作流（Workflow）**：
由一条交付型用户请求开始、在同一个 Pi agent run 中受控推进的过程。v1 为显式 opt-in；它不是跨 session 编排，也不是模型缓存迁移。
_避免混称_：整个会话、任务栈。

**工作流阶段（Workflow phase）**：
`planning`、`execution`、`verification`、`recovery`、`complete`、`blocked` 之一。planning/recovery 是高能力、默认只读的收敛阶段；execution/verification 是实现和证据阶段。
_避免混称_：任务的永久难度、普通用户回合。

**Profile 下限（Profile floor）**：
配置指定的阶段最低 capability band。它是所需能力而非实际 physical dispatch；当目标不可用时的 fallback 不会降低该需求。
_避免混称_：模型价格、fallback 后的实际档位。

**交接包（Workflow packet）**：
模型以 `gear_workflow_handoff` 提交的有界 JSON 工作材料，包含目标、决定、范围、验收、风险和阻塞项等；不含 hidden thinking、完整工具输出或凭据。
_避免混称_：模型自然语言中声称“计划完成”的段落。

**接受的交接（Accepted handoff）**：
通过本地 packet/phase/budget 校验且由独立 Jev readiness 判定接受的 append-only branch event。只有它可让紧接 continuation 打破 ordinary sticky dispatch。
_避免混称_：提出的 packet、tool-looking 文本、Jev 评分本身。

**普通 continuation / retry**：
没有可消费 accepted handoff 时，工具跟进和失败重试都沿用本轮实际 physical model/thinking pair。retry 永不消费 handoff。
_避免混称_：交接 continuation。

**交接 continuation（Handoff continuation）**：
紧随 accepted handoff 的下一次 `reason:"continuation"` route。reducer 消费一次 packet，更新 phase/profile/active packet 后才可改变 physical pair。
_避免混称_：任意后续模型请求。

**活动回合（Active turn）**：
当前 phase 可接受 handoff 的 user turn identity。新用户 steering 会重新判定并替换该 identity，使尚未消费的旧 handoff 失效；用户消息高于旧 packet。
_避免混称_：workflow 的 initial turn、assistant/tool continuation。

**提醒与阻塞（Reminder / blocked）**：
交付型 planning/recovery 自然结束且没有交接时，最多追加一次隐藏 reminder continuation。第二次缺失、或转换预算耗尽时会写入 branch-scoped `blocked` event，停止自动推进而不阻止新的用户消息。
_避免混称_：错误重试、用户取消。

**验证事实（Workflow validation fact）**：
支持的验证命令产生的 branch-scoped `passed`/`failed` 记录，只保留命令类别和结果。completion 需要当前 active user turn 中最后一个同 workflow 验证事实为 `passed`；它不是对全部验收条件的完整数学证明。
_避免混称_：完整 shell 输出、自然语言“测试已过”。

**缓存边界（Cache boundary）**：
accepted phase switch 是正确性驱动的模型/effort 边界，可能引发 cold prompt cache。router 不实现、也不假设跨物理模型的 KV/prompt-cache 转移。
_避免混称_：能力 profile、交接包复用。

## 会话观察与引导领域语言

**会话观察者（Conversation observer）**：
从当前任务、最新消息和公开事实中形成解释与建议的角色，不拥有开发方法、审批或工具执行权。
_避免混称_：第二个执行 agent、工作流指挥者。

**消息作用（Message effect）**：
一条用户消息对已有任务的关系与影响，例如解释、续接、补范围、暂停、取消或开启新目标。
_避免混称_：整项任务意图、重新启动阶段。

**方法阶段（Method stage）**：
由用户、项目约定或所选 Skill 定义的工作步骤及其审批要求，不天然对应某个模型或工具权限。
_避免混称_：路由能力状态、统一开发阶段。

**路由能力状态（Routing capability state）**：
当前工作所需的模型能力与思考深度，以及能力变化的依据；它不表示已获实施许可或业务完成。
_避免混称_：方法阶段、操作授权。

**Skill 候选（Skill candidate）**：
从当前运行环境允许自动建议的实际 Skill 目录中选出的相关方法，不等于已经读取或遵循其正文。
_避免混称_：已启用 Skill、强制方法。

**会话引导（Conversation guidance）**：
根据观察结果提供的简短方法或澄清建议，不是新的用户任务，也不覆盖已选择的方法与约束。
_避免混称_：高优先级命令、自动审批。

**能力交接（Capability handoff）**：
为后续请求改变能力配置而接受的有界工作材料与转换依据，不代替开发方法的审批。
_避免混称_：用户授权、业务阶段已批准。

**来源 identity（Source identity）**：
当前 branch 的真实持久 user entry、完整内容本地 digest、input/runtime epoch 与 policy/catalog 的绑定。provider-visible custom user 文本不是新用户依据。
_避免混称_：leaf ID、分类器输入摘要。

**调用预留（Call reservation）**：
联网前成功持久化的有界逻辑调用与 evidence key；结果、失败和取消不返还已使用额度。transport attempts 和服务 usage 独立记录。
_避免混称_：未执行请求、免费重试。

**能力接受／消费／响应（Accepted / consumed / response observed）**：
accepted 是能力材料接受记录；consumed 是下一合法 continuation 更新能力；physical response observed 才说明实际物理模型产生响应。三者都不表示业务完成。
_避免混称_：获准修改、验收完成。

**覆盖不足（Reduced coverage）**：
公开 SDK source、目录或事件不可可靠取得时的诊断。禁用相关建议／交接，保留可验证物理兜底；不是检测到所有审批的证明。
_避免混称_：安全沙箱、全局方法状态机。
