# luoome

> **织机 + 罗网 — 汇聚网罗有价值的信息数据，在面对变化的市场时提供准确的建议。**

luoome 是一个本地优先的个人投资管理 **advisor agent**。它把账户、持仓、交易、行情、
Strategy、Watchlist、AlertPlan、笔记与建议能力以 tool 形式暴露，并把多源数据织成可追溯事实。

- 作为 **TUI** 在终端盯盘、看建议
- 作为 **Web** 管理看板、持仓、Strategy、Watchlist 与 AlertPlan
- 作为 **MCP server** 被 Claude Desktop / OpenClaw / Hermes 等 agent 直接调用，并让它们替你做"分析 → 建议 → 行动"的推理

## 名字

**luoome = 织机 + 罗网**

- **织**：把分散的行情、财报、新闻、StrategySignal、历史持仓织成一张连贯的认知
- **罗**：把市场里有价值的信息数据罗（网）进来，不漏关键信号
- **me**：me，你（用户）是这一切的中心，不是旁观者

面对不断变化的市场，luoome 不替你下单，但**会主动告诉你**：哪里有机会、哪里有风险、哪些决策需要你确认。

## 设计原则

- **Advisor-first**：每一份数据最终都服务于"可执行的投资建议"，不是堆数据。
- **Agent-first**：所有能力都是 tool，没有"只能人用、agent 用不了"的功能。
- **Local-first**：数据在本地 SQLite，默认无云同步。
- **Schema-driven**：Zod schema 是 tool I/O 的事实来源，自动生成 TypeScript 类型、MCP tool 定义、OpenAI function calling schema。
- **Workflow ≠ Tool**：tool 是原子能力，workflow 是组合；workflow 内置编排，tool 暴露给上层 agent。
- **No magic**：每个数据源 / 适配器 / LLM 都显式可插拔，运行时可见。
- **Human-in-the-loop**：建议 ≠ 行动。advice 永远不直接触发交易；下单始终需要人确认。

## 它做什么

### 数据维度（读 + 写）

- 账户（多账户、真实/模拟）
- 持仓、交易、笔记、预警
- 行情快照、日线、技术指标
- 版本化 Strategy + StrategyResult / StrategySignal
- 多来源 Watchlist + AlertPlan / WatchTrigger
- 风控指标（VaR、Sharpe、最大回撤、集中度）

### 分析维度（只读）

- PnL、风险敞口、行业暴露
- Strategy 扫描、评分与可解释规则结果
- 多源行情交叉验证
- LLM 推理总结（每日复盘、个股分析）

### 建议维度（核心）

- **个股建议**：基于技术面、基本面、StrategySignal 与 LLM 综合判断，输出 buy / sell / hold / watch / avoid 决策
- **持仓建议**：每个持仓的继续持有 / 加仓 / 减仓 / 清仓建议
- **市场观点**：每日大盘观点、行业轮动、热点板块
- **风险预警**：跌破止损位、触发风控规则、异常波动
- **confidence 自校准**：历史 advice 按信心桶聚合 hitRate，告诉你系统 confidence 是否被高估

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
docs/          全部文档（架构 / 路线图 / 安全 / 交接 / 用户手册 / 设计文档 / backlog）
homebrew/
  luoome.rb    Homebrew formula（brew tap KowL/luoome && brew install luoome）
```

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `LUOOME_HOME` | `~/.luoome` | 数据目录（含 `luoome.db`、`ai-models.json`） |
| `LUOOME_MARKET_PROVIDER` | 必填 | 仅支持 `real`：Eastmoney 主 → Tencent 备；全源失败明确报错 |
| `LUOOME_MARKET_SOURCES` | `eastmoney,tencent` | 行情数据源启用顺序；可显式加入 `tushare` |
| `LUOOME_STOCK_UNIVERSE_SOURCES` | `eastmoney` | 股票目录数据源顺序；支持 `eastmoney,tushare` |
| `LUOOME_LIMIT_UP_LADDER_SOURCES` | `eastmoney` | 连板天梯数据源顺序；当前仅注册 `eastmoney` |
| `TUSHARE_TOKEN` | — | 任一路由显式启用 `tushare` 时必填 |
| `LUOOME_AI_CONFIG` | `$LUOOME_HOME/ai-models.json` | AI SDK 模型目录；默认路径缺失时自动生成，格式见 [`ai-models.example.json`](./ai-models.example.json) |
| provider 密钥变量 | 由目录指定 | `apiKeyEnv` 引用环境变量名，密钥不写入模型目录 |
| `LUOOME_EXPOSE_WRITE` | 关 | `=true`：MCP 追加 write 类 tool；Web 挂载 outcome 回填 endpoint |
| `LUOOME_EXPOSE_EXTERNAL` | 关 | `=true`：MCP 追加 external 类 tool |
| `LUOOME_EXPOSE_TRADE` | 关（**硬卡**） | `=true` 时 MCP server 启动即抛错退出（trade 永不暴露） |
| `LUOOME_FEISHU_WEBHOOK_URL` | — | 飞书通知 webhook；缺失时通知降级为 log，不抛错 |
| `LUOOME_A_SHARE_HOLIDAYS` | — | 追加 A 股休市日（逗号分隔 `YYYY-MM-DD`），与内置日历 union |
| `LUOOME_HOLIDAYS_FILE` | `$LUOOME_HOME/holidays.json` | 节假日历文件路径；文件损坏静默 fallback 到内置 |
| `LUOOME_LOG` | info | `debug` / `info` / `warn` / `error` / `silent` |
| `LUOOME_PORT` | 5173 | Web 端口（与 `--port` 等价） |

AI 模型由 adapters 内的 AI SDK Provider Registry 统一管理。`providers` 可声明
`openai-compatible`、`anthropic` 或 `gateway`，`profiles.generation` 与
`profiles.agent` 可分别选择 `provider:model`、默认生成参数和运行预算。旧
`LUOOME_LLM_*` / `LUOOME_AGENT_*` 不再读取。

Web 内置 Kimi 与 DeepSeek preset：Kimi 默认使用 `kimi-k3`、
`https://api.moonshot.cn/v1` 和 `MOONSHOT_API_KEY`；DeepSeek 默认使用
`deepseek-v4-pro`、`https://api.deepseek.com` 和 `DEEPSEEK_API_KEY`。两者均通过
OpenAI-compatible Chat Completions 接入。

Web 用户可直接进入「设置 → LLM 设置」选择提供商、模型、端点和生成参数并保存。
配置保存后立即应用到当前 Web 进程；模型目录写入
`$LUOOME_HOME/ai-models.json`，API Key 单独写入权限为 `0600` 的
`$LUOOME_HOME/.env`，读取 API 永不回显密钥。CLI/TUI/MCP 仍复用同一份配置。

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
bun install
./bin/luoome start
```

浏览器打开 `http://127.0.0.1:5173`。执行写操作前需以 `LUOOME_EXPOSE_WRITE=true` 启动 Web。

`start` / `restart` / `web serve` 默认后台运行，终端立即解放，日志追加到 `~/.luoome/logs/luoome.log`（`tail -f` 查看）；需要前台调试时加 `--foreground`。

## 自动任务

策略调度已内置：`luoome start` 与 `luoome web serve` 启动后每分钟自动检查一次
`StrategySchedule`，进程启动时也会立即检查，不需要配置 crontab。每个策略仍按自己的标准 5 段
cron 和 IANA 时区决定实际运行时间；多实例与手工正式运行由租约防重。

其它低频自动任务仍由 workflow + 外部 cron 触发（每次运行落一条 `WorkflowRun` 审计，
`list_workflow_runs` 可查）。建议在 crontab 中配置：

```cron
# 事件同步：每交易日 08:30（财报 / 解禁 / 分红…，按 (provider, externalId) 幂等 upsert）
30 8 * * 1-5  luoome workflow run sync-stock-events
# event-date 求值：每交易日 08:50（同步之后；命中提醒窗口的事件推送）
50 8 * * 1-5  luoome workflow run evaluate-event-rules
# 盘后数据闭环：目录完整快照 + 相关股票前复权日线 + 数据健康汇总
30 16 * * 1-5  luoome workflow run post-market-data
# 盘后补齐信号 T+1/T+3/T+5/T+20 真实表现（未到期样本保持 pending）
10 18 * * 1-5   luoome workflow run complete-strategy-observations
# 收盘复盘与周报：报告先保存，通知失败只会把 WorkflowRun 降为 partial
0 18 * * 1-5   luoome workflow run closing-report --mode scheduled
0 19 * * 5     luoome workflow run weekly-report --mode scheduled
# 开盘简报：周一会自动读取前一交易日，而不是自然日前一天
0 9 * * 1-5    luoome workflow run opening-report --mode scheduled
```

- `sync-stock-events`：空列表不删旧事件；单 provider 失败标 stale 并记 `partial`/`failed`。未配置数据源时记 `succeeded`、`upserted=0`。
- `evaluate-event-rules`：盘前一次，`intraday-watch` 不评估 event-date 规则；`normal` 优先级仅记录，`important/urgent` 推送。
- `post-market-data`：非交易日跳过；目录失败不阻断相关股票日线，局部失败返回 `partial`。
- 内置 `run-strategy-schedules`：每次 tick 原子抢占到期配置；非交易日或暂停策略跳过并推进，
  多实例与手工正式运行由租约防重。调度只执行 Strategy，不生成 Advice、不发通知、不交易。
- `complete-strategy-observations`：以信号基准后的第 N 根 qfq 日线补齐事实观察；日线不足时
  保持 `pending`，当前无指数日线时 benchmark 明确标记 unavailable。
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
- AlertPlan 引用 Watchlist，提供单轮试跑、全局心跳与 Trigger 审计
- Web 默认仅监听 `127.0.0.1`，mutation 统一显式能力开关 + 同源校验
- `luoome start` 一键启动 Web + 长驻盯盘

历史演进见 [docs/ROADMAP.md](./docs/ROADMAP.md)。
