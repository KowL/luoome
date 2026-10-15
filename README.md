# luoome

> **织机 + 罗网 — 汇聚网罗有价值的信息数据，在面对变化的市场时提供准确的建议。**

luoome 是一个可自行部署的个人投资管理 **advisor agent**。它把账户、持仓、交易、行情、
Strategy、Watchlist、AlertPlan、笔记与建议能力以 tool 形式暴露，并把多源数据织成可追溯事实。

- 作为 **TUI** 在终端盯盘、看建议
- 作为 **Web** 管理看板、持仓、Strategy、Watchlist 与 AlertPlan
- 作为 **MCP server** 被 Claude Desktop / OpenClaw / Hermes 等 agent 直接调用，并让它们替你做"分析 → 建议 → 行动"的推理

Web 使用同一套页面和服务入口，默认需要邮箱登录，按用户隔离数据并校验订阅，保留自选、策略、
预警、持仓和复盘。每位用户自动拥有一个 CNY 默认投资账户，初始本金和现金为 0；可修改名称，
不提供新增或切换账户。开发和生产仅使用不同配置，不切换另一套业务应用。
真实供应商、完整自动调度和生产放行仍待验收；详见[服务运行手册](./docs/runbooks/hosted-personal-subscription.md)。

## 名字

**luoome = 织机 + 罗网**

- **织**：把分散的行情、财报、新闻、StrategySignal、历史持仓织成一张连贯的认知
- **罗**：把市场里有价值的信息数据罗（网）进来，不漏关键信号
- **me**：me，你（用户）是这一切的中心，不是旁观者

面对不断变化的市场，luoome 不替你下单，但**会主动告诉你**：哪里有机会、哪里有风险、哪些决策需要你确认。

## 设计原则

- **Advisor-first**：每一份数据最终都服务于"可执行的投资建议"，不是堆数据。
- **Agent-first**：所有能力都是 tool，没有"只能人用、agent 用不了"的功能。
- **数据自持**：SQLite 保存在部署者控制的存储中，Web 用户数据使用独立私有库。
- **Schema-driven**：Zod schema 是 tool I/O 的事实来源，自动生成 TypeScript 类型、MCP tool 定义、OpenAI function calling schema。
- **Workflow ≠ Tool**：tool 是原子能力，workflow 是组合；workflow 内置编排，tool 暴露给上层 agent。
- **No magic**：每个数据源 / 适配器 / LLM 都显式可插拔，运行时可见。
- **Human-in-the-loop**：建议 ≠ 行动。advice 永远不直接触发交易；下单始终需要人确认。

## 它做什么

### 数据维度（读 + 写）

- 账户（Web 每人一个默认账户；单机 CLI/TUI/MCP 保留多账户、真实/模拟能力）
- 持仓、交易、笔记、预警
- 行情快照、日线、技术指标
- 版本化 Strategy + StrategyResult / StrategySignal
- 多来源 Watchlist + 持久的 Strategy → Watchlist 显式订阅 + AlertPlan / WatchTrigger
- 风控指标（VaR、Sharpe、最大回撤、集中度）

### 分析维度（只读）

- PnL、风险敞口、行业暴露
- Strategy 扫描、评分与可解释规则结果
- 只有用户明确订阅后，published operational StrategyRun 才能同步目标 Watchlist；complete 才能结束
  缺失来源，partial/failed 只标 stale，evaluation/trial/withheld/non-publishing/failed 不改 Watchlist
- 多源行情交叉验证
- LLM 推理总结（每日复盘、个股分析）

### 建议维度（核心）

- **个股建议**：基于技术面、基本面、StrategySignal 与 LLM 综合判断，输出 buy / sell / hold / watch / avoid 决策
- **持仓建议**：每个持仓的继续持有 / 加仓 / 减仓 / 清仓建议
- **市场观点**：每日大盘观点、行业轮动、热点板块
- **风险预警**：跌破止损位、触发风控规则、异常波动
- **账户决策与复盘**：从建议、交易计划版本或提醒回看当时依据，记录反馈、关联真实成交，并保留修订历史
- **confidence 校准**：按当前账户的明确反馈展示各信心桶的填报盈利占比与样本数，缺失盈亏不计为零

每条建议都带：**决策 + 信心度 + 有效期 + 核心论点 + 支持证据 + 反证 + 风险点 + 免责声明**。

## 仓库结构

Bun workspace monorepo：

```txt
packages/
  core/        纯领域类型 + 不变量（无 IO）
  db/          Drizzle schema + repository 实现
  tools/       Tool 注册表 + Zod → TS/MCP/OpenAI 自动生成
  adapters/    行情 / LLM / 通知 / 券商 等外部依赖适配
  workflows/   内置编排：review / scan / diagnose / advise
  mcp/         MCP server，把 tool registry 暴露给外部
  cli/         命令行入口
  tui/         opentui 应用
apps/
  web/         Hono + 同源静态仪表盘
  worker/      持久任务、通知/支付对账及离线恢复入口
docs/          全部文档（架构 / 路线图 / 安全 / 交接 / 用户手册 / 设计文档 / backlog）
homebrew/
  luoome.rb    Homebrew formula（brew tap KowL/luoome && brew install luoome）
```

## 环境变量

Web、worker 和运维命令共用显式服务配置，不读取个人目录或项目 `.env`。
以下是主要配置；完整字段、SMTP、套餐文件与恢复要求见[运行手册](./docs/runbooks/hosted-personal-subscription.md)。
现有 `HOSTED_*` 前缀是配置名称，不表示另一套运行模式。

| 变量 | 说明 |
|---|---|
| `HOSTED_ENVIRONMENT` | `development` 或 `production`，业务入口相同 |
| `HOSTED_DATA_ROOT` | 独立服务数据目录，不能使用个人单机数据目录 |
| `PUBLIC_ORIGIN` | 固定访问 origin，默认要求 HTTPS；临时 HTTP 验证须显式开启下项 |
| `HOSTED_ALLOW_INSECURE_HTTP` | 默认 `false`；设为 `true` 才允许固定 HTTP origin，仅用于临时功能验证 |
| `HOSTED_AUTH_SECRET_FILE` | 会话密钥文件；生产用部署 secret 提供 |
| `HOSTED_PLAN_FILE` / `HOSTED_JOB_BUDGET_MICRO` | 运营套餐 JSON 与明确的单任务成本预算 |
| `SMTP_HOST` / `SMTP_FROM` / `SMTP_USER` / `SMTP_PASSWORD_FILE` | 邮箱验证码 SMTP 配置；未配置时登录不可用，注册必须保持关闭 |
| `HOSTED_AI_ENABLED` / `LUOOME_AI_CONFIG` | 默认不装配 AI；启用时提供明确模型配置与供应商凭证 |
| `HOSTED_REGISTRATION_ENABLED` | 默认关闭；满足上线条件后由运营开启 |
| `LUOOME_HOST` / `PORT` | 服务监听地址和端口；默认 `127.0.0.1:5173` |

下面是保留的单机 CLI/TUI/MCP 配置，不是 Web 的另一套启动方式。服务需要的行情/模型能力由运营显式装配。

| 变量 | 默认 | 说明 |
|---|---|---|
| `LUOOME_HOME` | `~/.luoome` | 数据目录（含 `luoome.db`、`ai-models.json`） |
| `LUOOME_MARKET_PROVIDER` | 必填 | 仅支持 `real`：Eastmoney → Tencent → Sina；全源失败明确报错 |
| `LUOOME_FUNDAMENTAL_PROVIDER` | 可选 | 默认不装配；仅显式设置 `mock` 才注入固定 PIT fixture，gate 永远为 `not-ready`，不代表真实数据可用 |
| `LUOOME_MARKET_SOURCES` | `eastmoney,tencent,sina` | 行情数据源启用顺序；可显式加入 `tushare`（需 `TUSHARE_TOKEN`）/ `fuyao`（需 `FUYAO_API_KEY`） |
| `LUOOME_PORTFOLIO_BENCHMARK_STOCK_ID` | `000300.SH` | 账户绩效默认 benchmark；首期为沪深300，可用真实指数日线覆盖时才显示可用 |
| `LUOOME_STOCK_UNIVERSE_SOURCES` | `eastmoney,sina` | 股票目录数据源顺序；支持 `eastmoney,sina,tushare` |
| `LUOOME_LIMIT_UP_LADDER_SOURCES` | `eastmoney` | 连板天梯数据源顺序；当前仅注册 `eastmoney` |
| `TUSHARE_TOKEN` | — | 任一路由显式启用 `tushare` 时必填 |
| `LUOOME_AI_CONFIG` | `$LUOOME_HOME/ai-models.json` | AI SDK 模型目录；默认路径缺失时自动生成，格式见 [`ai-models.example.json`](./ai-models.example.json) |
| provider 密钥变量 | 由目录指定 | `apiKeyEnv` 引用环境变量名，密钥不写入模型目录 |
| `LUOOME_RESEARCH_VAULT` | — | 单机 Obsidian Vault 绝对路径；Web 受管文件按用户隔离 |
| `LUOOME_RESEARCH_ROOT` | `Research` | Vault 内参与研究索引扫描的相对目录 |
| `LUOOME_RESEARCH_MANAGED_ROOT` | `Research/Luoome` | luoome 可创建受管研究文件的相对目录，必须位于 research root 内 |
| `LUOOME_RESEARCH_EMBEDDING_ENABLED` | 关 | `=true`：显式挂载 Research embedding 外部 capability；默认搜索仍为本地 FTS5 |
| `LUOOME_RESEARCH_EMBEDDING_CONFIG` | `$LUOOME_HOME/research-embeddings.json` | OpenAI-compatible embedding 模型目录；只写 `apiKeyEnv` 名，不写密钥 |
| `LUOOME_RESEARCH_REMOTE_SYNC` | 关 | `=git`：启用独立 Git-only Vault 拉取 workflow；仍需 write/external 双 opt-in |
| `LUOOME_EXPOSE_WRITE` | 关 | `=true`：允许 write 类能力；Web 仍需登录、订阅与归属校验 |
| `LUOOME_EXPOSE_EXTERNAL` | 关 | `=true`：MCP 追加 external 类 tool |
| `LUOOME_EXPOSE_TRADE` | 关（**硬卡**） | `=true` 时 MCP server 启动即抛错退出（trade 永不暴露） |
| `LUOOME_FEISHU_WEBHOOK_URL` | — | 单机飞书通知 webhook；不能作为所有 Web 用户共用的私人通知目的地 |
| `LUOOME_A_SHARE_HOLIDAYS` | — | 追加 A 股休市日（逗号分隔 `YYYY-MM-DD`），与内置日历 union |
| `LUOOME_HOLIDAYS_FILE` | `$LUOOME_HOME/holidays.json` | 节假日历文件路径；文件损坏静默 fallback 到内置 |
| `LUOOME_STRATEGY_SCHEDULE_LEASE_MINUTES` | `30` | Strategy schedule claim 租约分钟数；范围 5～240 |
| `LUOOME_STRATEGY_DATA_CONCURRENCY` | `8` | Strategy 日线准备并发；范围 1～64 |
| `LUOOME_STRATEGY_DATA_MAX_STALENESS_TRADING_DAYS` | `1` | Strategy 成员日线允许陈旧交易日数；范围 0～30 |
| `LUOOME_STRATEGY_DATA_MAX_RETRIES` | `2` | Strategy 单成员行情最大重试次数；范围 0～5 |
| `LUOOME_STRATEGY_DATA_REQUEST_TIMEOUT_MS` | `20000` | Strategy 单成员行情请求超时（毫秒）；范围 500～120000 |
| `LUOOME_LOG` | info | `debug` / `info` / `warn` / `error` / `silent` |

生产拒绝 fixture provider。CLI/TUI/MCP 的单机库与 Web 私有库分开，不能通过缺少登录上下文的工具命令访问服务用户数据。

默认行情链路无需供应商密钥：报价由东方财富、腾讯、新浪按顺序提供；指数有东方财富与腾讯，
分钟 OHLCV 有腾讯原生 K 线。批量报价逐源补齐缺失股票，最后只对剩余项逐股重试；
已成功的报价保留原来源。缺失时间的报价会标记 `retrieval`，不能作为盘中行动的可信时间证据。
Tushare 与扶摇继续按显式配置接入，各能力与最近运行状态可通过 `get_market_data_status` 查询。

AI 模型由 adapters 内的 AI SDK Provider Registry 统一管理。`providers` 可声明
`openai-compatible`、`anthropic` 或 `gateway`，`profiles.generation` 与
`profiles.agent` 可分别选择 `provider:model`、默认生成参数和运行预算。旧
`LUOOME_LLM_*` / `LUOOME_AGENT_*` 不再读取。

模型目录支持 Kimi 与 DeepSeek preset：Kimi 默认使用 `kimi-k3`、
`https://api.moonshot.cn/v1` 和 `MOONSHOT_API_KEY`；DeepSeek 默认使用
`deepseek-v4-pro`、`https://api.deepseek.com` 和 `DEEPSEEK_API_KEY`。两者均通过
OpenAI-compatible Chat Completions 接入。

Web 的模型、数据源及密钥由运营配置，普通用户在原设置页管理个人通知、订阅与账户名称。
单机 CLI/TUI/MCP 继续读取自己的模型目录和环境配置；这些个人文件不会被 Web 自动加载。

## 文档

| 文档 | 用途 |
|---|---|
| [docs/README.md](./docs/README.md) | **完整文档导航**：产品需求、技术设计、运维手册与历史归档 |
| [docs/USER_GUIDE.md](./docs/USER_GUIDE.md) | 用户手册：安装 / CLI / TUI / Web / MCP / 多账户 / 复盘 / 校准 / FAQ |
| [skills/luoome/SKILL.md](./skills/luoome/SKILL.md) | 外部 Agent 接入：Skill 编排 + luoome MCP typed tools |
| [AGENTS.md](./AGENTS.md) | 编码 Agent 开发规范：架构边界、实现约定、测试与安全规则 |
| [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) | 架构核心：模块、概念、数据流、安全模型、advisor 模型 |
| [docs/ROADMAP.md](./docs/ROADMAP.md) | 版本演进与交付状态 |
| [docs/CONTRIBUTING.md](./docs/CONTRIBUTING.md) | 贡献者指南：开发环境、测试与扩展方式 |
| [docs/SECURITY.md](./docs/SECURITY.md) | 副作用分级、鉴权、密钥与审计要求 |

## 快速启动

```bash
# 一键安装（macOS / Linux，无需 git clone，自动装 Bun + 源码 + luoome 命令）
curl -fsSL https://raw.githubusercontent.com/KowL/luoome/main/install.sh | sh

# Windows（PowerShell 5.1+）
irm https://raw.githubusercontent.com/KowL/luoome/main/install.ps1 | iex

# 或者从本仓库安装依赖
bun install

# 按运行手册配置服务环境后，在不同终端启动同一应用的 Web 和 worker
bun --no-env-file run web
bun --no-env-file run worker
```

浏览器打开配置的 `PUBLIC_ORIGIN`，通过邮箱验证码登录。开发与生产均使用这些命令；
开发使用独立数据目录、测试套餐及邮件配置，生产使用审核后的部署配置。配置缺失会明确失败，不会退回免登录页面。

`./bin/luoome start`、`restart` 和 `web serve` 也启动同一认证 Web，默认后台运行，日志追加到
`$LUOOME_HOME/logs/luoome.log`；需要前台调试时加 `--foreground`。这些入口不加载个人或项目 `.env`，
也不在 Web 中启动单机 watch；worker 仍单独运行。直接用 Bun 调 CLI 时必须带 `--no-env-file`。

## 自动任务

Web 不启动单机 scheduler。独立 worker 已有持久任务、通知/支付对账和恢复基础设施；
原策略调度、账户计划、报告及观察补全的完整租户任务接线，以及统一额度计量仍未完成。
启动 Web 或 worker 不代表这些自动业务已经可用，交付状态见[改造计划](./docs/hosted-personal-subscription-development-plan.md)。

单机 CLI 的 `watch` 与 `workflow run` 能力继续保留，仅访问自己的单机库。下列 cron 是单机使用示例，
不能作为绕过 Web 身份与订阅的服务器租户调度方案；每次 workflow 运行落一条 `WorkflowRun` 审计：

```cron
# 事件同步：每交易日 08:30（财报 / 解禁 / 分红…，按 (provider, externalId) 幂等 upsert）
30 8 * * 1-5  luoome workflow run sync-stock-events
# event-date 求值：每交易日 08:50（同步之后；命中提醒窗口的事件推送）
50 8 * * 1-5  luoome workflow run evaluate-event-rules
# 盘后数据闭环：目录完整快照 + 相关股票前复权日线 + 数据健康汇总
30 16 * * 1-5  luoome workflow run post-market-data
# 盘后补齐信号 T+1/T+3/T+5 真实表现（未到期样本保持 pending）
10 18 * * 1-5   luoome workflow run complete-strategy-observations
# 收盘复盘与周报：报告先保存，通知失败只会把 WorkflowRun 降为 partial
0 18 * * 1-5   luoome workflow run closing-report --mode scheduled
0 19 * * 5     luoome workflow run weekly-report --mode scheduled
# 开盘简报：周一会自动读取前一交易日，而不是自然日前一天
0 9 * * 1-5    luoome workflow run opening-report --mode scheduled
# 可选 Research Vault Git 拉取：仅干净工作树 + fast-forward，先备份再重建索引
# 0 */2 * * *  luoome workflow run sync-research-vault-remote --mode scheduled
```

- `sync-stock-events`：空列表不删旧事件；单 provider 失败标 stale 并记 `partial`/`failed`。未配置数据源时记 `succeeded`、`upserted=0`。
- `evaluate-event-rules`：盘前一次，`intraday-watch` 不重新评估 event-date 规则；`normal` 优先级仅记录，`important/urgent` 走飞书，未配置时标记 `fallback-log`。
- 预警试跑不写正式触发或改变边沿状态。盘中循环与事件任务共用执行租约；失败及中断投递由后续盘中循环或事件执行补偿，当日最多尝试三次，重试间隔 1 分钟、5 分钟，仍受每日额度限制。
- `post-market-data`：非交易日跳过；目录失败不阻断相关股票日线，局部失败返回 `partial`。
- 内置 `run-strategy-schedules`：每次 tick 原子抢占到期配置；非交易日或暂停策略跳过并推进，
  多实例与手工正式运行由租约防重。策略启用推荐政策后，完成运行会按评分、排名、每轮上限和冷却
  生成可追溯 Advice，并可通知；Advice 失败不回滚运行，且不会自动交易。
- `complete-strategy-observations`：以信号基准后的第 N 根 qfq 日线补齐事实观察；日线不足时
  保持 `pending`，当前无指数日线时 benchmark 明确标记 unavailable；配置的 T+n 节点完成后可触发
  对应股票的阶段 Advice。也可手工运行 `strategy-recommendations`，输入策略、运行和推荐政策。
- 三类报告 workflow 在 `scheduled` 模式默认通知；可在 `--input` 中显式传
  `{"notify":false}` 关闭。相同类型、范围与周期重复运行会更新同一份 Report。
- `sync-stock-universe` 仍可单独人工执行；完整分页通过校验后原子提交，12 小时内有成功版本时默认跳过。
- 含 event-date 的方案建议单独建（event-date 不参与盘中 ANY/ALL 组合判定）。

## 状态

**当前模型 — Strategy + 统一 Watchlist + AlertPlan**

- 看板聚合账户 PnL、建议、AlertPlan 健康度和最近触发
- 持仓完整录入闭环与交易流水
- Strategy 不可变版本、校验、发布、dry-run/正式运行与信号事实
- Watchlist 支持 manual / strategy / ai / portfolio / import 多来源与研究阶段
- Strategy → Watchlist 需要显式持久订阅；可在 Strategy 设置页或对应 Tool 中取消，重复 producerRun 幂等
- AlertPlan 引用 Watchlist，提供单轮试跑、全局心跳与 Trigger 审计
- Web 默认仅监听 `127.0.0.1`，mutation 统一显式能力开关 + 同源校验
- `luoome start` 与 `web serve` 使用同一认证 Web；后台任务由独立 worker 承担

历史演进见 [docs/ROADMAP.md](./docs/ROADMAP.md)。
