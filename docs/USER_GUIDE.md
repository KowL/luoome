# luoome 用户手册

> 给**人**看的使用文档：本地安装、运行、自定义、复盘。如果你打算让外部 Agent 使用 luoome，请安装 [luoome Skill](../skills/luoome/SKILL.md)；想了解架构看 [ARCHITECTURE.md](./ARCHITECTURE.md)。

luoome 是一个**本地优先**的个人投资 advisor agent。它能：

- 在**终端（TUI）**盯盘、看今日建议
- 在**浏览器（Web）**管理 Strategy、Watchlist、AlertPlan 与复盘
- 作为 **MCP server** 把全部能力暴露给 Claude Desktop / OpenClaw 等 AI agent
- 通过**工作流**运行 Strategy、同步 Watchlist、盯盘与生成报告

但 luoome **不会**替你下单。所有建议都带 `decision / confidence / horizon / reasoning / risks / disclaimers / validUntil`，人最终拍板。

## 目录

1. [安装](#1-安装)
2. [第一次启动](#2-第一次启动)
3. [CLI 速查](#3-cli-速查)
4. [TUI 用法](#4-tui-用法)
5. [Web 用法](#5-web-用法)
6. [MCP 接入](#6-mcp-接入)
7. [多账户切换](#7-多账户切换)
8. [复盘与 confidence 校准](#8-复盘与-confidence-校准)
9. [数据存储位置](#9-数据存储位置)
10. [环境变量](#10-环境变量)
11. [FAQ / 故障排查](#11-faq--故障排查)

---

## 1. 安装

### 1.1 系统要求

- **macOS / Linux**（Windows 可走 WSL2）
- **Bun ≥ 1.3**（[安装](https://bun.sh)）
- **网络**（仅在启用 `LUOOME_MARKET_PROVIDER=real` 时需要，用于拉 Eastmoney / Tencent 行情）
- **可选** Python 3.10+（仅诊断/可视化子工具间接依赖）

### 1.2 从源码运行（开发 / 验证）

```bash
git clone git@github.com:KowL/luoome.git
cd luoome
bun install              # 装工作区依赖
bun run typecheck        # 全包静态检查
bun test                 # Node 兼容的 Vitest 测试
bun run test:all         # Vitest + Bun db/web 测试
```

### 1.3 通过 Homebrew（macOS / Linux）

```bash
# tap 后 install（formula 由仓库内 homebrew/luoome.rb 提供）
brew tap KowL/luoome
brew install luoome

# 验证
luoome --version
luoome tools list | head
```

> Formula 走 git HEAD 构建（依赖 Bun 编译器）；首次安装会从 GitHub 拉源码 + 跑 `bun install`。tag 发布后会切到 tarball binary。

### 1.4 不安装直接用

如果只是接 MCP / Agent，跳过本地 install；先按 [luoome Skill 的 MCP 配置](../skills/luoome/references/mcp-setup.md) 连接 `luoome mcp serve`，再通过 Agent harness 的 Skill 机制安装整个 `skills/luoome/` 目录。

---

## 2. 第一次启动

luoome 数据存在 `~/.luoome/luoome.db`（SQLite）。首次运行自动建表和安装内置 Strategy，
不会灌入账户、持仓、交易或建议。创建账户等写操作要求以 `LUOOME_EXPOSE_WRITE=true` 启动
Web（严格默认，见 §10 环境变量）；然后打开 Web 进入「设置」，使用 token 创建第一个真实账户。

### 2.1 一键启动完整 MVP

```bash
luoome start
```

这会在 `127.0.0.1:5173` 启动 Web，并进入盘中盯盘长驻循环。首次启动还会：

- 创建 `~/.luoome/luoome.db`
- 创建默认「全部持仓」分组和「持仓监控」盯盘池
- 生成 `~/.luoome/web-token`（权限 `0600`）

打开 `http://127.0.0.1:5173/`，到「设置」页粘贴 `web-token` 文件内容后，即可执行持仓、分组和盯盘修改（前提是以 `LUOOME_EXPOSE_WRITE=true` 启动；行情同步等外部调用还需 `LUOOME_EXPOSE_EXTERNAL=true`）。只想开 Web 时使用 `luoome start --no-watch` 或 `luoome web serve`。

### 2.2 终端全屏

```bash
luoome tui
```

你应该看到顶部两行：免责声明横幅 + 当前账户名（如你创建时填写的账户名）；左栏持仓、右栏今日建议；底部快捷键栏。

### 2.3 浏览器

```bash
luoome web serve
# 默认 5173 端口；浏览器开 http://localhost:5173/
```

页面包含看盘、持仓、Strategy、Watchlist、AlertPlan、研究、建议、报告、复盘、对话和设置。
所有 write/external mutation 同时要求显式环境开关、服务端 token 与同源 `Origin`。

**持仓 tab 支持完整持仓管理（v0.8 起）**：卡片头部「+ 新增持仓」（建仓即写交易记录；股票输入走外部数据源搜索——Eastmoney 主 → Tencent 备，无结果时按代码位数给出 .SH/.SZ/.HK/.US 后缀候选兜底，选定后自动填入现价）；每行行内操作 **加仓 / 减仓 / 纠错 / 平仓**，页面下方保留近期交易流水。写操作必须携带 Web token；MCP 暴露策略不受影响。

**Watchlist 页（对齐 PRD §10）**：顶部总览卡片（列表数 / 成员数 / 今日 entered-exited / 过期来源 / 紧急重要触发），四种视图切换——按列表、全部股票（去重 + 持仓标记）、今日变化、当前持仓；右侧详情支持编辑列表（名称 / 描述 / 启停）、删除列表（当前成员关系移除，来源与历史保留）、手动加成员（可填加入原因）、成员 priority 行内修改与删除、来源健康摘要（active/stale + 最近 dataAsOf）、成员最近触发，以及关联 AlertPlan 列表（点击跳转预警计划页）。写操作同样要求 mutation token。

### 2.4 MCP 模式

```bash
luoome mcp serve    # stdio JSON-RPC
```

安装 [luoome Skill](../skills/luoome/SKILL.md) 并连接 MCP 后，Agent 即可发现当前版本默认暴露的 read + advice tools；完整库存以 MCP discovery 为准。

---

## 3. CLI 速查

`luoome <子命令>` 全部子命令一览：

| 子命令 | 用途 |
|---|---|
| `luoome start [--port 5173] [--interval 60]` | 启动完整 MVP（Web + 长驻盯盘） |
| `luoome tui` | 终端全屏应用（依赖 opentui） |
| `luoome web serve [--port 5173]` | 仅启动 Web |
| `luoome watch [--interval 60] [--alert-plan ID] [--once]` | 启动 AlertPlan 盯盘或执行单轮 |
| `luoome strategy list|get|validate|run` | 查询、校验或运行 Strategy |
| `luoome watchlist list|get|sync` | 查询 Watchlist 或同步 portfolio 来源 |
| `luoome alert list` | 查询 AlertPlan |
| `luoome mcp serve` | 启动 MCP stdio server |
| `luoome tools list [--json]` | 列全部注册 tool（含 sideEffect） |
| `luoome tools inspect <name>` | 看 tool 的 input/output schema |
| `luoome tools call <name> --input '{...}'` | 直接调 tool（按解析后的 ctx） |
| `luoome accounts list` | 列账户（含 kind / currency / initialCapital） |
| `luoome holdings list [--accountId X]` | 列持仓（含现价、PnL、汇总） |
| `luoome analyze <stockId> [--include-evidence]` | 单只股票深度分析 |
| `luoome advice list [--since 7d] [--limit 50]` | 历史建议 |
| `luoome advice stats [--since 30d]` | 准确率统计（命中率、跟单盈亏） |
| `luoome advice outcome <id> --followed true --pnl 100` | 回填 advice 结果（write） |
| `luoome sync-quotes` | 全量同步当前账户持仓行情（写库） |
| `luoome daily-review [--since 7d]` | 触发 daily-review workflow，写入报告文件 |

`--since / --until` 接 ISO 时间或 `7d / 30d / 24h / 1y` 等相对量。详见 `luoome --help`。

---

## 4. TUI 用法

启动 `luoome tui` 后：

### 4.1 顶部两行

- 第 1 行：**STANDARD_DISCLAIMERS 前两条**——这是工具提示（不建议覆盖）。
- 第 2 行：**当前账户名 + 币种 + 初始资金** + `[a] 切换` 提示。

### 4.2 快捷键

| 按键 | 行为 |
|---|---|
| `[q]` | 退出 |
| `[r]` | 立即刷新（持仓 + 建议，绕过 5 s 自动刷新） |
| `[d]` | 当前持仓详细建议（核心论点 / 支持 / 反证 / 风险 / 免责声明） |
| `[s]` | **复盘统计**：命中率、跟单盈亏、按决策分解 |
| `[c]` | **confidence 自校准**：每 10 一档，看到底 confidence 被高估还是低估 |
| `[o]` | outcome 复盘：最近 20 条建议的状态（已回填 / 待回填） |
| `[a]` | **账户切换**：j/k 上下移动 + Enter 选中 |
| `[↑/↓]` 或 `[j/k]` | 滚动列表 / 弹层 / 账户光标（取决于当前激活视图） |
| `[esc]` | 关闭弹层；二次按下等同 `[q]` |

TUI 内部用 `ctxRef` 包裹当前 ToolContext；切账户 = clone user 不动 repos。刷新周期 5 s 自动 + `[r]` 手动。

---

## 5. Web 用法

`luoome start` 或 `luoome web serve` 启动后，浏览器访问 `http://127.0.0.1:5173`。

### 5.1 写操作 token

本机默认绑定 `127.0.0.1`（loopback），此时读 / 写 API 均无需 token（仍保留同源 Origin 校验，挡住浏览器跨站请求）。仅当通过 `LUOOME_HOST` / `--host` 绑定非 loopback 地址时，所有 API 都要求 Bearer token：未设置 `LUOOME_WEB_TOKEN` 时服务端会生成并复用 `$LUOOME_HOME/web-token`，复制文件内容到「设置」页即可；token 存入当前浏览器的 localStorage。

### 5.2 核心页面

| Tab | 内容 |
|---|---|
| **仪表盘** | 市值 / 盈亏 / 建议 + AlertPlan 健康度和最近 Trigger。 |
| **持仓** | 建仓、加仓、减仓、纠错、平仓 + 近期交易流水。 |
| **Strategy** | 从模板创建、版本校验、发布、dry-run 与运行结果。 |
| **Watchlist** | 总览卡片 + 四种视图（按列表 / 全部股票 / 今日变化 / 当前持仓）；成员 priority 编辑与删除、列表编辑/删除、来源健康与关联 AlertPlan 联动。 |
| **AlertPlan** | 规则管理、手动试跑和 Trigger 审计；试跑不自动交易。 |
| **建议** | 历史 + decision 过滤。 |
| **复盘** | 准确率统计 + **confidence 校准表** + outcome 回填。 |
| **对话** | AI SDK 流式助手；项目内持久化会话，工具执行轨迹可回看，写操作先生成确认草案。 |
| **设置** | 鉴权 token / 数据源 / 账户。 |

### 5.3 顶栏账户下拉

右上「账户」select 里显示已创建的真实账户；切换会向 `POST /api/account/select` 发请求，后端更新当前默认账户，然后自动 reload 当前视图。localStorage 持久化（`luoome.accountId`）以便下次启动自动复原。

---

## 6. MCP 接入

`luoome mcp serve` 启动 stdio JSON-RPC server。配置参考 [luoome Skill 的 MCP 配置](../skills/luoome/references/mcp-setup.md)。默认暴露：

- **read** tools（list / search / get / compute）
- **advice** tools（个股、持仓和市场观点分析）

opt-in 追加：

- `LUOOME_EXPOSE_WRITE=true` → 追加账户、持仓、交易、研究、事件和反馈等 write tools
- `LUOOME_EXPOSE_EXTERNAL=true` → 追加行情、同步、刷新和通知等 external tools

`LUOOME_EXPOSE_TRADE=true` **永远硬卡**：MCP server 启动即抛错退出；advice × trade 隔离硬约束绝不通过 MCP 暴露。

---

## 7. 多账户切换

账户不再内置。首次启动在 Web「设置」页创建；也可调用
`create_account({ name, currency, initialCapital })`。所有账户均为 `kind: real`。

切账户后：

- **TUI**：持仓 / 建议全部按新账户重读。list_holdings 等读路径走 `ctx.user.defaultAccountId`。
- **Web**：账户下拉切换会触发 `/api/account/select`，然后 reload 当前路由。
- **MCP**：agent 通过 `add_trade({ accountId: '...' })` 显式选账户，缺省用当前 ctx 默认。

### 7.1 给新账户加仓（演示）

```bash
# 添加到「短线交易」账户
luoome tools call add_trade --input '{
  "accountId": "a1b2c3d4-0001-4000-8000-000000000002",
  "stockId": "002594.SZ",
  "side": "buy",
  "quantity": 200,
  "price": 105.8,
  "executedAt": "2026-07-21T09:35"
}'
```

完成后切到「短线交易」账户，`list_holdings` 会显示这条新持仓。

---

## 8. 复盘与 confidence 校准

luoome 的 advice 永远是「带答卷 + 等批改」的状态。复盘 = 把结果写回来，让系统慢慢变聪明。

### 8.1 回填 outcome

三种粒度，越准确越好：

1. **CLI**（推荐，prompt 一问一答）：
   ```bash
   luoome advice outcome <adviceId> --followed true --pnl 80
   ```
2. **Web**：去「复盘」tab 点「回填 outcome」按钮。
3. **agent / MCP**：`record_advice_outcome` 工具。

### 8.2 看 confidence 校准

`get_confidence_calibration` 把历史 advice 按 confidence 桶（0-9 / 10-19 / ... / 90-100）聚合 hitRate。

```bash
luoome tools call get_confidence_calibration --input '{}'
```

返回每桶的 `total / withOutcome / hits / hitRate / avgPnl / avgConfidence`。

读法（v0.5 W4）：

- **高信心桶 hitRate 高**：confidence 校准有效；
- **高信心桶 hitRate 低**：系统 confidence **可能高估**——该考虑收紧 prompt / 调整 calibration；
- **低信心桶 hitRate 高**：系统 **偏保守**——可以适当抬信心；
- **整体命中率（overallHitRate）**：长期跟踪的胜率近似。

> TUI 按 `[c]`，Web 去「复盘」tab 都能看到这张校准表。

### 8.3 日报 / 周报

`luoome daily-review [--since 7d]` 跑内置 daily-review workflow，写报告到 `~/.luoome/reports/`。可在 [workflows 包](../packages/workflows/src/daily-review.ts) 看到执行步骤。

---

## 9. 数据存储位置

| 路径 | 内容 |
|---|---|
| `~/.luoome/luoome.db` | SQLite 主库（账户 / 持仓 / 行情 / Strategy / Watchlist / AlertPlan / Advice） |
| `~/.luoome/reports/` | workflow 产物（日报 / 周报 / 诊断） |
| `~/.luoome/luoome.log` | （如果开启 `LUOOME_LOG=info`） |

覆盖路径：设置 `LUOOME_HOME=/path` 即可让 luoome 用别的根目录。

---

## 10. 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `LUOOME_HOME` | `~/.luoome` | 数据根目录 |
| `LUOOME_WEB_TOKEN` | 仅非 loopback 需要 | 非 loopback 部署的 Bearer token；未设置时生成 `$LUOOME_HOME/web-token`；loopback 免 token |
| `LUOOME_HOST` | `127.0.0.1` | Web 监听地址；默认不暴露到局域网 |
| `LUOOME_MARKET_PROVIDER` | 必填 | 仅支持 `real`（Eastmoney 主 → Tencent 备，仅 A 股） |
| `LUOOME_AI_CONFIG` | `$LUOOME_HOME/ai-models.json` | AI SDK 模型目录路径 |
| provider 密钥变量 | 由模型目录指定 | `apiKeyEnv` 引用的环境变量，密钥不写入目录 |
| `LUOOME_EXPOSE_WRITE` | `false` | MCP 追加 write tool；Web 放行 write tool 与 outcome 回填端点 |
| `LUOOME_EXPOSE_EXTERNAL` | `false` | MCP 放行外部副作用；Web 放行白名单内 external tool（fetch_quote、盯盘 run-once 等） |
| `LUOOME_EXPOSE_TRADE` | `false`（**硬卡**） | `=true` 时启动即抛错退出 |
| `LUOOME_FEISHU_WEBHOOK_URL` | — | 飞书通知 webhook；缺失降级为 log channel |
| `LUOOME_LOG` | info | `debug` / `info` / `warn` / `error` / `silent` |
| `LUOOME_PORT` | 5173 | Web 端口（与 `--port` 等价） |

只读路径（read + advice）永远默认全部放行；write / external / trade 必须显式 opt-in。

---

## 11. FAQ / 故障排查

### 11.1 `bun: command not found`

按官网安装 Bun 或用 `npx bun`。

### 11.2 Web 端打开是空白，console 报 `await is only valid in async functions`

检查 `apps/web/public/js/app.js` 与 `pages.js` 是否被浏览器当 ES module 解析——确认 `<script type="module">` 或 http 头 `content-type: text/javascript`。

### 11.3 TUI 报「需要交互式终端」

TUI 依赖 opentui 渲染器，必须在真 TTY 跑。CI / pipe / `nohup` 都会触发。请改用 `luoome web serve` 或 tool/workflow CLI 走文件输出。

### 11.4 Eastmoney 失败 → 自动切 Tencent 还是空？

`LUOOME_MARKET_PROVIDER=real` 使用 Eastmoney 主源、Tencent 备源。两者都失败时明确返回行情源错误，不生成价格。未覆盖的市场返回 not_supported。

### 11.5 启动时报 AI 模型目录或 provider 密钥缺失

从仓库根目录的 `ai-models.example.json` 复制到
`$LUOOME_HOME/ai-models.json`，或设置 `LUOOME_AI_CONFIG` 指向配置文件。再设置
每个 provider 的 `apiKeyEnv` 所引用的环境变量；缺目录、未知 provider 或缺密钥都会
在启动期明确报错。

也可以启动 Web 后进入「设置 → LLM 设置」完成可视化配置。Web 在模型尚未配置或
配置损坏时会进入配置模式，不会阻止设置页启动；保存后配置立即生效。API Key 只写入
本地 `0600` 密钥文件，页面只显示“已配置”状态，不会读取或回显原值。

### 11.6 `get_confidence_calibration` 全 0 桶

历史 advice 还没回填 outcome。灌 5–10 条 outcome 就能看到形状：`luoome advice outcome <id> --followed true --pnl 100 --holding-hours 24`。

### 11.7 切账户后持仓没变？

Web 端确认当前路由已 reload（页面状态行的「账户已切换」提示）。TUI 按 `[r]` 也可强制刷新。如果仍然没变，说明该账户本来就没持仓——用 `add_trade` 灌一笔。

### 11.8 Advice 看不到 / 全部过期

`validUntil` 已过：默认 `get_advice` 不返回过期 advice（`includeExpired=true` 可强行列）。`analyze_stock` 会自动重新生成。

### 11.9 如何卸载？

```bash
rm -rf ~/.luoome          # 删数据
brew uninstall luoome     # 卸载 brew 安装的 luoome
```

---

## 12. 更多阅读

- [文档导航](./README.md) — 产品需求、技术设计、运维手册与历史归档
- [ARCHITECTURE.md](./ARCHITECTURE.md) — 模块 / 数据流 / advisor 模型
- [luoome Skill](../skills/luoome/SKILL.md) — 外部 Agent 接入、工具编排与安全规则
- [AGENTS.md](../AGENTS.md) — 编码 Agent 仓库开发规范
- [ROADMAP.md](./ROADMAP.md) — 版本演进
- [CONTRIBUTING.md](./CONTRIBUTING.md) — 贡献者指南
- [SECURITY.md](./SECURITY.md) — 副作用分级 + advice 安全
- [BACKLOG.md](./BACKLOG.md) — 一致性 / 工程债清单
