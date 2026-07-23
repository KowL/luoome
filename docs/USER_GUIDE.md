# luoome 用户手册

> 给**人**看的使用文档：本地安装、运行、自定义、复盘。如果你打算把 luoome 接到 Claude Desktop / OpenClaw 这类 agent，请看 [AGENTS.md](../AGENTS.md)；想了解架构看 [ARCHITECTURE.md](./ARCHITECTURE.md)。

luoome 是一个**本地优先**的个人投资 advisor agent。它能：

- 在**终端（TUI）**盯盘、看今日建议
- 在**浏览器（Web）**翻仪表盘、复盘、跑战法扫描
- 作为 **MCP server** 把全部能力暴露给 Claude Desktop / OpenClaw 等 AI agent
- 通过**工作流**做自动复盘、风险报告、战法扫描

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
bun test                 # vitest 单元 + 集成（~460 个）
bun run test:all         # 端到端合约（~107 个，含 sqlite memory + drizzle）
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

如果只是接 MCP / agent，跳过本地 install；按 [AGENTS.md §快速接入](../AGENTS.md#快速接入) 把 `luoome mcp serve` 配进 Claude Desktop 即可。

---

## 2. 第一次启动

luoome 数据存在 `~/.luoome/luoome.db`（SQLite）。首次运行自动建表 + 灌入 3 个 mock 账户 + 20 只股票 + 6 条持仓 + 5 套内置战法。

### 2.1 终端全屏

```bash
luoome tui
```

你应该看到顶部两行：免责声明横幅 + 当前账户名（如「默认模拟账户」）；左栏持仓、右栏今日建议；底部快捷键栏。

### 2.2 浏览器

```bash
luoome web
# 默认 5173 端口；浏览器开 http://localhost:5173/
```

页面分 6 个 tab：仪表盘 / 持仓 / 战法 / 建议 / 复盘 / 设置。首次打开会提示 `localhost 无 token`，去**设置**页生成 token 并粘回浏览器即可（v0.4 起的本地 token 鉴权）。

**持仓 tab 支持完整持仓管理（v0.8 起）**：卡片头部「+ 新增持仓」（建仓即写交易记录；股票输入走外部数据源搜索——Eastmoney 主 → Tencent 备，无结果时按代码位数给出 .SH/.SZ/.HK/.US 后缀候选兜底，选定后自动填入现价）；每行行内操作 **加仓 / 减仓 / 纠错 / 平仓**——加减仓写交易并自动联动加权成本与可卖数量（卖光自动平仓），纠错仅修正录入错误，平仓仅标记状态（危险按钮、需确认）。Web 端默认放行 write 类 tool；MCP 不受影响。

### 2.3 MCP 模式

```bash
luoome mcp serve    # stdio JSON-RPC
```

按 [AGENTS.md](../AGENTS.md) 接进 Claude Desktop / OpenClaw / Hermes 后，agent 即可调用 32 个 tool 中默认暴露的 read + advice 类。

---

## 3. CLI 速查

`luoome <子命令>` 全部子命令一览：

| 子命令 | 用途 |
|---|---|
| `luoome tui` | 终端全屏应用（依赖 opentui） |
| `luoome web [--port 5173]` | 启动 Web（同 `luoome web start`） |
| `luoome mcp [serve]` | 启动 MCP stdio server |
| `luoome tools list [--json]` | 列全部注册 tool（含 sideEffect） |
| `luoome tools inspect <name>` | 看 tool 的 input/output schema |
| `luoome tools call <name> --input '{...}'` | 直接调 tool（按解析后的 ctx） |
| `luoome accounts list` | 列账户（含 kind / currency / initialCapital） |
| `luoome holdings list [--accountId X]` | 列持仓（含现价、PnL、汇总） |
| `luoome analyze <stockId> [--include-evidence]` | 单只股票深度分析 |
| `luoome advice list [--since 7d] [--limit 50]` | 历史建议 |
| `luoome advice stats [--since 30d]` | 准确率统计（命中率、跟单盈亏） |
| `luoome advice outcome <id> --followed true --pnl 100` | 回填 advice 结果（write） |
| `luoome tactics list [--tag X]` | 战法规则列表 |
| `luoome tactics run <tacticId>` | 跑战法（作用于当前账户持仓） |
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
| `[t]` | 战法扫描：所有战法跑当前持仓 → score_signals 精排 top 10 |
| `[o]` | outcome 复盘：最近 20 条建议的状态（已回填 / 待回填） |
| `[a]` | **账户切换**：j/k 上下移动 + Enter 选中 |
| `[↑/↓]` 或 `[j/k]` | 滚动列表 / 弹层 / 账户光标（取决于当前激活视图） |
| `[esc]` | 关闭弹层；二次按下等同 `[q]` |

TUI 内部用 `ctxRef` 包裹当前 ToolContext；切账户 = clone user 不动 repos。刷新周期 5 s 自动 + `[r]` 手动。

---

## 5. Web 用法

`luoome web` 启动后浏览器访问 `http://localhost:5173`。

### 5.1 首次访问需 token

v0.4 起的本地 token 鉴权：去**设置**页生成 token，复制到浏览器（同源 cookie / sessionStorage 不会自动同步）。建议给 token 加一个浏览器扩展或密码管理器保存。

### 5.2 7 个 tab

| Tab | 内容 |
|---|---|
| **仪表盘** | 总市值 / 总盈亏 / 持仓数 / 今日建议数 + 高信心建议列表。5 s 自动刷新。 |
| **持仓** | 表格 + 单只刷新 / 全部 analyze。 |
| **行情** | 单只实时价 / 日线 / 指标（默认 mock）。 |
| **战法** | 列表 + 一键 scan。 |
| **建议** | 历史 + decision 过滤。 |
| **复盘** | 准确率统计 + **confidence 校准表** + outcome 回填。 |
| **设置** | 鉴权 token / 数据源 / 账户。 |

### 5.3 顶栏账户下拉

右上「账户」select 里能看到全部 mock 账户；切换会向 `POST /api/account/select` 发请求，后端 mutate ctxRef.current.user.defaultAccountId，然后自动 reload 当前视图。localStorage 持久化（`luoome.accountId`）以便下次启动自动复原。

---

## 6. MCP 接入

`luoome mcp serve` 启动 stdio JSON-RPC server。配置参考 [AGENTS.md §快速接入](../AGENTS.md#快速接入)。默认暴露：

- **read** 14 tool（list / search / get / compute）
- **advice** 3 tool（analyze_*、market_outlook）

opt-in 追加：

- `LUOOME_EXPOSE_WRITE=true` → + 5 tool（add_trade / add_holding / update_holding / close_holding / record_advice_outcome）
- `LUOOME_EXPOSE_EXTERNAL=true` → + 4 tool（fetch_quote / sync_quotes / send_notification / batch_quote 走真源时）

`LUOOME_EXPOSE_TRADE=true` **永远硬卡**：MCP server 启动即抛错退出；advice × trade 隔离硬约束绝不通过 MCP 暴露。

---

## 7. 多账户切换

v0.5 起内置 3 个 mock 账户（均 `kind: mock`、币种 CNY）：

| 名字 | id | 初始资金 | 用途 |
|---|---|---|---|
| 默认模拟账户 | `f47ac10b-...-d479` | 1,000,000 | 装满 6 条持仓的「日常账户」 |
| 长期持仓 | `a1b2c3d4-...-0001` | 500,000 | 演示「长持不动」，初始持仓空 |
| 短线交易 | `a1b2c3d4-...-0002` | 200,000 | 演示「频繁进出」，初始持仓空 |

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
| `~/.luoome/luoome.db` | SQLite 主库（账户 / 持仓 / 交易 / 行情 / 战法 / advice / notification） |
| `~/.luoome/tactics/` | （预留）自定义战法规则文件 |
| `~/.luoome/reports/` | workflow 产物（日报 / 周报 / 诊断） |
| `~/.luoome/luoome.log` | （如果开启 `LUOOME_LOG=info`） |

覆盖路径：设置 `LUOOME_HOME=/path` 即可让 luoome 用别的根目录。

---

## 10. 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `LUOOME_HOME` | `~/.luoome` | 数据根目录 |
| `LUOOME_MARKET_PROVIDER` | `mock` | `mock`（默认）/ `real`（Eastmoney 主 → Tencent 备 → Mock 兜底，仅 A 股） |
| `LUOOME_LLM_PROVIDER` | `mock` | `mock` / `openai-compatible` / `anthropic` |
| `LUOOME_LLM_API_KEY` | — | `openai-compatible` / `anthropic` 必填 |
| `LUOOME_LLM_BASE_URL` | 按 provider | 覆盖 LLM base URL |
| `LUOOME_LLM_MODEL` | 按 provider | 覆盖 LLM 模型 |
| `LUOOME_EXPOSE_WRITE` | `false` | MCP/Web 是否放行 write 副作用 |
| `LUOOME_EXPOSE_EXTERNAL` | `false` | MCP 是否放行外部副作用 |
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

TUI 依赖 opentui 渲染器，必须在真 TTY 跑。CI / pipe / `nohup` 都会触发。请改用 `luoome web` 或 `luoome analyze ...` 走文件输出。

### 11.4 Eastmoney 失败 → 自动切 Tencent 还是空？

`LUOOME_MARKET_PROVIDER=real` 默认主 Eastmoney → 备 Tencent → Mock。Tencent 也会失败就退到 Mock（mock 走 `MOCK_STOCK_BASE_PRICES` 表内基价）。北向 / 港股 / 美股暂未接入，强行 fetch 会得到 not_supported。

### 11.5 LLM `openai-compatible` 报 `provider missing key`

设 `LUOOME_LLM_API_KEY` 即可。`anthropic` 同理。`mock` 无 key 也能跑（走 `MockLLMAdapter`，确定性）。

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

- [ARCHITECTURE.md](./ARCHITECTURE.md) — 模块 / 数据流 / advisor 模型
- [AGENTS.md](../AGENTS.md) — agent 接入（MCP / tools 清单）
- [ROADMAP.md](./ROADMAP.md) — 版本演进
- [CONTRIBUTING.md](./CONTRIBUTING.md) — 贡献者指南
- [SECURITY.md](./SECURITY.md) — 副作用分级 + advice 安全
- [HANDOFF.md](./HANDOFF.md) — 跨上下文会话交接 + 功能 backlog
- [BACKLOG.md](./BACKLOG.md) — 一致性 / 工程债清单
