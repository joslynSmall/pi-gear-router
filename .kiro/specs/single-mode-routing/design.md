# 单一模式路由设计

## 模块

- `settings.ts`：只读 JSONC、默认值、配置缓存与受信任项目覆盖。
- `phase-routing.ts`：档位规则、候选短语、状态解析及旧 task 阶段迁移。
- `judge.ts`：一次评分，发送最新请求和有界公开 user／assistant 文本，不主动读取／附加 Skill 元数据，不取 system、工具输出、thinking 或图像；公开消息及显式 Skill 展开中已有的内容仍按普通文本处理。分类失败使用阶段默认值；传输失败最多两次重试，受总超时限制。
- `index.ts`：虚拟模型、物理可用性／thinking 裁剪、阶段请求与状态展示。
- `types.ts`／`defaults.ts`：共享小型类型与默认模型。

## 状态与事件

`RouterState` 使用 version 2，包含 phase、planGear、implementGear、dispatch、实际 gear、配置指纹、最后消费的 phase entry id 和最近一次评分或失败标记。Pi 持久化虚拟模型状态；`pi-gear-router.phase.v2` 自定义 entry 只保存版本及目标阶段，不作为模型消息。

命令只追加阶段请求，下条 reason:user 消费。关键词在 user route 中通过确认框决定，不追加隐藏提示。continuation／retry 不消费待切换请求。相同状态不重复写入。

路由先处理 direct／disabled／sticky；用户请求才初始化或切换阶段。初始直接选择 implement 时，一次评分同时形成原计划档位与实现档位。返回 plan 复用原档位。相同配置且派发仍可用时保留实际 pair，避免兜底恢复导致未经用户要求的换模。显式配置变化在下条用户消息生效。

旧 task 的 phaseRoute 映射到 v2（revising 仍视为 implement，不继续执行旧修订逻辑）；observer／workflow 状态不重解释为新阶段。恢复前的工具续接可保留 Pi 提供的 previous。

## 验证

单元测试覆盖评分阈值、否定与取消、配置旧字段忽略、项目 trust、故障、sticky、阶段命令、迁移、状态栏。真实 SessionManager 覆盖树／压缩／重开；真实 SDK 以离线模型流覆盖命令→路由→工具续接，不替换路由实现。默认联网原型只输出计划。
