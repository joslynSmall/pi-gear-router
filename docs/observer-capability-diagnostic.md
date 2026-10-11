# 能力交接低置信专项诊断

## 问题与边界

第二次可见目录 smoke 的独立 readiness 返回 ready/scope/clarity/methodGate 高置信，但 capability score=0.6/confidence=0.37，按批准的0.80门槛拒绝。不是 transport、概率格式或本地 parser 错误。

默认 `node test/observer-capability-diagnostic.mjs` 只重放已存报告。重放用固定 band3 本地策略 fixture；原始 live packet/input未保存，不能冒称重现原始输入。输出稳定拒绝0.37，保持六个有效字段。

假设：简短评分锚点不足、旧调查请求干扰下一实施评分、score confidence与ready不同、单次波动。实验不要求提高confidence、不放宽门槛、不增加chat。

## 有界实验

用户已许可真实网络；运行前公布8次Jev/8attempts、0chat，每次15秒、总120秒、无retry。四组同一合成string-key任务，每组两次；除选定变量，其他问题/packet保持不变。

```bash
node test/observer-capability-diagnostic.mjs
node test/observer-capability-diagnostic.mjs --run
```

原型仅在adapter复制的问题/输入上做对照，不参与生产路由。详情 [`observer-capability-diagnostic.json`](observer-capability-diagnostic.json)。

| 组 | 改动 | capability score/confidence | 六字段均有效 | 完整本地接受 |
|---|---|---|---|---|
| baseline | 原Light mechanical等简短锚点 | 0.36/0.44、0.34/0.49 | 1/2 | 0/2 |
| detailed-anchors | 完整机械/工程决策/深推理描述 | 0.08/0.88、0.08/0.88 | 2/2 | 0/2 |
| next-work-boundary | 只补说明评分下一包工作 | 0.24/0.64、0.28/0.59 | 2/2 | 0/2 |
| minimal-context | 去掉旧anchor/assistant，替换request为包评估 | 0.14/0.79、0.17/0.76 | 2/2 | 0/2 |

实际8次Jev/8attempts、0chat，13,552 reported tokens；baseline首个risk因概率规则无效，47/48字段有效，脚本退出1。详细锚点组仍有scope/methodGate低置信；裁剪上下文提高多个choice，但不能为了接受删掉真实请求或gate。两次重复不能建立校准、精度或因果证明。

## 生产修正与复验

仅将handoff capability三锚点补全为详细描述；保留原instructions、六问题、完整公开上下文、0.80门槛及strict概率契约。主观察问题不变。契约fingerprint加入 `handoff-anchors-v2`，旧策略继承/pending不复活。

这属于基线内问题描述细化，aligned，scope: architecture；没有把实验minimal-context接入生产。SDK/owner仍保持唯一职责，不增加聊天cascade、方法owner或权限授权。没有关于服务confidence已校准的正式依据。

首次锚点v2生产复验：6Jev/3chat，三阶段交接证据真实，但同任务解释将transitions从1覆盖为0。报告 [`observer-guided-routing-anchors-v2-smoke.json`](observer-guided-routing-anchors-v2-smoke.json)复核后改为partial/passed:false，原工具输出exit0不再作为最终完成证据。

根因：call owner选择logicalCalls较新的内存ledger时，把route已消费的transitions/guides/耗尽状态也当成transport所有的旧值。Implementation Drift，scope: architecture；正确基线不变。补owner与生产SDK红绿回归，再将同owner计数做单调合并（新task另有owner才重置）。日志 `/tmp/pi-capability-ledger-{red,green}.log`。

修复后最后生产复验：

```bash
node test/live-observer-smoke.mjs --run --budget-fix
```

独立报告 [`observer-guided-routing-budget-fix-smoke.json`](observer-guided-routing-budget-fix-smoke.json)，日志 `/tmp/pi-observer-budget-fix-live.log`。实际6Jev/6attempts、3chat、无retry；83/83字段valid，18,762 reported Jev tokens，latency257–1214ms（平均560.5ms），price0不代表免费。

- user调查：converge，requested1/protected3，实际Sol-high，同轮受控Skill提示到provider。
- 独立readiness：capability0.02/confidence0.97；ready/scope0.98、clarity/methodGate1.00、risk low0.95，符合全部原门槛。
- proposed→accepted→consumed→physical-response-observed，protected3→2，仅一band；下一真实continuation派发Luna-high。guide仍到provider；不写代码、不授予实施权限。
- 解释：可信same_task/explain，临时respond到space-bunny/low；同task ID、taskBand2不变、transitions仍1，调用预算1→2→3不回退。
- 两候选相关建议、无Skill正常、12候选最大schema20问题valid。大目录召回是词面capacity fixture，不能声称完整召回或通用准确率。

最后报告passed:true/budgetContinuity:true/transportPassed:true且三个handoff事实均true。个人auth/models/router settings SHA-256不变，临时认证清理。当前累计四次生产smoke＋一次诊断 **31Jev/31attempts、12chat**（另两次auth预检查0calls），不含历史可行性对照。未再联网。

## 验证与保留限制

最终fresh离线 `npm run typecheck`、`npm test` **263/263**（`/tmp/pi-observer-complete-offline.log`），生产SDK＋budget连续3次 **31/31**（`/tmp/pi-observer-complete-repeat-{1,2,3}.log`），脚本syntax及diff检查通过；诊断默认离线与缺auth清理测试纳入默认集，真实脚本不自动联网。

任务9.3可据最后生产轨迹完成，不代表全面发布保证。observer仍显式opt-in、默认task、legacy保留、个人设置未启用。概率舍入契约、任意Skill gate、跨用户大目录语义召回、长轨迹、provider/cache/费用收益及服务confidence校准仍未证实。有限成功样本不能证明阈值最优，也不能将拒绝率写成实际准确率。
