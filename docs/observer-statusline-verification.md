# observer 状态栏与只读详情验证

## 范围与批准

用户批准紧凑statusline＋只读 `/gear-status`，保留Pi原生footer，不做自定义footer或常驻多行widget。基线依照observer R9.8与设计§10；新增展示属于可观测性细化，不修改能力/权限/方法/预算政策、schema或contract fingerprint。

治理：aligned，scope: architecture。展示只读取已验证state/current branch事件；不能反向驱动路由或发起classifier。

## 实现

- `src/observer-status.ts`：纯展示接口 `observerStatus(state, branch, settings, activity)`，产出紧凑文本、详情及semantic tone。state来自版本校验，events使用严格parser。current source/session/content/policy/catalog匹配，旧source事件不混成当前交接。
- `src/index.ts`：原 `setStatus("pi-gear-router",…)` 接入展示，原task/legacy文本保留；注册 `/gear-status`。仅显示的request-local physical pair修正retry/fallback与旧state.dispatch不同的情况；绑定source identity、生命周期清理，不写回state或给reducer新增输入。TUI状态，TUI/RPC显式命令通知；print/JSON无UI调用。不替换footer、不另建terminal renderer。
- `src/observer-runtime.ts`：无authority的状态变更回调。观察/readiness开始/结束、调用事件/迟到usage、交接失效更新；session/tree/model/input失效清pending令牌，旧请求结束不能覆盖新pending。渲染异常不改变调用、持久化或routing。
- `src/observer-handoff.ts`：proposed/rejected/accepted事件后通知展示；消费后的route及实际assistant message_end刷新。statusChanged可选，不改变host接受契约。

示例：

```text
路由 收敛 → gpt-6.1-sol · high ｜ 能力保护 ｜ Jev 1/24
路由 实施 → gpt-6-luna · high ｜ 交接已生效 ｜ Jev 2/24
路由 解释 → space-bunny-free · low ｜ 临时降档 ｜ Jev 3/24
```

不会把valid当成高置信，不把implement或accepted显示为批准实施，consumed未响应显示待响应。异常按固定标签显示，额度/回退/方法等待/交接拒绝/timeout/invalid/coverage分开；不插入packet、request、Skill正文、原始错误或自由诊断。

详情区分本轮与持续需求、requested/protected/actual、接受/消费/响应、logical calls/attempts/transitions/guides、有效字段confidence/p、目录/event覆盖与usage是否报告。读取与显式展开/遵循未知分开；没有本地name映射时只显示候选数量，不解析guide文字补名称。counter通过branch预算恢复合并，旧ledger回退不会因展示复活。

accepted显示仅持久接受事实，reload后不保证仍可消费；所有显示均不是项目审批/业务完成。模型/provider值移除ANSI/控制字符、按字符设上限。窄终端依赖Pi原生footer的 `truncateToWidth`，不是按JS字符串长度自行裁终端行。默认模型短名优先，provider与有界完整model在详情中。

## 红绿与回归

1. `/tmp/pi-statusline-red.log`：新纯展示接口未实现时失败，实现后解释状态/持续需求通过。
2. `/tmp/pi-statusline-integration-red.log`：紧凑内容与新命令未实现时两项失败；接入后通过。
3. `test/observer-status.test.mjs`：解释、三阶段交接、旧source隔离、固定错误、budget/pending及terminal控制字符。
4. `test/observer-router.test.mjs`：pending到结果、read-only命令/branch账目、print UI隔离、手选清除、旧请求在tree替换后不重画、mode owner兼容。
5. `test/observer-sdk.test.mjs`：真正AgentSession公开UI绑定（TUI/RPC）＋mock physical provider。命令解析无额外entry/user/request/classify；accepted/consumed/actual response刷新；手选model清除；原steering/cancel/reload/fork/compaction等回归保留。
6. 原 `test/status.test.mjs` 保留task/legacy路径与非TUI行为。
7. `/tmp/pi-statusline-retry-{red,green}.log`：retry实际返回standard/medium但旧state仍heavy时展示错误的红绿回归；修复后状态及详情反映实际pair，持久taskBand/dispatch与classifier调用不变。

最终fresh命令：`npm run typecheck`、`npm test` **271/271**（`/tmp/pi-statusline-final.log`）、SDK/status/router连续3次各 **35/35**（`/tmp/pi-statusline-repeat-{1,2,3}.log`）、`git diff --check`通过。默认测试全离线，不读个人认证。不再做真实网络smoke，先前线上功能报告不是新UI渲染验收。

七维收尾复核：单一展示owner/纯格式化，UI→current branch snapshot依赖，不新增路由判断链；新增callback仅可观测、异常不改变接受结果；request-local display pair不替代持久state authority。legacy不退休、不替换Pi footer，净增复杂度限于经验证的生命周期/实际派发展示；测试和README显式记录边界。aligned，scope: architecture。

## 限制与隔离

真实SDK＋UI spy证明public API文本/刷新与无新增调用，不证明所有终端、字体、resize/主题下的像素外观。本次没有人工操作真实TUI。使用Pi原生footer布局，主题fg语义色在刷新时计算，无自定义宽度/动画/键盘组件。

只在当前扩展handler时点观察事件；其他后置扩展可改变最终显示，未建立跨扩展统一statusline owner。中途文件配置变化仍按下一个公开事件刷新，不启用定时轮询。print/JSON没有详情通知，继续通过既有结构化state/events消费。

个人auth/models/router settings SHA-256核对不变；工作区原有脏文件仅本次明确源码/测试/README范围改变。无commit/push，无个人配置启用变化。
