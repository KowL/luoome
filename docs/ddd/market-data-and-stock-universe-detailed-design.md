# 行情数据底座详细设计：多源规范化、盘后归档与本地股票目录

> 状态：**实施中（Phase 1 股票目录、Phase 2 规范日线与盘后闭环已完成）**
> 日期：2026-07-28
> 范围：行情 adapter seam、实时 Quote、新鲜度、规范日线、盘后归档、股票目录
> `StockUniverse` 本地同步、搜索与全市场扫描的数据关系
> 关联文档：[领域语言](../../CONTEXT.md)、[架构说明](../ARCHITECTURE.md)、
> [个股行情查看详细设计](./stock-market-view-detailed-design.md)、
> [Strategy 与统一 Watchlist 详细设计](./strategy-watchlist-unification-detailed-design.md)、
> [Tushare 行情适配器设计](./tushare-market-adapter-design.md)

## 1. 背景

当前行情实现已经具备 Eastmoney、Tencent、Tushare 三个真实数据源，以及
`MarketDataManager` 提供的缓存、限速和 fallback。CLI、TUI、MCP、Web 也统一通过
`createMarketAdapterFromEnv` 装配，依赖方向符合 `surface → tools → adapters/core`。

但现有 seam 主要保证 TypeScript 形状兼容，没有完整保证行为可替换：

1. `fetchDailyBars` 只在抛错时 fallback；主源返回空数组会被当成成功并缓存。
2. Eastmoney/Tencent 返回前复权日线但写 `adjFactor=1`；Tushare 返回未复权 OHLC
   和真实复权因子，切源会改变指标的价格坐标系。
3. Tushare 的 `fetchIndexQuotes` 是最近日线而非盘中实时数据，却满足当前“实时指数”
   方法形状。
4. Eastmoney/Tencent 的 Quote `ts` 使用抓取时间；盘前、午休和盘后重复抓取会把冻结价格
   伪装成刚刚成交的数据。
5. `batch_quote` 远端缺失时回退任意年龄的本地快照，调用方拿不到
   `local-fallback/stale` 语义。
6. `intraday-watch` 的昨收只读本地 `daily_bars`；目前日线主要在用户打开个股行情页时落库，
   缺失时又退回 `quote.open`，无法稳定保证“相对昨收”的规则语义。
7. Eastmoney 已能拉沪深全市场快照，但只缓存 5 分钟；`stocks` 仍只是“实际使用过的股票”
   集合，搜索、分组和全市场扫描对外部源依赖较强。
8. 指数存在隐式 Eastmoney fallback、连板天梯写死 Eastmoney、健康读模型写死
   Eastmoney/Tencent，配置与实际调用不完全一致。

本设计把这些问题视为一个数据底座问题，而不是逐个 caller 补 fallback。目标是深化行情
module：统一 interface 只暴露调用方真正需要理解的语义，把协议差异、有效性、缓存、fallback、
持久化时机与来源能力集中到 implementation，获得 locality 和 leverage。

## 2. 目标

### 2.1 必须实现

- 建立可由多个 adapter 满足的行情能力 seam，切换源不改变 Quote、DailyBar 和指数的业务语义。
- 区分数据源异常、能力不支持、合法空结果、无效空结果、部分结果和陈旧结果。
- Quote 同时表达市场观测时间与本地抓取时间，盘中规则拒绝陈旧本地回退。
- 统一日线为前复权价格坐标系，并明确记录复权方式和可选原始复权因子。
- 建立盘后日线归档 workflow，让次日盯盘不依赖用户是否打开过行情页。
- 新增股票目录（StockUniverse）同步，把明确覆盖范围内的股票基础资料原子写入本地。
- 搜索优先使用新鲜的本地股票目录，外部搜索只做补充与过期降级。
- 保留全市场行情快照的短 TTL 特性，不把高频价格错误塞入 `stocks`。
- 数据源配置、能力路由和健康观测来自同一 registry，不保留隐式 Eastmoney 旁路。
- 所有新 repository 同时提供 Drizzle 与 in-memory implementation，并复用 contract tests。

### 2.2 成功标准

- 空数据库完成一次股票目录同步后，断网仍可按代码或名称搜索已同步范围内的股票。
- 股票目录任一分页失败、结果为空或完整性校验失败时，本地上一版目录完全不变。
- 不打开行情页也能在每个交易日盘后写入关注股票的规范日线。
- `price-change` 只使用上一交易日已落定收盘；缺失时规则结果是 `unknown`，不退回今开。
- 同一股票和日期从不同 adapter 获取的规范日线，在价格精度容差内等价。
- 盘中远端行情失败时，超过允许年龄的本地 Quote 不进入盯盘规则求值。
- 关闭 Eastmoney 后，任何行情、指数、股票目录和健康检查路径都不会隐式调用 Eastmoney。
- 新增数据源时，主要工作集中在 adapter implementation 与共享 contract tests，不修改 caller。

## 3. 非目标

本设计不实现：

- 分钟 K、逐笔成交、Level-2、盘口和资金流；
- 为全市场每只股票每分钟持久化 PriceSnapshot；
- 自动交易或由行情同步触发交易；
- 把股票目录当作交易所官方证券主数据；
- 首期覆盖港股、美股、基金、债券、期货和加密资产；
- 根据一次目录缺失自动判定退市或物理删除股票；
- 在进程启动时阻塞等待全市场同步；
- 内置调度器；继续使用 workflow + 外部 cron；
- 重写连板天梯领域模型；它只需要在来源 registry 中消除隐式配置。

## 4. 领域口径

### 4.1 股票目录（StockUniverse）

股票目录回答“配置覆盖范围内有哪些可被系统识别的股票”。

首期覆盖范围固定标识为：

```text
CN_A_SHARES_SH_SZ = 上海 A 股 + 深圳 A 股
```

“全市场”在任何输出、日志和界面中都必须同时展示覆盖范围，不能把沪深 A 股描述成全球、
全品类或包含北交所的全集。

股票目录包含相对稳定的数据：

- `stockId`：`<code>.<exchange>`；
- `code`；
- `exchange`；
- `name`；
- `listingStatus`：`listed | suspended | delisted | unknown`；
- `source`；
- `observedAt`；
- 可选 `industry`、`listDate`、`delistDate`。

### 4.2 全市场行情快照（MarketSnapshot）

全市场行情快照回答“某个时刻覆盖范围内股票的价格横截面是什么”。它包含 `close`、
`changePct` 等高频字段，用于：

- formula 分组全市场扫描；
- LLM 分组候选上下文；
- 低成本战法初筛。

它保持 5 分钟级内存 TTL，不写入 `stocks`，首期也不批量写入 `price_snapshots`。

### 4.3 实时行情（Quote）

Quote 是单股票的稀疏市场观测，不是连续分钟行情。它必须区分：

- `observedAt`：数据源提供的市场观测时间；
- `fetchedAt`：本机收到响应的时间；
- `timestampSource`：`upstream | retrieval`；
- `source`：实际返回数据的 adapter；
- `retrieval`：`live | local-fallback`；
- `freshness`：基于市场时段和调用场景判断。

### 4.4 规范日线（DailyBar）

所有 adapter 对 caller 返回的 DailyBar 统一为前复权（`qfq`）价格。调用方不再理解各源原始
复权方式，也不根据 `source` 决定是否自行换算。

日线日期表达 Asia/Shanghai 交易日，仍使用 UTC 零点 `Date` 保存，避免改变现有 repository
键语义。

## 5. 已确认决策

### 5.1 外部 interface 深化，内部按能力设 seam

`ToolContext.adapters.market` 对 tools 保持一个深 interface，由 `MarketDataGateway`
implementation 隐藏：

- Quote 缓存与 fallback；
- 日线规范化与 fallback；
- 指数实时性要求；
- MarketSnapshot 路由；
- 有效性与新鲜度策略；
- source metadata。

在 adapters 包内部，不再要求每个 provider 实现一个宽而充满 optional 方法的 interface。
按实际变化原因拆成能力 seam：

```ts
interface QuoteSource {
  readonly name: MarketSourceId;
  readonly coverage: readonly MarketCoverage[];
  fetchQuote(stockId: string): Promise<SourceQuote>;
}

interface DailyBarSource {
  readonly name: MarketSourceId;
  readonly coverage: readonly MarketCoverage[];
  fetchDailyBars(stockId: string, range: DateRange): Promise<SourceDailyBarBatch>;
}

interface IndexQuoteSource {
  readonly name: MarketSourceId;
  readonly mode: 'realtime' | 'delayed';
  fetchIndexQuotes(): Promise<readonly SourceIndexQuote[]>;
}

interface MarketSnapshotSource {
  readonly name: MarketSourceId;
  readonly coverage: readonly MarketCoverage[];
  fetchMarketSnapshot(): Promise<SourceMarketSnapshot>;
}

interface StockUniverseSource {
  readonly name: MarketSourceId;
  readonly coverage: readonly MarketCoverage[];
  fetchStockUniverse(): Promise<StockUniverseSnapshot>;
}
```

一个 provider implementation 可以满足多个能力 seam，但不能因为“同属行情源”就用空实现
冒充能力支持。

### 5.2 股票目录使用独立 manager

股票目录是低频完整数据集，与实时 Quote 的缓存、限速和失败模型不同，因此由
`StockUniverseManager` 管理，不把 `fetchStockUniverse` 继续塞进现有
`MarketDataAdapterLike` optional 方法。

`ToolContext` 增加：

```ts
readonly adapters: {
  readonly market: MarketDataGatewayLike;
  readonly stockUniverse: StockUniverseManagerLike;
  readonly llm: LLMAdapterLike;
}
```

`sync_stock_universe` tool 是唯一允许把外部目录写入 repository 的入口。Workflow 只通过
该 tool 编排，不直接调用 manager 或 repository。

### 5.3 `stocks` 是规范身份，目录观测单独保存

现有 `stocks` 继续作为 Holding、Trade、StockGroup、Advice 等实体引用的规范股票身份，
不为每个 provider 复制一套 Stock。

新增 `stock_universe_memberships` 保存 provider 观测和同步状态。这样可以：

- 保留手工创建的 Stock；
- 同时记录 Eastmoney/Tushare 对同一股票的观测；
- 在一个源漏数据时不删除规范身份；
- 审计改名、缺失和覆盖范围；
- 将“未在本轮观测到”与“退市”分开。

### 5.4 完整快照原子提交

目录 adapter 必须自行完成全部分页，成功时返回完整快照；任何页失败都抛错，不能返回已拉到的
半份结果。

Manager 和 repository 在提交前执行完整性校验：

- `complete=true`；
- `entries.length > 0`；
- `reportedTotal` 存在时与去重后条数一致；
- `stockId` 在快照内唯一；
- code、exchange、name 合法；
- 所有 entry 均在声明 coverage 内；
- 数量没有低于上一次成功同步的异常阈值。

只有校验通过才在一个数据库事务中应用。失败、空结果和部分结果不改变 `stocks` 或现有
membership。

### 5.5 缺失不等于退市

完整快照中未出现、但上一版存在的 membership 标记为 `missing`，设置 `missingSince`。
不执行：

- 删除 `stocks`；
- 删除持仓、交易、分组成员或历史 Advice；
- 自动写 `delisted`。

只有 provider 明确返回退市状态，或者后续人工确认，才能写 `delisted`。

### 5.6 目录与行情持久化分离

一次股票目录同步只写：

- `stocks` 基础身份；
- `stock_universe_memberships`；
- `stock_universe_sync_runs`；
- `WorkflowRun` 审计。

即使 Eastmoney clist 同时返回 `close/changePct`，也不在目录同步中批量写
`price_snapshots`。价格横截面继续由 MarketSnapshot module 管理。

### 5.7 日线统一为 `qfq`

规范 DailyBar 增加：

```ts
type PriceAdjustment = 'raw' | 'qfq' | 'hfq';

interface DailyBar {
  readonly stockId: string;
  readonly date: Date;
  readonly open: Money;
  readonly high: Money;
  readonly low: Money;
  readonly close: Money;
  readonly volume: number;
  readonly adjustment: 'qfq';
  readonly sourceAdjFactor?: number;
  readonly source: string;
}
```

- Eastmoney：继续请求 `fqt=1`，返回 `adjustment='qfq'`，因接口未给原始 factor，
  `sourceAdjFactor` 省略。
- Tencent：优先 `qfqday`，若只有 `day` 则该源本轮不满足 qfq 契约并触发 fallback。
- Tushare：用 `daily + adj_factor` 在 adapter 内换算 qfq；不能只把 raw OHLC 与 factor
  并排返回给 caller。
- 任一源不能产生 qfq 时必须抛 `unsupported_adjustment` 或 `no_data`，不能用
  `adjFactor=1` 伪装。

### 5.8 Quote 区分观测与抓取时间

Quote 演进为：

```ts
interface Quote {
  readonly stockId: string;
  readonly observedAt: Date;
  readonly fetchedAt: Date;
  readonly timestampSource: 'upstream' | 'retrieval';
  readonly open: Money;
  readonly high: Money;
  readonly low: Money;
  readonly close: Money;
  readonly volume: number;
  readonly prevClose?: Money;
  readonly source: string;
}
```

兼容迁移期保留 `ts` getter 或映射只存在于 module implementation，不把双时间语义泄漏给
所有 caller。最终 repository 主键改为 `(stockId, observedAt, source)`，`fetchedAt` 只描述
获取行为。

各 adapter 的时间映射：

- Eastmoney：请求并解析上游时间字段；拿不到时 `observedAt=fetchedAt` 且
  `timestampSource='retrieval'`。
- Tencent：解析 minute 响应的 `date` 和最后一条 `HHmm`，不再无条件用本地时钟。
- Tushare：解析 `trade_time`；缺失时按 retrieval 标记。

### 5.9 没有隐式数据源

source registry 是启用状态、顺序、能力和健康观测的唯一事实来源。任何 manager 不得在
registry 之外 `new EastmoneyAdapter()`。

初始配置：

```text
LUOOME_MARKET_SOURCES=eastmoney,tencent[,tushare]
LUOOME_STOCK_UNIVERSE_SOURCES=eastmoney[,tushare]
```

股票目录使用独立顺序，因为 Tencent 首期不具备完整目录能力，而 Quote 源顺序不应隐式决定
目录来源。

显式启用 Tushare 时继续要求 `TUSHARE_TOKEN`。如果配置了一个不支持所需能力的 source，
启动期快速失败，不在运行时静默跳过。

## 6. 目标架构

```text
cli / tui / mcp / web
          │
          ▼
        tools
          │
          ├── quote / market-view / indicators
          │        │
          │        ▼
          │   MarketDataGateway  ── internal capability seams
          │        │                 ├── Eastmoney adapters
          │        │                 ├── Tencent adapters
          │        │                 └── Tushare adapters
          │        ▼
          │   Quote / DailyBar repositories
          │
          └── sync_stock_universe
                   │
                   ▼
             StockUniverseManager
                   │
                   ├── EastmoneyUniverseAdapter
                   └── TushareUniverseAdapter
                   │
                   ▼
             StockUniverseRepository
                   │
                   ├── stocks
                   ├── stock_universe_memberships
                   └── stock_universe_sync_runs

workflows ──► ctx.tools.* only
```

删除 `MarketDataGateway` 会迫使缓存、有效性、复权、fallback 和 source metadata 回到多个
tool；删除 `StockUniverseManager` 会迫使分页、完整性和 source fallback 回到同步 tool。
两者都通过删除测试证明具有足够 depth。

## 7. Core 契约

### 7.1 Coverage

```ts
const MarketCoverageSchema = z.enum([
  'CN_A_SHARES_SH_SZ',
  'CN_A_SHARES_BJ',
  'HK_EQUITIES',
  'US_EQUITIES',
]);
```

首期 StockUniverse 只接受 `CN_A_SHARES_SH_SZ`。Quote adapter 可以声明更多 coverage，
但搜索返回的候选必须能被至少一个启用 QuoteSource 获取，否则候选不能标记为可用。

### 7.2 StockUniverseEntry

```ts
const ListingStatusSchema = z.enum(['listed', 'suspended', 'delisted', 'unknown']);

const StockUniverseEntrySchema = z.object({
  stockId: z.string().regex(/^[A-Z0-9]{1,12}\.(SH|SZ|BJ|HK|US)$/),
  code: StockCodeSchema,
  exchange: ExchangeSchema,
  name: z.string().trim().min(1).max(100),
  listingStatus: ListingStatusSchema,
  industry: z.string().trim().min(1).max(100).optional(),
  listDate: z.coerce.date().optional(),
  delistDate: z.coerce.date().optional(),
});
```

### 7.3 StockUniverseSnapshot

```ts
const StockUniverseSnapshotSchema = z.object({
  source: MarketSourceIdSchema,
  coverage: MarketCoverageSchema,
  observedAt: z.coerce.date(),
  complete: z.literal(true),
  reportedTotal: z.number().int().positive().optional(),
  entries: z.array(StockUniverseEntrySchema).min(1),
});
```

Adapter 不能返回 `complete=false` 给 Manager。分页未完成直接抛 source error，避免 caller
误用部分结果。

### 7.4 Source errors

共享错误分类：

```ts
type MarketSourceErrorKind =
  | 'network'
  | 'timeout'
  | 'rate_limited'
  | 'permission'
  | 'unsupported_market'
  | 'unsupported_capability'
  | 'unsupported_adjustment'
  | 'no_data'
  | 'partial_data'
  | 'invalid_payload';
```

Adapter implementation 保留 provider 原始错误作为 cause，但 Manager 只根据稳定 kind
决定 fallback。Tool 最终转为现有 `ToolError.adapter_error`，不会把上游响应直接泄漏给调用方。

### 7.5 Repository interface

```ts
interface StockUniverseRepository {
  applySnapshot(input: {
    syncId: string;
    snapshot: StockUniverseSnapshot;
    appliedAt: Date;
  }): Promise<StockUniverseApplySummary>;

  latestSuccessfulSync(input?: {
    source?: string;
    coverage?: MarketCoverage;
  }): Promise<StockUniverseSyncRun | null>;

  listCurrent(input: {
    coverage: MarketCoverage;
    status?: 'active' | 'missing' | 'all';
  }): Promise<readonly Stock[]>;
}
```

`applySnapshot` 的 interface 保证：

- 完整性校验已通过；
- Stock 与 membership 同事务提交；
- 同一 snapshot 重放幂等；
- 旧 membership 缺失只标记，不删除；
- summary 计数基于提交后的事实。

Drizzle 和 in-memory implementation 必须共享同一套 contract tests。

## 8. 数据模型

### 8.1 `stocks` 演进

现有字段保留，新增：

```text
name_source       text not null  -- stub | manual | universe
name_updated_at   integer null
updated_at        integer not null
```

迁移规则：

- 存量 `name == code` → `name_source='stub'`；
- 其它存量名称 → 保守标记 `manual`；
- 新目录创建的 Stock → `universe`；
- 手工录入未带名称 → `stub`；
- 搜索候选或目录可覆盖 `stub`；
- `universe` 名称可被后续完整目录同步更新；
- `manual` 名称不被外部源自动覆盖；
- `industry` 只在当前为空时由目录补齐，首期不新增 industry provenance 列。

### 8.2 `stock_universe_memberships`

```text
source             text not null
coverage           text not null
stock_id           text not null
observed_name      text not null
listing_status     text not null
state              text not null  -- active | missing
first_seen_at      integer not null
last_seen_at       integer not null
missing_since      integer null
last_sync_id       text not null
metadata           text(json) null

primary key (source, coverage, stock_id)
index (coverage, state, stock_id)
index (stock_id)
```

`metadata` 只保存经过白名单筛选的非核心 provider 字段，不保存 token、请求头或完整原始响应。

### 8.3 `stock_universe_sync_runs`

```text
id                 text primary key
source             text not null
coverage           text not null
status             text not null  -- running | succeeded | failed
started_at         integer not null
finished_at        integer null
observed_at        integer null
reported_total     integer null
observed_count     integer not null default 0
created_stocks     integer not null default 0
updated_stocks     integer not null default 0
reactivated        integer not null default 0
marked_missing     integer not null default 0
error_kind         text null
error_message      text null
```

该表记录 dataset 专属审计；外层 workflow 仍写 `workflow_runs`，两者用途不同：

- `stock_universe_sync_runs`：一次 source snapshot 的完整性和应用结果；
- `workflow_runs`：用户/cron 发起的整个 workflow 状态。

### 8.4 `price_snapshots` 演进

新增：

```text
observed_at       integer not null
fetched_at        integer not null
timestamp_source  text not null
```

迁移期从现有 `ts` 同时回填 observed/fetched，`timestamp_source='retrieval'`。完成迁移后
逐步淘汰 `ts` 列，避免一次版本同时改主键和删除列。

### 8.5 `daily_bars` 演进

新增：

```text
adjustment         text not null default 'qfq'
source_adj_factor  real null
```

迁移规则：

- Eastmoney/Tencent 存量行标记 `qfq`；
- Tushare 存量行标记 `raw`，在完成重新同步前不允许与 qfq 行混合计算指标；
- 新写入必须是 `qfq`；
- 同 `(stockId, date)` upsert 时同时更新 source、adjustment 和 factor。

Drizzle schema 与 `ensureSchema` DDL 必须同步，迁移幂等。

## 9. Adapter implementation

### 9.1 Eastmoney 股票目录

新增 `EastmoneyStockUniverseAdapter`，内部复用 clist transport，但与 MarketSnapshot 映射分离。

请求：

```text
push2.eastmoney.com/api/qt/clist/get
pn=<page>&pz=500
fs=沪深 A 股范围
fields=f12,f13,f14
```

规则：

- 顺序分页，避免并发整批拒绝；
- 任一页 HTTP、JSON、`rc`、字段解析失败 → `partial_data`；
- 根据 `data.total` 验证累计条数；
- `f13` 映射 SH/SZ，其它市场丢弃前必须确认不在声明 coverage；
- 停牌股票没有价格不影响目录，目录映射不依赖 `f2/f3`；
- `listingStatus` 首期写 `unknown`，不能根据有无报价推断停牌或退市。

MarketSnapshot adapter 可以复用同一个私有 clist client，但两个公开 adapter 返回不同领域形状。

### 9.2 Tushare 股票目录

新增 `TushareStockUniverseAdapter`，使用 `stock_basic`：

- 分别请求 `list_status=L/P/D`，避免默认只返回上市股票却被误解为完整状态全集；
- 将 SSE/SZSE 映射为 SH/SZ；
- 过滤不在 `CN_A_SHARES_SH_SZ` 的条目；
- 映射 name、industry、list_date、delist_date；
- 三个状态请求任一失败 → 整次 snapshot `partial_data`；
- token/积分/权限失败分类为 `permission`。

Eastmoney 与 Tushare 两个 implementation 让 StockUniverseSource seam 成为真实 seam，并共享
adapter contract tests。

### 9.3 Tencent

Tencent 首期只实现 Quote、DailyBar 和 Search 能力，不注册为 StockUniverseSource 或
IndexQuoteSource。不能添加返回空数组的占位 implementation。

### 9.4 指数

`IndexQuoteSource.mode` 必须参与路由：

- 实时指数调用只选择 `mode='realtime'`；
- Tushare `index_daily` 注册为 delayed index source，只能用于盘后/历史场景；
- 没有实时 source 时返回 `unsupported_capability`，不能把日线伪装为实时；
- 不再创建 registry 之外的 Eastmoney index fallback。

## 10. Manager 策略

### 10.1 有效结果才停止 fallback

| 能力 | 有效成功 | 继续 fallback |
|---|---|---|
| Quote | 价格合法、时间和 coverage 合法 | 空、全零、过期、unsupported、异常 |
| DailyBar | qfq、范围内有合法交易日数据 | 空、raw、全部越界、部分解析、异常 |
| Search | 结果在 source coverage 内；coverage 完整时空可终止 | source 只覆盖部分目标市场且为空 |
| Realtime index | `mode=realtime` 且时间合法 | delayed、空、异常 |
| MarketSnapshot | complete、数量和 coverage 校验通过 | 空、部分分页、异常 |
| StockUniverse | complete、原子完整性校验通过 | 空、部分分页、数量异常、异常 |

DailyBar 请求区间如果按交易日历确认不包含任何交易日，可以合法返回空，不强制 fallback。

### 10.2 抑制窗口

现有 `finalFallbackAtByKey` 改为：

```text
key = capability + stockId/query/coverage
```

只在 final source **成功返回有效数据后**建立 source affinity。最终源失败不得刷新窗口；否则会
在主备源恢复后继续跳过它们。

窗口内 final source 失败时立即清除 affinity，并重新尝试正常 source 顺序一次。

### 10.3 缓存

| 数据 | key | TTL | 是否允许缓存空结果 |
|---|---|---:|---|
| Quote | stockId | Web 10s，其它 60s | 否 |
| DailyBar | stockId + 对齐日期 + adjustment | 1h | 仅无交易日区间 |
| Realtime index | coverage/index set | 10s | 否 |
| MarketSnapshot | coverage | 5min | 否 |
| StockUniverse | source + coverage | 一次 sync 进程内 | 否 |

所有 TTL 使用注入 clock，避免 Manager 使用测试时钟而 LRU 使用 `Date.now()` 的双时钟。

final source 成功的 Quote、DailyBar 和 snapshot 必须与主备源使用同一缓存写入路径。

### 10.4 批量 Quote

`batch_quote` 输出演进为逐股票结果：

```ts
type BatchQuoteItem =
  | {
      stockId: string;
      status: 'ok';
      quote: Quote;
      retrieval: 'live' | 'local-fallback';
      freshness: 'fresh' | 'stale';
    }
  | {
      stockId: string;
      status: 'unresolved' | 'unavailable';
      reason: string;
    };
```

DB fallback 必须传入调用场景：

- `display`：允许返回旧数据，但明确 `stale`；
- `intraday-rule`：只允许当前交易日且年龄不超过
  `max(2 × watchInterval, 180s)` 的 Quote；
- `post-market`：允许当日最后观测，但不能标记成实时。

不再把任意年龄的本地快照放入普通 `quotes` 数组。

## 11. Repository 应用算法

`StockUniverseRepository.applySnapshot` 的 Drizzle implementation：

1. 在事务外完成远端请求和 snapshot schema 校验。
2. 开启 SQLite transaction。
3. 读取同 source + coverage 的当前 membership。
4. 对 snapshot entries：
   - Stock 不存在 → 创建；
   - `name_source='stub'` → 用 observed name 更新；
   - `name_source='universe'` 且名称变化 → 更新；
   - `name_source='manual'` → 不覆盖；
   - industry 为空且 provider 提供 → 补齐；
   - membership upsert 为 `active`，清除 `missingSince`。
5. 对上一版 active、但本次未出现的 membership 标记 `missing`。
6. 更新 `stock_universe_sync_runs` 为 succeeded 和各计数。
7. 提交事务。

任一步失败整体 rollback。failed sync run 可在独立短事务中记录，但不能留下 running membership
或半批 Stock。

为避免 SQLite 参数上限，implementation 按固定批次执行 upsert，但事务仍覆盖全部批次。

## 12. Tool 契约

### 12.1 `sync_stock_universe`

```ts
const SyncStockUniverseInput = z.object({
  source: MarketSourceIdSchema.optional(),
  coverage: MarketCoverageSchema.default('CN_A_SHARES_SH_SZ'),
  force: z.boolean().default(false),
  dryRun: z.boolean().default(false),
});
```

`force=false` 且最近成功同步未超过 12 小时时返回 `skipped='fresh-enough'`，不访问外部源。

输出：

```ts
const SyncStockUniverseOutput = z.object({
  syncId: z.string(),
  source: MarketSourceIdSchema,
  coverage: MarketCoverageSchema,
  status: z.enum(['succeeded', 'dry-run', 'skipped']),
  observedCount: z.number().int().nonnegative(),
  createdStocks: z.number().int().nonnegative(),
  updatedStocks: z.number().int().nonnegative(),
  reactivated: z.number().int().nonnegative(),
  markedMissing: z.number().int().nonnegative(),
  observedAt: z.coerce.date().nullable(),
});
```

Tool 属性：

- `sideEffect='external'`；
- 远端请求 + 本地写入都在描述中显式说明；
- dry-run 仍访问外部源，但不修改 Stock/membership；可记录 debug 日志，不写成功 sync；
- source 未指定时由 StockUniverseManager 按配置 fallback；
- 所有源失败 → `adapter_error(recoverable=true)`；
- 完整性失败 → `adapter_error`，错误 kind 保留 `partial_data/invalid_payload`。

### 12.2 `get_stock_universe_status`

read tool，返回：

- coverage；
- 最近成功 source、observedAt、finishedAt、count；
- 当前 active/missing 数；
- freshness：`fresh | stale | unknown | unavailable`；
- 最近失败摘要；
- 当前启用的 universe sources。

不写死 provider 名称。

### 12.3 `search_stocks`

搜索顺序改为：

```text
新鲜本地目录有匹配
  → 返回 local-universe
本地无匹配或目录 stale/unknown
  → 外部 search source
  → 成功返回 external
  → 失败再回退本地历史 stocks
```

外部搜索结果本身仍不落库；用户进入行情、持仓、交易或分组流程时通过 `ensureStockStub` 落
规范 Stock。

输出 source 扩展为：

```text
local-universe | external | local-history
```

### 12.4 `sync_daily_bars`

新增原子 tool：

```ts
const SyncDailyBarsInput = z.object({
  stockIds: z.array(z.string()).max(1000).optional(),
  scope: z.enum(['relevant', 'explicit']).default('relevant'),
  correctionWindowDays: z.number().int().min(5).max(60).default(15),
});
```

`relevant` 复用“活跃持仓 ∪ enabled 分组当前成员 ∪ 有研究/事件的股票”，不为目录内全部股票
每日拉日线。

规则：

- 取最近本地 bar 日期并向前回看 correction window，覆盖复权因子变化和数据修订；
- 只保存 qfq；
- 每只股票独立报告成功/失败；
- 空数组按交易日历和 Manager 有效性策略处理；
- 返回 `partial` 时保留成功股票，不删除旧 bar；
- 不生成 Advice、不发送通知。

### 12.5 `get_previous_closes`

新增 batch read tool：

```ts
input: { stockIds: string[]; tradingDate?: string }
output: {
  items: Array<
    | { stockId: string; status: 'ok'; close: Money; date: string; source: string }
    | { stockId: string; status: 'unavailable'; reason: string }
  >
}
```

它集中“上一交易日、qfq、日期严格小于目标交易日”的语义。`intraday-watch` 不再直接读取
DailyBarRepository。

## 13. Workflow 与调度

### 13.1 `sync-stock-universe`

单步 workflow 调 `sync_stock_universe`，由 workflow 引擎写 `WorkflowRun`。支持人工执行和
cron，不在 Web 启动时自动阻塞同步。

推荐：

```cron
# 交易日收盘后同步沪深 A 股目录
20 16 * * 1-5  luoome workflow run sync-stock-universe
```

workflow 内先检查交易日；非交易日输出 succeeded + skipped，不访问 provider。

### 13.2 `post-market-data`

新增盘后 workflow：

```text
is trading day?
  ├─ no  → skipped
  └─ yes
      ├─ sync_stock_universe
      ├─ sync_daily_bars(scope='relevant')
      ├─ get_stock_universe_status
      └─ 汇总 WorkflowRun
```

目录同步失败不阻止相关股票日线同步；日线部分失败也不回滚已成功的目录。Workflow 最终状态：

- 全部成功 → `succeeded`；
- 至少一项成功、至少一项失败 → `partial`；
- 全部失败 → `failed`。

推荐统一 cron：

```cron
30 16 * * 1-5  luoome workflow run post-market-data
```

若采用统一 workflow，就不再单独配置 16:20 的目录 cron。

### 13.3 `intraday-watch`

盘中链路调整：

```text
batch_quote(context='intraday-rule')
  → get_previous_closes
  → 规则求值
```

- Quote stale/unavailable → 该股票本轮所有价格规则 `unknown`；
- previous close unavailable → `price-change` 为 `unknown`；
- 不再构造 `source='unresolved', close=0` 的伪 Quote；
- 不再使用 `quote.open` 作为昨收；
- unknown 不改变 WatchRuleState，也不产生 triggered/recovered；
- WatchRun 记录 unavailable/stale 股票数，仪表盘可见。

## 14. 股票目录与现有场景

### 14.1 添加持仓、交易和分组

`ensureStockStub` 保留，作为目录缺失、外部市场或离线手工录入的安全入口。目录同步后大多数
沪深 A 股已经存在，不再频繁创建 `name=code` 的 stub。

### 14.2 动态分组

formula/LLM 分组区分：

- 候选身份集合：本地 StockUniverse；
- 当日价格横截面：MarketSnapshot；
- 历史指标：规范 DailyBar。

MarketSnapshot 可用时继续用于高效全市场初筛；不可用时可以使用本地目录确定候选身份，但不能
对约 5000 只股票无上限逐只远程拉 Quote。降级必须有并发、配额和最大候选数。

### 14.3 全市场战法

`run_tactic(scope='all-stocks')` 的“all”改为当前 coverage 下 active StockUniverse，而不是
`stocks` 中曾经使用过的股票。输出必须携带 coverage 和 universe observedAt。

需要 OHLCV 的战法仍依赖 Quote/DailyBar；股票目录只解决候选身份，不替代行情。

### 14.4 本地搜索

本地目录使搜索变成稳定 read path。外部搜索继续用于：

- 目录尚未初始化；
- 目录过期；
- 搜索目录覆盖范围之外的市场；
- 本地无匹配时补充新上市或改名股票。

## 15. 健康与可观测性

`get_market_data_status` 不再维护 `KNOWN_PROVIDERS` 常量。它从 source registry 和 dataset
checkpoint 生成：

```text
dataset: quote | daily-bars | market-snapshot | stock-universe | realtime-index
source
coverage
capabilityEnabled
configurationReady
lastAttemptAt
lastSuccessAt
dataAsOf
freshness
lastErrorKind
```

关键指标：

- 每 source/capability 调用、成功、失败、fallback 次数；
- empty/partial/invalid payload 次数；
- Quote cache hit 和 stale rejection；
- DailyBar qfq validation failure；
- universe observed/created/updated/missing 数；
- post-market workflow 成功、partial、failed；
- intraday unavailable/stale stock 数。

日志不得包含 Tushare token、完整请求体、持仓集合或用户研究内容。

## 16. 安全与副作用

- `sync_stock_universe`、`sync_daily_bars` 为 `external`，MCP 默认不暴露。
- Web 手动同步需要同源 Origin，并受 external 能力开关控制。
- 数据同步不会触发 Advice 或 trade。
- 数据源配置继续存 `$LUOOME_HOME/.env`，权限 `0600`，读接口不返回密钥。
- provider 原始 payload 不整包落库，避免未知字段携带敏感信息或导致数据库膨胀。
- 目录缺失、行情 stale 和 workflow partial 必须显式展示，不能把 confidence 表述为确定性。

## 17. 迁移与兼容

### 17.1 SQLite

迁移顺序：

1. 新增 `stock_universe_memberships`。
2. 新增 `stock_universe_sync_runs`。
3. 给 `stocks` 增加 name provenance 与 updatedAt。
4. 给 `price_snapshots` 增加 observed/fetched/timestampSource。
5. 给 `daily_bars` 增加 adjustment/sourceAdjFactor。
6. 回填存量行。
7. 新代码双读迁移字段，稳定后再停止依赖旧 `ts/adjFactor` 语义。

每一步必须同时更新 Drizzle schema 与 `ensureSchema`，对存量库重复启动幂等。

### 17.2 Tool 兼容

`batch_quote` 输出属于 breaking change。迁移期可以保留：

```text
quotes       -- 仅 status=ok 的兼容投影
unresolved   -- 兼容投影
items        -- 新逐股票状态
```

所有 caller 切到 `items` 后再删除旧字段。

`search_stocks.source` 扩枚举会影响 Web schema/tests，需要同一阶段更新。

### 17.3 日线

在 Tushare raw 存量行完成 qfq 重同步前：

- 指标计算只选择 `adjustment='qfq'`；
- raw 行仍保留供审计；
- 不用 raw 填补 qfq 时间序列；
- 同日期 qfq upsert 后覆盖规范读取路径。

## 18. 测试策略

### 18.1 Core

- StockUniverseEntry/Snapshot schema；
- coverage 与 exchange 一致；
- complete snapshot 非空；
- Quote 双时间不变量；
- DailyBar 必须 qfq；
- source error kind 穷尽。

### 18.2 Adapter contract tests

所有 StockUniverseSource implementation 复用：

1. 返回完整非空 snapshot；
2. stockId 唯一；
3. code/exchange/id 自洽；
4. coverage 不泄漏；
5. reportedTotal 自洽；
6. 任一分页失败不得返回部分 snapshot；
7. 空响应转 `no_data`；
8. 名称和日期规范化；
9. 不读取调用方 repository；
10. 不输出凭据。

Quote/DailyBar contract 增加：

- observed/fetched 时间；
- qfq 等价；
- 空结果 fallback；
- delayed index 不满足 realtime；
- unsupported market 分类。

### 18.3 Manager

- 主源空日线 → fallback；
- 主源全部越界 → fallback；
- final source 失败不建立抑制窗口；
- final source 成功写缓存；
- suppress key 按 capability 隔离；
- DB Quote 超龄在 intraday context 被拒绝；
- 市场休市时 display context 可返回 closed/stale；
- cache 使用注入 clock；
- 配置关闭 Eastmoney 后无 Eastmoney 调用。

### 18.4 Repository contract tests

Drizzle 与 in-memory 共用：

- 首次完整同步创建 Stock/membership；
- 同 snapshot 重放幂等；
- stub 名称升级；
- manual 名称不覆盖；
- universe 名称可更新；
- 缺失标 missing、不删除 Stock；
- 再次出现 reactivated；
- 两个 source membership 互不覆盖；
- 事务中途失败无半批；
- latestSuccessfulSync 正确；
- 同步摘要计数一致。

### 18.5 Tool/Workflow

- local universe 搜索优先；
- 目录 stale 时外部补充；
- 目录同步 fresh-enough 跳过；
- dry-run 不写业务表；
- post-market 非交易日跳过；
- 日线 partial 正确审计；
- previous close 严格排除目标交易日；
- intraday 缺昨收为 unknown；
- stale Quote 不改变 WatchRuleState。

### 18.6 外部 smoke

外部 smoke 独立于确定性测试，要求显式凭据和网络：

- Eastmoney 沪深目录条数与 reportedTotal 一致；
- Tushare 同 coverage 条数在合理差异范围；
- 随机抽样代码/交易所/名称一致；
- 当日收盘后随机关注股有 qfq 日线；
- 本地目录同步后断网搜索成功。

不把公网 smoke 纳入默认单元测试，避免上游波动阻塞开发。

## 19. 实施阶段

### Phase 0：锁定现状

- 为已确认问题补失败测试：空日线、陈旧 DB Quote、final failure suppress、复权不一致。
- 为 source registry 和当前 composition roots 补调用审计。

### Phase 1：股票目录

- core StockUniverse schema；
- repository + 两张表 + 双 implementation；
- Eastmoney/Tushare universe adapters；
- StockUniverseManager/factory；
- `sync_stock_universe`、status tool、workflow；
- 本地优先搜索；
- 文档和 cron。

### Phase 2：规范日线与盘后闭环（已完成）

- DailyBar qfq 契约和迁移；
- 三个 adapter 统一；
- `sync_daily_bars`、`get_previous_closes`；
- `post-market-data`；
- intraday 去掉 open fallback。

### Phase 3：Quote 新鲜度（已完成）

- Quote 双时间；
- price snapshot 迁移；
- batch item 状态；
- caller 按 display/intraday/post-market context 使用。

### Phase 4：能力 registry（已完成）

- capability-specific internal seams；
- 去掉 optional 占位和隐藏 Eastmoney fallback；
- 指数 realtime/delayed 分路；
- 动态健康读模型；
- 连板天梯来源接入显式 registry。

每个 Phase 独立可回滚；不得一次提交同时跨完所有 schema、adapter、tool、workflow 和 Web 改动。

## 20. 文件影响范围

预计涉及：

```text
CONTEXT.md
docs/ARCHITECTURE.md
docs/README.md
docs/ddd/market-data-and-stock-universe-detailed-design.md
docs/runbooks/market-data-sync.md

packages/core/src/context.ts
packages/core/src/entity/{quote,stock-universe}.ts
packages/core/src/repository/index.ts

packages/adapters/src/market/{registry,gateway,manager,cache}.ts
packages/adapters/src/market/{eastmoney,tencent,tushare}.ts
packages/adapters/src/stock-universe/*

packages/db/src/schema/index.ts
packages/db/src/client.ts
packages/db/src/repository/{drizzle,memory}/stock-universe.ts
packages/db/src/repository/contract-tests.ts

packages/tools/src/tools/{sync-stock-universe,get-stock-universe-status}.ts
packages/tools/src/tools/{sync-daily-bars,get-previous-closes}.ts
packages/tools/src/tools/{batch-quote,search-stocks,get-market-data-status}.ts

packages/workflows/src/{sync-stock-universe,post-market-data,intraday-watch}.ts
packages/cli/src/index.ts
apps/web/src/server.ts
```

实际实施按 Phase 逐步收敛，不为未来阶段提前创建空 module。

## 21. 验收清单

- [x] `CONTEXT.md` 明确 StockUniverse 与 MarketSnapshot 的区别。
- [x] Eastmoney、Tushare 两个 universe adapter 通过同一 contract tests。
- [x] 全市场分页失败或空结果不改变本地目录。
- [x] 同步事务不会留下半批 Stock/membership。
- [x] 本地目录断网可搜索。
- [x] 外部搜索结果仍需进入业务流程才创建目录外 Stock。
- [x] MarketSnapshot 价格没有写入 `stocks`。
- [x] 盘后 workflow 不依赖用户打开 Web。
- [x] intraday price-change 不使用 quote.open 代替昨收。
- [x] DailyBar 在所有 source 下均为 qfq。
- [x] Quote stale 状态能传播到盯盘 caller。
- [x] Tushare delayed index 不冒充 realtime。
- [x] source 配置与实际调用完全一致。
- [x] health 输出自动包含新 source/capability。
- [x] Drizzle schema 与 `ensureSchema` 同步、迁移幂等。
- [x] `bun run test:all`、`bun run typecheck`、`bun run lint` 通过。
- [x] 不新增任何自动交易路径。

## 22. 取舍总结

本设计没有把“缓存全市场股票”简化为启动时执行一次 `stocks.upsert`。那种实现会丢失来源、
完整性、缺失语义和审计，后续仍会把 provider 差异泄漏到搜索、分组和战法 caller。

选择 StockUniverseManager + 原子 repository 的代价是新增两张表和一组 contract tests；收益是：

- interface 小于其隐藏的分页、校验、fallback 和持久化 implementation，形成 deep module；
- 两个 adapter 让 seam 真实存在；
- 股票身份、价格横截面和历史日线各有明确生命周期；
- 盘中与盘后共享同一规范数据，不再由页面访问偶然决定正确性；
- 后续替换数据源时，变化集中在 adapter 和 registry，获得 locality。
