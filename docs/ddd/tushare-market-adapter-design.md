# Tushare 行情适配器详细设计

> 状态：已实施（2026-07-27）
> 日期：2026-07-27
> 范围：直连 tushare 官方 HTTP API，使其成为 Eastmoney / Tencent 之外的第三个真实行情源
> 关联文档：[架构说明 §4.7](../ARCHITECTURE.md)、[个股行情查看详细设计](./stock-market-view-detailed-design.md)、[Tushare 集成手册](../runbooks/tushare-integration.md)
> 说明：本文档替代原 [adshare 设计]（已删除）——adshare 私有代理服务已整体移除，传输层由 adshare `GET /tushare/*` + 双认证头改为 tushare 官方 POST envelope，环境变量由 `ADSHARE_*` 改为 `TUSHARE_*`。领域语义（第三真实源契约、字段映射、复权因子合并、vol 手→股、市场范围、错误转译）保持不变。

## 1. 目标

把 tushare 作为 luoome 通用行情链路上的第三个真实数据源，使用现有 `MarketDataAdapterLike` 契约：

- 注册为可排序的数据源；默认关闭，启用后可占据 `primary`、`fallback` 或
  `finalFallback` 槽位；
- 同时具备 `fetchQuote` / `batchQuote` / `fetchDailyBars` / `searchStocks` 四个能力；
- 与 Eastmoney / Tencent 共享 `Quote` / `DailyBar` / `StockSearchCandidate` 形状，统一进入现有缓存；需要持久化的 tool 继续按既有职责写 repository；
- A 股场景下允许用户配置一至三个真实源的启用状态与优先级，保留现有降级语义与抑制窗口。

完成后，返回数据与日志必须记录 source 名 `tushare`；`MarketDataManager.stats()` 的
`finalFallbackCalls` 继续表示第三源**尝试次数**，不把它解释为成功次数。`luoome tools list`
只验证既有行情 tool 仍被注册，不承担运行时数据源观测职责。

## 2. 非目标

本设计不实现：

- 港股 / 美股 / 北交所 / 加密资产。adapter 只覆盖 SH / SZ A 股，其它市场不在支持范围。
- 分钟 K 线、复盘分钟行情、分时图。本设计仅对齐日 K 与实时快照，分钟行情另有独立设计。
- 自动交易、盯盘触发、Advice 联动。本设计只做读取。
- tushare 积分 / 权限体系的自动检测。接口权限不足统一按 `upstream_error` 走既有降级，
  人工处理见集成手册。

## 3. 已确认决策

### 3.1 直连 tushare 官方 HTTP API，单一 POST 协议

不再经过任何私有代理。所有接口共用一个传输形态（[协议文档 doc_id=130](https://tushare.pro/document/1?doc_id=130)）：

```text
POST ${TUSHARE_URL 或默认 http://api.tushare.pro}
Content-Type: application/json

{"api_name": "...", "token": "...", "params": {...}, "fields": "..."}
→ {"code": 0, "msg": "", "data": {"fields": [...], "items": [[...], ...]}}
```

客户端 `tushareQuery`（`packages/adapters/src/tushare/client.ts`）统一处理：

- token 随 POST body 发送，不使用认证头；
- `AbortController` 超时 10s；
- 仅 5xx 与网络错误重试（指数退避 `200ms × 2^attempt`，最多 2 次），4xx 直接抛错；
- 错误统一为带 `tushare ...` 前缀的普通 `Error`，不引入额外错误类。

各能力的 `api_name` 映射：

| 能力 | api_name | 备注 |
|---|---|---|
| `fetchQuote` | `rt_k` | 实时 Level-1 快照，price 即最新价，vol 单位=股；**需单独开通权限**（[doc_id=290](https://tushare.pro/document/1?doc_id=290)） |
| `fetchDailyBars` | `daily` + `adj_factor` | 日线 vol 单位=手；复权因子单独请求并合并；均需 2000 积分起 |
| `searchStocks` | `stock_basic` | `exchange` 用 `SSE` / `SZSE`；客户端截断 20 条 |

### 3.2 Adapter 进入可配置的三段行情路由

`MarketDataManager` 已经有 primary、fallback、finalFallback 槽位与 30 分钟抑制窗口。
`LUOOME_MARKET_SOURCES` 从左到右把启用源映射到这些槽位，数据源可选
`eastmoney`、`tencent`、`tushare`，至少启用一个且不得重复。缺省顺序仍是
Eastmoney → Tencent；显式启用 Tushare 后，它可以处于任意优先级。

现有 `finalFallbackSuppressMs` 是**主备源抑制窗口**，不是 Tushare 自身冷却窗口：

- 窗口外：按配置依次尝试 primary → fallback → finalFallback；
- 窗口内：跳过前两个槽位，直接调用 finalFallback；
- 每个 key（股票代码；搜索按 query）的窗口时间在每次准备调用 finalFallback 时更新，
  即使调用最终失败也会刷新该 key 的窗口；
- 窗口按 key 隔离：某只股票启用第三源只抑制该股票，不再全局熔断整个股票池
  （避免一只港股 / 故障股把全池打进第三源 30 分钟）。

成功结果写入对应内存缓存；相同 cache key 在缓存 TTL 内不会再次发起远端请求。本设计
保留这一既有语义，不把抑制窗口描述成某个具体数据源的冷却窗口。

### 3.3 A 股支持范围写入 adapter

adapter 只覆盖 SH / SZ A 股（包含科创板 688xxx 与创业板 300xxx 等深圳子板）。其它股票代码：

- 北交所 `8xxxxx.BJ` → adapter 直接抛 `unsupported_market`，让 manager 把它当成一次失败；
- 港股 `00700.HK`、美股 `AAPL.US` → 同样抛 `unsupported_market`。

manager 不区分 `unsupported_market` 与远端故障，但 adapter 在日志中明确说明“market not supported by tushare”，便于人工排查。

### 3.4 成交量单位按接口分别处理

tushare 各接口 vol 字段单位不一致：

| api_name | 返回单位 | adapter 处理 |
|---|---|---|
| `daily` | 手 | `vol × 100` 写回 DailyBar |
| `rt_k` | 股 | 直接使用 |

不能仅凭字段名判断单位；归一逻辑固定在 `fetchQuote` / `fetchDailyBars` 各自的映射处。

### 3.5 复权因子走单独接口

`daily` 的日线数据本身不包含 `DailyBar.adjFactor`，必须额外请求：

```text
POST {"api_name": "adj_factor", "params": {"ts_code": "...", "end_date": "..."}}
```

`adj_factor` 不带 `start_date` 取全量历史（≤ end_date）：官方源按交易日逐日返回，但部分代理
网关只返回因子变动日的稀疏行。Adapter 在 `fetchDailyBars` 内：

1. 并发请求 `daily` 与 `adj_factor`；任一失败 → 整体失败；
2. 因子行过滤为有效变动点（有限且 > 0）并按日期升序；
3. 每个 bar 日的当日因子 = 最后一个 ≤ 当日的变动点因子（前向填充；密集逐日源等价于精确匹配）；
4. qfq 换算：`ratio = 当日因子 / 最新变动点因子`，OHLC × ratio；
5. 因子完全缺失，或 bar 日早于首个变动日 → 抛 `unsupported_adjustment` 走降级。

### 3.6 Adapter 失败必须有可恢复语义

tushare 失败必须保留可检索的错误前缀。Manager 当前不按错误种类分支，只把任意异常视为
该源失败，因此 adapter 统一映射为普通 `Error`：

- 网络 → `tushare network: ...`；
- 超时 → `tushare timeout: ...`；
- HTTP 4xx / 5xx → `tushare http: ...`；
- envelope `code≠0` → `tushare upstream_error: <code> <msg>`（token / 积分 / 权限问题都在这里，常见 2002）；
- Schema 解析失败 → `tushare parse: ...`；
- 不支持的市场 → `unsupported_market: <code>`；
- 报价命中但空（多为远端限流 / 抖动的瞬时空响应）→ 原地重试一次，仍空抛 `tushare no_data: <code>`；
- 报价行 OHLC 全零（盘前 / 停牌尚无成交，`rt_k` 返回全 0）→ 抛 `tushare no_data: <code>`，走既有降级链，不进入 Zod 校验；
- 日线或搜索命中但空 → 返回空数组，由现有调用方按其契约处理。

### 3.7 不改 core 实体

`Quote` / `DailyBar` / `StockSearchCandidate` 已具备 `source: string`，adapter 直接写 `source: 'tushare'`，不需要新增列。

## 4. 端到端数据流

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
  ├─ finalFallback (TushareMarketAdapter)
  │       ├─ TushareMarketAdapter.fetchQuote
  │       │     ├─ 不支持的市场 → 抛 unsupported_market
  │       │     ├─ tushareQuery('rt_k', {ts_code: 完整代码})
  │       │     ├─ 解析 envelope → Quote（price 即最新价，vol=shares）
  │       │     └─ 失败 → 转译为 Error(tushare network/timeout/http/upstream_error/parse)
  │       ├─ 成功 → 写缓存 → 返回 source='tushare'
  │       └─ 失败 → 抛 Error，manager 视作最终失败
  │
  └─ 全源失败 → 异常返回调用方
```

抑制窗口内仍会调用 `finalFallback`，只是跳过主备源。`finalFallbackCalls` 在调用前递增，
因此统计的是尝试次数。

TushareMarketAdapter 内部对 fetchDailyBars 的合并：

```text
TushareMarketAdapter.fetchDailyBars(code, range)
  ├─ 把 range 拆成 (start_date, end_date)
  ├─ 并发发起：
  │   ├─ 必需：tushareQuery('daily', {ts_code, start_date, end_date})
  │   └─ 必需：tushareQuery('adj_factor', {ts_code, end_date})（全量历史）
  ├─ daily / adj_factor 任一失败 → 整体失败
  ├─ 解析 envelope → rows
  ├─ 单位归一：vol 手 → 股（×100）
  ├─ 因子变动点前向填充出逐日因子，OHLC ×（当日因子 / 最新因子）换算 qfq
  ├─ 因子完全缺失或 bar 日早于首个变动日 → unsupported_adjustment
  ├─ 按 date 升序、去重、丢弃范围外
  └─ 返回 DailyBar[]（source='tushare'）
```

## 5. Adapter 契约

### 5.1 类签名

```ts
export interface TushareMarketAdapterOptions {
  readonly clock?: () => Date;
  readonly fetchImpl?: typeof fetch;
  readonly logger: Logger;
  /** 由 assembly factory 从 TUSHARE_* 解析后注入；adapter 不读 process.env。 */
  readonly config: TushareConfig;
}

export class TushareMarketAdapter {
  readonly name = 'tushare';
  constructor(options: TushareMarketAdapterOptions) { ... }
  fetchQuote(stockCode: string): Promise<Quote>;
  batchQuote(stockCodes: readonly string[]): Promise<Map<string, Quote>>;
  fetchDailyBars(stockCode: string, range: DateRange): Promise<DailyBar[]>;
  searchStocks(query: string): Promise<StockSearchCandidate[]>;
}
```

满足 `MarketDataAdapterLike`，可作为任意槽位注入 manager。实现在
`packages/adapters/src/market/tushare.ts`。

### 5.2 market code 识别

```ts
const isTushareSupported = (stockCode: string): boolean => {
  // '600519.SH' / '000001.SZ' / '300750.SZ' / '688981.SH'
  // '00700.HK' / 'AAPL.US' / '830xxx.BJ' → 拒绝
  const [, suffix] = stockCode.toUpperCase().trim().split('.');
  return suffix === 'SH' || suffix === 'SZ';
};
```

不支持的市场抛 `Error('unsupported_market')`，manager 视作一次失败。

### 5.3 配置注入

```ts
export interface TushareConfig {
  /** API 地址；默认 http://api.tushare.pro（可用 TUSHARE_URL 覆盖，如代理网关）。 */
  readonly url: string;
  readonly token: string;
  readonly timeoutMs: number; // 固定 10_000
  readonly retries: number;   // 固定 2
}
```

`tushareConfigFromEnv` 在 `packages/adapters/src/tushare/client.ts` 中实现，`TUSHARE_TOKEN`
缺失即抛错；只在 factory 调用一次。Adapter 不读取 `process.env`，测试直接注入
`TushareConfig`。

### 5.4 fetchQuote

```ts
async fetchQuote(stockCode: string): Promise<Quote> {
  if (!isTushareSupported(stockCode)) {
    throw new Error(`unsupported_market: ${stockCode}`);
  }
  const tsCode = stockCode.toUpperCase(); // 保留完整 '600519.SH'

  const rows = await tushareQuery(
    'rt_k',
    { ts_code: tsCode },
    this.config,
    this.fetchImpl,
    ['ts_code', 'trade_time', 'open', 'high', 'low', 'price', 'vol'],
  );
  const row = rows[0];
  if (row === undefined) throw new Error(`tushare not_found: ${tsCode}`);
  // rt_k 盘前 / 停牌尚未有成交时价格全 0：不是合法 Quote，按无数据抛错走降级。
  if (isZeroQuoteRow(row)) throw new Error(`tushare no_data: ${tsCode} 快照价格全零`);
  const parsed = QuoteRowSchema.parse(row);

  return {
    stockId: tsCode,
    // trade_time 缺失或不可解析时才退回本地抓取时间。
    ts: parseTradeTime(parsed.trade_time) ?? this.clock(),
    open: money(parsed.open),
    high: money(parsed.high),
    low: money(parsed.low),
    close: money(parsed.price), // rt_k 的 price 即最新价（接口没有 close 列）
    volume: parsed.vol,         // rt_k 的 vol 已是股
    source: 'tushare',
  };
}
```

`QuoteRowSchema` 显式校验 `ts_code` / `trade_time` / `open` / `high` / `low` / `price` /
`vol`；`price` 映射到 `Quote.close`。注意 `rt_k` 的最新价列名是 `price`，请求 `close`
会被接口静默丢弃（盘中响应缺列，盘前则返回全零行）——这是实盘踩过的坑。优先使用
远端成交时间（无时区按 +08:00 解释），远端缺失或不可解析时才使用本地抓取时间。

### 5.5 batchQuote

并行调用 `fetchQuote`，单只失败只丢弃该只，不让批量读路径整体失败：

```ts
async batchQuote(codes: readonly string[]): Promise<Map<string, Quote>> {
  const out = new Map<string, Quote>();
  await Promise.all(codes.map(async (code) => {
    try {
      out.set(code, await this.fetchQuote(code));
    } catch (error) {
      this.logger.warn('tushare.batchQuote omitted', { code, error: errorMessage(error) });
    }
  }));
  return out;
}
```

### 5.6 fetchDailyBars

```ts
async fetchDailyBars(stockCode: string, range: DateRange): Promise<DailyBar[]> {
  if (!isTushareSupported(stockCode)) throw new Error(`unsupported_market: ${stockCode}`);
  const tsCode = stockCode.toUpperCase();
  const startDate = formatYmd(range.start);
  const endDate = formatYmd(range.end);

  // 日线必需、复权因子可降级：并发发起，adj_factor 失败只降级不整批失败。
  const [dailyResult, adjResult] = await Promise.allSettled([
    tushareQuery('daily', { ts_code: tsCode, start_date: startDate, end_date: endDate },
      this.config, this.fetchImpl,
      ['ts_code', 'trade_date', 'open', 'high', 'low', 'close', 'vol']),
    tushareQuery('adj_factor', { ts_code: tsCode, start_date: startDate, end_date: endDate },
      this.config, this.fetchImpl,
      ['ts_code', 'trade_date', 'adj_factor']),
  ]);

  if (dailyResult.status === 'rejected') throw dailyResult.reason;
  const dailyRows = dailyResult.value;

  let adjRows: Array<Record<string, unknown>> = [];
  if (adjResult.status === 'fulfilled') {
    adjRows = adjResult.value;
  } else {
    this.logger.warn('tushare.fetchDailyBars adj_factor request failed', {
      stockCode: tsCode, error: errorMessage(adjResult.reason),
    });
  }

  const adjByDate = new Map<string, number>();
  for (const row of adjRows) {
    const date = normalizeTradeDate(row.trade_date);
    if (date !== null && typeof row.adj_factor === 'number'
        && Number.isFinite(row.adj_factor) && row.adj_factor > 0) {
      adjByDate.set(date, row.adj_factor);
    }
  }

  const bars: DailyBar[] = [];
  for (const row of dailyRows) {
    // server 可能把 YYYYMMDD 序列化为 number 或 string。
    const date = normalizeTradeDate(row.trade_date);
    if (date === null) continue;
    const adj = adjByDate.get(date);
    if (adj === undefined) {
      this.logger.warn('tushare.fetchDailyBars adj_factor missing', { stockCode: tsCode, date });
    }
    bars.push({
      stockId: tsCode,
      date: parseYmd(date), // UTC 00:00
      open: asMoney(row.open),
      high: asMoney(row.high),
      low: asMoney(row.low),
      close: asMoney(row.close),
      volume: asShares(row.vol), // unit=lots → shares（×100）
      adjFactor: adj ?? 1.0,
      source: 'tushare',
    });
  }

  return bars
    .filter((b) => b.date >= range.start && b.date <= range.end)
    .sort((a, b) => a.date.getTime() - b.date.getTime());
}
```

`normalizeTradeDate` 同时接受八位数字和八位字符串，输出规范化 `YYYYMMDD`；其它输入返回
`null`。`asShares` 内部使用 core 的 `brandQuantity`，价格使用 `money`，并拒绝非有限值、
负成交量和非正价格（不合规行整行丢弃）。

### 5.7 searchStocks

```ts
async searchStocks(query: string): Promise<StockSearchCandidate[]> {
  const normalized = query.trim().toUpperCase();
  if (!normalized) return [];
  const tsCode = normalizeSearchTsCode(normalized);
  const rows = await tushareQuery(
    'stock_basic',
    tsCode === null ? { name: normalized } : { ts_code: tsCode },
    this.config,
    this.fetchImpl,
    ['ts_code', 'name', 'exchange'],
  );
  return rows.slice(0, 20).flatMap((row) => {
    const exchange = row.exchange === 'SSE'
      ? 'SH'
      : row.exchange === 'SZSE'
        ? 'SZ'
        : null;
    if (exchange === null) {
      return []; // 不支持的市场从搜索结果剔除
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

查询是完整 `000001.SZ` / 可推断交易所的六位代码（5/6/9 开头 → SH，0/1/2/3 开头 → SZ）时按
`ts_code` 精确查，否则按 `name` 模糊查。tushare `stock_basic.exchange` 使用 `SSE` /
`SZSE`，adapter 显式映射为 core 的 `SH` / `SZ`。其它交易所结果被剔除，避免把 HK / US /
BJ 漏到下游；结果在客户端截断为 20 条。

### 5.8 envelope 解析

```ts
const TushareEnvelopeSchema = z.object({
  code: z.number().int(),
  msg: z.string().nullish().default(''),
  data: z.object({
    fields: z.array(z.string()),
    items: z.array(z.array(z.unknown())),
  }),
});

export const parseTushareEnvelopeRows = (raw: unknown): Array<Record<string, unknown>> => {
  const env = TushareEnvelopeSchema.parse(raw);
  if (env.code !== 0) {
    throw new Error(`tushare upstream_error: ${env.code} ${env.msg ?? ''}`);
  }
  return env.data.items.map((row) => {
    if (row.length !== env.data.fields.length) {
      throw new Error('tushare parse: fields/items length mismatch');
    }
    const obj: Record<string, unknown> = {};
    env.data.fields.forEach((field, i) => {
      obj[field] = row[i];
    });
    return obj;
  });
};
```

集中放在 `packages/adapters/src/tushare/envelope.ts`，方便单测。该 helper 只接受
tushare 官方 API 的唯一协议 `{code, msg, data: {fields, items}}`，不为对象数组或无
字段名的纯数组增加宽松兼容。

### 5.9 错误转译

```ts
export const translateTushareError = (error: unknown): Error => {
  if (error instanceof ZodError) return new Error(`tushare parse: ${error.message}`);
  return error instanceof Error ? error : new Error(String(error));
};
```

`tushare network / timeout / http / upstream_error / parse` 前缀已在客户端 `tushareQuery`
与 envelope 解析内生成；adapter 只补 ZodError → `tushare parse` 的转译。manager 只接
`Error`，wrap 后的字符串前缀 `tushare ...` 便于日志检索。

## 6. Factory 接线

`packages/adapters/src/market/factory.ts` 公开 `MarketSourceIdSchema`、
`MarketSourceOrderSchema` 与 `marketSourceOrderFromEnv`。factory 读取
`LUOOME_MARKET_SOURCES`，按逗号切分并校验：

- 可选值只有 `eastmoney`、`tencent`、`tushare`；
- 至少一个、最多三个，不允许重复；
- 从左到右分别占据 primary、fallback、finalFallback；
- 只启用一个源时使用内部 disabled adapter 占据必需的 fallback 端口，真实请求失败仍按
  “全源失败”返回，不生成合成行情；
- 显式启用 Tushare 但缺少 `TUSHARE_TOKEN` 时启动期抛 `Tushare 已启用，但 TUSHARE_TOKEN
  未配置`，避免界面显示已启用但运行时静默跳过。

未设置时默认 Eastmoney → Tencent。旧 `LUOOME_MARKET_ADSHARE` 兼容开关已删除。各 surface
只把自己的 env 传给 factory，不再分别解析开关。

### 6.1 Web 设置与热更新

Web 的 `/api/settings/market` 提供运行时配置：

- GET 返回全部源的启用状态、优先级与 `configured` 状态，不返回 token；
- POST 接收 `{ sources: MarketSourceId[] }`，受同源 Origin 保护；
- 启用 tushare 但 `TUSHARE_TOKEN` 未配置时拒绝保存（`启用 Tushare 前必须配置
  TUSHARE_TOKEN`）；
- 保存成功后原子写入 `$LUOOME_HOME/.env`，文件权限保持 `0600`，随后替换
  `ctxRef.current.adapters.market`，当前进程立即生效；
- Eastmoney 与 Tencent 无额外配置要求。

## 7. Core / DB 演进

### 7.1 Core

不修改 `core`。`Quote` / `DailyBar` / `StockSearchCandidate` 已具备 `source: string`，adapter 直接写 `'tushare'`。

### 7.2 DB

不修改 `db`。Manager 只写内存缓存，不直接写 repository。需要持久化日线的现有 tool
（例如 `get_stock_market_view`）继续调用 `DailyBarRepository.saveMany`，并按每根 bar 的
`source` 落库。实时报价当前没有通用 repository 写路径。

### 7.3 Adapter 测试夹具

复用 `packages/adapters/src/testing/fake-market.ts` 的 `FakeMarketAdapter`，通过
`source: 'tushare'` 构造 finalFallback 测试替身，不新增与真实 adapter 类耦合的专用 fake：

```ts
const finalFallback = new FakeMarketAdapter({ source: 'tushare', clock });
```

manager-resilience / search 测试用该实例验证 finalFallback 路径；adapter 自身协议测试仍
通过 `fetchImpl` stub 验证，不依赖网络。

## 8. 日志与可观测性

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
Tushare 成功次数。Manager 已记录主源 / 备源失败和“准备使用 final source”；Tushare
adapter 在成功解析后补充 operation 级成功日志：

```ts
logger.warn('tushare.fetchQuote failed', { stockCode, kind: 'network' | 'http' | 'parse' | 'unsupported_market' | 'not_found' | 'unknown' });
logger.warn('tushare.fetchDailyBars adj_factor missing', { stockCode, date });
logger.info('tushare.fetchQuote ok', { stockCode, source: 'tushare' });
logger.info('tushare.fetchDailyBars ok', { stockCode, source: 'tushare', count: bars.length });
```

`stats().finalFallbackCalls > 0` 只能作为“第三源被尝试过”的检测信号。成功使用以返回对象的
`source === 'tushare'` 或上述成功日志为准。若后续需要稳定的成功率 / 失败率 metric，应另行
扩展 `ManagerStats`，不从调用次数反推。

## 9. 安全与副作用

- 不引入新 IO 类型；adapter 仍然只是 `fetch + Zod`，与现有 adapter 形态一致。
- tushare 返回的 stockId / code / name 都按 Zod schema 严格校验，不直接传 DOM / shell / SQL。
- 不在 adapter 内记录 token；日志不得打印 `config.token`（token 随 POST body 发送，
  出错信息不含 body）。
- 不写 `Trade` / `Advice` / `WatchTrigger`；adapter 本身不持久化，只由 manager 写行情内存
  缓存，需要落库的 tool 继续走既有 repository。
- 不引入自动交易路径；与现有 `advice ≠ trade` 边界保持一致。
- 不引入 WebSocket / SSE；tushare 官方 HTTP API 为请求式，`MarketDataAdapterLike` 的
  契约保持 REST pull。

## 10. 测试与验收

### 10.1 单元测试（adapter 与客户端）

`packages/adapters/src/market/tushare.test.ts` 与
`packages/adapters/src/tushare/{client,envelope}.test.ts` 覆盖：

1. 不支持的市场（HK / US / BJ）抛 `unsupported_market`；
2. `fetchQuote` 正常响应 → 使用完整 `ts_code` 请求 `rt_k`，把 `price` 映射为最新价、
   `vol` 映射为 shares、优先使用远端 `trade_time`，返回 source='tushare'；价格全零行
   （盘前 / 停牌）→ 抛 `tushare no_data`；
3. `fetchQuote` 4xx → 转译为 `tushare http` 错误且不重试；
4. `fetchQuote` 5xx → 重试耗尽后抛错；
5. `fetchQuote` 网络错误 / 超时 → 转译为 `tushare network` / `tushare timeout`；
6. envelope code≠0 → 抛 `tushare upstream_error`（含权限类 2002）；
7. `fetchQuote` items 为空 → 抛 `tushare not_found`；
8. `fetchDailyBars` 日线 + 复权因子都成功 → 变动点前向填充出逐日因子、换算 qfq、vol × 100；
9. `fetchDailyBars` 复权因子完全缺失，或 bar 日早于首个变动日 → 抛 `unsupported_adjustment`；
10. `fetchDailyBars` 复权因子请求或 envelope 解析失败 → 整批失败；
11. `fetchDailyBars` 日线成功但越界 → 范围外 bar 丢弃；
12. `batchQuote` 部分失败 → 只保留成功项；
13. `searchStocks` 把 `SSE` / `SZSE` 映射为 `SH` / `SZ`，并剔除其它交易所候选、截断 20 条；
14. `searchStocks` 空 query → 空数组；六位代码按 ts_code 精确查，其它按 name 查；
15. envelope 解析接受 `{code, msg, data: {fields, items}}`，拒绝 code≠0、行列数量不符及
    其它响应形态；
16. 配置缺失 `TUSHARE_TOKEN` → `tushareConfigFromEnv` 抛错；factory 在启用 tushare 但
    token 缺失时抛 `Tushare 已启用，但 TUSHARE_TOKEN 未配置`。

### 10.2 集成测试（manager）

`packages/adapters/src/market/manager-resilience.test.ts` 覆盖：

1. Eastmoney + Tencent 都失败、tushare 成功 → 返回 tushare 数据，source='tushare'；
2. Eastmoney + Tencent 都失败、tushare 也失败 → 抛错；
3. 首次进入 finalFallback 后 30 分钟内跳过 Eastmoney / Tencent，并对后续未命中缓存的
   请求直接调用 tushare；
4. Eastmoney + Tencent 成功时 finalFallbackCalls = 0；
5. `searchStocks` 主源返回空数组 → 不触发 fallback 到 tushare；
6. `searchStocks` 主源抛错 → 触发 fallback 到 tushare。

### 10.3 合约测试（fake adapter）

复用 `packages/adapters/src/testing/fake-market.ts` 的 `FakeMarketAdapter`，设置
`source: 'tushare'` 后验证 finalFallback 的 `fetchQuote` / `batchQuote` /
`fetchDailyBars` / `searchStocks` 形状稳定。tushare 协议由 adapter 与客户端单元测试负责。

### 10.4 命令

开发中：

```bash
bun test packages/adapters/src/tushare
bun test packages/adapters/src/market/tushare.test.ts
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

### 10.5 端到端验收

1. 确认 `TUSHARE_TOKEN` 已填（积分 / `rt_k` 权限满足，见集成手册 §2），并在 Web 设置页启用
   Tushare、调整优先级；
2. 用集成手册 §3.1 的 curl 直连验证 token 有效（`code: 0`）；
3. 启动 web，访问行情页搜索 `002594`（比亚迪）；
4. 把 Eastmoney 调为第一优先级，行情正常显示 source='东方财富'；
5. 把 Tushare 调为第一优先级，刷新行情页 → 应展示 source='tushare' 的报价；
6. 同时屏蔽 tushare → 应展示“数据不可用”提示，不暴露价格 0；
7. CLI：`luoome tools list` 中既有行情 tool 仍被注册；实际调用返回数据的
   `source='tushare'`，日志记录 Tushare 成功；
8. MCP：调用同一 tool，tushare 链路可被 MCP 触发；
9. 在设置页关闭 Tushare → 路由立即恢复为其余启用源，刷新后配置仍保留；
10. 启用 Tushare 但删除 `TUSHARE_TOKEN` → 启动期快速失败，错误信息明确。

## 11. 跨市场候选

若后续接入 HK / US / BJ，单独设计：

1. market code 识别表扩展；
2. 各市场的 trading calendar 与 market session 语义；
3. `StockSearchCandidate` 仍走同一形状；
4. 单元 / 集成测试扩展。

不在本设计范围。

## 12. 文件变更清单

```text
packages/adapters/src/tushare/client.ts              (new：POST envelope 客户端 + fromEnv)
packages/adapters/src/tushare/envelope.ts            (new：parseTushareEnvelopeRows)
packages/adapters/src/tushare/client.test.ts         (new)
packages/adapters/src/tushare/envelope.test.ts       (new)
packages/adapters/src/market/tushare.ts              (new：TushareMarketAdapter)
packages/adapters/src/market/tushare.test.ts         (new)
packages/adapters/src/market/factory.ts              (tushare 排入路由 + TUSHARE_TOKEN 快速失败)
.env.example                                         (TUSHARE_TOKEN / TUSHARE_URL)
docs/runbooks/tushare-integration.md                 (new)
docs/ddd/tushare-market-adapter-design.md            (本文)
```

不动：

```text
packages/core/src/entity/quote.ts
packages/core/src/context.ts
packages/db/src/repository/**                        (复用现有 upsert)
```

已删除（adshare 迁移移除，不再属于本仓）：

```text
packages/adapters/src/market/adshare*.ts
packages/adshare-sdk/**
docs/runbooks/adshare-integration.md
docs/ddd/adshare-market-adapter-design.md
```

## 13. 验收原则

- tushare 是可排序的真实行情源，缺省关闭；启用后可位于三段路由任意位置；
- 不动 core 实体；`source='tushare'` 由 adapter 直接写入；
- 传输层为 tushare 官方 POST envelope 单一协议，token 随 body 发送，不引入私有代理；
- A 股覆盖范围显式声明；HK / US / BJ 由 adapter 拒绝而非静默失败；
- 成交量单位按接口分别归一为股（`daily` 手×100，`rt_k` 已是股）；
- 复权因子走单独接口全量历史，按变动点前向填充；完全缺失或早于首个变动日才降级失败；
- manager 不感知额外错误类，错误统一前缀 `tushare ...`；
- 不引入自动交易、不写入 Trade / Advice / WatchTrigger；
- 抑制窗口沿用“窗口内跳过主备、直达第三源”的现有语义，不宣称它会冷却 Tushare；
- `finalFallbackCalls` 表示尝试次数，Tushare 成功以返回 source 或成功日志为准；
- 所有改动配套 unit / 集成 / 端到端三类验收；
- 未启用 tushare 时不要求配置；显式启用但缺少 `TUSHARE_TOKEN` 时启动期快速失败，避免静默错配。
