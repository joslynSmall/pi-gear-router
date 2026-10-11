# pi-gear-router

为 [Pi](https://pi.dev) 提供**计划／实现两阶段模型路由**。选择 `gears/auto`，由 [TypeSafe Jev](https://typesafe.ai) 在阶段入口评估能力；同阶段保持物理模型与 thinking 稳定。

本扩展只路由模型。Skill 的选择与执行交给 Pi，需求追问与审批交给用户、项目指引及 Skill；不编排工作流、不注入方法提示、不接管工具权限、不自动续写。

## 快速开始

### 1. 准备 Pi 与凭据

需要 Pi 1.1.0+、TypeSafe 凭据，以及目标物理模型的有效凭据。尚未安装 Pi 时，可在 Node.js 22.19+ 环境中执行：

```sh
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
pi --version
```

其他安装方式见 [Pi 安装指南](https://pi.dev/docs/latest/quickstart#1-install-pi)。启动 `pi`，在会话内运行 `/login typesafe`，按提示保存 TypeSafe API key；目标物理模型的供应商同样通过 `/login` 配置。Pi 将凭据保存在 `~/.pi/agent/auth.json`，不要提交到版本库。

也可在启动 Pi 的 shell 中提供环境变量：

```sh
export TYPESAFE_API_KEY="apikey_..."
```

`export` 只影响当前 shell 及其子进程，不会永久保存，也不会更新已启动的 Pi 进程；已有进程需要重启。Pi 内置 `typesafe/jev-latest`，无需另装 TypeSafe SDK 或启用 codemode。

### 2. 安装扩展

以下两种来源选一种，不要同时安装：

```sh
# 从 GitHub 安装
pi install git:github.com/joslynSmall/pi-gear-router

# 或引用已有的本地仓库目录（替换为实际路径）
pi install /path/to/pi-gear-router
```

默认写入用户级 `~/.pi/agent/settings.json` 的 `packages`。仅供当前项目使用时加 `--local`，写入 `.pi/settings.json`；项目安装只在 Pi 项目信任确认后加载。扩展会执行代码，安装前应审阅来源，见 [Pi 包管理](https://pi.dev/docs/latest/packages)。

### 3. 配置物理档位

创建配置目录：

```sh
mkdir -p ~/.pi/agent/pi-gear-router
```

将下列内容保存为 **扩展自身的** `~/.pi/agent/pi-gear-router/settings.json`，替换为 Pi 中已有且已鉴权的模型。provider 和 model 必须与 Pi 中的标识一致，可先在 `/model` 中确认；自定义端点先按 [Pi 模型配置](https://pi.dev/docs/latest/models#configure-a-compatible-endpoint)接入。

```json
{
  "gears": {
    "light": { "provider": "yourprovider", "model": "fallback-model-id", "thinkingLevel": "low" },
    "standard": { "provider": "yourprovider", "model": "balanced-model-id", "thinkingLevel": "medium" },
    "heavy": { "provider": "yourprovider", "model": "frontier-model-id", "thinkingLevel": "high" }
  }
}
```

档位按实际能力递增，可跨供应商。使用默认 Anthropic Haiku／Sonnet／Opus 时可省略此文件，但仍需 Anthropic 凭据，具体模型见 [`src/defaults.ts`](src/defaults.ts)。light 只是可用性兜底，不按每条消息挑选。thinking 使用该档配置并按模型支持范围裁剪，虚拟模型的 `/thinking` 选择不覆盖档位配置。

### 4. 启用路由

安装不等于启用。启动新会话时显式选择：

```sh
pi --model gears/auto
```

已有会话先运行 `/reload` 加载刚安装或更新的扩展，再用 `/model` 选择 `gears/auto`。退出路由同样手选物理模型。

若要新会话默认使用路由，先备份 **Pi 自身的** `~/.pi/agent/settings.json`，再合并以下两项；不要整份替换已有文件，保留 `packages` 等其他设置：

```json
{
  "defaultProvider": "gears",
  "defaultModel": "auto"
}
```

若已有 `enabledModels`，将 `gears/**` 追加到原列表；未限制模型范围时无需新增该字段。默认设置作用于新会话，恢复旧会话仍可能还原旧模型，需用 `/model` 切换。

### 5. 检查安装与配置

```sh
pi list
pi --offline --no-mcp --list-models gears
PI_OFFLINE=1 pi auth check --provider typesafe --no-refresh
```

`pi list` 应包含所选安装来源，模型列表应包含 provider 为 `gears`、model 为 `auto` 的记录。对各物理模型的供应商另执行 `PI_OFFLINE=1 pi auth check --provider yourprovider --no-refresh`，将 `yourprovider` 替换为实际供应商。

这些命令不发起聊天或分类请求；`ready` 只表示凭据可解析，不证明远端服务健康。会话内用 `/gear-status` 查看状态；选择 `gears/auto` 后、首次请求前显示待评估，实际派发要等用户请求触发。

### 更新与卸载

GitHub 安装可更新指定包：

```sh
pi update git:github.com/joslynSmall/pi-gear-router
```

若安装来源固定到 Git 标签或 commit，更新不会自动改到其他版本。本地目录安装不复制源码，更新原仓库即可，无需再次 `pi install`：

```sh
git -C /path/to/pi-gear-router pull --ff-only
```

更新后在已有会话运行 `/reload`，或重启 Pi。仅修改扩展的档位配置不必重装，下一条用户消息会重新解析。

卸载前先选回物理模型；若设置过默认路由，也要恢复 Pi 的 `defaultProvider`／`defaultModel`，并从已有模型范围中移除 `gears/**`。按 `pi list` 中的安装来源使用对应命令：

```sh
# GitHub 安装
pi remove git:github.com/joslynSmall/pi-gear-router

# 或本地目录安装
pi remove /path/to/pi-gear-router
```

项目级安装在卸载命令中同样加 `--local`。卸载后 `/reload` 或重启；卸载不会删除本地源码、扩展个人配置、供应商凭据或会话。

## 如何工作

```text
首轮用户请求 → Jev 一次评分 → 计划档位保持稳定
                                ↓ 用户确认或显式命令
                             Jev 一次评分
                                ↓
                             实现档位保持稳定
```

| 阶段 | 选档规则 |
|---|---|
| **计划（plan）** | 默认 heavy；Jev confidence ≥ 0.8 且 score < 1.5 时用 standard |
| **实现（implement）** | 默认 standard；Jev confidence ≥ 0.8 且 score ≥ 1.5 时保持原计划档位 |

阈值是本地规则，不是准确率。Jev 失败使用上述默认档位。同阶段的新消息、“继续”、独立新任务、工具续接和重试不触发评分或语义换档。

### 用户决定阶段

- 在计划阶段输入“开始实现”“确认需求”“按计划做”等候选短语，有 UI（TUI／RPC）时出现确认框；只有确认后才切换。普通问答、“继续”、否定表达或取消不切换。短语只是候选，不证明需求完整。
- `/gear-phase implement`：下一条用户消息进入实现；不再弹确认框。
- `/gear-phase plan`：下一条消息返回原计划档位，不调用 Jev；再次进入实现时重新评分。
- `/gear-phase` 或 `/gear-status`：查看当前状态。

没有第三个“计划修订”状态。print／JSON 等无对话 UI 的模式不根据关键词切换，使用显式命令。命令与状态跟随当前会话分支，跨恢复和压缩保留。**路由阶段不授予修改许可**，不替代项目或 Skill 的审批。

## 配置

支持 JSONC（`//`、`/* */` 注释），完整示例见 [`example.settings.json`](example.settings.json)。省略／非法字段保留默认或继承值。

| 字段 | 默认值 | 用途 |
|---|---|---|
| `enabled` | `true` | false 不调用 Jev，保留已有物理派发；无历史时尝试 standard |
| `gears` | Haiku／Sonnet／Opus | 三档 provider、model 与 thinkingLevel；不能指向虚拟模型 |
| `judgeTimeoutMs` | `15000` | 分类总超时；传输失败最多额外尝试两次，HTTP 错误不由扩展重试 |

项目文件 `<项目根>/.pi/pi-gear-router/settings.json` 仅在 **Pi 项目信任已确认**时覆盖用户配置，gears 按档位覆盖。信任只控制配置加载，不是安全沙箱。

同阶段保留已选派发，包括兜底模型；恢复可用性不会自动跳回高档。模型配置修改或当前派发不可用时，在下一条用户消息重新解析；工具续接、重试仍优先沿用实际 pair。

### 从 0.1 升级

0.2.0 只保留一种模式。旧 `routingMode`、`gearBias`、`bands`、`taskRouting`、`observer`、`workflow` 字段直接忽略，**不会重写个人配置**；gears、enabled 与超时继续生效。已移除交接工具、能力保护窗口及 Skill 推荐。

旧 task 两阶段状态可保留阶段（修订视为实现）；observer／workflow 状态不迁移为新阶段，下条用户消息重新进入计划评估。升级、阶段切换或配置变化可能产生一次缓存边界。

## 状态与故障边界

TUI footer 显示阶段、实际模型与 thinking，例如：

```text
路由 计划 → magpie/zies/gpt-6.1-sol · high
路由 实现 → magpie/zies/gpt-6-luna · high
```

- **目标缺失／无凭据**：依次尝试目标档、standard、heavy、light、历史物理模型，去重检查；全部不可用明确报错。凭据已配置不代表服务健康。
- **物理服务错误**：交给 Pi 的请求／重试机制；本扩展不做网络故障自动切换。
- **续接／重试**：沿用实际派发，包括 thinking，避免同轮切换。
- **独立新目标／验证失败**：不会自动升级或重启阶段。需要更强模型时手动切阶段、选模型或开新会话。

Jev 是外部服务，会收到最新请求与有界公开 user／assistant 文本；扩展不主动读取或附加 Skill 目录／正文，不取 system、隐藏思考、图像或工具输出。Pi 显式 `/skill:name` 展开的正文，以及公开消息中已有的 Skill 信息或工具摘录，仍可能作为请求文本发送。**截断不是脱敏**，用户文本可能含敏感信息。

模型切换可能损失 prompt cache；不支持跨模型缓存迁移，不保证省钱、缓存命中或任务质量。Pi 主模型也可能漏选 Skill，可用 `/skill:name` 强制加载。

## 开发与证据

```sh
npm install
npm run typecheck
npm test
```

测试使用临时目录、离线模型流和真实 Pi SDK／SessionManager，不改个人配置、不联网。需要支持原生 TypeScript stripping 的 Node，建议 Node 22.19+。

- [单一模式规格](.kiro/specs/single-mode-routing/requirements.md) · [设计](.kiro/specs/single-mode-routing/design.md)
- [ADR 0002](docs/adr/0002-single-mode-routing.md)：为什么删除多模式和 Skill 推荐，含 Jev 与主模型对照实测的条件和限制
- [领域术语](CONTEXT.md) · [验证记录](docs/single-mode-routing-verification.md)

`test/skill-*.prototype.mjs` 为保留的合成实验脚本，默认只检查计划；`--run` 会真实联网、可能产生费用，应先取得许可。其结果不是当前路由器的端到端联网验证。

基于 Pi [虚拟模型](https://pi.dev/docs/latest/virtual-models)，不修改 Pi 核心。

## 许可证

[MIT](LICENSE)。
