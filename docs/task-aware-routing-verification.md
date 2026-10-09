# 任务感知路由实现验证

## 范围与结论

本次实现“任务连续性＋有限继承＋滚动最大值降档保护”，保留三档模型、五段 thinking、同轮物理派发冻结与既有兜底。设计与任务已获用户授权，未提交 Git，未修改个人 Pi 配置、凭据、远端服务或记忆扩展。

本次验证为**离线验证**：分类答案与模型回复由测试 adapter 提供。真实 Pi SDK、SessionManager、扩展事件、codemode 和 Bash 工具参与测试，但没有请求真实 Jev 或物理模型服务。不能据此声称分类准确率、生成质量、总费用收益或已运行 TUI 加载成功。

## 实现位置

- `src/task-routing.ts`：任务状态校验、有限继承、关系迁移、窗口、内容去重、复核退避、偏置重映射。
- `src/task-context.ts`：严格续接匹配、Unicode 字符预算、公开分类上下文。
- `src/judge.ts`：同一次 classify 的 score/relation，严格 valid/partial/unavailable 校验。
- `src/observation.ts`：分支 cursor、验证失败 marker、结项提示、手动模型 gap 与未知覆盖。
- `src/index.ts`：同轮冻结、物理派发、取消、生命周期和 footer。
- `src/types.ts`、`src/gears.ts`、`src/settings.ts`：版本字段、五区间接口及有效配置。

配置默认 `maxInheritedTurns=3`、`downgradeWindow=2`、`downgradeMargin=0.08`、`minConfidence=0.8`，均是尚待真实轨迹校准的工程初值。

## 验收对照

| 验收 | 证据 |
|---|---|
| A1 / A2 复杂任务续接、有限复用 | task-routing 的三轮继承；router 的实际 pair/状态栏/第四轮调用计数 |
| A3 附加要求 | 完整白名单及实质性变更测试，不按子串或短句绕过 |
| A4 独立新任务 | 可信 new_task 直接清空窗口并更换 taskId |
| A5 快速升级 | 0.70 → 1.92 轨迹及 2,205 个有限网格案例 |
| A6 / A7 波动与稳定降档 | 1.79/1.78 保持；1.70/1.68 降到 heavy/high；3,969 个窗口/偏置/裕量网格案例 |
| A8 结项提示 | 仅完整行提示且消费 cursor；路由重评不跳过窗口或证明成功 |
| A9 支持的验证失败 | observation 结构事件测试及真实离线 SDK 嵌套 codemode→Bash 失败 |
| A10 分类失败 | unavailable/timeout/partial 测试；同轮冻结、下一用户重评 |
| A11 重试、工具、重复路由 | 既有 router 测试及 SDK 工具跟进 pair 一致性 |
| A12 生命周期 | 真实 JSONL 重开、createBranchedSession、forkFrom、压缩及 tree 分支隔离 |
| A13 旧状态与配置变化 | 旧 turnId/state、无效版本、fingerprint、偏置重映射及同轮配置变更 |
| A14 图文续接 | 非文本禁继承；纯图 adapter 无调用兜底 |
| A15 取消 | 判决前/中、物理解析后的 Abort，不返回候选状态；旧对象不变 |
| A16 重复上下文 | 规范 CONTINUE key、重复低分不增加样本、长实质性请求去重 |
| A17 无新证据退避 | expedited 复核退避后允许有限继承，不靠反复提问凑确认 |

补充边界：低置信度打断窗口；零继承不关闭保护；目标降级不改任务承诺能力；观测 append 失败使 coverage 未知；缺失公开助手上下文保守重评；未知/不一致退出码和复杂 shell 不伪造验证失败。

离线 SDK 测试通过临时 `npm test`（fixture 故意退出 1）验证嵌套事件。该 fixture 的失败是预期测试输入，不是仓库测试失败；目录结束后删除。两类外部服务 transport 都替换，模型目录网络刷新关闭，不读取个人认证。

## 验证命令

```sh
npm run typecheck
npm test
node test/live-smoke.mjs
node --check test/live-smoke.mjs
git diff --check
```

最终全量检查：类型检查通过，**65 项测试通过，0 失败、0 跳过**；联网脚本语法检查、无 `--run` 的 opt-in 检查和 `git diff --check` 通过。有限数值性质网格共 6,174 个案例，包含在两项测试内，不计为 6,174 项独立测试。

未带 `--run` 的 smoke 只输出 opt-in 提示，不产生模型请求。测试使用 Node v26.3.0；结论不外推为其他 Node/Pi 版本的验证。

审查中补充了回归测试并修正：配置对象键顺序引起无效重评；保护裕量基线的偏置误重映射；长请求的截断文本去重；路由物理解析后的取消；公开上下文被移除后仍可继承的问题；同轮禁用时误选更早一轮的 previous pair。

## 仍需运行环境验证

现有安装指向本地项目路径，不需要重新安装。运行中的 Pi 使用 `/reload` 或重启加载新代码；本次未直接观察用户终端，不能声称已自动加载或 footer 已实际显示。

联网脚本已转发 `pi.on`、`pi.appendEntry`，增加 `--task-aware` 轨迹，记录关系判决和调用来源。**本次未执行 `--run`**。之后如批准限量联网，应检查复杂任务续接、新任务重置、阶段变化、实际模型支持等级、分类延迟与费用缺失；另外人工标注关系与最低能力，不能只以“少调用一次”评价效果。

历史联网记录 `live-verification.md` 早于本次算法，不证明任务感知策略有效。窗口样本是可区分上下文，不是独立统计实验；公开助手文字不是完成证明；秘密截断不是通用脱敏。
