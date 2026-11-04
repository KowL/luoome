# Fuyao 数据能力扩展与 Tushare 退役详细设计

> 状态：Phase 0–5 代码与生产接线已完成；Tushare 运行时代码与现役入口已移除。最终验收见 §17.4；Phase 6 严格门禁继续独立保留。
> 日期：2026-11-03
> 范围：保留现有 Fuyao 行情适配器；按独立端口扩展 market dump、公司行动、天梯/情绪、龙虎榜、资讯、板块与财务；同次移除 Tushare 运行时代码和配置，保留存量历史数据只读兼容。
> 上游依据：`https://fuyao.aicubes.cn/llms-full.txt`，本地取证副本 `/tmp/luoome-fuyao-llms-full.txt`。
> 关联文档：[架构说明](../ARCHITECTURE.md)、[Fuyao 行情适配器设计](./fuyao-market-adapter-design.md)、[数据源可插拔与观测设计](./source-pluggability-and-observation-design.md)、[基本面 PIT 门禁](./fundamental-factor-scoring-phase3-detailed-design.md)、[严格回测设计](./strategy-strict-backtest-detailed-design.md)、[连板天梯设计](./limit-up-ladder-detailed-design.md)。

## 1. 背景与结论

luoome 已有 `FuyaoSource`，当前绑定：

- `quote` / `batch-quote`；
- `daily-bars`（在线单股票、前复权日 K）；
- `search`；
- `market-snapshot` / `market-snapshot-envelope`；
- `delayed-index`。

真实 Key 冒烟和 Web 验收已经覆盖上述主链路。现有实现也明确保留两项限制：快照只有 `timestampSource='retrieval'`，指数仍属延时能力；分钟 OHLCV 没有可用绑定。

最新上游文档已增加全市场 Parquet dump、公司行动、财务指标、估值、资讯、集合竞价、热榜、龙虎榜明细等能力。退役前，Tushare 存在于行情路由、分钟线、股票目录、设置页、请求协调器、环境变量和现役文档中，但其目录属性、分钟线和实时报价权限并未形成统一的生产保障。

本设计的结论是：

1. **Fuyao 扩为多个独立数据域，不把 dump、财务、资讯、天梯、龙虎榜或板块塞进 `MarketDataManager`。**
2. **现有 Fuyao 在线行情行为保留**，共享传输层可以重构，但不借机提升实时性等级。
3. **Tushare 运行时代码与配置全量下线**；存量 `source='tushare'` 数据仍是合法历史事实，不做 DB 删除、重写或来源改名。
4. **接口存在不等于门禁通过**：动态限流、capability 权限、字段完整性、历史覆盖和 revision 证据都必须逐项验收。
5. **严格 PIT 财务门禁维持 `not-ready`**，直至真实 revision 链证据满足既有标准；财务当前快照与 PIT 事实分轨。

## 2. 当前仓库约束

### 2.1 既有架构

```text
DSH 插件 / Web / Batch
        │
        ▼
      tools ───────────────► core
        │                    ▲
        ▼                    │
   各领域 Manager             │
        │                    │
        ▼                    │
   SourceRegistry             │
        │                    │
        ▼                    │
   Fuyao/Eastmoney/...        │
                             │
      db ─────────────────────┘
```

- `core` 只放领域类型、端口和纯计算，不承载 HTTP、文件或 Parquet IO。
- `adapters` 实现外部源和 Manager；`db` 实现 Drizzle/in-memory 双仓储。
- Workflow 只通过 `ctx.tools.*` 编排；不直接调用 repository 或 adapter。
- 非行情域继续使用 `ToolContext` 顶层可选端口，并通过各领域 `SourceRegistry` 观测。
- 所有新增 repository 同时提供 Drizzle 与 in-memory 实现，复用 contract tests；schema 与 `ensureSchema` 同步且迁移幂等。

### 2.2 Tushare 退役后的已知能力变化

| 能力 | 退役后的承接方式 | 必须披露的降级 |
|---|---|---|
| 在线报价、日 K、检索 | 保留 Eastmoney/Tencent/Sina/Fuyao/Xueqiu 现有路由 | 不再出现 Tushare 可选项 |
| 当前会话分钟 OHLCV | Tencent `minute-bars` | Fuyao 高频动向不是 OHLCV，不补绑 |
| 延时指数 | Fuyao `delayed-index` | 不升级为实时指数 |
| 股票目录行业、上市状态、上市/退市日期 | Fuyao 代码表和板块关系可补部分当前属性 | 缺证据的属性保持 unknown；不用当前值回填历史 |
| 严格回测 raw OHLC 与公司行动 | 新增 Fuyao dump 原始事实链 | 门禁未验收前继续 partial/unavailable |

Tushare 目录源曾是唯一同时提供行业、上市/退市状态和日期的实现。移除后不得把缺口藏在文案中：`StockUniverseSnapshot.attributeCoverage`、严格回测门禁和数据状态页必须如实变短或降级。

## 3. 上游能力清单与实施边界

### 3.1 本期纳入的外部 REST 能力

| 数据域 | 上游端点 | 目标用途 |
|---|---|---|
| 全市场 dump | `GET /api/dump/market-dumps/daily-k/download-url` | 约 10 年全 A 原始日 K |
| 近期 dump | `GET /api/dump/market-dumps/daily-k-10d/download-url` | 最近 10 交易日原始日 K 增量 |
| 复权事件 dump | `GET /api/dump/market-dumps/adjustment-factors/download-url` | 全量分红、送股、配股原始事件 |
| 单股公司行动 | `GET /api/a-share/corporate-actions/adjustment-factors` | 指定股票、指定区间补取与交叉核验 |
| 涨停池 | `GET /api/a-share/special-data/limit-up-pool` | 天梯与封板池 |
| 炸板池 | `GET /api/a-share/special-data/limit-break-pool` | 情绪炸板池 |
| 连板天梯 | `GET /api/a-share/special-data/limit-up-ladder` | 近 30 交易日矩阵与交叉核验 |
| 涨停统计 | `GET /api/a-share/special-data/limit-up-statistics` | 封板率、打开家数、晋级统计扩展事实 |
| 龙虎榜 | `GET /api/a-share/special-data/dragon-tiger-list` | 一年内的全部/机构/游资榜 |
| 快讯 | `GET /api/news/flash/list`、`/refresh` | 结构化滚动资讯 |
| 个股新闻 | `GET /api/news/stock/timeline-list` | 后续个股新闻查询 |
| 资讯/公告详情 | `GET /api/news/article/detail`、`/notice/detail` | 按 ID 读取已发现内容 |
| 板块目录 | `GET /api/a-share-index/catalog/ths-index-list` | 行业、概念等地域/特色目录 |
| 板块行情 | `GET /api/a-share-index/prices/snapshot` | 行业/概念指数快照 |
| 板块历史 | `GET /api/a-share-index/prices/historical` | 近五年板块日 K |
| 个股板块反查 | `GET /api/a-share-index/constituents/ths-index-list-by-stock` | 当前行业/概念/地域/特色关系 |
| 三大报表 | `GET /api/a-share/financials/{income-statements,balance-sheets,cash-flow-statements}` | 当前数据商视图的多期报表 |
| 财务指标 | `GET /api/a-share/financials/indicators` | 指定报告期的五类指标 |
| 最新估值 | `GET /api/a-share/valuations/snapshot` | PE/PB/PS/PCF 当前快照 |

下载 URL 的响应 schema 在聚合文档中未完整列出，Phase 0 必须用真实响应固化 `downloadUrl/expiresAt/dumpId` 等字段映射；不得根据示例脚本猜字段名。

### 3.2 明确不纳入本期实施

下列页面标注“仅供同花顺 AI 客户端”或“暂未开放外部接入”，本期不创建 adapter、Tool、配置项或设置页入口：

- 主力资金 `/api/a-share/capital-flow/**`；
- 高频动向 `/api/a-share/high-frequency/**`；
- 筹码形态；
- 资讯事件库 `/api/news/events/search`；
- 市场成交额预测；
- 同花顺新增概念；
- 宽基 ETF 申购净流入；
- 其他仅客户端可见的期货 F10 等能力。

另有两类“规划文档”也不构成实施依据：

- 股票基础信息、指数概况页面中的“敬请期待”；
- 指数历史成分和权重规划。当前成分接口只代表当前关系，不承担历史 PIT 成分回溯。

集合竞价、热榜、异动监控、IPO、基金/期货/期权/港股 IPO 虽有公开或部分公开契约，但不属于本次七个目标域，避免扩大实施面。

## 4. 总体设计决策

### 4.1 共享一个 Fuyao 传输与调度实例

当前 `FuyaoSource` 内部自建 `FuyaoClient`，且 `parseFuyaoEnvelope` 假定 `data.item[]`。新增端点存在 `data.items`、`stock_items`、分页对象、下载地址及非列表数据，不能复制多套互相不知情的限流客户端。

目标结构：

```text
FuyaoClient（进程级共享）
  ├─ HTTP timeout / JSON / 统一 code 错误
  ├─ 动态限流、共享冷却、有限退避
  └─ getData(...) → unknown data + requestId
        │
        ├─ 现有 item[] 兼容封装 → FuyaoSource（在线行情）
        ├─ MarketDump adapter
        ├─ CorporateAction adapter
        ├─ LimitUp/Sentiment/DragonTiger adapters
        ├─ News/Sector adapters
        └─ FinancialSnapshot adapter
```

实施要求：

- 保留 `FuyaoClient.get()` 对现有行情适配器的返回语义；新增通用 `getData()`，各领域用 Zod 校验自己的 `data` 形状。
- `FuyaoSource` 支持注入共享 client；已有 constructor 配置路径保留为测试便利，生产 composition root 只创建一个共享实例。
- `LocalAdapters.sources` 增加共享 `fuyao` 依赖描述，向 market 和各领域 factory 分发；禁止 factory 为同一进程隐式创建绕过协调器的客户端。
- 每个 binding 仍使用 `source='fuyao'` 和独立 capability 名，权限与健康状态不互相覆盖。

### 4.2 动态限流与重试

上游只承诺当前不限制累计次数，QPS 会随负载变化；HTTP 429 和 `code=4001` 都是限流信号。不得把“不限累计次数”实现成高并发全市场循环。

新增进程级 `FuyaoRequestCoordinator`：

| 配置 | 默认建议 | 语义 |
|---|---:|---|
| `FUYAO_MAX_CONCURRENCY` | `2` | 所有 Fuyao REST 请求共享并发上限 |
| `FUYAO_MIN_INTERVAL_MS` | `200` | 共享启动间隔；不是上游承诺 QPS |
| `FUYAO_RATE_LIMIT_COOLDOWN_MS` | `30000` | 未提供有效 Retry-After 时的共享冷却 |
| `FUYAO_RATE_LIMIT_MAX_RETRIES` | `2` | 仅幂等 GET 的限流重试上限 |

规则：

1. 429 优先遵守合法 `Retry-After`，并设置实现侧上限；4001 使用带抖动的 1s、5s 级退避。重试耗尽抛 `rate_limited`。
2. 任一请求限流会暂停共享队列，避免天梯、财务和 dump 同时继续加压；Manager 既有 fallback 仍可转向其它供应商。
3. 2001/2003、参数错误、schema 错误不做限流重试；网络/timeout/5xx 沿用有界重试，不能形成无限循环。
4. 设置页主动 probe、定时任务和交互查询都经过同一协调器，不留旁路。
5. 大文件下载只对“获取下载 URL”计入 API 协调器；S3 文件传输另有大小、超时和磁盘门禁。
6. 日志记录 `request_id`、capability、耗时和错误 kind；不记录 API Key、完整预签名 URL 或请求头。

### 4.3 Capability 权限模型

- 任一领域显式启用 `fuyao` 且缺 `FUYAO_API_KEY`，该 factory 启动期快速失败。
- `configurationReady=true` 只表示凭据和配置齐全，不代表 capability 已授权。
- `code=2003` 映射 `permission`，只将当前 `(source, capability)` 标为不可用并走该域 fallback；不得把其它已授权 Fuyao 能力一并禁用。
- 未显式启用的 capability 不发探测请求；AI 客户端专属能力没有“可配置但未授权”状态。
- `get_market_data_status` 和设置页展示每个 binding 的实际权限错误，不以 API Key 存在推断全能力可用。

## 5. Market dump 与原始日线

### 5.1 独立端口

新增 `MarketDumpManagerLike`，作为 `ToolContext.marketDump` 顶层可选端口，不加入 `MarketDataAdapterLike`：

```ts
type MarketDumpKind = 'daily-k' | 'daily-k-10d' | 'adjustment-factors';

interface MarketDumpManagerLike {
  readonly name: 'market-dump';
  sync(input: {
    kind: MarketDumpKind;
    resumeRunId?: string;
  }): Promise<MarketDumpSyncResult>;
  status(): Promise<readonly MarketDumpRun[]>;
}
```

Tool 边界：

- `sync_market_dump`：`external + write`，仅显式人工/授权批处理调用；支持一种 dump、一次有界运行和断点续传。
- `get_market_dump_status`：`read`，返回 dumpId、文件 hash、行数、日期范围、checkpoint、状态与错误，不返回下载 URL。
- Workflow 如需盘后执行，只调用上述 tools；首期不默认开启自动调度。

### 5.2 下载与本地 artifact

1. 从 API 获取一次性预签名 URL；URL 只在本次下载内存中使用，不落库、不落日志、不进入 ToolResult。
2. 对重定向和最终下载请求剥离 `X-api-key`；验证 HTTPS、响应 Content-Length/实际大小、超时与可用磁盘。
3. 下载至 `$LUOOME_HOME/market-dumps/.tmp/`；完成后计算 SHA-256，再原子 rename 到：
   `$LUOOME_HOME/market-dumps/<dumpId>/<artifactSha256>.parquet`。
4. 相同 `(dumpId, artifactSha256)` 复用完整 artifact；内容变化必须生成新身份，不覆盖旧文件。
5. 使用 Node 运行时兼容的 Parquet cursor 逐批读取，不把全文件载入内存；默认部署不依赖本机 Python。
6. 读取前按 dumpId 校验精确列集合和类型：日 K 必须满足 `interval=1d`、`adjusted=none` 和 CNY；复权事件使用独立事件 schema。任何 schema 漂移整批失败。

### 5.3 原始日线与现有 qfq 严格分离

dump 日 K 固定 `adjusted=none`，因此：

- **不得写入**现有 `daily_bars` 或 `daily_bar_revisions` 并声称 `qfq`；
- 新增 `RawDailyBarRevision` 与 `RawDailyBarRepository`；
- 现有在线 `FuyaoSource.fetchDailyBars(adjust=forward)` 继续负责规范 qfq 日线；
- 本期不自创现金分红/送转/配股的 qfq 推导器，避免把复权公式混入下载工具。

```ts
interface RawDailyBarRevision {
  stockId: string;
  date: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  turnover: number | null;
  source: 'fuyao';
  dumpId: string;
  artifactSha256: string;
  recordedAt: Date;
  contentHash: string;
}
```

主键沿用 revision 思路：`(stockId, date, recordedAt, contentHash)`；另建 `(dumpId, artifactSha256)` 和日期查询索引。`recordedAt` 是本地批次时间，后到的全量 dump 不会变成过去 cutoff 已可见的数据。

### 5.4 分批导入与恢复

新增 `MarketDumpRunRepository` 保存：

- runId、kind、dumpId、source、artifactSha256；
- requestedAt/downloadedAt/startedAt/finishedAt；
- status=`running/complete/failed`；
- nextRowOffset、processedRows、minDate/maxDate；
- errorKind 和脱敏错误消息。

每个批次建议 1,000 行。每个 run 在首次开始时冻结统一 `recordedAt`，恢复时沿用原值：

1. 按 kind 分流：daily-k/daily-k-10d 写 raw revisions，adjustment-factors 写公司行动 revisions；
2. 写成功后推进对应 run 的 checkpoint；
3. 进程在两者中间退出时，下一执行以相同 recordedAt 重放相同行；revision 主键和内容 hash 保证幂等；
4. 只有相同 artifact hash 可从 checkpoint 续跑；新文件从新 run 开始；
5. 重复主键但不同内容必须保留新 revision，并在审计中报告，不覆盖旧行；
6. 任一非法行记录行号、stockId（若有）和原因；关键 schema/主键错误使整次 failed，不静默跳过形成“完整”假象。

## 6. 公司行动与严格回测

### 6.1 原始公司行动仓储

新增独立 `CorporateActionEvent` 与 `CorporateActionEventRepository`，不直接复用账户级 `PortfolioCorporateAction`：

```ts
interface CorporateActionEventRevision {
  stockId: string;
  exDate: Date;
  dividendPerShare: number;
  perShareBonus: number;
  allotmentRatio: number | null;
  allotmentPrice: number | null;
  currency: 'CNY';
  source: 'fuyao';
  sourceRecordId: string;
  dumpId?: string;
  artifactSha256?: string;
  recordedAt: Date;
  contentHash: string;
}
```

- dump 是完整事件候选源；在线单股端点用于补取和差异检查。
- 在线文档的响应未提供 `event_type`、`record_date`、`adjust_factor`，且响应字段表未列配股字段；仅凭在线响应不得声明配股覆盖完整。
- `sourceRecordId` 由 `thscode + exDate + 规范化事件内容` 稳定派生，内容 hash 单独保存；同日不同现金/送转/配股事件须分别保留，纯重复行按内容去重。二者都不冒充上游 revision 或公告 ID。真实依据见 [Phase 0 dump 证据](./fuyao-phase0-dump-evidence.md)。
- 原始事件 append-only；后续下载的不同内容形成新 revision。

### 6.2 与账户账本隔离

市场公司行动不直接修改账户持仓、现金或 `portfolio_corporate_actions`。若后续提供账户应用建议，必须生成用户可确认的草案，再经既有账户写路径执行；本设计不新增自动分红入账、自动改股数或自动交易路径。

### 6.3 严格回测接入条件

现有 `StrictBacktestCorporateAction` 只支持 `split` 和 `cash-dividend`：

- `dividendPerShare > 0` 映射现金分红；
- `perShareBonus > 0` 映射 `split.ratio = 1 + perShareBonus`；
- 原始事实保留大于 `-1` 的负股数变动比例（2026-11-04 真实 artifact 有两条）；负比例不在当前执行模型中自动解释为账户动作，严格门禁仍按 unsupported 处理。
- 同一除权日可同时产生两条动作，各自保留可追溯 `sourceId`；
- `allotmentRatio > 0` 或配股价格出现时，当前执行模型标为 `unsupported-corporate-action`，对应门禁保持 partial/unavailable，不能丢弃配股后继续声称 complete。

目标改造：

1. `syncBacktestMarketFacts` 的 raw OHLC 改读同 cutoff 的 `RawDailyBarRepository`，不再把 qfq revision 字段当原始价。
2. 公司行动按 `recordedAt <= revisionCutoff` 读取，后补 dump 不进入更早的 vintage。
3. 只有在 raw 日线、事件覆盖、artifact 完整性、配股处理和真实样本验收全部通过后，才将 `corporateActionsStatus` 改为 `complete`。
4. 在此之前继续输出既有 `unavailable` 审计，不输出严格收益指标。
5. 公司行动门禁只是严格回测的一项；PIT universe、可交易性、benchmark、费用、滑点和 evaluator identity 仍各自独立验收。

## 7. 连板天梯与 A 股情绪

### 7.1 接入现有独立 Manager

新增：

- `FuyaoLimitUpLadderAdapter implements LimitUpLadderAdapterLike`；
- `FuyaoAShareSentimentSource implements AShareSentimentPoolSource`。

分别注册到：

- `LimitUpLadderCapabilityMap['limit-up-ladder']`；
- `AShareSentimentCapabilityMap['sentiment-sealed-pool']`；
- `AShareSentimentCapabilityMap['sentiment-broken-pool']`。

不修改 `MarketDataManager`，不新增隐藏行情旁路。

### 7.2 字段映射

涨停池：

- `thscode/ticker/name` → 身份与名称；
- `continue_day_cnt` → `level/limit_up_days`；
- `limit_up_time` → `first_time`，格式补为 `HH:MM:SS`；
- `last_price` → `close/rawClose`；
- `price_change_ratio_pct` → 小数 `change_pct = value / 100`；
- `limit_up_reason` → `reason`；
- `seal_money/open_times/is_st` 保留在情绪原始层，不能无契约塞入天梯实体。

炸板池：

- `open_times` → `openCount`；
- `first_seal_time/last_seal_time` 属池内原始证据；
- `sealAmount=null`，不从成交额或价格合成封单额；
- 行业/概念没有返回时为空，不调用当前板块关系倒灌历史。

分页必须读尽并核对 `pagination.total/pages/page/size`。目标日、覆盖范围、空池和“未就绪”分别处理：合法 `total=0` 才是空池；缺分页、错日、部分页失败和 3002 均不得转成一个正常空池。

### 7.3 时间与历史门禁

- 当前查询和正式 scan/scheduled 可保存 Fuyao 天梯 PIT 快照，沿用 `(date, source)` 与 manager 语义。
- 近 30 日天梯只用于近期展示和交叉核验；`seal_nextday` 是事后字段，不回写到当时快照。
- 炸板池/情绪池不得反向填充历史天梯、Strategy meta 或专用历史事实。
- `meta.isBroken`、`meta.consecutiveBoard`、`meta.isBoardBreak` 的注册门禁不变：仍需 `publishedAt`、captured/backfill、revision-preserving repository 和真实样本。
- Fuyao 接口支持按日查询只证明可取历史观测，不证明当时可见性或修订链完整。

`limit-up-statistics` 可作为情绪的新增事实端口，先独立返回原始统计；不替代现有封板/炸板池完整度判断。

## 8. 龙虎榜

新增 `FuyaoDragonTigerAdapter implements DragonTigerAdapterLike`，注册到既有 `dragon-tiger-list` capability。

### 映射与约束

- 固定 `board_type=all` 满足现有 `fetchList(date)`；机构/游资榜及营业部/机构明细作为后续独立 capability，不在首版混入现有列表。
- `trade_date` 必须等于请求日；`timestamp` 是目标交易日零点，不是实际发布时间。
- `change` 与 `net_rate` 已是小数，直接映射；金额为元。
- 上游榜单契约未提供收盘价和换手率，而现有 `DragonTigerEntry.close/turnoverRate` 必填。实施时把这两个字段改为可选，旧 Eastmoney 行继续提供原值，Fuyao 行保持缺省并增加 `close-unavailable`/`turnover-rate-unavailable` warning；不用 0、最新价或涨跌幅反推。
- 同一股票当日榜与三日榜通过新增可选 `rangeDays` 保留身份；现有实体和结果校验同步扩展，不做隐式去重。
- 首版无买卖席位时 `buySeats/sellSeats` 缺省；营业部历史、经典战绩与机构详情另设只读 Tool，不改变现有 `dragon_tiger_list` 输出。

默认仍可采用 `eastmoney,fuyao`，真实双源一致性和权限验收后再调整顺序。

## 9. 资讯

### 9.1 现有要闻流

新增 `FuyaoNewsSource implements NewsAdapterLike`，注册 `finance-news` capability，保留 `NewsManager` 的分类、关键词、来源路由和 `persist_external_facts` 两阶段写入。

字段映射：

- `id` 保持字符串，避免大整数精度损失；
- `create_time_ms` → `published_at`；
- `update_time_ms` 只表示内容更新，不覆盖首次发布时间；
- `encoded_url` → 原文链接；
- 列表没有媒体来源时明确写 `同花顺快讯`，不得落入 Eastmoney 默认哨兵；
- 标题分类仍由 `inferNewsCategory` 产生，属于本地启发式而非上游标签。

`flash/list` 使用 `tag_id + seq` 而不是页码：

- page=1 使用 `seq='0'`；
- 同一源顺序浏览时保存页到 next seq 的进程内游标；
- 冷启动直接请求 page>1 且没有游标时返回 `unsupported_capability`，让其它已启用源承担，不能把 page 数字当 seq；
- 不把游标持久化为跨来源通用分页 token；
- `flash/refresh` 只用于已知最新 seq 的增量刷新。

`LUOOME_FUYAO_NEWS_TAG_ID` 在启用 Fuyao news 时必填；Phase 0 先确认栏目确实对应当前财经要闻范围，不使用文档示例值冒充已核实配置。

### 9.2 个股与详情能力

个股分时新闻、资讯详情、公告解读使用独立 `NewsContentManager` 或后续明确子 capability，不让 `fetch_news` 隐式执行 N 次详情请求。正文 HTML 作为不可信内容处理，展示端沿用内容安全策略；公告详情需要已知 `seq`，不是公告列表替代品。

资讯事件库属于 AI 客户端专属，本期不接入。

## 10. 板块行情与当前板块关系

### 10.1 SectorQuoteManager 先完成 Registry 化

当前 `SectorQuoteManager` 只有单个 primary，`SectorQuoteSourceSchema` 也是 Eastmoney 封闭枚举。目标改造：

- `SectorQuoteSource` 改用通用 `SourceIdSchema`；
- `fetchList` 通过独立 `SourceRegistry<SectorQuoteCapabilityMap>` 路由和 fallback；
- 显式 `query.source` 只访问该源；缺省按 `LUOOME_SECTOR_QUOTE_SOURCES` 顺序；
- 输出的 `source` 取实际成功 handle，不再回显请求默认值；
- 加入 `status()` 并接入 `get_market_data_status`。

新增 `FuyaoSectorQuoteAdapter`：

1. `catalog/ths-index-list?tag=industry` 取得行业目录；概念目录作为显式类型，不与行业混算。
2. 按有界批次调用指数快照，映射 `thscode/name/last_price/price_change/price_change_ratio_pct/turnover`。
3. 涨跌幅除以 100 转为现有小数；代码保留 `.TI`，不伪造 Eastmoney `BKxxxx`。
4. `upCount/downCount/leadingStock*` 未返回则缺省。
5. 快照时间延续 Fuyao 行情限制，只记录 fetched/retrieval；不生成可信盘中 observedAt。

### 10.2 板块关系独立端口

新增 `SectorMembershipManagerLike` 和 `get_stock_sector_memberships` external Tool，调用个股反查端点：

- 每次最多 100 个原始代码，超出由 Tool 有界分批；
- 保留 `cn_concept/industry/region/tszs` 类型和 `.TI` 标准代码；
- 空 `index_list` 只表示当前无匹配，不证明股票不存在；
- 结果是当前关系快照，带 fetchedAt/source/contentHash；
- 不回写历史 `StockUniverseSnapshotMember.industry`，不充当历史指数成分或权重。

板块历史日 K 可作为独立只读能力复用指数历史契约，近五年限制明确展示；不得通过当前成分乘历史指数生成历史板块归因。

## 11. 财务：当前快照与严格 PIT 双轨

### 11.1 当前数据商快照轨

新增 `FinancialSnapshotManagerLike` 与独立 Registry capabilities：

- `financial-income-statements`；
- `financial-balance-sheets`；
- `financial-cash-flow-statements`；
- `financial-indicators`；
- `valuation-snapshot`。

新增 `get_stock_financial_snapshot` external Tool，按股票和报告期返回三类事实，输出统一带：

```text
source='fuyao'
viewKind='current-vendor-view'
periodEnd / reportDate（若端点提供）
observedAt / fetchedAt
pitStatus='not-ready'
rawContentHash
missingFields / issues
```

规则：

- 三大报表的 `report_date_ms` 映射为披露日 `reportDate`；`period_end_ms` 是报告期末，不是发布时间。
- 财务 `data.timestamp` 取最大 `period_end_ms`，不得作为 fetch、披露或 revision 时间。
- 金额原币元，EPS 元/股；null 保留缺失，不补零。
- 指标 `value` 是字符串，用显式 metric registry 解析；单位按字段定义映射 `percent-points/ratio/CNY/...`，禁止根据中文名称猜单位。
- 季报累计值不在本期擅自单季化；TTM 不由当前快照临时拼接。
- 估值只有最新快照；`data.timestamp` 是上游指标元数据最大有效时间，不代表五个指标同刻更新，也不提供历史估值。
- 首版可以只读查询，不写入 `financial_fact_revisions`，也不进入 AnalysisContext 的 strict PIT 财务部分。

### 11.2 严格 PIT 轨保持关闭

现有 `FinancialFact` 必填：

- `sourceRecordId`；
- `sourceRevision`；
- `publishedAt`；
- `revisionPublishedAt`；
- `recordedAt`；
- restatement/retraction 关系与内容 hash。

Fuyao 当前财务文档只明确报告期与 `report_date_ms`，未给出每一重述版本的独立身份、发布时间、撤回关系。因此：

1. 不把 `recordedAt` 复制成 `revisionPublishedAt`；
2. 不把响应 content hash 命名为上游 `sourceRevision`；
3. 不把多期“当前值序列”当成历史 vintage；
4. `REAL_FINANCIAL_FACT_SOURCES` 保持不包含 Fuyao；
5. `LUOOME_FUNDAMENTAL_PROVIDER=fuyao` 本期不注册，既有 mock 仍是唯一显式 fixture provider；
6. 生产 `FundamentalScore` 和 Strategy DSL 基本面门禁保持 not-ready/unavailable。

只有真实证据满足既有 evaluation-ready/operational 门禁后，才另提 `FuyaoFundamentalDataAdapter` 实施变更：至少包括公告版本发现、修订发布时间、重述/撤回样本、单位和期间映射、50/100 股票覆盖及两次以上真实同步审计。当前快照轨的成功不会自动升级该门禁。

## 12. Tushare 全量退役与历史兼容

### 12.1 下线范围

**删除运行时实现及专属测试：**

- `packages/adapters/src/tushare/{client,envelope}.ts` 及测试；
- `packages/adapters/src/market/tushare.ts` 及测试；
- `packages/adapters/src/stock-universe/tushare.ts` 及测试。

**移除装配与路由：**

- `MarketSourceIdSchema` 中的 `tushare`；
- `buildTushare`、`tushareBindings` 及 imports/exports；
- `StockUniverseSourceIdSchema` 和 factory 的 Tushare 分支；
- `MARKET_SOURCE_MANIFEST` 的 Tushare 项；
- `MarketRequestCoordinator.providerOf` 的 `tushare.pro` 映射；
- Manager 中只服务于 Tushare 的注释或配额特例；分钟通用能力保留给 Tencent。

**移除配置与 UI：**

- `TUSHARE_TOKEN`、`TUSHARE_URL`；
- `.env.example`、README、USER_GUIDE 和部署示例中的相关配置；
- DSH 设置页来源标签、凭据格、保存校验和专属测试；
- 严格回测门禁中“配置 TUSHARE_TOKEN 补齐”的现行建议，改为披露属性缺口及新的数据来源状态。

**文档收口：**

- Tushare 专属设计和 runbook 移入 `docs/archive/` 并标注退役日期，或删除现役入口；
- `docs/README.md` 移除现役导航；
- ARCHITECTURE、CONTEXT、行情底座、分钟线、天梯等维护文档改为当前行为；
- 历史开发计划中的当时决策可作为阶段记录保留，不继续呈现为可执行配置。

不得为了清空字符串搜索结果而修改历史事实。`tushare` 只允许继续出现在归档文档、退役说明、历史数据兼容测试及必要的只读 decoder 注释中。

### 12.2 存量数据只读兼容

以下表和字段不做删除、更新或重签来源：

- `daily_bars.source='tushare'`；
- `daily_bar_revisions.source='tushare'`；
- `minute_bars.source='tushare'`；
- `price_snapshots.source='tushare'`；
- `stock_universe_sync_runs` 与 PIT snapshot 中的 Tushare 来源；
- 其它已经持久化且引用该 source 的审计/运行事实。

兼容原则：

1. `SourceIdSchema` 和现有各实体的开放 source 字符串保持不变，不增加会拒绝旧数据的封闭枚举迁移。
2. 旧 PIT snapshot 仍可按原 `syncId` 读取；旧日 K、分钟和回测输入仍按原 recordedAt/hash 读取。
3. 退役源不进入新的在线 fallback、主动 probe 或设置页；历史可读不等于外部能力仍启用。
4. 不把旧行改成 `fuyao`，也不以 Fuyao 当前值覆盖旧 revision。
5. 新 migration 仅允许新增 dump/raw/公司行动表和索引；没有 `DROP`、`DELETE`、`UPDATE source` 或历史回填。
6. 数据导出仍包含原始 source；导入旧备份时同样接受历史值。

## 13. 配置与迁移

### 13.1 目标配置

```ini
# 现有 Fuyao 行情与共享客户端
FUYAO_API_KEY=...
FUYAO_BASE_URL=https://fuyao.aicubes.cn
FUYAO_MAX_CONCURRENCY=2
FUYAO_MIN_INTERVAL_MS=200
FUYAO_RATE_LIMIT_COOLDOWN_MS=30000
FUYAO_RATE_LIMIT_MAX_RETRIES=2

# 各领域独立、有序启用；缺省保持现有来源
LUOOME_MARKET_SOURCES=eastmoney,tencent,sina
LUOOME_STOCK_UNIVERSE_SOURCES=eastmoney,sina
LUOOME_LIMIT_UP_LADDER_SOURCES=eastmoney
LUOOME_ASHARE_SENTIMENT_SOURCES=eastmoney
LUOOME_DRAGON_TIGER_SOURCES=eastmoney
LUOOME_NEWS_SOURCES=eastmoney,10jqka
LUOOME_SECTOR_QUOTE_SOURCES=eastmoney

# 新端口默认不装配；显式写 fuyao 才启用
LUOOME_SECTOR_MEMBERSHIP_SOURCES=
LUOOME_FINANCIAL_SNAPSHOT_SOURCES=
LUOOME_MARKET_DUMP_SOURCES=

# 仅 Fuyao news 启用时必填
LUOOME_FUYAO_NEWS_TAG_ID=...
```

dump 通过 Tool 显式执行，不增加常驻调度开关。财务当前快照只有在显式配置 `fuyao` 到对应 `FinancialSnapshot` 来源时启用；不与 `LUOOME_FUNDAMENTAL_PROVIDER=mock` 混用。

### 13.2 配置迁移步骤

部署新版本前执行一次性、可重复运行的配置迁移：

1. 读取 `$LUOOME_HOME/.env`；部署环境变量和 systemd/docker 配置同时列入人工核对。
2. 以 `0600` 创建带时间戳备份，备份不进入日志、ToolResult 或 Git。
3. 从 `LUOOME_MARKET_SOURCES` 删除 `tushare`，保留其它项原顺序；结果为空时写回 `eastmoney,tencent,sina`。
4. 从 `LUOOME_STOCK_UNIVERSE_SOURCES` 删除 `tushare`；结果为空时写回 `eastmoney,sina`。
5. 删除活动配置中的 `TUSHARE_TOKEN` 和 `TUSHARE_URL`。不自动新增 Fuyao，也不复用旧 token。
6. 校验新 schema 和至少一个有效来源，原子写回 `.env`；失败时保留原文件并停止升级。
7. 输出仅包含变更键名和来源数量，不输出密钥值。
8. 启动后核对设置页无 Tushare、当前来源顺序正确、历史数据查询仍可读。

迁移工具已实现：[migrate-retired-data-sources.mjs](../../infra/migrate-retired-data-sources.mjs)。默认只处理 `$LUOOME_HOME/.env`，也可显式指定配置文件；进程环境、service 和 compose 由部署步骤移除，应用不改宿主配置。本次开发验收仅操作临时测试文件，未执行真实部署配置迁移。

```bash
node -- infra/migrate-retired-data-sources.mjs --env-file /path/to/.luoome/.env
```

脚本先校验所有剩余来源；有变更时创建同目录 `0600` 备份并原子替换，重复执行不重写。输出只有键名与来源数量。

### 13.3 回滚

- 单域回滚：从对应 `LUOOME_*_SOURCES` 移除 `fuyao`，原 Eastmoney/10jqka 等链路和存量数据保留。
- dump 回滚：停止 Tool 和调度，新表与 artifact 保留只读；不回删已落库 revision。
- 代码整体回滚到支持 Tushare 的旧版本时，需要管理员从安全备份显式恢复旧配置；新版本不自动恢复凭据。
- 新增 DB migration 均为 additive，回滚代码不要求 destructive down migration。

## 14. 观测、安全与副作用

- 每个新 Manager 提供 `status()`；`get_market_data_status` 纳入天梯、情绪、龙虎榜、资讯、板块、dump 和财务快照的实际 dataset。
- dump 的 `dataAsOf` 使用文件实际最大交易日；`recordedAt` 与 `fetchedAt` 分开。权限/网络/解析失败不复用旧成功时间伪装新鲜。
- 财务当前快照始终展示 `viewKind` 和 `pitStatus`，不把报告期序列称为 PIT。
- API Key 仅通过共享 client 的 `X-api-key` 发送给 Fuyao API；下载重定向和 S3 请求不携带该头。
- 预签名 URL、API Key、财报完整正文和私人账户数据不进入日志或状态页。
- `sync_market_dump` 是 `external + write`；新增在线查询是 `external`；状态查询是 `read`。
- 新能力不生成 Advice、Trade，不自动修改账户现金、持仓或公司行动账本。
- 生产默认不开启新增自动任务；启用批处理仍沿用 DSH 授权和指纹门禁。

## 15. 文件变更清单

以下为 Fuyao 扩展的实现期清单；§15.4 的 Tushare 删除已在本次变更中完成。

### 15.1 Core / DB

- 新增 `packages/core/src/entity/{market-dump,raw-daily-bar,corporate-action-event,financial-snapshot}.ts`。
- 修改 `packages/core/src/context.ts`、`repository/index.ts`、`index.ts`，增加独立端口与类型导出。
- 修改 `packages/core/src/entity/{dragon-tiger,sector-quote}.ts` 及对应 Manager，支持龙虎榜缺省字段、rangeDays 和板块通用 SourceId。
- 修改 `packages/db/src/schema/index.ts`、`migrations.ts`、`repositories.ts`。
- 新增 dump run、raw daily、公司行动的 Drizzle/in-memory repository 与 contract tests。
- 更新 `packages/db/src/repository/schema-parity.contract.test.ts`、Node contract 和数据导入导出契约；历史 source 校验保持开放。

### 15.2 Fuyao 共享层与各领域 adapters

- 修改 `packages/adapters/src/fuyao/{client,envelope,source}.ts` 及测试：共享 client、通用 data 解析、动态限流，现有行情契约不变。
- 新增 `packages/adapters/src/fuyao/request-coordinator.ts` 及测试。
- 新增 `packages/adapters/src/market-dump/{fuyao,manager,factory,types}.ts` 与测试。
- 新增 `packages/adapters/src/corporate-action/{fuyao,manager,factory,types}.ts` 与测试。
- 新增 `packages/adapters/src/limit-up-ladder/fuyao.ts`、`ashare-sentiment/fuyao.ts`、`dragon-tiger/fuyao.ts`、`news/fuyao.ts`、`sector-quote/fuyao.ts`，以及对应 factory/manager/types/tests。
- 新增板块关系与财务快照独立 adapter/Manager/factory/types/tests。
- 修改 `packages/adapters/src/local-adapters.ts`、`index.ts`，统一注入共享 Fuyao 实例。
- `sector-quote/manager.ts` 从单 primary 迁到独立 SourceRegistry。

### 15.3 Tools / Batch / Surface

- 新增 `sync_market_dump`、`get_market_dump_status`、`get_stock_financial_snapshot`、`get_stock_sector_memberships` tools 和测试。
- 修改 `packages/tools/src/{registry.ts,context.ts}`、`testing/context.ts`、`get-market-data-status` 及注册/副作用测试。
- 严格回测真实 raw/公司行动接入时修改 `packages/tools/src/internal/backtest-market-facts.ts`、`strategy-backtest.ts` 及测试；门禁未通过前维持原降级。
- 若增加授权批处理，修改 `packages/batch/src/index.ts` 与测试，再接入 DSH 原生任务；首版手动 Tool 不需要新增 cron。
- 修改 `packages/dsh-luoome/src/host/{production.ts,market-settings.ts}` 及设置页相关测试，移除 Tushare，保留 Fuyao 配置与共享装配。

### 15.4 Tushare 删除与文档

- 删除 §12.1 列出的 Tushare 实现和专属测试。
- 修改 `market/factory.ts`、`stock-universe/factory.ts`、`market/manifest.ts`、`market/request-coordinator.ts`、`adapters/index.ts` 及关联测试。
- 将通用 manager 测试中的 Tushare 名称改为中性 fake source；只有历史兼容用例保留 `source='tushare'`。
- 更新 `.env.example`、README、CONTEXT、ARCHITECTURE、USER_GUIDE、ROADMAP/开发计划和 `docs/README.md` 的当前行为。
- 归档 `docs/ddd/tushare-market-adapter-design.md`、`docs/runbooks/tushare-integration.md`，清理维护文档中的现役链接。

## 16. 分阶段实施

### Phase 0：真实契约 spike

- [x] 2026-11-03 已完成真实 Key 分域验证，证据见 [综合契约记录](./fuyao-phase0-contract-verification-2026-11-03.md)、[dump/公司行动](./fuyao-phase0-dump-evidence.md)、[特色数据/资讯/板块](./fuyao-phase0-special-evidence.md) 与 [财务](./fuyao-phase0-financial-evidence.md)。动态限流未触发，仍按保守默认实现。
- 用真实 Key 验证每个目标 capability 的权限、响应 data 形状、分页、空值、时间字段和动态限流。
- 固化 dump 下载 URL 响应、文件大小、Parquet schema、S3 重定向行为和 Node 读取方案。
- 验证快讯 `tag_id`、seq 翻页、公司行动配股字段、天梯/炸板历史窗口。
- 财务专门检查同报告期重述后是否返回 revision identity/time；没有证据则维持双轨结论。

产出脱敏响应夹具和权限矩阵，不把真实 Key 或完整预签名 URL 写入仓库。

### Phase 1：共享传输与 Tushare 退役

- [x] 完成共享 FuyaoClient、通用 getData、动态限流、权限观测与配置解析；63 条 Fuyao 测试及适配器类型检查通过（2026-11-04）。
- [x] 删除 Tushare 运行时代码、路由、设置项和现役配置（2026-11-03）。
- [ ] 部署时执行 §13 配置迁移，并完成历史 `source='tushare'` 只读回归。

### Phase 2：market dump + 原始日线 + 公司行动

- [x] Phase 0 固化三种 artifact 的真实契约；2026-11-04 用当前 Manager 完成近期日 K 与完整公司行动文件隔离导入验证。
- [x] 实现 raw revision、公司行动 revision、checkpoint、幂等恢复、前置失败审计和状态 Tool；包含北交所显式身份、内容去重、恢复前 hash 校验与下载资源门禁。
- 严格回测 raw/公司行动的执行资格仍留待 Phase 6 独立验收，当前门禁继续关闭。

### Phase 3：天梯/情绪 + 龙虎榜

- [x] 各 capability 独立启用、独立权限和 fallback；共享同一 Fuyao 客户端与协调器。
- 先作为 Eastmoney 后备源，完成双源对照后再调整排序。
- 历史炸板/断板字段继续受专用 PIT 门禁约束。

### Phase 4：资讯 + 板块

- [x] 接入要闻流、个股板块关系和板块行情，并完成 Tool、Workflow 类型与 DSH 生产接线。
- [x] 完成 SectorQuote Registry 化与状态观测。
- 个股详情、板块历史等能力按实际产品调用入口逐项开放。

### Phase 5：财务当前快照

- [x] 完成三大报表、指标、估值的只读 Tool、单位 registry 与五 capability 独立观测；使用真实响应回放验证 `FY` / `Q1` 等期间、字段名、股票身份、未知指标及逐表缺失。
- 页面和输出明确 `current-vendor-view`、`pitStatus=not-ready`。
- 不写 strict PIT facts，不开放生产基本面评分。

### Phase 6：严格门禁另行验收

- 公司行动/严格回测与财务 PIT 分别提交证据包和评审。
- 任一证据不足只影响对应门禁，不回滚已可用的当前数据能力。

## 17. 测试与验收

### 17.1 单元与契约测试

**共享客户端**

- HTTP 200 + 非零 code、HTTP 429、4001、2003、timeout、非 JSON、schema 漂移。
- 429/4001 共享冷却、Retry-After、抖动退避、最大次数、并发上限。
- 不同 `data` 形状由各领域 schema 校验；现有 `item[]` 行情解析不回归。
- API Key 不出现在日志；S3/重定向请求无 `X-api-key`。

**Dump / 公司行动**

- Parquet 精确 schema、非法日期、重复键、raw OHLC 区间、volume=0、null turnover。
- 原始日 K 不进入 qfq 表；revision hash 稳定；同 artifact 重跑幂等。
- 中途失败后 checkpoint 恢复；新 artifact 不复用旧 checkpoint。
- 现金分红、10 送 1、同日现金+送转、配股 unsupported、空事件和字段漂移。
- `recordedAt <= cutoff` 的 vintage 查询；后补数据不进入历史 cutoff。
- Drizzle/in-memory contract、schema parity、幂等迁移和历史 Tushare 行不变。

**各独立域**

- 天梯/情绪完整分页、合法空池、3002、错日、百分比转小数、近 30 日窗口。
- 龙虎榜当日/三日身份、缺 close、机构/游资能力不串线、时间字段不冒充发布时间。
- 快讯大整数 ID、create/update 时间、冷启动分页降级、tag 配置、详情 HTML 按不可信内容处理。
- 板块 `.TI` 身份、行业/概念分组、当前关系空列表、快照 retrieval 时间、历史成分不伪造。
- 财务金额/EPS/百分比/比率单位、null、报告期与披露日、当前快照不写 PIT facts。

**Tushare 退役**

- 所有运行时 source enum 和设置 schema 拒绝 `tushare`。
- 新配置不含 `TUSHARE_*`，设置页无对应凭据格。
- 通用测试不再依赖 Tushare 实现；历史 decoder/repository 仍能读取旧 source。
- DB 迁移前后对历史行做计数、主键、source、contentHash 对照，结果完全一致。

### 17.2 真实验收矩阵

| 能力 | 最小真实证据 |
|---|---|
| 在线行情回归 | 现有 quote/batch/qfq/search/snapshot/delayed-index 全通过；realtime-index 和 minute-bars 仍未绑定 |
| Dump | 三种文件下载、hash、schema、行数、日期范围、断点恢复；抽样与在线 raw/qfq 差异可解释 |
| 公司行动 | 现金、送转、配股、同日组合、除权日、后补 revision；账户账本未被自动修改 |
| 天梯/情绪 | 至少五个真实交易日，覆盖首板/多板、ST/20cm、炸板/回封、空池和限流 |
| 龙虎榜 | 当年及历史日、全部/机构/游资权限、双源数量与金额差异可解释 |
| 资讯 | 首屏/翻页/刷新、重复 ID、发布时间、个股新闻、持久化幂等 |
| 板块 | 行业/概念目录、快照、100 只分批反查、当前关系与历史 PIT 隔离 |
| 财务 | 多股票、多报告期、五类指标和估值权限；缺 revision 证据时 gate 仍 not-ready |
| 动态限流 | 多域并发下触发 429/4001 后共享冷却、fallback、恢复与状态页一致 |
| Tushare 退役 | 新运行无 Tushare 网络请求；旧 SQLite 的 quote/daily/minute/universe/backtest 历史查询可读 |

### 17.3 交付门禁

每个 Phase 至少执行与其范围匹配的最小测试，最终执行：

```bash
bun run typecheck
bun run test:all
bun run lint
bun run build
```

另需：

- `git diff --check` 和 Markdown 相对链接检查；
- DSH Node 生产装配测试，证明无 Bun/Python 运行依赖；
- 实际浏览器验证数据源设置、状态页、新增查询和降级文案；
- 对真实 Key 做逐 capability 权限验收，而不是一次 200 推断全部可用；
- 搜索运行时和现役配置中的 Tushare 引用，仅保留 §12.2 允许的兼容与归档位置；
- 保存脱敏验收证据，记录 source、capability、asOf/cutoff、覆盖、错误 kind、hash 和 reviewer。

### 17.4 实施验收记录（2026-11-04）

实施初期使用 Kimi K3-256K；额度耗尽后由 Codex 完成独立代码评审、契约修正和生产集成。以下均为实际运行结果：

| 检查 | 结果 |
|---|---|
| `bun run test:baseline`（包含 test:all 各段、coverage 和 lint） | 458 文件、5,760 测试全过；Vitest 4,610 / Bun DB 798 / Node SQLite 335 / DSH authority 17 |
| 全仓 TypeScript / Biome | 通过；lint 0 错误、0 告警 |
| Workspace 与 DSH Node 插件构建 | 通过；Parquet WASM 为固定版本运行依赖，bundle 不引用开发机 WASM 绝对路径 |
| 独立 npm tarball 安装 | 通过；真实 DSH Loader、Node SQLite、WASM 初始化、74 个 read 与 14 个 market 工具，以及 dump external+write Operation 均验收 |
| Chrome 浏览器 | 隔离 DSH profile 的真实 Chrome/CDP 验收通过；设置保存和热更、刷新、降级、移动端无横向溢出 |
| 文档、架构边界、空白差异 | `check:docs`、`check:layers`、`git diff --check` 通过 |
| 历史 Tushare | 新增三表和重复迁移后，历史 quote/qfq/revision 原值不变；无运行时 Tushare binding |
| 配置迁移 | 临时文件 CLI 测试 19 项通过；未修改真实部署配置 |

真实供应商文件经当前 Manager 下载、流式解析并导入独立临时目录和内存仓储（未写个人数据库）：

| Artifact | SHA-256 | 处理结果 |
|---|---|---|
| `daily-k-10d` | `5d4a6fcd617ac8abc522eddcd3dbf375d72463e7a090bf0077d5d55662888873` | complete；55,693 行，checkpoint=55,693；2026-10-22 至 2026-11-04 |
| `adjustment-factors` | `5f6b6bb5047792694f1e0f9514be76e6245dc3ed60521331f9089e0737501c1b` | complete；57,745 行，checkpoint=57,745；57,744 条 revision（吸收一条纯重复） |

当前复权事件 artifact 的精确八列包括 `thscode` 与 `ticker`；全市场 dump 含 `.BJ`，其原始身份保留，不据此提升在线行情覆盖。另有 `000887.SZ` / `600381.SH` 两条负股数变动比例（`-0.67335` / `-0.87581`），市场原始事实保留该值，拒绝小于等于 `-1` 的无效股数倍数，不自动生成账户动作。此前生成样本缺列和非负假设均已修正并加入回归。

修复还覆盖：限流重试耗尽时仍在释放槽位前登记共享冷却；首条 revision 前冻结 recordedAt；跨批次重复和重排稳定身份；恢复前校验本地 bytes/hash；取票或下载失败保存 failed attempt。取票前失败的 dumpId 为明确的 `unresolved:<kind>:<runId>` 本地标记，hash 保持 null。

动态 429/4001 使用确定性故障注入验证，并未通过真实 API 压测强行触发。浏览器使用合成账户，验证装配和交互；真实供应商验证与浏览器证据分别记录。严格 PIT、历史炸板/断板与公司行动回测门禁继续保持现状，Phase 6 尚未开放。

## 18. 完成定义

本设计全部落地且仅在以下事实同时成立时完成：

1. 现有 Fuyao 在线行情能力继续工作，未提升实时时间等级。
2. 新能力均经独立端口/Manager/Registry 接入，没有非行情域塞入 `MarketDataManager`。
3. Dump、原始日线和公司行动形成可恢复、可审计、append-only 的本地事实链。
4. 天梯/情绪、龙虎榜、资讯、板块和财务当前快照具备独立权限、fallback、状态和测试。
5. AI 客户端专属能力未进入运行时代码和配置。
6. 严格 PIT 财务、历史炸板/断板和严格回测门禁仍按真实证据独立判定。
7. Tushare 运行时代码、配置和现役入口全部移除；历史 `source='tushare'` 数据原样保留且可读。
8. 配置迁移、回滚、文件变更、分阶段实施与测试验收均有可复现记录。
