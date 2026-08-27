# 个股行情查看详细设计：Market View + Web 图表

> 状态：Phase 1/2/3 已实施；Phase 4 首个 MinuteBar 竖向切片已实施（历史分钟仍为本地保留范围）
> 日期：2026-08-20
> 范围：个股实时快照、日 K、MinuteBar 分时/分钟 K、成交量、指标摘要、数据来源与新鲜度
> 关联文档：[架构说明](../ARCHITECTURE.md)、[ruo 能力迁移详细设计](./ruo-feature-migration-detailed-design.md) §6、[Strategy 与统一 Watchlist 详细设计](./strategy-watchlist-unification-detailed-design.md)

## 1. 目标

在现有 Web 中增加“行情”入口，让用户搜索一只股票后看到：

- 股票代码、名称和交易所；
- 当前价、涨跌额、涨跌幅、今开、最高、最低和成交量；
- 行情获取时间、实际数据源、数据新鲜度和降级提示；
- 1 个月、3 个月、6 个月、1 年日 K；
- 成交量副图和已有技术指标摘要；
- 跳转到该股票的研究、持仓和 Advice 场景。

行情页是事实查看入口，不生成 Advice、不执行交易、不代替专业行情终端。

## 2. 非目标

首期不实现：

- 任意历史日期的远端分钟补数（当前 provider 只提供当前交易日）；
- Level-2、五档盘口、逐笔成交、资金流向；
- 复权方式切换；
- 自定义画线、复杂指标编辑器；
- 指数、板块和全市场行情中心；
- WebSocket 或 SSE 推送；
- 自动交易。

`PriceSnapshot` 是用户调用、workflow 或盯盘扫描时留下的稀疏快照，不能当成连续分钟行情。
MinuteBar 的冻结 schema、provider 能力、缺口和生命周期见 [MinuteBar 详细设计](./minute-bar-detailed-design.md)。

## 3. 已确认决策

### 3.1 一个组合 Tool 承担行情查看语义

新增 `get_stock_market_view` Tool，一次返回股票、实时行情、日 K、派生涨跌、指标和数据状态。

Web 不分别调用 `fetch_quote`、日线 adapter、repository 和 `compute_indicators` 后自行拼装。组合规则集中在 Tool 中，CLI、MCP、Web 和后续研究页可以复用同一契约。

### 3.2 Tool 的副作用类型是 `external`

打开行情页会访问外部行情源，并把成功结果写入本地 `PriceSnapshot` / `DailyBar` repository，因此：

- `sideEffect: 'external'`；
- Web 必须把 `get_stock_market_view` 加入 `WEB_ALLOWED_EXTERNAL`；
- MCP 仍受 `LUOOME_EXPOSE_EXTERNAL=true` 控制；
- 不把它标成 `read` 绕过外部访问权限。

### 3.3 首期只提供日 K

现有 `MarketDataAdapterLike` 只有：

- `fetchQuote`；
- `batchQuote`；
- `fetchDailyBars`。

它可以可靠支撑“实时快照 + 日 K”，不能可靠支撑完整分时。UI 周期只有 `1m / 3m / 6m / 1y`，其中 `m` 表示 month，不出现 `1d` 分时入口。

### 3.4 使用 Lightweight Charts

Web 图表实现采用 `lightweight-charts@5.2.0`：

- 金融图表专用；
- 支持 Candlestick、Histogram、Line 和多 pane；
- ESM 与现有原生模块结构兼容；
- Apache-2.0；
- 体积小于通用图表库，首期不需要引入前端框架。

运行时不依赖 CDN。依赖固定在 `apps/web/package.json`，由 Web server 只读暴露确定的 ESM 产物。保留默认 TradingView attribution logo，满足其 NOTICE/link 要求。

图表库只能存在于 `market-chart.js` 的实现中，Tool 输出和页面状态不得使用该库的类型。

### 3.5 数据来源必须可见

用户必须能区分：

- Eastmoney 主源成功；
- Tencent 备源成功；
- 外部请求失败后使用本地旧快照；
- 数据完全不可用。

不能以价格 `0`、空图或“暂无触发”掩盖行情失败。

### 3.6 日线写库，但 DB 不是首选在线缓存

成功拉取日线后写入 `DailyBarRepository`，用于：

- 外部数据源失败时回退；
- 离线查看已有历史；
- 后续真实信号复盘。

在线请求仍先走 `MarketDataManager` 的内存缓存和主备链。数据库没有独立 `fetchedAt`，首期不把 DB 命中描述成“新鲜”，只能标记为 `stale`。

## 4. 当前实现与缺口

### 4.1 已有能力

| 能力 | 位置 | 现状 |
|---|---|---|
| Quote / DailyBar | `packages/core/src/entity/quote.ts` | 已有 OHLCV、时间和 Quote source |
| Quote repository | `packages/core/src/repository/index.ts` | 支持最新、批量最新和区间查询 |
| DailyBar repository | 同上 | 支持区间和最近 N 根 |
| Eastmoney adapter | `packages/adapters/src/market/eastmoney.ts` | 实时快照 + 前复权日线 |
| Tencent adapter | `packages/adapters/src/market/tencent.ts` | 实时快照 + 前复权日线 |
| Sina adapter | `packages/adapters/src/market/sina.ts` | 沪深 A 股 qfq 日线；不声明实时快照能力 |
| MarketDataManager | `packages/adapters/src/market/manager.ts` | 主源、备源、限速、Quote 60s 缓存、日线 1h 缓存 |
| 技术指标 | `packages/tools/src/internal/indicators.ts` | MA、RSI、MACD、BOLL、成交量等 |
| 股票搜索 | `search_stocks` / `/api/stocks/search` | 外部搜索失败回本地 Stock repository |
| Web | Hono + 原生 HTML/CSS/ES modules | 无前端构建步骤 |

### 4.2 已关闭缺口（截至 2026-08-14）

1. `get_stock_market_view` 在 Tool 内同时返回 candles、指标和数据状态，页面不再重复调用 `compute_indicators`。
2. `DailyBar`、Drizzle 与 memory repository 均保留真实 `source`；批量 upsert 不以首行覆盖其它日期。
3. 日线成功结果由行情查看 Tool 写入 repository，缓存键按规范化交易日区间复用。
4. Quote 已支持可选 `prevClose`、成交额和换手率；缺失时仍由 Market View 从前复权日线推导昨收。
5. `observedAt` / `fetchedAt` 区分上游观测和本地抓取，界面继续使用“获取于”而不是“成交于”。
6. 股票搜索统一使用 `q` 契约；外部搜索失败时只回退本地事实，不生成样例股票。
7. Sina 仅注册 `daily-bars` capability，真实源失败按 provider error 返回，不提供 mock 生产 fallback。

## 5. 端到端数据流

```text
Web #market
  │
  ├─ GET /api/stocks/search?q=...
  │    └─ search_stocks
  │         └─ MarketDataManager.searchStocks → registered search sources → local repo
  │
  └─ POST /api/tools/get_stock_market_view/call
       └─ get_stock_market_view (external)
            ├─ resolve / register Stock
            ├─ MarketDataManager.fetchQuote
            ├─ MarketDataManager.fetchDailyBars
            ├─ QuoteRepository.save
            ├─ DailyBarRepository.saveMany
            ├─ DB fallback when external fetch fails
            ├─ derive previous close / change / candles
            └─ compute indicators
                  │
                  ▼
             Market View output
                  │
                  ▼
          market.js → market-chart.js → Lightweight Charts
```

Web 不直接访问 adapter 或 repository。Workflow 若将来需要相同组合数据，也只调用 Tool。

## 6. Core 演进

### 6.1 DailyBar 增加 source

修改 `packages/core/src/entity/quote.ts`：

```ts
export interface DailyBar {
  readonly stockId: string;
  readonly date: Date;
  readonly open: Money;
  readonly high: Money;
  readonly low: Money;
  readonly close: Money;
  readonly volume: number;
  readonly adjFactor: number;
  readonly source: string;
}
```

`DailyBarSchema` 同步增加：

```ts
source: z.string().min(1)
```

同步范围：

- Eastmoney 产生 `source: 'eastmoney'`；
- Tencent 产生 `source: 'tencent'`；
- fixed/mock adapter 明确给出测试 source；
- Drizzle row mapping 读写真实 source；
- memory repository 保留 source；
- repository contract tests 验证 upsert 后 source 随最新 bar 更新；
- fixtures 和现有测试补 source。

SQLite 已有 `daily_bars.source NOT NULL`，本次不新增列，也不需要存量迁移。`ensureSchema` DDL 保持不变。

### 6.2 Quote 的可选源字段与派生边界

Quote 已保留不同源能够稳定提供的可选 `prevClose`、`amount` 和 `turnoverRatePct`；`change` /
`changePct` 仍属于 Market View read model。若 Quote 没有 `prevClose`，Tool 从上一交易日 qfq
DailyBar 推导，不把缺失值填成 0，也不把单一源字段升级为强制领域不变量。

### 6.3 不新增 MarketView 领域实体

Market View 是面向调用方的组合读取模型，不参与持久化、身份和领域生命周期，因此：

- 不放入 `packages/core/src/entity/`；
- Zod input/output schema 放在 `packages/tools/src/tools/get-stock-market-view.ts`；
- 可复用的纯计算 helper 放在 `packages/tools/src/internal/market-view.ts`；
- `DataFreshnessSchema` 复用 `packages/core/src/entity/provenance.ts`。

## 7. Tool 契约

### 7.1 输入

```ts
export const MarketViewRangeSchema = z.enum(['1m', '3m', '6m', '1y']);

export const GetStockMarketViewInput = z.object({
  stockId: z.string().trim().min(1),
  stockName: z.string().trim().min(1).max(100).optional(),
  range: MarketViewRangeSchema.default('3m'),
});
```

约定：

- `stockId` 支持完整 Stock.id 或纯代码；
- 搜索候选提供完整 `<code>.<exchange>` 和 `stockName`；
- 完整 Stock.id 尚未入库时，复用 `ensureStockStub` 登记；
- 纯代码无法解析到唯一 Stock 时返回 `not_found`；
- `range` 到自然日回看长度：`1m=35`、`3m=100`、`6m=190`、`1y=370`，给节假日留余量；
- Tool 最多返回 260 根日 K，避免输出无上限。

### 7.2 输出

```ts
const MarketCandleSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  open: MoneySchema,
  high: MoneySchema,
  low: MoneySchema,
  close: MoneySchema,
  volume: z.number().nonnegative(),
  source: z.string().min(1),
  completeness: z.enum(['closed', 'live']),
});

const MarketQuoteSummarySchema = z.object({
  quote: QuoteSchema,
  previousClose: MoneySchema.nullable(),
  change: z.number().nullable(),
  changePct: z.number().nullable(),
});

const MarketDataStatusSchema = z.object({
  freshness: DataFreshnessSchema,
  retrieval: z.enum(['live', 'local-fallback']),
  quoteFetchedAt: z.coerce.date().nullable(),
  barsAsOf: z.string().nullable(),
  sources: z.array(z.string().min(1)),
  marketSession: z.enum([
    'pre-open',
    'trading',
    'midday-break',
    'closed',
    'non-trading-day',
  ]),
  warnings: z.array(z.enum([
    'quote-local-fallback',
    'bars-local-fallback',
    'provider-fallback',
    'previous-close-unavailable',
    'bars-insufficient',
    'market-closed',
  ])),
});

export const GetStockMarketViewOutput = z.object({
  stock: z.object({
    id: z.string(),
    code: z.string(),
    name: z.string(),
    exchange: ExchangeSchema,
  }),
  quote: MarketQuoteSummarySchema,
  candles: z.array(MarketCandleSchema),
  indicators: TechnicalIndicatorsSchema,
  indicatorsAsOf: z.string().nullable(),
  dataStatus: MarketDataStatusSchema,
});
```

说明：

- `change` / `changePct` 用 number，不创建新的 Money 品牌，因为前者可为负数；
- `previousClose` 缺失时三项均为 `null`，Web 显示 `--`；
- `sources` 去重，包含 Quote 和 candles 实际来源；
- `barsAsOf` / `indicatorsAsOf` 是 `YYYY-MM-DD`，表示最后一根 candle 的日期；
- `quoteFetchedAt` 是抓取时间，不冒充市场成交时间；
- `freshness='unavailable'` 时 Tool 只有在连本地回退也不存在时才整体返回错误，因此成功输出不会出现 `unavailable`；保留该枚举是为了与公共 provenance 契约一致。

### 7.3 sideEffect 与错误

```ts
export const getStockMarketViewTool = defineTool({
  name: 'get_stock_market_view',
  description: '获取个股实时快照、日 K、指标和数据状态',
  sideEffect: 'external',
  input: GetStockMarketViewInput,
  output: GetStockMarketViewOutput,
  handler: ...
});
```

错误映射：

| 场景 | ToolError |
|---|---|
| stockId / range 不合法 | `invalid_input` |
| 股票无法解析 | `not_found` |
| Quote 全源失败且无本地快照 | `adapter_error`，`recoverable=true` |
| 日线全源失败且 DB 无任何数据 | `adapter_error`，`recoverable=true` |
| 有 Quote、只有不足量历史 bars | 成功 + `bars-insufficient` |
| 输出不满足 schema | `internal`（由 `defineTool` 统一处理） |

不能把上游网络异常直接泄漏成 `internal`。

## 8. Tool 处理流程

### 8.1 时间范围归一化

所有日期按 Asia/Shanghai 计算，但传给 adapter/repository 的 `Date` 使用 UTC 零点表达对应自然日。

```text
now = ctx.clock()
today = Asia/Shanghai 的 YYYY-MM-DD
end = today 对应 UTC 00:00
start = end - range 对应自然日数
```

`start/end` 必须按自然日对齐，不能直接用每次变化的 `now`，否则 DailyBarCache 的 exact-range key 几乎无法命中。

### 8.2 拉取与回退

Quote 与 DailyBar 在股票解析后并行拉取：

```text
quote:
  adapter.fetchQuote 成功
    → QuoteRepository.save
    → retrieval=live
  失败
    → QuoteRepository.latestByStock
    → 有值：retrieval=local-fallback + warning
    → 无值：adapter_error

bars:
  adapter.fetchDailyBars 成功且非空
    → DailyBarRepository.saveMany
  失败或返回空
    → DailyBarRepository.findInRange
    → 有值：warning=bars-local-fallback
    → 无值：adapter_error
```

Quote 和 bars 任一外部分支失败都写 warn 日志，包含 stockId、adapter、range 和错误摘要，不输出私有数据。

### 8.3 bars 规范化

对拉取或回退的 DailyBar：

1. 只保留 `[start, end]`；
2. 按 date 升序；
3. 同日重复时保留最后一条；
4. 校验 `high >= max(open, close)`；
5. 校验 `low <= min(open, close)`；
6. 最多保留最后 260 根；
7. 不足 20 根时追加 `bars-insufficient`。

DailyBarSchema 已保证价格为正；OHLC 关系作为 Market View helper 的防御性外部数据校验。非法 bar 丢弃并记录 warning 日志，不把整页变成 500。

### 8.4 昨收和涨跌

昨收必须取：

```text
date < Asia/Shanghai today 的最后一根有效 DailyBar.close
```

不能使用：

- `quote.open`；
- 当天未收盘 DailyBar；
- 本地 PriceSnapshot 的上一条记录。

计算：

```text
change = quote.close - previousClose
changePct = previousClose > 0 ? change / previousClose : null
```

输出前按现有 Money / 数值精度约定处理，Web 不重复计算。

### 8.5 当日 candle 合并

远端日线可能包含当天未收盘 K，也可能只返回历史收盘 K。Market View 输出采用统一规则：

1. 历史 candle：只取 `date < today` 的 DailyBar，`completeness='closed'`；
2. 当 Quote 对应当前上海自然日且当日已有交易（session 为 `trading` / `midday-break` / `closed`）时，用 Quote 生成当天 candle：
   - open/high/low/close/volume 来自 Quote；
   - source 来自 Quote；
   - 盘中、午休 `completeness='live'`；
   - 收盘后仍标记 `live`，因为 Quote 的 `ts` 是抓取时间，无法证明这是交易所最终结算 K；
   - 盘前 / 非交易日不生成当天 candle：Quote 的 `ts` 只是抓取时间，当日尚无成交，
     拼成蜡烛会伪造一根未开盘的 K 线（此时 quote 卡片照常展示，K 线止于上一交易日）；
3. 不同时保留远端当天 DailyBar 和 Quote candle，避免同日两根；
4. Quote 是历史本地回退且日期不是 today 时，不生成伪造的当天 candle。

后续接入交易所明确的收盘状态或正式日线后，才允许把当天 candle 标记为 `closed`。

### 8.6 指标

首期复用 `computeSimpleIndicators`，输入规范化后的 candles（去掉 `completeness` 后转回计算形状）。

规则：

- 指标只计算一次；
- Tool 输出 candles 与指标来自同一组数据；
- 不再调用 `compute_indicators` Tool，避免同一请求重复拉日线；
- `indicatorsAsOf` 等于参与计算的最后一根 candle 日期；
- 指标缺少窗口时按现有 schema 返回 `undefined`，并通过 `bars-insufficient` 提示。

### 8.7 数据状态

首期的 freshness 表示“本次获取路径是否仍依赖旧本地数据”，不是交易所逐笔实时性：

| 条件 | freshness | retrieval |
|---|---|---|
| Quote 和 bars 外部调用成功 | `fresh` | `live` |
| 任一部分使用 DB 回退 | `stale` | `local-fallback` |
| 成功获取 Quote，但无足够历史 | `unknown` | `live` |
| 全部不可用 | Tool 返回 `adapter_error` |

`marketSession` 由现有交易日历和 Asia/Shanghai 时间纯计算。午休是 `midday-break`，非交易日是 `non-trading-day`。收盘状态不等于数据 stale。

行情来源由 `LUOOME_MARKET_SOURCES` 和 capability registry 决定，默认顺序为 Eastmoney → Tencent → Sina。
Sina 当前只绑定 `daily-bars`，因此不会被误用于实时快照或股票搜索。fallback metadata 必须来自
实际返回的 provider，不按 source 名称硬编码。

## 9. Repository 与缓存

### 9.1 QuoteRepository

沿用现有接口，不新增方法。

成功外部 Quote 总是保存。DB fallback 不重新保存，避免用旧数据制造新的 `ts`。

### 9.2 DailyBarRepository

沿用现有接口：

```ts
saveMany(bars)
findInRange(stockId, from, to)
```

当前实现的 Drizzle `saveMany` 已使用 SQLite `excluded.column` 表达式完成批量 upsert：

- 每根 bar 写自己的 `source`；
- 冲突更新逐行读取对应 VALUES 的 OHLCV / adjustment / source，不会用首行覆盖整批其它行；
- 批量内不同日期或来源逐条正确更新，并由 memory/Drizzle contract test 守住。

此前从 `rows[0]` 构造统一 `set` 的实现已修复；后续修改 schema 或 upsert 字段时必须继续保留该
逐行语义和对应 contract test。

### 9.3 缓存

| 数据 | 内存缓存 | DB | 页面刷新 |
|---|---:|---:|---:|
| Quote | 60s | 每次成功写快照 | 60s |
| DailyBar | 1h | 每次成功 upsert | 切换股票/周期时拉取 |
| 搜索 | 无 | 本地 fallback | 用户输入 debounce |

页面不能设置低于 60 秒的自动刷新，因为会反复拿到同一缓存值。

## 10. Registry 与 Surface 接线

新增/修改：

- `packages/tools/src/tools/get-stock-market-view.ts`；
- `packages/tools/src/internal/market-view.ts`；
- `packages/tools/src/index.ts` 桶导出；
- `packages/tools/src/registry.ts` 注册；
- `packages/tools/src/registry.test.ts` 更新库存和 sideEffect 断言；
- `packages/tools/src/agent-whitelist.ts` 首期不加入，避免通用 agent 一次拉取大段 K 线；
- CLI / MCP 通过 registry 自动发现；
- `apps/web/src/server.ts` 的 `WEB_ALLOWED_EXTERNAL` 加 `get_stock_market_view`；
- Web server tests 覆盖允许调用和鉴权。

不新增专用 `/api/market/view` 路由，Web 使用现有：

```text
POST /api/tools/get_stock_market_view/call
```

这样响应继续保持 `ToolResult` 形状。

## 11. Web 信息架构

### 11.1 路由

行情页不单独占用侧栏菜单项，入口来自：

- 仪表盘股票搜索；
- 持仓和分组中的股票链接；
- 行情页内搜索及最近查看；
- 外部或站内深链接。

进入行情深链接时，现有侧栏不设置 active 项。“涨停梯队”首期保持现有独立入口，不在本任务重组整个侧栏。

支持深链接：

```text
#market?stockId=002594.SZ&range=3m
```

路由解析修改为：

```text
routeName = hash 中 ? 之前部分
routeParams = hash 中 ? 之后的 URLSearchParams
```

兼容现有 `#dashboard`、`#groups` 等 hash。无 stockId 时展示搜索空态。

### 11.2 页面结构

```text
行情
├── 搜索区
│   ├── 代码/名称输入
│   ├── 搜索候选
│   └── 最近查看（localStorage，最多 8 只）
├── 报价头
│   ├── 名称 / 代码 / 交易所
│   ├── 当前价 / 涨跌 / 涨跌幅
│   ├── 开 / 高 / 低 / 昨收 / 成交量
│   └── 获取时间 / source / freshness
├── 周期切换：1M / 3M / 6M / 1Y
├── 图表
│   ├── 日 K 主 pane
│   ├── MA5 / MA10 / MA20（可切换）
│   └── Volume 副 pane
├── 指标摘要
│   ├── RSI14
│   ├── MACD
│   ├── BOLL
│   ├── 20 日高低
│   └── 成交量比
└── 关联入口
    ├── 查看研究
    ├── 查看 Advice
    └── 持仓中定位
```

### 11.3 展示规则

- A 股默认红涨绿跌，保持项目现有 `text-pos` / `text-neg` 语义；
- `changePct` 以百分比展示，保留两位；
- 金额使用现有 `fmtMoney`；
- volume 按股为底层单位，UI 可格式化为万/亿股；
- `source=eastmoney` 显示“东方财富”；
- `source=tencent` 显示“腾讯行情（备用源）”；
- 本地回退显示 amber badge：“旧快照”；
- `marketSession=closed` 显示“已收盘”，不等同于故障；
- null 一律显示 `--`；
- 无 bars 时不创建空 chart，显示明确错误/空态；
- 不展示“实时”字样，只写“行情获取于 HH:mm:ss”。

### 11.4 页面状态

`market.js` 维护单页状态：

```ts
{
  stockId,
  range,
  loading,
  requestId,
  data,
  error,
}
```

并发规则：

- 每次切换股票或周期递增 `requestId`；
- 响应只在 requestId 仍是当前值时渲染；
- 自动刷新与手动切换不能让旧响应覆盖新股票；
- 页面离开后停止 timer；
- `document.visibilityState !== 'visible'` 时暂停刷新；
- 回到可见状态后立即刷新一次；
- 网络错误保留上一份成功画面并显示 stale/error banner，不把图清空。

### 11.5 搜索

输入至少 1 个字符后触发，debounce 250ms：

```text
GET /api/stocks/search?q=<encoded>
```

行为：

- 最多展示 10 条；
- 键盘上下选择、Enter 确认、Escape 关闭；
- 选择后写入 hash 深链接；
- 最近查看只存 `id/code/name/exchange`，不存价格等行情私人数据；
- 同步修复研究页把 `query=` 改为 `q=`。

## 12. 图表 Module

新增：

```text
apps/web/public/js/market.js
apps/web/public/js/market-chart.js
```

`market-chart.js` 的页面内 interface：

```js
createMarketChart(container, options)
  → {
      setData({ candles, ma5, ma10, ma20 }),
      resize(width, height),
      destroy(),
    }
```

该 module 内部负责：

- Lightweight Charts import；
- Candlestick / Histogram / Line series 创建；
- A 股涨跌配色；
- pane 高度；
- crosshair tooltip；
- `ResizeObserver`；
- 移动端手势；
- attribution；
- destroy 时断开 observer 和事件监听。

`market.js` 不出现 `CandlestickSeries`、`HistogramSeries` 或任何第三方类型。

### 12.1 本地依赖暴露

`apps/web/package.json`：

```json
"lightweight-charts": "5.2.0"
```

Web server 增加只允许一个确定文件的路由：

```text
GET /vendor/lightweight-charts.mjs
```

实现用 `import.meta.resolve('lightweight-charts')` 解析已安装包入口并返回文件，不能接受用户传入 path，不能暴露整个 `node_modules`。

响应头：

```text
content-type: text/javascript; charset=utf-8
cache-control: public, max-age=31536000, immutable
```

HTML/JS 中使用固定 URL；升级依赖时同步更改 URL 版本段，避免旧缓存：

```text
/vendor/lightweight-charts-5.2.0.mjs
```

### 12.2 图表数据转换

Tool 输出使用通用 MarketCandle；`market-chart.js` 内转换成库数据：

```js
{
  time: candle.date,
  open: candle.open,
  high: candle.high,
  low: candle.low,
  close: candle.close,
}
```

volume 颜色根据 `close >= open` 决定。MA 序列从 candles 在前端纯计算只用于绘制，指标摘要仍以 Tool 输出为权威。

首期不在 Tool 输出整段 MA series，避免扩大通用 Tool 响应。前端 MA 计算必须放在可独立测试的纯函数中。

## 13. 安全与副作用

- 浏览器只访问同源 Web server，不直接调用 Eastmoney/Tencent；
- 所有写请求继续受显式能力开关和同源 Origin 校验保护；
- `get_stock_market_view` 只写行情缓存表和必要的 Stock stub；
- 不写 Holding、Trade、Advice、WatchTrigger；
- 不引入任何下单路径；
- 日志不记录 token、环境变量和用户持仓；
- 股票代码、range 先经 Zod 和 Stock 解析，不拼接成任意远端 URL；
- vendor 路由路径固定，禁止目录遍历；
- 图表 tooltip 只用 `textContent` / DOM helper，不拼用户输入 HTML。

## 14. 测试与验收

### 14.1 Core / DB

- `DailyBarSchema` 缺 source 拒绝；
- Eastmoney/Tencent DailyBar source 正确；
- memory / drizzle contract tests 同时验证 source；
- 多根 DailyBar 同批 upsert 不会互相覆盖 OHLCV；
- 冲突更新会更新对应日期的 source；
- 旧 SQLite 库启动不需要新增迁移。

### 14.2 Tool

`get-stock-market-view.test.ts` 至少覆盖：

1. 完整 Stock.id 正常返回；
2. 纯代码从 repo 解析；
3. 完整新 Stock.id + stockName 自动登记；
4. 1m/3m/6m/1y 范围归一化；
5. Quote 和 bars 成功后写 repository；
6. Quote 主源结果 + Tencent bars fallback，sources 正确；
7. Quote 外部失败 → DB 回退 + stale；
8. bars 外部失败 → DB 回退 + stale；
9. Quote 无外部也无 DB → adapter_error；
10. bars 无外部也无 DB → adapter_error；
11. 昨收严格排除今日 bar；
12. 今日远端 DailyBar 被 Quote candle 替换；
13. 历史 Quote 不生成今日 candle；
14. 少于 20 根 bars 返回 warning；
15. 同日 bars 去重并按日期升序；
16. 输出最多 260 根；
17. 指标与最后 candle 的 dataAsOf 一致；
18. 非交易日 / 收盘后 session 状态正确。

### 14.3 Web server

- `get_stock_market_view` 在 external 白名单内返回 200；
- 缺 token 返回现有鉴权错误；
- adapter_error 转 HTTP 502；
- vendor ESM 路由返回正确 content-type；
- 任意 `/vendor/../../...` 不可访问；
- `/market` 和 SPA fallback 返回 index.html；
- 搜索只接受 `q`，行情页和研究页都走同一参数。

### 14.4 前端纯函数

- MarketCandle → Lightweight Charts 数据转换；
- volume 红绿配色；
- MA5/10/20 计算；
- null / stale / fallback 展示；
- hash 参数解析与序列化；
- 旧请求不会覆盖新 requestId；
- 最近查看去重并限制 8 条；
- route 离开时 timer 清理。

### 14.5 浏览器验收

按照仓库 UI 约束，实际启动 Web 并用浏览器验证：

- 搜索 `002594` / “比亚迪”均能选中；
- 真实 Eastmoney 行情显示 K 线；
- 模拟 Eastmoney 失败后显示 Tencent 备用源；
- 模拟全源失败但有 DB 快照时显示“旧快照”；
- 无任何数据时显示明确错误，不显示价格 0；
- 1M/3M/6M/1Y 切换；
- resize、窄屏、触屏滚动；
- 标签页隐藏后不继续轮询；
- 深链接刷新后恢复股票与周期；
- 研究页搜索未因参数修复回归。

### 14.6 命令

开发中先跑：

```bash
bun test packages/tools/src/tools/get-stock-market-view.test.ts
bun test packages/db
bun test apps/web
```

交付前：

```bash
bun run typecheck
bun run test:all
bun run lint
bun run build
```

## 15. 分阶段实施

### Phase 1：数据契约（✅ 已完成）

1. DailyBar 增加 source；
2. 修复 Drizzle DailyBar 批量 upsert；
3. 新增 Market View 纯 helper；
4. 新增 `get_stock_market_view`；
5. registry / Web external 白名单接线；
6. Tool、repository 和 server tests。

完成标准已满足：CLI / MCP / Web 调 Tool 可返回真实 Quote、日 K、指标、来源和新鲜度。

### Phase 2：Web 页面（✅ 已完成）

1. 接入固定版本 Lightweight Charts；
2. 新增 `market-chart.js`；
3. 新增 `market.js`、HTML route 和 CSS；
4. 搜索、深链接和最近查看；
5. 60 秒刷新与页面生命周期；
6. 前端 tests 和真实浏览器验收。

完成标准已满足：用户能在 Web 搜索股票并查看日 K，错误和 fallback 状态可见。

### Phase 3：场景联动（✅ 已完成基础切片）

1. 研究页、Advice、持仓股票代码链接到 `#market`；
2. WatchTrigger / Trade / Advice 作为 chart marker；
3. 复盘场景按历史日期定位图表；
4. 评估是否加入 agent 只读能力白名单。

完成标准：行情页成为研究、建议和复盘事实的共享查看入口。

### Phase 4：分钟行情（✅ 首个生产级竖向切片）

已完成独立 `MinuteBar` core schema、Drizzle/in-memory repository、Tushare `rt_min`
adapter seam、`get_stock_minute_bars` Tool 和 Web 分时/分钟 K 展示。当前 provider 只覆盖
沪深 A 股当日会话；显式历史日期只读 30 天本地保留，缺失时诚实返回 unavailable/partial。
完整冻结契约见 [MinuteBar 详细设计](./minute-bar-detailed-design.md)。不得用 PriceSnapshot
或累计口径 IntradayMinute 区间查询替代 MinuteBar。

## 16. 文件变更清单

预计涉及：

```text
packages/core/src/entity/quote.ts
packages/adapters/src/market/eastmoney.ts
packages/adapters/src/market/tencent.ts
packages/tools/src/internal/market-view.ts
packages/tools/src/tools/get-stock-market-view.ts
packages/tools/src/registry.ts
packages/tools/src/index.ts
packages/db/src/repository/drizzle/daily-bar.ts
packages/db/src/repository/memory/daily-bar.ts
packages/db/src/repository/contract-tests.ts
apps/web/package.json
apps/web/src/server.ts
apps/web/public/index.html
apps/web/public/js/app.js
apps/web/public/js/market.js
apps/web/public/js/market-chart.js
apps/web/public/js/pages.js
apps/web/public/style.css
```

以及相邻测试和 fixtures。

## 17. 验收原则

- Web、CLI、MCP 看到的是同一个 Tool 契约；
- 页面不复制行情派生逻辑；
- 真实数据源失败不伪装成正常空数据；
- 数据来源、获取时间和 stale 状态始终可见；
- 日 K 与指标来自同一批 candles；
- 没有分钟数据就不展示分时；
- 图表库是可替换实现，不进入领域或 Tool interface；
- 任何改动不突破 Advice 与 Trade 的隔离。
