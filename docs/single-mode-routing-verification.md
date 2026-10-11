# 单一模式路由验证

版本：0.2.0；验证日期：2026-10-11。

## 已执行

- `npm run typecheck`：通过。
- `npm test`：**49/49 通过**，0 失败、取消或跳过。
- `git diff --check`：通过。
- 两个 `test/skill-*.prototype.mjs` 的 `node --check`：通过。
- 两个原型不带 `--run` 执行：通过，networkCalls=0；Jev 计划读取 35 个候选，Pi 基线系统提示词列出相同 35 个 Skill。基线脚本报告个人配置及生产源码未变化、临时目录删除。
- `npm pack --dry-run --json --ignore-scripts --offline`：通过，入口包含现有 6 个源码文件，无已删除模块；这是打包清单检查，未安装发布包、未发布。

上述检查在当前修改后的源码上执行，不引用旧 277 项测试数量；旧 observer／workflow／task 测试随被删除功能退休，替换为聚焦当前契约的测试。

## 覆盖

| 要求 | 验证证据 |
|---|---|
| 只路由模型、不读／推荐 Skill、不插入上下文、不编排续写或权限 | router 注册事件断言；真实 SDK 无新增工作流工具／隐藏 custom_message |
| 首轮与进入实现评分，普通新消息和继续不评分 | router 调用计数；真实 SDK 执行阶段命令前后统计 |
| 评分阈值、默认档位、失败降级 | phase-routing／judge／router 边界用例 |
| 关键词确认、否定、取消、无 UI 不自动切换 | router TUI／RPC 模拟 UI；真实 SDK print 模式 |
| 阶段命令下轮生效、可取消覆盖、返回原计划 | router；真实 SDK 命令派发与返回 plan |
| 工具续接及 retry 保存实际 pair，direct 不评分 | router；真实 SDK read 后续请求模型／thinking 一致 |
| light 仅兜底、历史模型兜底、认证／虚拟模型过滤、thinking 裁剪 | router |
| 同阶段兜底不因恢复可用性跳档，配置变更下轮生效 | router |
| JSONC、旧字段忽略、只读、缓存更新、项目 trust | settings |
| 分支、压缩、重开和分叉状态 | 真实 Pi SessionManager，临时会话文件 |
| 超时、取消、无效结果、认证适配器停滞、传输重试上限 | judge／router；传输测试替换 fetch，无真实请求 |
| 状态栏／只读状态、手选物理模型、关闭状态 | router 模拟 UI |

## 未验证与限制

- 本轮没有再次联网，也未在真实 TUI 或 RPC 客户端点击确认框。UI 通过事件／接口模拟验证，SDK 路径以 print 模式执行。
- 新评分输入增加 phase、使用最近六条每条最多 1000 字符的公开文本；首轮／阶段切换语义评分效果没有新增真实服务测量。
- 之前两份 Skill 实测用于删除推荐的决策，不是 0.2 路由的端到端联网测试。只测早期加载意图，没有证明 Skill 后续执行正确或需求确认完整。
- 不测长会话 Skill 漏选、提供商故障自动切换、费用收益、缓存命中率或跨模型缓存迁移。
- 本轮没有修改 `~/.pi/agent/pi-gear-router/settings.json`，旧字段可以留在文件中，不影响新配置解析。

规格：[requirements](../.kiro/specs/single-mode-routing/requirements.md)、[design](../.kiro/specs/single-mode-routing/design.md)。决策与实测原始结果：[ADR 0002](adr/0002-single-mode-routing.md)。
