# 单一模式路由需求

用户已在本次对话中确认需求与设计方向；本规格取代 task-aware-routing、phase-orchestrated-routing、observer-guided-routing。

## R1 职责边界

扩展只为 `gears/auto` 选择物理模型及 thinking。不得读取／推荐 Skill、注入方法指令、注册交接工具、接管工具权限、判断需求完整性或自动续写。上述工作交给 Pi、用户与 Skill。

## R2 两阶段

- 会话默认从计划（plan，含需求收敛）开始。首次用户请求调用一次 Jev：confidence ≥ 0.8 且 score < 1.5 选 standard，否则选 heavy；失败也选 heavy。
- 用户切换到实现（implement）时调用一次 Jev：confidence ≥ 0.8 且 score ≥ 1.5 保持计划档位，否则选 standard；失败也选 standard。
- 同一阶段的普通新消息、继续、工具续接及重试不得调用 Jev。
- `/gear-phase plan` 返回原计划档位，不重新评估；再次进入实现时重新评估。没有计划修订中间态。

## R3 用户切换

- WHEN 用户在计划阶段使用“开始实现”“确认需求”等候选短语 AND 有对话 UI THEN 扩展 SHALL 弹出确认框，只有确认后才切换；否定表达、取消不得切换。
- WHEN 用户输入 `/gear-phase plan|implement` THEN 扩展 SHALL 记录分支内的阶段请求，在下一条用户消息生效；同阶段请求为无操作。
- 无对话 UI 时不猜测批准，使用显式命令切换。阶段不是修改许可，不替代项目或 Skill 的审批。

## R4 稳定与故障

- 同阶段保持物理模型／thinking，包括已选的兜底；用户修改模型配置或当前派发失去可用性时才重新解析。
- 工具续接沿用 previous；重试沿用 failed，路由失败无 failed 时优先当前保存派发。direct 不评估、不修改阶段。
- light 只在 standard、heavy 均不可用时兜底；顺序为目标档 → standard → heavy → light → 历史物理模型。全部不可用则明确报错。
- `enabled:false` 不调用 Jev，保留已有物理模型，无历史用 standard。

## R5 配置与状态

- 支持 `enabled`、`gears`、`judgeTimeoutMs`，JSONC 与逐档继承。忽略 routingMode、gearBias、bands、taskRouting、observer、workflow，不写回个人配置。
- 项目覆盖只在 Pi 项目信任已确认时加载；信任不是工具授权。
- 状态与阶段请求跟随会话分支，跨恢复、压缩保留。可识别旧 task 两阶段状态保留阶段；其余旧状态下个用户请求重新进入计划。
- 状态栏显示阶段、实际模型、thinking 及有限故障诊断；`/gear-status` 只读，`/gear-phase` 无参数也可查看。

## R6 交付验证

版本 0.2.0。删除被替代的源码、规格、验证与 smoke 文档，保留 ADR 与 Skill 对照实测记录。运行 typecheck、离线单元及真实 Pi SDK／SessionManager 测试；不得把合成用例结果写成通用准确率、省钱或缓存命中保证。
