# 同花顺 fuyao 行情适配器设计

> 状态：已实施（2026-08-22；真实 FUYAO_API_KEY smoke 通过，见 §10.5）
> 日期：2026-08-22
> 范围：将同花顺金融数据 API（`https://fuyao.aicubes.cn`）接入为 `MarketDataManager` 的第四个真实行情源 `fuyao`，覆盖 quote / batchQuote / fetchDailyBars / searchStocks / fetchMarketSnapshot / fetchIndexQuotes
> 关联文档：[ARCHITECTURE.md §4.7](../ARCHITECTURE.md)、[行情数据底座详细设计](./market-data-and-stock-universe-detailed-design.md)、[Tushare 行情适配器设计](./tushare-market-adapter-design.md)、[Tushare 集成手册](../runbooks/tushare-integration.md)
> 上游契约来源：`https://fuyao.aicubes.cn/llms-full.txt`（同花顺金融数据 API 全站聚合文档）

## 1. 目标

接入后 `fuyao` 作为 `MarketSourceId` 之一参与 `LUOOME_MARKET_SOURCES` 排序，通过既有 `MarketSourceRegistry` capability 绑定提供：

| luoome capability | fuyao 端点 | 说明 |
|---|---|---|
| `quote` / `batchQuote` | `GET /api/a-share/prices/snapshot?thscodes=` | 显式 thscodes 批量模式，按入参顺序返回 |
| `daily-bars` | `GET /api/a-share/prices/historical?adjust=forward` | 单标的日 K，前复权对齐 `DailyBar.adjustment='qfq'` |
| `search` | `GET /api/meta/tickers/search` | 按名称/代码消歧，解析 thscode |
| `market-snapshot` | `GET /api/a-share/prices/snapshot`（无 thscodes） | 全市场分页模式，`limit=100` + `offset` 循环取尽 |
| `delayed-index` | `GET /api/a-share-index/prices/snapshot` | 指数快照；实时性未经实盘验证前只绑 `delayed-index` |

验收口径与既有源一致：registry `describe()` 能派生 fuyao 的启用状态、coverage、`dataAsOf` 与 `lastErrorKind`；manager 的缓存、限速、抑制窗口语义不变。

## 2. 非目标

- 不接入基金接口（`/api/fund/**`）、特色数据（涨停池/热榜/龙虎榜/异动）、集合竞价、估值快照。连板天梯与龙虎榜已有独立 manager，不在本设计替换。
- 不接入 Parquet 全市场导出（dump 是离线批量通道，与在线 adapter 语义不同，后续如需盘后归档另行设计）。
- 不做分钟级数据：fuyao 无分钟线端点，`fetchIntradayMinutes` / `fetchMinuteBars` 必须抛 `unsupported_capability`，不得用日 K 冒充。
- 不改 core 实体、不改 `MarketDataManager` / `MarketSourceRegistry` 接口、不改 DB schema。
- 不自动交易、不新增任何写或交易路径。
- 北交所（`.BJ`）覆盖：fuyao 支持 `.BJ` 后缀，但 luoome 首期只覆盖沪深 A 股（见 CONTEXT.md），adapter 对 `.BJ` 显式 `unsupported_market` 拒绝。

## 3. 已确认决策

### 3.1 走 REST，不走 MCP

fuyao 同时提供 REST 与 4 个 MCP 服务（`/mcp/a-share`、`/mcp/a-share-index`、`/mcp/fund`、`/mcp/meta`），二者共享同一 capability 与信封。luoome 的 adapter 是进程内 TypeScript 组件，直接调 REST；MCP 面向外部 Agent 消费场景，不进入本仓库的 adapter 层。

### 3.2 路由槽位：`MarketSourceRegistry` 第四个 source

`MarketSourceIdSchema` 增加 `fuyao`，`LUOOME_MARKET_SOURCES` 接受最多 3 个源的约束不变（ARCHITECTURE §4.7），fuyao 与 eastmoney/tencent/sina/tushare 竞争同一排序槽位。新增来源只在 `market/factory.ts` 绑 binding，tool / workflow / surface 零改动（构造硬约束：不得在 Registry 之外临时实例化隐藏来源）。

### 3.3 市场范围

`coverage` 声明为沪深 A 股（`SH` / `SZ`）。thscode 必须带后缀，adapter 内部把 luoome 的 6 位代码归一为 `XXXXXX.SH|SZ`；收到 `.BJ`、`.TI`、`.OF` 或纯代码无法判定市场时抛 `unsupported_market`。

### 3.4 单位与坐标系

fuyao 的口径与 luoome 规范化目标天然一致，adapter 不做单位换算：

- `volume` 已经是股（无需手→股换算），`turnover` 为元，`currency` 恒 CNY；
- `price_change_ratio_pct` 等百分数字段是百分数原值（`1.74` = 1.74%），写入 `Quote` 时保持原值，不除 100；
- 财务金额字段为原币元（本设计不消费，仅记录口径备查）。

### 3.5 复权语义

luoome 的 `DailyBar` 统一前复权（`adjustment: 'qfq'`）。fuyao `prices/historical` 的 `adjust=forward` 直接返回前复权价格，adapter 固定传 `forward`；`none/ backward` 不暴露给上层。`sourceAdjFactor` 不从 K 线响应推导（响应不含因子），留 `undefined`；如后续策略链路需要因子，走 `GET /api/a-share/corporate-actions/adjustment-factors` 单独取事件流，不在本设计内。

历史窗口上限 10 年（`end-start` 超出返回 `1003`），adapter 在请求前裁剪并记录，不静默截断语义：调用方请求超窗时按 `unsupported_adjustment` 之外的既有参数错误语义抛错（见 §5.9）。

### 3.6 时效语义

- 行情快照与 K 线的 `data.timestamp` 是上游最新有效时间，作为 binding 的 `dataAsOf` 提取来源；
- `timestampSource` 置 `upstream`；`observedAt` 用 `data.timestamp`，`fetchedAt` 用本地时钟，满足 `QuoteSchema` 的 `observedAt ≤ fetchedAt` 不变量；
- `tickers/search` 无数据时效语义，不参与 `dataAsOf`。

### 3.7 失败语义与快速失败

- 显式在 `LUOOME_MARKET_SOURCES` 启用 `fuyao` 但缺 `FUYAO_API_KEY`：启动期抛错（对齐 `buildTushare` 快速失败），不静默降级；
- 运行时错误统一抛 `packages/adapters/src/source-error.ts` 的结构化 `SourceExecutionError`（§5.9），registry 按 `error.kind` 观测归类，manager 按既有降级机制处理，不引入新错误类；
- fuyao 所有响应（含错误）HTTP 恒 200，业务结果按信封 `code` 分发——adapter 不得以 HTTP 状态判定成败。

### 3.8 不改 core / DB

`MarketDataAdapterLike` 端口已覆盖目标能力，无需扩展 core；无新增 repository，无 schema 迁移。

## 4. 端到端数据流

```text
Tool / Workflow / Surface
        │  ctx.adapters.market（MarketDataAdapterLike）
        ▼
MarketDataManager ── TTL 缓存 / 限速 / 抑制窗口 / 搜索空数组不降级
        │  按 capability + coverage 路由
        ▼
MarketSourceRegistry ── bindings: quote / daily-bars / search / market-snapshot / delayed-index
        │
        ▼
FuyaoSource（fuyao/source.ts）
        │  代码归一（加 .SH/.SZ 后缀）、响应归一（Quote/DailyBar/Stock）
        ▼
FuyaoClient（fuyao/client.ts）
        │  GET + X-api-key + envelope 解析 + 超时重试
        ▼
https://fuyao.aicubes.cn/api/**
```

## 5. Adapter 契约

### 5.1 类签名

```ts
// packages/adapters/src/fuyao/source.ts
export class FuyaoSource {
  readonly name = 'fuyao';
  readonly indexQuoteMode = 'delayed' as const;
  constructor(options: { clock?; fetchImpl?; logger; config: FuyaoConfig });
  // MarketDataAdapter 全量方法（结构满足，对齐 TushareMarketAdapter 不显式 implements）；
  // 不支持的能力抛 unsupported_capability
}
```

配置注入对齐既有约定：`env → factory 一次性解析 → 构造注入`，adapter 不读 `process.env`。

```ts
// packages/adapters/src/fuyao/client.ts
export function fuyaoConfigFromEnv(env): FuyaoConfig {
  // FUYAO_API_KEY 缺失 → 抛错（快速失败由 factory 的 buildFuyao 触发）
  // FUYAO_BASE_URL 缺省 https://fuyao.aicubes.cn
  // timeoutMs / retries 为代码常量（对齐 TushareConfig）
}
```

### 5.2 代码归一

- 入参 6 位数字：`60/68/9` 开头 → `.SH`，`00/30/20` 开头 → `.SZ`；已带后缀的原样 trim + toUpperCase；
- `.BJ` / `.TI` / `.OF` / 无法判定 → `unsupported_market`；
- fuyao 快照响应不含中文名 `name`，`Quote` 不依赖 name；名称解析走 `search` capability。

### 5.3 fetchQuote / batchQuote

```text
GET /api/a-share/prices/snapshot?thscodes=600519.SH,000001.SZ
→ item[]: thscode/ticker/last_price/price_change/price_change_ratio_pct/
          open_price/high_price/low_price/prev_price/volume/turnover
→ Quote { price: last_price, open/high/low/preClose, volume（股）, turnover,
          observedAt: data.timestamp, timestampSource: 'upstream', source: 'fuyao' }
```

批量去重保序由服务端完成；上游未返回的标的生成 `no_data` 部分失败语义，不伪造占位项。

### 5.4 fetchDailyBars

```text
GET /api/a-share/prices/historical?thscode=600519.SH&interval=1d
    &start=<ms>&end=<ms>&adjust=forward
→ item[]: date_ms/open_price/high_price/low_price/close_price/volume/turnover
→ DailyBar { date: date_ms(Asia/Shanghai 零点), ohlc, volume, turnover,
             adjustment: 'qfq', source: 'fuyao' }
```

约束：单标的（thscode 不接受逗号）、仅 `1d`、`end-start ≤ 10 年`。

### 5.5 searchStocks

```text
GET /api/meta/tickers/search?q=<keyword>&exchange=SH|SZ&asset_type=a-share&limit=≤50
→ item[]: thscode/ticker/name/exchange/asset_type/currency
→ Stock { code, name, exchange }
```

沿用 manager 既有语义：空数组不降级、抛错才降级。

### 5.6 fetchMarketSnapshot

无 `thscodes` 的全市场分页模式：`limit=100`，`offset` 循环直至 `item.length < limit`。快照响应不含中文名，`MarketSnapshotItem.name` 以代码占位（满足 name 非空不变量，名称解析走 search capability）；`.BJ` 条目过滤、按 id 去重。实盘验证（2026-08-22）：全市场分页含停牌标的，`last_price` 可能为 `null`——保留条目、仅省略 `close`/`changePct`。只绑 `market-snapshot` capability，不绑 `market-snapshot-envelope`（完整性信封仍由 eastmoney/tencent 承担）。

### 5.7 fetchIndexQuotes

```text
GET /api/a-share-index/prices/snapshot?thscodes=000001.SH,399001.SZ,399006.SZ,000300.SH,000688.SH
```

指数集合对齐 eastmoney MAJOR_INDICES 的沪深部分（上证指数 / 深证成指 / 创业板指 / 沪深300 / 科创50）；恒生指数不在 fuyao A 股覆盖范围内，不含。指数快照不返回名称，用 thscode → 中文名常量映射（同 tushare）。指数无复权语义。绑定 `delayed-index`；只有实盘验证快照时效后，才允许在 factory 追加 `realtime-index` 绑定（对齐「Tushare 日线型指数不得进实时接口」的抑制原则）。

### 5.8 envelope 解析

```ts
// packages/adapters/src/fuyao/envelope.ts
interface FuyaoEnvelope<T> {
  code: number;        // 0 成功；非 0 业务错误（HTTP 恒 200）
  message: string;
  request_id: string;  // 日志追踪
  data: { timestamp: number | null; item: T[] } | null;
}
```

`parseFuyaoEnvelope(body)`：`code !== 0` → 按 §5.9 抛结构化 `SourceExecutionError`；`code === 0` 且 `data === null` → `no_data`。信封形状不符（Zod 校验失败）→ `invalid_payload`；非 JSON 响应由 client 在 `res.json()` 处更早拦截为 `invalid_payload`。`data.timestamp` 为 `null`（快照无有效数据）时归一为 `undefined`，由 source 回退本地时钟 + `timestampSource='retrieval'`。

### 5.9 错误转译

| fuyao code | 含义 | `SourceExecutionError.kind` |
|---|---|---|
| `0` | 成功 | 正常返回 |
| `1001`/`1002`/`1003`/`1004` | 参数缺失/格式/越界/冲突 | `upstream_error`（adapter 自身 bug 的兜底归类，不触发源降级语义之外的特判；message 保留原始 code/message） |
| `2001`/`2003` | 未认证/无权限 | `permission` |
| `3001` | 标的不存在 | `no_data` |
| `3002` | 数据未就绪 | `no_data`（可重试语义交给 manager） |
| `3004` | 标的类型不支持 | `unsupported_market` |
| `4001` | 频率超限 | `rate_limited`（client 内置退避重试一次，仍失败则抛出） |
| `5001`/`5002`/`5003` | 内部/上游超时/上游不可用 | `upstream_error` |
| 网络错误 / 超时 / 非 200 / 非 JSON | — | `network` / `timeout` / `httpStatusErrorKind(status)` / `invalid_payload` |

历史窗口超 10 年（上游 `1003`）由 adapter 在请求前拦截，按同一 `upstream_error`（`fuyao invalid_params: ...`）归类，不静默截断。QPS 上限官方未公布，client 默认保守节流（10s 超时 + 4001 单次退避），API key 只在 `X-api-key` 请求头出现，不进入任何日志与错误消息。

## 6. Factory 接线

`packages/adapters/src/market/factory.ts`：

```ts
const MarketSourceIdSchema = z.enum(['eastmoney', 'sina', 'tencent', 'tushare', 'fuyao']);

function buildFuyao(env, sourceOpts, logger): FuyaoSource {
  // LUOOME_MARKET_SOURCES 含 fuyao 且 FUYAO_API_KEY 缺失 → 启动期抛错
  const config = fuyaoConfigFromEnv(env);
  return new FuyaoSource({ ...sourceOpts, config, logger });
}

// 绑定：quote / daily-bars / search（commonBindings）+ market-snapshot + delayed-index；
// 不绑 realtime-index / market-snapshot-envelope / minute-bars / intraday-minutes。
```

`CreateMarketAdapterDeps.sources` 增加可选 `fuyao?: FuyaoSource`，注入时 fuyao 分支复用而不自构（对齐 eastmoney 共享机制）。`MarketSourceOrderSchema` 的 `max(3)` 约束不变。

`.env.example` 增加（凭证默认注释，启用开关与凭证分离）：

```ini
# ---------- FUYAO 同花顺数据服务（未配置时不参与行情源） ----------
# FUYAO_API_KEY=xxxxxxxxx
# FUYAO_BASE_URL=https://fuyao.aicubes.cn
```

API Key 获取：同花顺账号登录 `https://fuyao.aicubes.cn` → `/admin`「API Key 管理」创建，完整 Key 仅创建时可见一次。运行时 `/api/settings/market` 热更新路径与既有源一致，不单独开口。

## 7. Core / DB 演进

- Core：不动。`MarketDataAdapterLike`、`Quote`、`DailyBar`、`Stock` 均已满足。
- DB：不动。日线归档沿用既有 `DailyBarRepository` 路径，`source` 字段记 `fuyao`。
- 测试夹具：`testing/fake-market.ts` 无需改动；新增 fuyao 的 fake fetch 响应夹具。

## 8. 日志与可观测性

复用 registry 既有观测面：`describe()` 派生 fuyao 的 `configurationReady` / `dataAsOf` / `lastErrorKind` / lastAttemptAt / lastSuccessAt。adapter 日志记录 `request_id` 以便与 fuyao 服务端对账，不记录 `X-api-key`。不扩展 manager 接口。

## 9. 安全与副作用

- 不新增 IO 类型：adapter 仅出向 HTTPS GET，纳入既有 `external` 语义；
- `FUYAO_API_KEY` 只经 env 注入，不落日志、不落库、不进 tool 输出；
- 不触碰 Trade / Advice / WatchTrigger 链路；行情源变更不产生任何自动下单路径。

## 10. 测试与验收

### 10.1 单元测试（`fuyao/{envelope,client,source}.test.ts` + `market/factory.test.ts`，逐条编号）

1. 代码归一：6 位代码加后缀、已带后缀原样、`.BJ`/`.TI`/`.OF`/纯字母 → `unsupported_market`；
2. snapshot 批量：字段映射到 `Quote`（volume 原样为股、百分数原值保留）、`data.timestamp` → `observedAt` + `timestampSource='upstream'`；
3. daily-bars：`adjust=forward` 固定传参、`adjustment='qfq'`、窗口超 10 年抛参数错误；
4. envelope：`code=0 data=null` → `no_data`；各错误码按 §5.9 转译为结构化 kind；非 JSON / 信封形状不符 → `invalid_payload`；
5. search：空结果返回空数组（不抛错）；
6. market-snapshot：分页循环在 `item.length < limit` 终止；`last_price=null`（停牌）保留条目仅省略 close；
7. `fetchIntradayMinutes` / `fetchMinuteBars` → `unsupported_capability`；
8. 快速失败：`FUYAO_API_KEY` 缺失时 `buildFuyao` 启动期抛错；
9. client：`X-api-key` 头、4001 退避重试一次、超时/network 归类、错误消息不泄漏 API key。

### 10.2 集成测试（manager 层）

fake fetch 注入 fuyao 信封，验证 registry 路由（`LUOOME_MARKET_SOURCES=fuyao`）、降级顺序、`describe()` 健康输出、`4001` 退避。

### 10.3 合约测试

复用 `FakeMarketAdapter` 既有合约套件，`source: 'fuyao'` 跑同一组端口断言。

### 10.4 命令

`bun run test`、`bun run typecheck`、`bun run lint`。

### 10.5 端到端验收清单

- [x] 真实 `FUYAO_API_KEY` smoke（2026-08-22，临时脚本 `/tmp/fuyao-smoke.ts`，用完即删）：fetchQuote(600519)、fetchDailyBars（近 30 天 21 根 qfq 日 K）、searchStocks(茅台)、fetchMarketSnapshot（5218 条分页取尽）、fetchIndexQuotes（5 只大盘指数）全链路返回且 `observedAt`/`dataAsOf` 取自信封 `data.timestamp`；
- [x] 缺 `FUYAO_API_KEY` 启动期快速失败（buildFuyao 单测）；错误 Key 运行时返回 `code=2003` → `permission`（smoke 验证）；
- [ ] Web 个股行情页在 fuyao 源下渲染正常；
- [ ] 实盘观察指数快照时效后，决定 `realtime-index` 是否放行（单独记录结论）。

## 11. 后续扩展（不在本设计范围）

| 方向 | fuyao 端点 | luoome 落点 |
|---|---|---|
| 基本面真实源 | `/api/a-share/financials/{income-statements,balance-sheets,cash-flow-statements,indicators}` | 实现 `FundamentalDataAdapterLike`，替换 mock，注意 `FinancialFact` 的 PIT 时间链（fuyao 返回 `report_date_ms` 可作 `publishedAt` 候选，需单独设计 vintage 映射） |
| 交易日历 | `/api/a-share/calendar/trading-days` | Strategy 日运行 checkpoint |
| 复权因子事件流 | `/api/a-share/corporate-actions/adjustment-factors` | `DailyBar.sourceAdjFactor` 补全、严格回测数据门禁 |
| 集合竞价 / 龙虎榜 / 特色数据 | `/api/a-share/{auction,special-data}/**` | 在对应域 registry 增加 fuyao binding（`LUOOME_*_SOURCES=eastmoney,fuyao` 有序切换），不进 MarketDataManager |
| 全市场离线导出 | `/api/dump/market-dumps/**`（S3 预签名链接，5 分钟过期） | 盘后归档通道，另行设计 |

## 12. 文件变更清单

新增：

- `packages/adapters/src/fuyao/client.ts`、`envelope.ts`、`source.ts`
- `packages/adapters/src/fuyao/client.test.ts`、`envelope.test.ts`、`source.test.ts`
- 本文档

修改：

- `packages/adapters/src/market/factory.ts`（`MarketSourceIdSchema` + `buildFuyao` + `fuyaoBindings` + `deps.sources.fuyao`）
- `packages/adapters/src/market/factory.test.ts`（fuyao 路由 / 降级 / 快速失败 / 不注册能力）
- `packages/adapters/src/index.ts`（桶导出）
- `apps/web/src/market-settings.ts` + 测试（fuyao 源元信息与 `FUYAO_API_KEY` 配置检查）
- `.env.example`（FUYAO 配置段 + `LUOOME_MARKET_SOURCES` 可选值注释）
- `docs/README.md`（DDD 索引）

不动：core 全部实体与端口、`MarketDataManager` / `MarketSourceRegistry`、DB schema、四个 surface 组装根、`testing/fake-market.ts`。

## 13. 验收原则

- fuyao 只经 `MarketSourceRegistry` 绑 binding 接入，任何 surface / tool / workflow 代码零改动；
- 不支持的能力显式 `unsupported_capability`，不用日 K 冒充分钟、不用指数快照冒充实时；
- HTTP 恒 200 的 envelope 语义在 adapter 内闭环，上层只见 `Quote`/`DailyBar`/`Stock` 或既有 kind 的错误；
- 凭证缺失快速失败，运行时失败可降级，两种路径各有测试；
- 文档与实现冲突时以代码和测试为准，并回填本文档状态。
