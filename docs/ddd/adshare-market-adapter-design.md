# Adshare 行情适配器详细设计

> 状态：Phase 1 已实施（2026-07-26）
> 日期：2026-07-26
> 范围：把 adshare 远端数据服务接入 luoome `MarketDataAdapter` 契约，使其成为 Eastmoney / Tencent 之外的第三个真实行情源
> 关联文档：[架构说明 §4.7](../ARCHITECTURE.md)、[个股行情查看详细设计](./stock-market-view-detailed-design.md)、[Adshare 集成手册](../runbooks/adshare-integration.md)、[连板天梯详细设计](./limit-up-ladder-detailed-design.md)

## 1. 目标

把 adshare 作为 luoome 通用行情链路上的第三个真实数据源，使用现有 `MarketDataAdapterLike` 契约：

- 注册为可排序的数据源；默认关闭，启用后可占据 `primary`、`fallback` 或
  `finalFallback` 槽位；
- 同时具备 `fetchQuote` / `batchQuote` / `fetchDailyBars` / `searchStocks` 四个能力；
- 与 Eastmoney / Tencent 共享 `Quote` / `DailyBar` / `StockSearchCandidate` 形状，统一进入现有缓存；需要持久化的 tool 继续按既有职责写 repository；
- A 股场景下允许用户配置一至三个真实源的启用状态与优先级，保留现有降级语义与抑制窗口。

完成后，返回数据与日志必须记录 source 名 `adshare`；`MarketDataManager.stats()` 的
`finalFallbackCalls` 继续表示第三源**尝试次数**，不把它解释为成功次数。`luoome tools list`
只验证既有行情 tool 仍被注册，不承担运行时数据源观测职责。

## 2. 非目标

首期不实现：

- 港股 / 美股 / 北交所 / 加密资产。adshare 当前远端只覆盖 SH / SZ A 股，其它市场不在 adapter 支持范围。
- 分钟 K 线、复盘分钟行情、分时图。本设计仅对齐日 K 与实时快照，分钟行情另有独立设计。
- 重写 `adshare-sdk` 的现有 endpoint。SDK 仍保留 limit-up ladder 与股票搜索能力；Phase 1
  只把现有 `fetchWithAuth` / `fetchStockBasic` 加入包级公开导出，行情、K 线与复权因子的
  协议映射仍由 adapter 处理。
- 自定义 SDK 的 Tushare envelope 解析、复权因子合并与成交量单位归一化为 SDK 内置能力。adapter 层处理这些差异。
- 自动交易、盯盘触发、Advice 联动。本设计只做读取。
- Adshare worker / 上游数据同步链路。仓库 `/Volumes/mm/project/adshare` 是外部项目，不在本仓改动范围。

## 3. 已确认决策

### 3.1 Adapter 独立于 SDK 现有 endpoint

实时行情与日线不复用 `adshare-sdk` 的 `getQuote` / `getKLine`，因为当前 SDK endpoint 与
本设计选用的 server 路由不一致；股票搜索继续复用 `fetchStockBasic`：

| SDK 当前 endpoint | server 实际 endpoint | 备注 |
|---|---|---|
| `GET /quote?ts_code=...` | `GET /tushare/realtime/rt_k?ts_code=...` | Tushare envelope；保留完整 `600519.SH` |
| `GET /daily?ts_code=...&period=D` | `GET /daily?ts_code=...&period=D` | 一致，但需要同时取 `/tushare/stock/adj_factor` |
| `GET /stock_basic?name=...` | `GET /stock_basic?name=...` | 一致，仍可复用 |
| 无 | `GET /tushare/stock/daily` | Tushare 协议，`{code, msg, data: {fields, items}}` |
| 无 | `GET /tushare/stock/adj_factor` | 单独获取复权因子 |
| 无 | `GET /tushare/realtime/rt_k` | 实时 Level-1 快照，字段名与日线不同 |

Phase 1 选择在 `packages/adapters/src/market/adshare.ts` 内新建 adapter，通过
`@luoome/adshare-sdk` 的包级入口复用 `fetchWithAuth`，直接调用 server 已有的 Tushare
REST 路由。`/realtime/quote/{code}` 返回 `{success, count, data: object[]}`，并非 Tushare
envelope；为避免在同一 adapter 内维护第二种实时协议，Phase 1 不使用该路由。

### 3.2 复用 SDK 的鉴权基础设施

SDK 的 `fetchWithAuth` 已经处理：

- `X-API-Key` + `Authorization: Bearer` 双头；
- `AbortController` 超时；
- 仅 5xx 与网络错误重试；
- `AdshareError` 错误分类。

adapter 内部对所有远端调用都走它。Phase 1 在 `adshare-sdk/src/index.ts` 公开导出
`fetchWithAuth` / `fetchStockBasic`，不允许从未公开的 `src/endpoints/*` 子路径深层导入。
`AdshareError` 在 adapter 内转译为普通 `Error`，不引入新的错误类型。

> 实施修正（2026-07-26 实测）：`fetchWithAuth` 原为所有 GET 携带
> `Content-Type: application/json`；adshare `/tushare/*` 路由会把「JSON Content-Type +
> 空 body」当 JSON 解析失败返回 400（`/stock_basic` 容忍）。Phase 1 已移除该头（GET 本无
> 请求体），`/stock_basic` / kline / quote 行为不变。

### 3.3 Adapter 进入可配置的三段行情路由

`MarketDataManager` 已经有 primary、fallback、finalFallback 槽位与 30 分钟抑制窗口。
`LUOOME_MARKET_SOURCES` 从左到右把启用源映射到这些槽位，数据源可选
`eastmoney`、`tencent`、`adshare`，至少启用一个且不得重复。缺省顺序仍是
Eastmoney → Tencent；显式启用 Adshare 后，它可以处于任意优先级。

现有 `finalFallbackSuppressMs` 是**主备源抑制窗口**，不是 Adshare 自身冷却窗口：

- 窗口外：按配置依次尝试 primary → fallback → finalFallback；
- 窗口内：跳过前两个槽位，直接调用 finalFallback；
- `lastFinalFallbackAt` 在每次准备调用 finalFallback 时更新，即使调用最终失败也会刷新窗口；
- 窗口状态由 manager 全局共享，不按股票代码或 quote / daily / search 操作隔离。

成功结果写入对应内存缓存；相同 cache key 在缓存 TTL 内不会再次发起远端请求。Phase 1
保留这一既有语义，不把抑制窗口描述成某个具体数据源的冷却窗口。

### 3.4 A 股支持范围写入 adapter

adshare 当前只覆盖 SH / SZ A 股（包含科创板 688xxx 与创业板 300xxx 等深圳子板）。其它股票代码：

- 北交所 `8xxxxx.BJ` → adapter 直接抛 `unsupported_market`，让 manager 把它当成一次失败；
- 港股 `00700.HK`、美股 `AAPL.US` → 同样抛 `unsupported_market`。

manager 不区分 `unsupported_market` 与远端故障，但 adapter 在日志中明确说明“market not supported by adshare”，便于人工排查。

### 3.5 成交量单位按 endpoint 分别处理

adshare 历史上 vol 字段单位不一致：

| endpoint | 内部存储 | 返回单位 | adapter 处理 |
|---|---|---|---|
| `/tushare/stock/daily` | 股（int64） | 手（除以 100） | `vol * 100` 写回 DailyBar |
| `/tushare/realtime/rt_k` | 股 | 股（`vol`） | 直接使用 |

Adapter 内部维护一个 `unitByEndpoint` 表，避免每个调用点重复判断。两个 Tushare endpoint
都返回 `vol`，但单位不同，不能仅凭字段名判断。

### 3.6 复权因子走单独 endpoint

`/daily` 和 `/tushare/stock/daily` 的日线数据本身不包含 `DailyBar.adjFactor`，必须额外请求：

```text
GET /tushare/stock/adj_factor?ts_code=...
```

按 `(ts_code, trade_date)` 与日线 join。Adapter 在 `fetchDailyBars` 内：

1. 请求 stock/daily；
2. 请求 adj_factor；
3. 按 `(ts_code, trade_date)` 合并；
4. 缺复权因子的 bar 用 1.0 占位并打 warn 日志，不让整批失败。

不在 SDK 内做合并。

### 3.7 Adapter 失败必须有可恢复语义

adshare 失败必须保留可检索的错误前缀。Manager 当前不按错误种类分支，只把任意异常视为
该源失败，因此 adapter 统一映射为：

- 网络/超时 → `Error('network/timeout')`；
- HTTP 4xx / 5xx → `Error('http_error')`；
- Schema 解析失败 → `Error('parse_error')`；
- 不支持的市场 → `Error('unsupported_market')`；
- 报价命中但空 → 抛 `not_found`；
- 日线或搜索命中但空 → 返回空数组，由现有调用方按其契约处理。

不抛 `AdshareError` 到 manager；adapter 内部吸收。

### 3.8 不改 core 实体

`Quote` / `DailyBar` / `StockSearchCandidate` 已具备 `source: string`，adapter 直接写 `source: 'adshare'`，不需要新增列。

## 4. 实施基线与已处理缺口

### 4.1 已有能力

| 能力 | 位置 | 现状 |
|---|---|---|
| `MarketDataAdapterLike` | `packages/core/src/context.ts:18-28` | 已有 fetchQuote / batchQuote / fetchDailyBars / searchStocks |
| `MarketDataManager` | `packages/adapters/src/market/manager.ts:57-68` | 已有 `finalFallback` 槽位与 30 分钟抑制窗口 |
| Factory | `packages/adapters/src/market/factory.ts` | 已支持三个真实源的启停与排序 |
| adshare-sdk | `packages/adshare-sdk/src/endpoints/` | 提供 limit-up ladder、`stock_basic` 搜索、`fetchWithAuth` 鉴权 |
| Env 变量 | `.env.example` | `ADSHARE_URL` / `ADSHARE_API_KEY` / `ADSHARE_TIMEOUT_MS` / `ADSHARE_MAX_RETRIES` 已存在 |
| Eastmoney / Tencent adapter | `packages/adapters/src/market/{eastmoney,tencent}.ts` | 已实现的 shape 可直接复用 |
| 缓存与限速 | `packages/adapters/src/market/{cache,manager}.ts` | 60s Quote / 1h DailyBar / 10 rps rate limiter |

### 4.2 Phase 1 已处理的缺口

1. `factory.ts` 已创建 adshare adapter，并按用户配置注入三段路由。
2. adshare SDK 的 `quote.ts` endpoint 与 server 实际路径不一致；Phase 1 改走
   `/tushare/realtime/rt_k`。日线走 `/tushare/stock/daily`，字段名为 `ts_code` /
   `trade_date` / `open` / `high` / `low` / `close` / `vol` / `amount`。
3. `/tushare/stock/daily` 返回 `{code, msg, data: {fields, items}}` envelope，必须按 `data.fields` 动态解析 `items`，不能用现成 `Zod.parse` 直接解析每行。
4. 复权因子通过 `/tushare/stock/adj_factor` 单独请求并在 adapter 内合并。
5. `fetchWithAuth` / `fetchStockBasic` 已从 SDK 根入口导出；adapter 不通过包的
   `exports` 深层导入。
6. Manager 当前不暴露“尝试过哪些源、按什么顺序成功 / 失败”的结构化事件，`stats()` 只给聚合计数。Phase 1 不扩展 manager 接口，仅在 adapter 自身日志中说明。
7. `.env.example` 已增加 `LUOOME_MARKET_SOURCES`，并保留旧开关兼容说明。

## 5. 端到端数据流

```text
Tool（quote / daily / market-view / search_stocks）
  │
  ▼
MarketDataManager.fetchQuote / fetchDailyBars / searchStocks
  │
  ├─ QuoteCache / DailyBarCache 命中 → 直接返回
  │
  ├─ inSuppress ? skip primary/fallback : primary (Eastmoney)
  │       ├─ 成功 → 写缓存 → 返回 source='eastmoney'
  │       └─ 失败 → 继续 fallback
  │
  ├─ inSuppress ? skip : fallback (Tencent)
  │       ├─ 成功 → 写缓存 → 返回 source='tencent'
  │       └─ 失败 → 继续 finalFallback
  │
  ├─ finalFallback (AdshareMarketAdapter)
  │       ├─ AdshareMarketAdapter.fetchQuote
  │       │     ├─ 不支持的市场 → 抛 unsupported_market
  │       │     ├─ fetchWithAuth GET /tushare/realtime/rt_k?ts_code={完整代码}
  │       │     ├─ 解析 Tushare envelope → Quote（price → close，vol=shares）
  │       │     └─ 失败 → 转译为 Error(http/network/parse)
  │       ├─ 成功 → 写缓存 → 返回 source='adshare'
  │       └─ 失败 → 抛 Error，manager 视作最终失败
  │
  └─ 全源失败 → 异常返回调用方
```

抑制窗口内仍会调用 `finalFallback`，只是跳过主备源。`finalFallbackCalls` 在调用前递增，
因此统计的是尝试次数。

AdshareMarketAdapter 内部对 fetchDailyBars 的合并：

```text
AdshareMarketAdapter.fetchDailyBars(code, range)
  ├─ 把 range 拆成 (start_date, end_date)
  ├─ 并发发起：
  │   ├─ 必需：GET /tushare/stock/daily?ts_code=...&start_date=...&end_date=...
  │   └─ 可降级：GET /tushare/stock/adj_factor?ts_code=...&start_date=...&end_date=...
  ├─ daily 失败 → 整体失败
  ├─ adj_factor 失败 → warn，使用空因子集合继续
  ├─ 解析 envelope → rows
  ├─ 单位归一：vol_lots → vol_shares
  ├─ 按 (trade_date) join adj_factor
  ├─ 缺 adj_factor → 1.0 占位 + warn 日志
  ├─ 按 date 升序、去重、丢弃范围外
  └─ 返回 DailyBar[]（source='adshare'）
```

## 6. Adapter 契约

### 6.1 类签名

```ts
export interface AdshareMarketAdapterOptions {
  readonly clock?: () => Date;
  readonly fetchImpl?: typeof fetch;
  readonly logger: Logger;
  /** 由 assembly factory 从 ADSHARE_* 解析后注入。 */
  readonly config: AdshareConfig;
}

export class AdshareMarketAdapter {
  readonly name = 'adshare';
  constructor(options: AdshareMarketAdapterOptions) { ... }
  fetchQuote(stockCode: string): Promise<Quote>;
  batchQuote(stockCodes: readonly string[]): Promise<Map<string, Quote>>;
  fetchDailyBars(stockCode: string, range: DateRange): Promise<DailyBar[]>;
  searchStocks(query: string): Promise<StockSearchCandidate[]>;
}
```

满足 `MarketDataAdapterLike`，可作为 `finalFallback` 注入 manager。

### 6.2 market code 识别

```ts
const SUPPORTED_MARKETS = ['SH', 'SZ'] as const;

function isAdshareSupported(stockCode: string): boolean {
  // '600519.SH' / '000001.SZ' / '300750.SZ' / '688981.SH'
  // '00700.HK' / 'AAPL.US' / '830xxx.BJ' → 拒绝
  const [, suffix] = stockCode.split('.');
  return suffix === 'SH' || suffix === 'SZ';
}
```

不支持的市场抛 `Error('unsupported_market')`，manager 视作一次失败。

### 6.3 配置注入

```ts
import type { AdshareConfig } from '@luoome/adshare-sdk';

const config = options.config;
```

`fromEnv` 已在 adshare-sdk 中实现，但只在 factory 调用一次。Adapter 不读取
`process.env`，测试直接注入 `AdshareConfig`。

### 6.4 fetchQuote

```ts
async fetchQuote(stockCode: string): Promise<Quote> {
  if (!isAdshareSupported(stockCode)) {
    throw new Error(`unsupported_market: ${stockCode}`);
  }
  const tsCode = stockCode.toUpperCase(); // 保留 '600519.SH'
  const params = new URLSearchParams({ ts_code: tsCode });

  const res = await fetchWithAuth(
    `${this.config.url}/tushare/realtime/rt_k?${params}`,
    this.config.apiKey,
    this.fetchImpl,
    { timeoutMs: this.config.timeoutMs, retries: this.config.retries },
  );
  const rows = parseTushareEnvelopeRows(await readJson(res));
  const row = rows[0];
  if (!row) throw new Error(`adshare not_found: ${tsCode}`);
  const parsed = QuoteRowSchema.parse(row);

  return {
    stockId: tsCode,
    // trade_time 缺失时才退回本地抓取时间。
    ts: parsed.tradeTime ?? this.clock(),
    open: parsed.open,
    high: parsed.high,
    low: parsed.low,
    close: parsed.price,
    volume: parsed.vol, // rt_k 的 vol 已是股
    source: 'adshare',
  };
}
```

`QuoteRowSchema` 显式校验 `ts_code` / `trade_time` / `price` / `open` / `high` /
`low` / `vol`；`price` 映射到 `Quote.close`。优先使用远端成交时间，远端缺失时才使用本地
抓取时间。

### 6.5 batchQuote

并行调用 `fetchQuote`，单只失败只丢弃该只，不让批量读路径整体失败：

```ts
async batchQuote(codes: readonly string[]): Promise<Map<string, Quote>> {
  const out = new Map<string, Quote>();
  await Promise.all(codes.map(async (code) => {
    try {
      out.set(code, await this.fetchQuote(code));
    } catch (error) {
      this.logger.warn('adshare.batchQuote omitted', { code, error: errorMessage(error) });
    }
  }));
  return out;
}
```

### 6.6 fetchDailyBars

```ts
async fetchDailyBars(stockCode: string, range: DateRange): Promise<DailyBar[]> {
  if (!isAdshareSupported(stockCode)) throw new Error(`unsupported_market: ${stockCode}`);
  const [code, suffix] = splitCodeSuffix(stockCode);

  const startDate = formatYmd(range.start);
  const endDate = formatYmd(range.end);

  const [dailyResult, adjResult] = await Promise.allSettled([
    fetchWithAuth(
      `${this.config.url}/tushare/stock/daily?${new URLSearchParams({
        ts_code: `${code}.${suffix}`,
        start_date: startDate,
        end_date: endDate,
      })}`,
      this.config.apiKey,
      this.fetchImpl,
      { timeoutMs: this.config.timeoutMs, retries: this.config.retries },
    ),
    fetchWithAuth(
      `${this.config.url}/tushare/stock/adj_factor?${new URLSearchParams({
        ts_code: `${code}.${suffix}`,
        start_date: startDate,
        end_date: endDate,
      })}`,
      this.config.apiKey,
      this.fetchImpl,
      { timeoutMs: this.config.timeoutMs, retries: this.config.retries },
    ),
  ]);

  if (dailyResult.status === 'rejected') {
    throw translateAdshareError(dailyResult.reason);
  }
  const dailyRows = parseTushareEnvelopeRows(await readJson(dailyResult.value));
  let adjRows: Array<Record<string, unknown>> = [];
  if (adjResult.status === 'fulfilled') {
    try {
      adjRows = parseTushareEnvelopeRows(await readJson(adjResult.value));
    } catch (error) {
      this.logger.warn('adshare.fetchDailyBars adj_factor parse failed', {
        stockCode,
        error: errorMessage(error),
      });
    }
  }
  if (adjResult.status === 'rejected') {
    this.logger.warn('adshare.fetchDailyBars adj_factor request failed', {
      stockCode,
      error: errorMessage(adjResult.reason),
    });
  }

  const adjByDate = new Map<string, number>();
  for (const row of adjRows) {
    const date = normalizeTradeDate(row.trade_date);
    if (date !== null && typeof row.adj_factor === 'number') {
      adjByDate.set(date, row.adj_factor);
    }
  }

  const bars: DailyBar[] = [];
  for (const row of dailyRows) {
    // server 可能把 YYYYMMDD 序列化为 number 或 string。
    const date = normalizeTradeDate(row.trade_date);
    if (date === null) continue;
    const adj = adjByDate.get(date);
    const adjFactor = adj ?? 1.0;
    if (adj === undefined) {
      this.logger.warn('adshare.fetchDailyBars adj_factor missing', { stockCode, date });
    }
    bars.push({
      stockId: stockCode,
      date: parseYmd(date), // UTC 00:00
      open: asMoney(row.open),
      high: asMoney(row.high),
      low: asMoney(row.low),
      close: asMoney(row.close),
      volume: asShares(row.vol), // unit=lots → shares
      adjFactor,
      source: 'adshare',
    });
  }

  return bars
    .filter((b) => b.date >= range.start && b.date <= range.end)
    .sort((a, b) => a.date.getTime() - b.date.getTime());
}
```

`normalizeTradeDate` 同时接受八位数字和八位字符串，输出规范化 `YYYYMMDD`；其它输入返回
`null`。`asShares` 内部使用 core 的 `brandQuantity`，价格使用 `money`，并拒绝非有限值、
负成交量和非正价格。

### 6.7 searchStocks

复用 SDK `fetchStockBasic`：

```ts
async searchStocks(query: string): Promise<StockSearchCandidate[]> {
  if (!query.trim()) return [];
  const rows = await fetchStockBasic(
    this.config.url,
    this.config.apiKey,
    this.fetchImpl,
    { name: query, fields: ['ts_code', 'name', 'exchange'], limit: 20 },
    { timeoutMs: this.config.timeoutMs, retries: this.config.retries },
  );
  return rows.flatMap((row) => {
    const exchange = row.exchange === 'SSE'
      ? 'SH'
      : row.exchange === 'SZSE'
        ? 'SZ'
        : null;
    if (exchange === null) {
      return []; // adshare 不支持的市场从搜索结果剔除
    }
    return [{
      id: row.ts_code,
      code: row.ts_code.split('.')[0],
      exchange,
      name: row.name,
    }];
  });
}
```

Adshare `stock_basic.exchange` 使用 `SSE` / `SZSE`，adapter 显式映射为 core 的 `SH` /
`SZ`。其它交易所结果被剔除，避免把 HK / US / BJ 漏到下游。

### 6.8 envelope 解析

```ts
const TushareEnvelopeSchema = z.object({
  code: z.number().int(),
  msg: z.string().optional().default(''),
  data: z.object({
    fields: z.array(z.string()),
    items: z.array(z.array(z.unknown())),
  }),
});

function parseTushareEnvelopeRows(raw: unknown): Array<Record<string, unknown>> {
  const env = TushareEnvelopeSchema.parse(raw);
  if (env.code !== 0) {
    throw new Error(`adshare upstream_error: ${env.code} ${env.msg}`);
  }
  return env.data.items.map((row) => {
    if (row.length !== env.data.fields.length) {
      throw new Error('adshare parse: fields/items length mismatch');
    }
    const obj: Record<string, unknown> = {};
    env.data.fields.forEach((field, i) => {
      obj[field] = row[i];
    });
    return obj;
  });
}
```

集中放在 `packages/adapters/src/market/adshare-envelope.ts`，方便单测。该 helper 只接受
Adshare Tushare REST 的唯一协议 `{code, msg, data: {fields, items}}`，不为对象数组或无
字段名的纯数组增加宽松兼容。`/realtime/quote/{code}` 若未来接入，应使用独立 schema。

### 6.9 错误转译

```ts
function translateAdshareError(error: unknown): Error {
  if (error instanceof AdshareError) {
    switch (error.code) {
      case 'NETWORK_ERROR':
      case 'TIMEOUT': return new Error(`adshare network: ${error.message}`);
      case 'HTTP_ERROR': return new Error(`adshare http: ${error.message}`);
      case 'PARSE_ERROR': return new Error(`adshare parse: ${error.message}`);
      case 'NOT_FOUND': return new Error(`adshare not_found: ${error.message}`);
      case 'INVALID_INPUT': return new Error(`adshare invalid_input: ${error.message}`);
      default: return new Error(`adshare unknown: ${error.message}`);
    }
  }
  if (error instanceof ZodError) return new Error(`adshare parse: ${error.message}`);
  return error instanceof Error ? error : new Error(String(error));
}
```

manager 不感知 `AdshareError`，只接 `Error`。wrap 后的字符串前缀 `adshare ...` 便于日志检索。

## 7. Factory 接线

`packages/adapters/src/market/factory.ts` 公开 `MarketSourceIdSchema`、
`MarketSourceOrderSchema` 与 `marketSourceOrderFromEnv`。factory 读取
`LUOOME_MARKET_SOURCES`，按逗号切分并校验：

- 可选值只有 `eastmoney`、`tencent`、`adshare`；
- 至少一个、最多三个，不允许重复；
- 从左到右分别占据 primary、fallback、finalFallback；
- 只启用一个源时使用内部 disabled adapter 占据必需的 fallback 端口，真实请求失败仍按
  “全源失败”返回，不生成合成行情；
- 显式启用 Adshare 但缺少 `ADSHARE_URL` 时快速失败，避免界面显示已启用但运行时静默跳过。

未设置新变量时默认 Eastmoney → Tencent；为兼容已有部署，
`LUOOME_MARKET_ADSHARE=true` 会在默认链末尾追加 Adshare。各 surface 只把自己的 env
传给 factory，不再分别解析开关。

### 7.1 Web 设置与热更新

Web 的 `/api/settings/market` 提供运行时配置：

- GET 返回全部源的启用状态、优先级与 `configured` 状态，不返回 API key；
- POST 接收 `{ sources: MarketSourceId[] }`，受 mutation token 和同源 Origin 保护；
- 服务端先用候选配置构造完整 adapter，成功后再原子写入 `$LUOOME_HOME/.env`；
- 文件权限保持 `0600`，随后替换 `ctxRef.current.adapters.market`，当前进程立即生效；
- Adshare 未配置 URL 时在界面中不可启用；Eastmoney 与 Tencent 无额外配置要求。

## 8. Core / SDK / DB 演进

### 8.1 Core

不修改 `core`。`Quote` / `DailyBar` / `StockSearchCandidate` 已具备 `source: string`，adapter 直接写 `'adshare'`。

### 8.2 adshare-sdk

Phase 1 不修改 SDK endpoint 实现文件。修改 `packages/adshare-sdk/src/index.ts`，从包级
入口公开导出：

- `fetchWithAuth`（鉴权 / 超时 / 重试）；
- `fetchStockBasic`（股票搜索）；
- `fromEnv`（env 解析）。

Phase 2 候选：在 SDK 内增加 `fetchTushareDaily` / `fetchTushareAdjFactor` /
`fetchRealtimeQuote`，把 envelope 解析与 unit 归一集中到 SDK。Phase 1 不做。

### 8.3 DB

不修改 `db`。Manager 只写内存缓存，不直接写 repository。需要持久化日线的现有 tool
（例如 `get_stock_market_view`）继续调用 `DailyBarRepository.saveMany`，并按每根 bar 的
`source` 落库。实时报价当前没有通用 repository 写路径。

### 8.4 Adapter 测试夹具

复用 `packages/adapters/src/testing/fake-market.ts` 的 `FakeMarketAdapter`，通过
`source: 'adshare'` 构造 finalFallback 测试替身，不新增与真实 adapter 类耦合的专用 fake：

```ts
const finalFallback = new FakeMarketAdapter({ source: 'adshare', clock });
```

manager-resilience / search 测试用该实例验证 finalFallback 路径；adapter 自身协议测试仍
通过 `fetchImpl` stub 验证，不依赖网络。

## 9. 日志与可观测性

manager 已有 `ManagerStats`：

```ts
{
  primaryCalls, primaryFailures,
  fallbackCalls, fallbackFailures,
  finalFallbackCalls,
  cache: { quote, dailyBar },
}
```

本设计不扩展 manager 接口。`finalFallbackCalls` 在实际调用前递增，表示尝试次数，不表示
Adshare 成功次数。Manager 已记录主源 / 备源失败和“准备使用 final source”；Adshare
adapter 在成功解析后补充 operation 级成功日志：

```ts
logger.warn('adshare.fetchQuote failed', { stockCode, kind: 'network' | 'http' | 'parse' | 'unsupported_market' });
logger.warn('adshare.fetchDailyBars adj_factor missing', { stockCode, date });
logger.info('adshare.fetchQuote ok', { stockCode, source: 'adshare' });
logger.info('adshare.fetchDailyBars ok', { stockCode, source: 'adshare', count: bars.length });
```

`stats().finalFallbackCalls > 0` 只能作为“第三源被尝试过”的检测信号。成功使用以返回对象的
`source === 'adshare'` 或上述成功日志为准。若后续需要稳定的成功率 / 失败率 metric，应另行
扩展 `ManagerStats`，不从调用次数反推。

## 10. 安全与副作用

- 不引入新 IO 类型；adapter 仍然只是 `fetch + Zod`，与现有 adapter 形态一致。
- adshare 返回的 stockId / code / name / industry 都按 Zod schema 严格校验，不直接传 DOM / shell / SQL。
- 不在 adapter 内记录 API key；`AdshareError` 默认 message 不含 key，但日志仍要确保不打印 `config.apiKey`。
- 不写 `Trade` / `Advice` / `WatchTrigger`；adapter 本身不持久化，只由 manager 写行情内存
  缓存，需要落库的 tool 继续走既有 repository。
- 不引入自动交易路径；与现有 `advice ≠ trade` 边界保持一致。
- 不引入 WebSocket / SSE；虽然 adshare 提供推送能力，Phase 1 为保持
  `MarketDataAdapterLike` 的请求式契约只走 REST pull。

## 11. 测试与验收

### 11.1 单元测试（adapter）

`packages/adapters/src/market/adshare.test.ts` 覆盖：

1. 不支持的市场（HK / US / BJ）抛 `unsupported_market`；
2. `fetchQuote` 正常响应 → 使用完整 `ts_code` 请求 `rt_k`，把 `price` 映射为 close、
   `vol` 映射为 shares、优先使用远端 `trade_time`，返回 source='adshare'；
3. `fetchQuote` 4xx → 转译为 http 错误；
4. `fetchQuote` 5xx → 重试耗尽后抛错；
5. `fetchQuote` 网络错误 → 转译为 network 错误；
6. `fetchQuote` envelope code≠0 → 抛错；
7. `fetchQuote` items 为空 → 抛 not_found；
8. `fetchDailyBars` 日线 + 复权因子都成功 → 按 trade_date 合并、vol × 100、缺因子 1.0 占位；
9. `fetchDailyBars` 复权因子完全缺失 → 不抛错，warn 日志，全部 1.0；
10. `fetchDailyBars` 复权因子请求或 envelope 解析失败 → 日线仍返回，warn 日志；
11. `fetchDailyBars` 日线成功但越界 → 范围外 bar 丢弃；
12. `batchQuote` 部分失败 → 只保留成功项；
13. `searchStocks` 把 `SSE` / `SZSE` 映射为 `SH` / `SZ`，并剔除其它交易所候选；
14. `searchStocks` 空 query → 空数组；
15. envelope 解析接受 `{code, msg, data: {fields, items}}`，拒绝 code≠0、行列数量不符及
    其它响应形态；
16. 错误转译覆盖 `AdshareError` 全部 `code`；
17. 配置缺失 `ADSHARE_API_KEY` → 不抛错，传空串（与 server 容忍策略一致）。

### 11.2 集成测试（manager）

`packages/adapters/src/market/manager-resilience.test.ts` 增加：

1. Eastmoney + Tencent 都失败、adshare 成功 → 返回 adshare 数据，source='adshare'；
2. Eastmoney + Tencent 都失败、adshare 也失败 → 抛错；
3. 首次进入 finalFallback 后 30 分钟内跳过 Eastmoney / Tencent，并对后续未命中缓存的
   请求直接调用 adshare；
4. Eastmoney + Tencent 成功时 finalFallbackCalls = 0；
5. `searchStocks` 主源返回空数组 → 不触发 fallback 到 adshare；
6. `searchStocks` 主源抛错 → 触发 fallback 到 adshare。

### 11.3 合约测试（fake adapter）

复用 `packages/adapters/src/testing/fake-market.ts` 的 `FakeMarketAdapter`，设置
`source: 'adshare'` 后验证 finalFallback 的 `fetchQuote` / `batchQuote` /
`fetchDailyBars` / `searchStocks` 形状稳定。Adshare 私有协议由 adapter 单元测试负责。

### 11.4 命令

开发中：

```bash
bun test packages/adapters/src/market/adshare.test.ts
bun test packages/adapters/src/market/manager-resilience.test.ts
bun test packages/adapters/src/testing
```

交付前：

```bash
bun run typecheck
bun run test:all
bun run lint
bun run build
```

### 11.5 端到端验收

1. 确认 `ADSHARE_URL` / `ADSHARE_API_KEY` 已填，并在 Web 设置页启用 Adshare、调整优先级；
2. 启动 adshare：`curl -fsS $ADSHARE_URL/health` 期望 200；
3. 启动 web，访问行情页搜索 `002594`（比亚迪）；
4. 把 Eastmoney 调为第一优先级，行情正常显示 source='东方财富'；
5. 把 Adshare 调为第一优先级，刷新行情页 → 应展示 source='adshare' 的报价；
6. 同时屏蔽 adshare → 应展示“数据不可用”提示，不暴露价格 0；
7. CLI：`luoome tools list` 中既有行情 tool 仍被注册；实际调用返回数据的
   `source='adshare'`，日志记录 Adshare 成功；
8. MCP：调用同一 tool，adshare 链路可被 MCP 触发；
9. 在设置页关闭 Adshare → 路由立即恢复为其余启用源，刷新后配置仍保留。

## 12. 分阶段实施

### Phase 1：最小可用接线

1. 新建 `packages/adapters/src/market/adshare.ts` 与 `adshare-envelope.ts`；
2. 新建 `packages/adapters/src/market/adshare.test.ts`；
3. 在 `packages/adshare-sdk/src/index.ts` 公开导出 `fetchWithAuth` / `fetchStockBasic`；
4. 复用 `packages/adapters/src/testing/fake-market.ts` 的可配置 source；
5. 改造 `factory.ts`：解析并校验可排序的数据源列表；
6. Web 设置页提供启停、排序、持久化与运行时热更新；
7. 更新 `.env.example` 并兼容旧 `LUOOME_MARKET_ADSHARE`；
8. manager-resilience 测试覆盖 finalFallback 的既有主备抑制语义；
9. API、界面与端到端验收。

完成标准：adshare 能在 Eastmoney / Tencent 不可达时提供 A 股实时快照与日 K，source
字段正确；进入抑制窗口后，未命中缓存的请求跳过主备源并直达 Adshare。

### Phase 2：SDK 沉淀（独立设计）

1. 在 adshare-sdk 内增加 `fetchTushareDaily` / `fetchTushareAdjFactor` / `fetchRealtimeQuote`；
2. 把 envelope 解析与 unit 归一集中到 SDK；
3. adapter 改为调用 SDK 新增方法，行为不变；
4. SDK 自身增加单元测试；
5. 同步更新 adshare 集成手册。

完成标准：adapter 文件不再包含 adshare 私有字段名（如 `vol_lots` / `adj_factor`），相关 helper 全部下沉到 SDK。

### Phase 3：跨市场候选

若 adshare 后续接入 HK / US / BJ，单独设计：

1. market code 识别表扩展；
2. 各市场的 trading calendar 与 market session 语义；
3. `StockSearchCandidate` 仍走同一形状；
4. 单元 / 集成测试扩展。

不在本设计范围。

## 13. 文件变更清单

预计涉及：

```text
packages/adapters/src/market/adshare.ts              (new)
packages/adapters/src/market/adshare-envelope.ts    (new)
packages/adapters/src/market/adshare.test.ts        (new)
packages/adapters/src/market/manager-resilience.test.ts
packages/adapters/src/market/factory.ts
packages/adshare-sdk/src/index.ts
packages/cli/src/context.ts
packages/tui/src/index.ts
packages/mcp/src/context.ts
apps/web/src/server.ts
.env.example
docs/README.md                                       (索引新增)
```

不动：

```text
packages/core/src/entity/quote.ts
packages/core/src/context.ts
packages/adshare-sdk/src/endpoints/*                (Phase 1 仅从 index 公开 helper；
                                                     fetchWithAuth 移除 GET 的 Content-Type 头，见 §3.2 实测修正)
packages/db/src/repository/**                        (复用现有 upsert)
```

## 14. 验收原则

- adshare 是可排序的真实行情源，缺省关闭；启用后可位于三段路由任意位置；
- 不动 core 实体；`source='adshare'` 由 adapter 直接写入；
- 不动 adshare-sdk 现有 endpoint 实现；仅补包级导出并复用 SDK 鉴权 / env 解析；
- A 股覆盖范围显式声明；HK / US / BJ 由 adapter 拒绝而非静默失败；
- 成交量单位按 endpoint 分别归一为股；
- 复权因子走单独 endpoint，缺失不阻塞整批；
- manager 不感知 `AdshareError`，错误统一前缀 `adshare ...`；
- 不引入自动交易、不写入 Trade / Advice / WatchTrigger；
- 抑制窗口沿用“窗口内跳过主备、直达第三源”的现有语义，不宣称它会冷却 Adshare；
- `finalFallbackCalls` 表示尝试次数，Adshare 成功以返回 source 或成功日志为准；
- 所有改动配套 unit / 集成 / 端到端三类验收；
- 未启用 adshare 时不要求配置；显式启用但缺少 URL 时拒绝保存或启动，避免静默错配。
