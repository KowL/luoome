# luoome

> **织机 + 罗网 — 汇聚网罗有价值的信息数据，在面对变化的市场时提供准确的建议。**

luoome 是一个可自行部署的个人投资管理 **advisor agent**。它把账户、持仓、交易、行情、
Strategy、Watchlist、AlertPlan、笔记与建议能力以 tool 形式暴露，并把多源数据织成可追溯事实。

- 作为 **DSH 插件** 接入 DSH：默认部署由 dsh-luoome 在 DSH Node 进程内提供三面板、四技能与原生工具/审批，事实库是 `$LUOOME_HOME/luoome.db`（Node SQLite）；旧 MCP 四实例仅保留给手动/隔离验收
- 作为 **MCP server** 被 DSH / Claude Desktop / OpenClaw / Hermes 等 agent 直接调用，并让它们替你做"分析 → 建议 → 行动"的推理
- 作为 **Web** 看板：账户、持仓、Strategy、Watchlist 与 AlertPlan（本地单机装配，随 DSH 面板使用）

当前形态是**单机版**：没有多租户、没有订阅计费、没有托管站点——DSH 是唯一入口，
`$LUOOME_HOME/luoome.db` 是唯一事实库。批处理调度由 DSH 的定时任务负责，
不再有常驻调度进程。真实供应商与生产放行仍待验收。

## 名字

**luoome = 织机 + 罗网**

- **织**：把分散的行情、财报、新闻、StrategySignal、历史持仓织成一张连贯的认知
- **罗**：把市场里有价值的信息数据罗（网）进来，不漏关键信号
- **me**：me，你（用户）是这一切的中心，不是旁观者

面对不断变化的市场，luoome 不替你下单，但**会主动告诉你**：哪里有机会、哪里有风险、哪些决策需要你确认。

## 设计原则

- **Advisor-first**：每一份数据最终都服务于"可执行的投资建议"，不是堆数据。
- **Agent-first**：所有能力都是 tool，没有"只能人用、agent 用不了"的功能。
- **数据自持**：SQLite 保存在本机 `$LUOOME_HOME/luoome.db`，只有一份事实库。
- **Schema-driven**：Zod schema 是 tool I/O 的事实来源，自动生成 TypeScript 类型、MCP tool 定义、OpenAI function calling schema。
- **Workflow ≠ Tool**：tool 是原子能力，workflow 是组合；workflow 内置编排，tool 暴露给上层 agent。
- **No magic**：每个数据源 / 适配器 / LLM 都显式可插拔，运行时可见。
- **Human-in-the-loop**：建议 ≠ 行动。advice 永远不直接触发交易；下单始终需要人确认。

## 它做什么

### 数据维度（读 + 写）

- 账户（单机多账户；Web 与 CLI/TUI/MCP 共享同一份账户事实）
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
  mcp/         MCP server，把 tool registry 暴露给外部（含批处理入口）
  dsh-bridge/  DSH 插件：只读面板、纪律提示词与独立 profile 装配
  cli/         命令行入口
  tui/         opentui 应用
apps/
  web/         Hono + 同源静态仪表盘（本地单机装配）
deploy/dsh/    独立 DSH 纯插件部署（compose、Caddy、插件 profile 装配）
infra/dsh/     DSH 构建与受控验证底座
.dsh/skills/   旧 MCP 过渡形态技能目录（P5 前保留给手动验收；默认部署使用插件随包的四条投研技能）
docs/          全部文档（架构 / 路线图 / 安全 / 交接 / 用户手册 / 设计文档 / backlog）
homebrew/
  luoome.rb    Homebrew formula（brew tap KowL/luoome && brew install luoome）
```

## 环境变量

单机形态没有多租户与订阅体系，也没有 `HOSTED_*` 配置族。下面是单机 CLI/TUI/MCP/DSH 共用的配置；
部署侧的 DSH/插件变量（`DSH_*`、`LUOOME_OWNER_*`、`LUOOME_HOME`、`CADDY_IMAGE`）见
[DSH 部署配置](deploy/dsh/production.env.example)。默认部署不再需要 `LUOOME_MCP_*`。

| 变量 | 默认 | 说明 |
|---|---|---|
| `LUOOME_HOME` | `~/.luoome` | 数据目录（含 `luoome.db`） |
| `LUOOME_MARKET_PROVIDER` | 必填 | 仅支持 `real`：Eastmoney → Tencent → Sina；全源失败明确报错 |
| `LUOOME_FUNDAMENTAL_PROVIDER` | 可选 | 默认不装配；仅显式设置 `mock` 才注入固定 PIT fixture，gate 永远为 `not-ready`，不代表真实数据可用 |
| `LUOOME_MARKET_SOURCES` | `eastmoney,tencent,sina` | 行情数据源启用顺序；可显式加入 `tushare`（需 `TUSHARE_TOKEN`）/ `fuyao`（需 `FUYAO_API_KEY`） |
| `LUOOME_PORTFOLIO_BENCHMARK_STOCK_ID` | `000300.SH` | 账户绩效默认 benchmark；首期为沪深300，可用真实指数日线覆盖时才显示可用 |
| `LUOOME_STOCK_UNIVERSE_SOURCES` | `eastmoney,sina` | 股票目录数据源顺序；支持 `eastmoney,sina,tushare` |
| `LUOOME_LIMIT_UP_LADDER_SOURCES` | `eastmoney` | 连板天梯数据源顺序；当前仅注册 `eastmoney` |
| `TUSHARE_TOKEN` | — | 任一路由显式启用 `tushare` 时必填 |
| `LUOOME_RESEARCH_VAULT` | — | 单机 Obsidian Vault 绝对路径；Web 受管文件按用户隔离 |
| `LUOOME_RESEARCH_ROOT` | `Research` | Vault 内参与研究索引扫描的相对目录 |
| `LUOOME_RESEARCH_MANAGED_ROOT` | `Research/Luoome` | luoome 可创建受管研究文件的相对目录，必须位于 research root 内 |
| `LUOOME_RESEARCH_EMBEDDING_ENABLED` | 关 | `=true`：显式挂载 Research embedding 外部 capability；默认搜索仍为本地 FTS5 |
| `LUOOME_RESEARCH_EMBEDDING_CONFIG` | `$LUOOME_HOME/research-embeddings.json` | OpenAI-compatible embedding 模型目录；只写 `apiKeyEnv` 名，不写密钥 |
| `LUOOME_RESEARCH_REMOTE_SYNC` | 关 | `=git`：启用独立 Git-only Vault 拉取 workflow；仍需 write/external 双 opt-in |
| `LUOOME_EXPOSE_WRITE` | 关 | `=true`：允许 write 类能力；Web 仍需同源校验与当前账户绑定 |
| `LUOOME_EXPOSE_EXTERNAL` | 关 | `=true`：MCP 追加 external 类 tool |
| `LUOOME_EXPOSE_TRADE` | 关（**硬卡**） | `=true` 时 MCP server 启动即抛错退出（trade 永不暴露） |
| `LUOOME_FEISHU_WEBHOOK_URL` | — | 单机飞书通知 webhook；单机形态下只服务这台机器上的操作者 |
| `LUOOME_A_SHARE_HOLIDAYS` | — | 追加 A 股休市日（逗号分隔 `YYYY-MM-DD`），与内置日历 union |
| `LUOOME_HOLIDAYS_FILE` | `$LUOOME_HOME/holidays.json` | 节假日历文件路径；文件损坏静默 fallback 到内置 |
| `LUOOME_STRATEGY_SCHEDULE_LEASE_MINUTES` | `30` | Strategy schedule claim 租约分钟数；范围 5～240 |
| `LUOOME_STRATEGY_DATA_CONCURRENCY` | `8` | Strategy 日线准备并发；范围 1～64 |
| `LUOOME_STRATEGY_DATA_MAX_STALENESS_TRADING_DAYS` | `1` | Strategy 成员日线允许陈旧交易日数；范围 0～30 |
| `LUOOME_STRATEGY_DATA_MAX_RETRIES` | `2` | Strategy 单成员行情最大重试次数；范围 0～5 |
| `LUOOME_STRATEGY_DATA_REQUEST_TIMEOUT_MS` | `20000` | Strategy 单成员行情请求超时（毫秒）；范围 500～120000 |
| `LUOOME_LOG` | info | `debug` / `info` / `warn` / `error` / `silent` |

生产拒绝 fixture provider。CLI/TUI/MCP/Web 与 DSH 插件共用同一份单机事实库 `$LUOOME_HOME/luoome.db`，没有第二份服务用户库；默认部署由插件在 DSH Node 进程内直接打开 Node SQLite，旧 MCP 实例仅在手动/隔离验收时使用。

默认行情链路无需供应商密钥：报价由东方财富、腾讯、新浪按顺序提供；指数有东方财富与腾讯，
分钟 OHLCV 有腾讯原生 K 线。批量报价逐源补齐缺失股票，最后只对剩余项逐股重试；
已成功的报价保留原来源。缺失时间的报价会标记 `retrieval`，不能作为盘中行动的可信时间证据。
Tushare 与扶摇继续按显式配置接入，各能力与最近运行状态可通过 `get_market_data_status` 查询。

模型推理与模型配置都由 DSH 承担：luoome 侧没有模型运行时、模型目录与模型设置页。
需要模型判断的任务由 DSH agent 经 MCP 调用工具完成，密钥由 DSH 侧配置。

模型推理与模型配置由 DSH 承担，luoome 侧不再有模型设置页；本地 CLI/TUI/MCP 读取同一份
默认目录和环境变量。Web 只管数据源、通知、账户与数据导入导出，没有管理员与普通用户之分，
也没有订阅与权益概念。

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

# 启动单机 Web（默认只监听 127.0.0.1:5173）
bun --no-env-file run web
```

单机形态没有邮箱登录，也没有订阅：DSH 是唯一入口，公网经 Caddy 转发到 dsh-pocket，
输入 Pocket 密码后自动完成 DSH 启动 token 握手，手机使用同一个入口。独立 Web 只在本机可达，
远程访问走 SSH 隧道或受控反代。

`./bin/luoome start`、`restart` 和 `web serve` 启动同一个单机 Web，默认后台运行，日志追加到
`$LUOOME_HOME/logs/luoome.log`；需要前台调试时加 `--foreground`。这些入口不加载个人或项目 `.env`。
批量调度由 DSH 定时任务负责，没有常驻调度进程。直接用 Bun 调 CLI 时必须带 `--no-env-file`。

## 自动任务

批处理调度由 **DSH 定时任务**负责：提醒写入真实投递回执后，宿主直接通过 `executeScheduled`
执行五个原生批处理入口（`run_strategy_daily_cycle`、`run_closing_report_cutoff`、
`run_portfolio_performance_snapshot`、`run_intraday_plan_batch`、`run_strategy_autonomy_weekly`），
业务执行不依赖模型工具调用；当前 DSH 版本仍会唤醒会话，但提示只要求保持静默。
每个任务必须有匹配当前任务指纹的持久授权，批处理与自动执行开关均需显式开启。
策略页也可直接准备并一次性确认正常日循环，无需进入 AI 对话，默认不使用 `force`。
门槛判定（交易日、盘中时段、盘后小时、周几）随工具走，不满足时返回 `skipped`，不会写库。
迁移与授权步骤见[用户手册](docs/USER_GUIDE.md#74-dsh-定时任务与批处理)。

队列消费能力保留，但默认部署已切纯插件、不运行常驻 worker：交互式分析经插件的原生
`record_advice` / `record_analysis_result` 确认操作直接写回，不创建 `analysis_job`；默认部署
没有生产者，也没有常驻消费者。旧 MCP worker 链路只作为手动/隔离验收入口保留在源码中
（见[用户手册](docs/USER_GUIDE.md#75-批量分析与队列)）。

单机 CLI 的 `watch` 与 `workflow run` 能力继续保留，仅访问自己的单机库。下列 cron 是单机使用示例；
每次 workflow 运行落一条 `WorkflowRun` 审计：

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
- `luoome start` 与 `web serve` 启动同一个单机 Web；批量调度由 DSH 定时任务承担

历史演进见 [docs/ROADMAP.md](./docs/ROADMAP.md)。

### 独立 DSH 部署（默认纯插件形态）

默认部署由 DSH 用 Node 加载 **dsh-luoome 插件**：插件提供五块业务面板（看盘 / 持仓 / 关注 / 策略 / 复盘）、
四条投研技能与原生只读/审批工具，安装/升级/备份/回退步骤见
[用户手册](docs/USER_GUIDE.md#7-dsh-单机用法)。部署入口与配置见
[DSH 部署配置](deploy/dsh/compose.yaml)。

- 事实库是 `$LUOOME_HOME/luoome.db`（Node SQLite），由插件在 DSH 进程内直接打开；没有第二份服务用户库。
- 默认部署没有 MCP client/server、Bun CLI、旧 Bun Web、analysis worker 或 queue probe 进程；
  `docker compose config` 只有 `dsh-web`（Node）与 `caddy`。
- 写操作（交互分析 record、复盘、策略创建/校验/发布、用户反馈）只经 DSH 原生确认操作执行；
  `trade` 永不注册，`LUOOME_EXPOSE_TRADE=true` 启动即失败；自动任务默认关闭。
- 旧 MCP 过渡形态（`luoome` / `luoome-settings` / `luoome-analysis` / `luoome-batch` 四实例与
  手动 worker）源码保留，仅用于手动/隔离验收，**默认部署不再启动**；P5 再统一删除。
- 批量分析仍使用 `analysis_job` 租约队列；队列实体、repository、claim/complete/fail 与手动验收链路
  全部保留，默认部署没有生产者 workflow，也不再运行常驻消费者。消费者取得冻结事实包后生成结果，
  由 `complete_analysis_job` 在同一事务中校验来源、写回并完成任务。
- 存量建议标为 `legacy-ai`；新建议保留生成器、模型、技能版本和事实时点。
- 模型调用只在 DSH 侧发生；luoome 领域工具与工作流不直接调用模型。

> 当前仓库只完成隔离切换/回退演练（`infra/dsh/plugin-switch-acceptance.ts`），**尚未在真实生产
> 服务器执行切换**；旧 MCP/Bun 源码尚未删除。
