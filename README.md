# luoome

> **织机 + 罗网 — 汇聚网罗有价值的信息数据，在面对变化的市场时提供准确的建议。**

luoome 是一个可自行部署的个人投资管理 **advisor agent**。它把账户、持仓、交易、行情、
Strategy、Watchlist、AlertPlan、笔记与建议能力以 tool 形式暴露，并把多源数据织成可追溯事实。

- 作为 **DSH 插件** 接入 DSH：dsh-luoome 在 DSH Node 进程内提供五块业务面板、随包技能与原生工具，事实库是 `$LUOOME_HOME/luoome.db`（Node SQLite）
- 通过 **DSH Web 面板** 查看和维护账户、持仓、Strategy、Watchlist 与复盘，写入按明确意图执行并保留 Operation 回执
- 独立的 `luoome` CLI / TUI 已随 T15 下线：两个包、仓库内命令入口、安装 shim 与 Homebrew
  formula 一并删除；能力改由插件面板与工具提供，见
  [packages/dsh-luoome/README.md](./packages/dsh-luoome/README.md)

> stdio MCP 用户入口（`packages/mcp`、`luoome mcp serve` 与四个 MCP 实例）已按 REQ-M2-03
> 删除；暴露面判定归位到 `packages/tools/src/exposure/`，由插件面与 Web 面共同使用。

当前形态是**单机版**：没有多租户、没有订阅计费、没有托管站点——DSH 是唯一入口，
`$LUOOME_HOME/luoome.db` 是唯一事实库。批处理调度由 DSH 的定时任务负责，
不再有独立常驻调度进程。当前能力、可选后台模型和实验数据门槛见
[领域语言](./CONTEXT.md)与[插件说明](./packages/dsh-luoome/README.md)。

## 名字

**luoome = 织机 + 罗网**

- **织**：把分散的行情、财报、新闻、StrategySignal、历史持仓织成一张连贯的认知
- **罗**：把市场里有价值的信息数据罗（网）进来，不漏关键信号
- **me**：me，你（用户）是这一切的中心，不是旁观者

面对不断变化的市场，luoome 不替你下单，但**会主动告诉你**：哪里有机会、哪里有风险、哪些决策需要你确认。

## 设计原则

- **Advisor-first**：事实支持研究、提醒、建议和复盘，建议保留证据与风险；研究资料不必先转成建议。
- **Agent-first**：业务能力复用统一 tools；插件按能力与账户选择开放入口，trade 保留专用人工路径。
- **数据自持**：SQLite 保存在本机 `$LUOOME_HOME/luoome.db`，只有一份事实库。
- **Schema-driven**：Zod schema 是 tool I/O 的事实来源，自动生成 TypeScript 类型、MCP tool 定义、OpenAI function calling schema。
- **Workflow ≠ Tool**：tool 是原子能力，workflow 是组合；workflow 内置编排，tool 暴露给上层 agent。
- **No magic**：数据源显式配置并披露运行状态；模型路由与凭据由 DSH 管理。
- **Human-in-the-loop**：建议 ≠ 行动。advice 永远不直接触发交易；下单始终需要人确认。

## 它做什么

### 数据维度（读 + 写）

- 账户（单机多账户；Web 与 DSH 插件共享同一份账户事实）
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

- **个股建议**：DSH 基于冻结事实与可核对的策略证据分析，经 `record_advice` 写回 buy / sell / hold / watch / avoid；缺失事实明确披露，实验 PIT 基本面评分不作为生产输入
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
  adapters/    行情 / 通知 / 事件 / 研究资料适配
  workflows/   确定性编排：策略 / 观察 / 计划 / 报告
  batch/       共享 run_* 批处理入口
  dsh-luoome/  DSH host / client / skills 与 Node SQLite 装配
deploy/direct/ 宿主机直部署与升级配置
deploy/dsh/    容器部署与整栈回退配置
infra/dsh/     DSH 构建与受控验证底座
docs/          领域 / 架构 / 产品需求 / 详细设计 / 运维 / 历史归档
```

## 环境变量

单机形态没有多租户与订阅体系，也没有 `HOSTED_*` 配置族。下面是单机 Web 与 DSH 插件共用的配置；
部署侧的 DSH/插件变量（`DSH_*`、`LUOOME_OWNER_*`、`LUOOME_HOME`、`CADDY_IMAGE`）见
[DSH 部署配置](deploy/dsh/production.env.example)。默认部署不再需要 `LUOOME_MCP_*`。

| 变量 | 默认 | 说明 |
|---|---|---|
| `LUOOME_HOME` | `~/.luoome` | 数据目录（含 `luoome.db`） |
| `LUOOME_ANALYSIS_PROVIDER` | 关 | 与 `LUOOME_ANALYSIS_MODEL` 成对配置，显式启用 DSH 普通后台分析模型；provider 须已由 DSH 注册，不增加模型可见队列生产者 |
| `LUOOME_ANALYSIS_MODEL` | 关 | 普通后台分析所用 DSH 模型 ID；路由启动时冻结，凭据由 DSH 管理；详见[插件说明](packages/dsh-luoome/README.md#可选后台分析模型) |
| `LUOOME_MARKET_PROVIDER` | 必填 | 仅支持 `real`：Eastmoney → Tencent → Sina；全源失败明确报错 |
| `LUOOME_FUNDAMENTAL_PROVIDER` | 可选 | 默认不装配；仅显式设置 `mock` 才注入固定 PIT fixture，gate 永远为 `not-ready`，不代表真实数据可用 |
| `LUOOME_MARKET_SOURCES` | `eastmoney,tencent,sina` | 行情数据源启用顺序；可显式加入 `fuyao`（需 `FUYAO_API_KEY`）/ `xueqiu` |
| `LUOOME_PORTFOLIO_BENCHMARK_STOCK_ID` | `000300.SH` | 账户绩效默认 benchmark；首期为沪深300，可用真实指数日线覆盖时才显示可用 |
| `LUOOME_STOCK_UNIVERSE_SOURCES` | `eastmoney,sina` | 股票目录数据源顺序；支持 `eastmoney,sina` |
| `LUOOME_LIMIT_UP_LADDER_SOURCES` | `eastmoney` | 连板天梯来源；支持 `eastmoney,fuyao` |
| `LUOOME_ASHARE_SENTIMENT_SOURCES` | `eastmoney` | A 股情绪来源；支持 `eastmoney,fuyao` |
| `LUOOME_DRAGON_TIGER_SOURCES` | `eastmoney` | 龙虎榜来源；支持 `eastmoney,fuyao` |
| `LUOOME_NEWS_SOURCES` | `eastmoney,10jqka` | 财经快讯来源；也支持 `fuyao` |
| `LUOOME_SECTOR_QUOTE_SOURCES` | `eastmoney` | 板块行情来源；支持 `eastmoney,fuyao` |
| `LUOOME_SECTOR_MEMBERSHIP_SOURCES` | 关 | `fuyao`：当前个股板块关系；不代表历史成分 |
| `LUOOME_FINANCIAL_SNAPSHOT_SOURCES` | 关 | `fuyao`：财务当前快照；`pitStatus=not-ready` |
| `LUOOME_MARKET_DUMP_SOURCES` | 关 | `fuyao`：显式启用 dump 同步；artifact 保存于 `$LUOOME_HOME/market-dumps` |
| `LUOOME_FUYAO_NEWS_TAG_ID` | — | Fuyao 快讯启用时必填；`21103` 已验证为财经混合流 |
| `FUYAO_API_KEY` | — | 任一 Fuyao 能力启用时必填；仅通过请求头发送 |
| `FUYAO_BASE_URL` | `https://fuyao.aicubes.cn` | Fuyao API 地址 |
| `FUYAO_MAX_CONCURRENCY` | `2` | 所有 Fuyao REST 请求共享并发上限 |
| `FUYAO_MIN_INTERVAL_MS` | `200` | 共享请求启动间隔（毫秒） |
| `FUYAO_RATE_LIMIT_COOLDOWN_MS` | `30000` | HTTP 429 缺有效 Retry-After 时的共享冷却（毫秒） |
| `FUYAO_RATE_LIMIT_MAX_RETRIES` | `2` | 幂等请求的限流重试次数 |
| `LUOOME_RESEARCH_VAULT` | — | 单机 Obsidian Vault 绝对路径；Web 受管文件按用户隔离 |
| `LUOOME_RESEARCH_ROOT` | `Research` | Vault 内参与研究索引扫描的相对目录 |
| `LUOOME_RESEARCH_MANAGED_ROOT` | `Research/Luoome` | luoome 可创建受管研究文件的相对目录，必须位于 research root 内 |
| `LUOOME_RESEARCH_EMBEDDING_ENABLED` | 关 | `=true`：显式挂载 Research embedding 外部 capability；默认搜索仍为本地 FTS5 |
| `LUOOME_RESEARCH_EMBEDDING_CONFIG` | `$LUOOME_HOME/research-embeddings.json` | OpenAI-compatible embedding 模型目录；只写 `apiKeyEnv` 名，不写密钥 |
| `LUOOME_RESEARCH_REMOTE_SYNC` | 关 | `=git`：启用独立 Git-only Vault 拉取 workflow；仍需 write/external 双 opt-in |
| `LUOOME_EXPOSE_WRITE` | 关 | `=true`：允许 write 类能力；Web 仍需同源校验与当前账户绑定 |
| `LUOOME_EXPOSE_EXTERNAL` | 关 | `=true`：Web/CLI 放行 external 类 tool |
| `LUOOME_EXPOSE_TRADE` | 关（**硬卡**） | `=true` 时 DSH 插件与 Web 启动即抛错退出（trade 永不暴露） |
| `LUOOME_FEISHU_WEBHOOK_URL` | — | 单机飞书通知 webhook；单机形态下只服务这台机器上的操作者 |
| `LUOOME_A_SHARE_HOLIDAYS` | — | 追加 A 股休市日（逗号分隔 `YYYY-MM-DD`），与内置日历 union |
| `LUOOME_HOLIDAYS_FILE` | `$LUOOME_HOME/holidays.json` | 节假日历文件路径；文件损坏静默 fallback 到内置 |
| `LUOOME_STRATEGY_SCHEDULE_LEASE_MINUTES` | `30` | Strategy schedule claim 租约分钟数；范围 5～240 |
| `LUOOME_STRATEGY_DATA_CONCURRENCY` | `8` | Strategy 日线准备并发；范围 1～64 |
| `LUOOME_STRATEGY_DATA_MAX_STALENESS_TRADING_DAYS` | `1` | Strategy 成员日线允许陈旧交易日数；范围 0～30 |
| `LUOOME_STRATEGY_DATA_MAX_RETRIES` | `2` | Strategy 单成员行情最大重试次数；范围 0～5 |
| `LUOOME_STRATEGY_DATA_REQUEST_TIMEOUT_MS` | `20000` | Strategy 单成员行情请求超时（毫秒）；范围 500～120000 |
| `LUOOME_LOG` | info | `debug` / `info` / `warn` / `error` / `silent` |

生产拒绝 fixture provider。Web 与 DSH 插件共用同一份单机事实库 `$LUOOME_HOME/luoome.db`，没有第二份服务用户库；默认部署由插件在 DSH Node 进程内直接打开 Node SQLite。

默认行情链路无需供应商密钥：报价由东方财富、腾讯、新浪按顺序提供；指数有东方财富与腾讯，
分钟 OHLCV 有腾讯原生 K 线。批量报价逐源补齐缺失股票，最后只对剩余项逐股重试；
已成功的报价保留原来源。缺失时间的报价会标记 `retrieval`，不能作为盘中行动的可信时间证据。
扶摇按各领域的显式配置接入，各能力与最近运行状态可通过 `get_market_data_status` 查询。
`get_stock_sector_memberships` 返回当前板块关系，`get_stock_financial_snapshot` 返回财务当前快照；两者均为外部只读查询。
`sync_market_dump` 同时需要 external 与 write 能力，按显式调用下载并导入一种 artifact；用 `get_market_dump_status` 查询运行和 checkpoint。
原始日线、市场公司行动和财务快照分别保存，不自动提升实时性、严格 PIT 或回测门禁。

Tushare 已从运行时代码和来源设置中退役。升级前可显式运行配置迁移（会先创建同目录 `0600` 备份；不改数据库）：

```bash
node -- infra/migrate-retired-data-sources.mjs --env-file /path/to/.luoome/.env
```

省略 `--env-file` 时处理 `$LUOOME_HOME/.env`（缺省 `~/.luoome/.env`）。进程环境、systemd 和 compose 中的旧配置需同步移除；历史 `source='tushare'` 记录保留读取。

模型推理与模型配置都由 DSH 承担：luoome 侧没有模型运行时、模型目录与模型设置页。
需要模型判断的任务由 DSH agent 经插件原生工具调用完成，密钥由 DSH 侧配置。

模型推理与模型配置由 DSH 承担，luoome 侧不再有模型设置页；插件与 Web 读取同一份
默认目录和环境变量。Web 只管数据源、通知、账户与数据导入导出，没有管理员与普通用户之分，
也没有订阅与权益概念。

## 文档

| 文档 | 用途 |
|---|---|
| [docs/README.md](./docs/README.md) | **完整文档导航**：产品需求、技术设计、运维手册与历史归档 |
| [docs/USER_GUIDE.md](./docs/USER_GUIDE.md) | 用户手册：安装 / DSH 插件 / Web / 多账户 / 复盘 / 校准 / FAQ |
| [packages/dsh-luoome/README.md](./packages/dsh-luoome/README.md) | 外部接入：DSH 插件安装、面板与随包技能 |
| [AGENTS.md](./AGENTS.md) | 编码 Agent 开发规范：架构边界、实现约定、测试与安全规则 |
| [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) | 架构核心：模块、概念、数据流、安全模型、advisor 模型 |
| [docs/ROADMAP.md](./docs/ROADMAP.md) | 版本演进与交付状态 |
| [docs/CONTRIBUTING.md](./docs/CONTRIBUTING.md) | 贡献者指南：开发环境、测试与扩展方式 |
| [docs/SECURITY.md](./docs/SECURITY.md) | 副作用分级、鉴权、密钥与审计要求 |

## 快速启动

```bash
# 一键安装（macOS / Linux，无需 git clone，自动装 Bun + 源码 + 工作区依赖；
# luoome 没有独立 CLI，装完按提示在 DSH 里安装插件）
curl -fsSL https://raw.githubusercontent.com/KowL/luoome/main/install.sh | sh

# Windows（PowerShell 5.1+）
irm https://raw.githubusercontent.com/KowL/luoome/main/install.ps1 | iex

# 或者从本仓库安装依赖
bun install

# 构建当前 DSH 插件
bun run build:dsh-luoome
```

在已有 DSH profile 中安装插件并绑定现有账户，步骤见[插件安装说明](./packages/dsh-luoome/README.md#安装)。
当前不提供独立 `bun run web` 启动入口。宿主机部署见[服务配置](./deploy/direct/luoome-dsh.service)，
容器部署见[DSH 部署配置](./deploy/dsh/compose.yaml)。公网访问由部署侧的 Pocket/Caddy 准入，
不引入 luoome 多租户或订阅体系；手机与桌面使用同一个 DSH 入口。

## 测试基线

测试数量不是手写常量，是跑出来的事实：

```bash
bun run test:baseline   # 逐段跑 test:all，写 infra/test-baseline.json（含各段文件数/用例数与覆盖率）
```

**什么时候必须重跑**：新增/删除测试文件、新增/删除测试用例、调整 vitest 收集口径（`vitest.config.ts` 的
include/exclude）、或改动覆盖率配置。PR 里改测试数量却不重跑基线，会被评审直接打回——手改
`infra/test-baseline.json` 等于让基线撒谎。覆盖率与基线相比差因不得超过 2pp（见 PR 模板）。

M2 的验收口径是**两个可验证事实**，不是百分比：M2 期间删除的 17 个测试文件零残留
（`infra/test-baseline.test.ts` 逐文件断言路径不存在、且不在 `test:all` 的收集结果里），以及本基线产物存在。

### 需要本地浏览器的测试（**手动，不在 `test:all`**）

```bash
bun run test:panels-browser
```

**它做什么**：用真实 Chrome（CDP）点真实按钮，验收面板的「用户能不能真的用」。

**为什么不在 `test:all`**：
- 需要**本地 Chrome** 与可用的 CDP 连接（CI 环境没有浏览器）
- 需要先 `bun run build:dsh-luoome`（脚本内部会跑），比单测慢一个数量级
- 它验的是**整条链路**（点按钮 → 发请求 → 回执 → 界面更新），失败时通常是环境问题而非代码问题

**为什么仍然必须跑**：host 层 e2e 全绿而按钮 404 的情况真实发生过
（`/execute` 那条路径：单测覆盖两端，中间断开看不见）。改面板交互、改 Operation 路由、
改面板读计划（allowlist）时，这一档是唯一能发现问题的门。

## 自动任务

批处理调度由 **DSH 定时任务**负责：提醒写入真实投递回执后，宿主直接通过 `executeScheduled`
执行五个原生批处理入口（`run_strategy_daily_cycle`、`run_closing_report_cutoff`、
`run_portfolio_performance_snapshot`、`run_intraday_plan_batch`、`run_strategy_autonomy_weekly`），
业务执行不依赖模型工具调用；当前 DSH 版本仍会唤醒会话，但提示只要求保持静默。
每个任务必须有匹配当前任务指纹的持久授权，批处理与自动执行开关均需显式开启。
策略页也可直接准备并一次性确认正常日循环，无需进入 AI 对话，默认不使用 `force`。
门槛判定（交易日、盘中时段、盘后小时、周几）随工具走，不满足时返回 `skipped`，不会写库。
迁移与授权步骤见[用户手册](docs/USER_GUIDE.md#74-dsh-定时任务与批处理)。

交互分析经 `get_analysis_context → DSH 推理 → record_*` 直接写回，不创建 AnalysisJob。
后台队列能力已实现，默认不开放模型可见入队入口、不运行常驻 worker；显式后台模型配置见
[插件说明](./packages/dsh-luoome/README.md#可选后台分析模型)。旧 MCP worker 链路已退役。

策略日循环只产出事实、预检和 T+1/T+3/T+5 观察，不在领域 workflow 内调用模型生成 Advice。
收盘复盘等待预期工作完成，同日同范围只生成一份；当日 18:00 未完成仍等待，后到事实不改写正文。
跨日恢复可补记逾期缺口，不用当前数据重建当时事实。
周报复盘补充版不可变且不通知。精确规则见[领域语言](./CONTEXT.md#6-复盘与报告)；
重试、数据同步和运行审计见[架构说明](./docs/ARCHITECTURE.md)与[运维手册](./docs/runbooks/strategy-reliability-operations.md)。

## 状态

**当前模型 — Strategy + 统一 Watchlist + AlertPlan**

- 看板聚合账户 PnL、建议、AlertPlan 健康度和最近触发
- 持仓完整录入闭环与交易流水
- Strategy 不可变版本、校验、发布、dry-run/正式运行与信号事实
- Watchlist 支持 manual / strategy / ai / portfolio / import 多来源与研究阶段
- Strategy → Watchlist 需要显式持久订阅；可在 Strategy 设置页或对应 Tool 中取消，重复 producerRun 幂等
- AlertPlan 引用 Watchlist，提供单轮试跑、全局心跳与 Trigger 审计
- DSH 插件复用宿主身份与 HTTP 同源校验，写入经过能力控制、账户绑定和 Operation 回执
- 批量调度由 DSH 定时任务承担，无独立 Web/CLI 服务入口

历史演进见 [docs/ROADMAP.md](./docs/ROADMAP.md)。

### 独立 DSH 部署（默认纯插件形态）

默认部署由 DSH 用 Node 加载 **dsh-luoome 插件**：插件提供五块业务面板（看盘 / 持仓 / 关注 / 策略 / 复盘）、
投研技能与原生工具，个人写入按明确意图直接执行；安装/升级/备份/回退步骤见
[用户手册](docs/USER_GUIDE.md#7-dsh-单机用法)。部署入口与配置见
[DSH 部署配置](deploy/dsh/compose.yaml)。

- 事实库是 `$LUOOME_HOME/luoome.db`（Node SQLite），由插件在 DSH 进程内直接打开；没有第二份服务用户库。
- 默认部署没有 MCP client/server、Bun CLI、旧 Bun Web、analysis worker 或 queue probe 进程；
  `docker compose config` 只有 `dsh-web`（Node）与 `caddy`。
- 写操作（交互分析 record、复盘、策略创建/校验/发布、用户反馈）只经插件操作 policy 按明确意图执行，
  保留冻结输入、账户绑定与回执；`trade` 永不注册，`LUOOME_EXPOSE_TRADE=true` 启动即失败，自动任务默认关闭。
- 旧 MCP 过渡形态（`luoome` / `luoome-settings` / `luoome-analysis` / `luoome-batch` 四实例与
  手动 worker）已删除：`packages/mcp`、`deploy/dsh/mcp-tool-probe.ts` 与 `luoome mcp serve`
  子命令都不再存在；交互分析写回契约迁到 `packages/dsh-luoome/src/host/analysis-surface.contract.e2e.test.ts`。
- 批量分析仍使用 `analysis_job` 租约队列；队列实体、repository、claim/complete/fail 与手动验收链路
  全部保留，默认部署没有生产者 workflow，也不再运行常驻消费者。消费者取得冻结事实包后生成结果，
  由 `complete_analysis_job` 在同一事务中校验来源、写回并完成任务。
- 存量建议标为 `legacy-ai`；新建议保留生成器、模型、技能版本和事实时点。
- 模型调用只在 DSH 侧发生；luoome 领域工具与工作流不直接调用模型。

> 切换/回退演练见 `infra/dsh/plugin-switch-acceptance.ts`；旧 MCP 用户入口源码已随 REQ-M2-03
> 删除（判定层保留在 `packages/tools/src/exposure/`）。
