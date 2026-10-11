# ADR 0002：只路由模型，不重复 Pi 的 Skill 选择

状态：已接受；取代 ADR 0001 中的 Skill 推荐、计划修订与单次切换限制。

## 原因

observer、task、legacy-workflow 叠加了任务识别、能力保护、交接材料、readiness、预算和方法引导。用户需要的是简单明确的模型路由，而不是另一个工作流引擎。需求理解、追问、完整性与正确性确认由 Skill 和用户负责。

Pi 已把可自动调用的 Skill 名称、描述和路径交给主模型，主模型按需读取正文。额外推荐是否有益需要对照，而不是仅证明 Jev 会选。

## 实测依据

相同的 18 个合成用例（15 个正例、3 个无需 Skill 用例），本机 35 个可自动调用 Skill：

| 方案 | 正例命中 | 无需 Skill 判对 | 预设答案之外的建议／读取意图 |
|---|---|---|---|
| Jev 全目录单选 | 15/15 | 2/3 | 1 |
| Pi 主模型，无路由提示 | 15/15 | 3/3 | 0 |

主模型使用 `magpie/zies/gpt-6-luna`、high，真实 Pi 系统提示词及 AGENTS.md，默认 read/bash/edit/write 工具；关闭其他扩展。每例最多两次请求，检测到 SKILL.md 读取意图即拦截并停止，未执行 Skill 后续工作。无需 Skill 的两个文件操作例到请求上限；结论只覆盖早期选择，不证明整个 agent run 永远不加载 Skill。没有执行命令或修改业务文件。

数据：[Jev](../skill-recommendation-feasibility-results.json)、[Pi 基线](../skill-baseline-feasibility-results.json)；脚本在 `test/skill-*.prototype.mjs`。有效基线运行 20 次请求，另一次原型中断方式调试用了两次；单轮、单一目录、agent 编写预设答案，不代表长会话、其他模型或通用准确率。Jev 数据含完整描述 400 字符截断；基线用 Pi 原生描述。

这批样例未显示额外推荐收益，且 Jev 多一次误推荐。因此删除推荐，而不加入更多阈值和模式。

## 决策

- 只保留计划／实现，用户确认或 `/gear-phase` 控制；返回计划不引入中间态。
- Jev 只在首轮及进入实现时评分。计划默认 heavy，高置信普通工作用 standard；实现默认 standard，高置信困难保持计划档位。light 仅兜底。
- 同阶段不随消息反复换模型／thinking；不注入方法提示、不读 Skill、不注册交接工具、不续写、不接管权限。
- 保留 Pi 的分支状态、模型可用性兜底与 thinking 裁剪。无 UI 使用显式命令，不把关键词猜测当批准。
- 0.2.0 忽略旧模式字段；删除旧实现和配套规格，历史由 Git 保留。

## 后果

路由器不会因独立新任务、风险或验证失败自动升级；需要用户切阶段、换模型或开启新会话。Skill 可能在长对话或其他模型上漏选，用户可用 `/skill:name` 强制加载。切模型可能损失缓存，不提供跨模型缓存迁移或费用保证。

详细契约：[需求](../../.kiro/specs/single-mode-routing/requirements.md)、[设计](../../.kiro/specs/single-mode-routing/design.md)。
