# Agent 指引文件的范围与实践

调研日期：2026-10-10

## 结论

`AGENTS.md` 是给 coding agent 使用的上下文与工作说明文件。其内容应与文件的目录作用范围一致：跨项目文件只承载真正通用、稳定的协作原则；技术栈、命令、目录、架构和项目流程应放在对应项目内。全局规则应精简、具体、可操作，避免强制所有项目使用特定开发流程或依赖未安装的命令。

## 对本机 Pi 配置的适用方式

Pi 区分 agent 用户目录与目录层级中的 context files：

- 用户指引可放在 `~/.pi/agent/AGENTS.md`，作为跨工作目录的个人指引。
- `AGENTS.md` 也会从当前工作目录和父目录发现，指引适用于该目录及其后代目录。
- 因此 `/Users/joslyn/AGENTS.md` 不只是 Pi 的 agent-home 配置；它会对 `/Users/joslyn/` 下的多个项目生效。
- Pi 对 context files 的发现不要求项目 trust。应谨慎放入会自动应用的内容，并理解文件所在目录决定影响范围。
- 项目级技术与流程约定应留在仓库内，避免扩大父目录指引的影响面。

## 实践建议

1. 先确定文件位置和继承/发现范围，再决定要写入的规则。
2. 跨项目文件只保留多项目确实共享的协作底线和偏好；避免重复项目 README 或完整开发手册。
3. 规则写成可执行动作，避免模糊的“始终遵循最佳实践”等泛化要求。
4. 对有成本的流程采用条件触发，例如按任务复杂度、高风险或项目明确要求启动需求、设计、审批流程。
5. 不把具体 slash command、MCP server 或工具当作普遍可用；先确认当前环境存在，否则给出替代工作方式。
6. 通过项目级指引约束专属技术栈、测试、架构、审批和规格存放路径。
7. 对 prompt/agent instruction 文件的安全性保持意识：项目文件和上下文可影响模型行为，加载并不等于可信。

## 本次修改

已将 `/Users/joslyn/AGENTS.md` 调整为跨项目通用原则：移除所有项目都必须执行的 Kiro 阶段审批与 `/prompts:kiro-*` 命令列表；保留需求歧义澄清、需求变更影响评估、按任务复杂度选择流程等共通规则。明确 Kiro/规格工作流仅在项目声明采用时适用，并要求确认当前环境是否实际提供相应命令。

本次修改只调整个人机器上的 `/Users/joslyn/AGENTS.md`，不修改某个具体仓库的 Kiro 工作流约定。

## 来源

- Pi 官方配置文档：<https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/configuration.md> — agent 目录、context files 发现范围、父目录继承和 trust 行为。
- Pi 官方安全文档：<https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/security.md> — context files 可影响模型行为；项目 trust 不是对内容或行为的安全保证。
- Pi 官方 Skills 文档：<https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/skills.md> — skill 元数据决定模型考虑何时加载；完整指引按需读取；可用 `/skill:name` 显式调用。
- Agent Skills 规范：<https://agentskills.io/specification> — 描述应说明技能用途与触发情境；采用渐进式披露，按需加载详细指引。
- AGENTS.md 项目：<https://agents.md/> — 将 `AGENTS.md` 定位为 coding agent 的项目上下文/指引，示例包括构建步骤和代码约定。
- OpenAI Codex 指引：<https://developers.openai.com/codex/guides/agents-md> — 参考 AGENTS.md 层级与项目指导原则；具体机制因 agent 而异。

## 适用性说明

不同 agent 对文件发现路径、优先级、trust 和自动加载的实现可能不同。以上范围结论针对本机安装的 Pi 版本及其官方文档；不要把 Pi 的路径机制概括成所有 agent 的共同机制。
