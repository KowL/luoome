# MinuteBar 详细设计（Market View Phase 4）

> 状态：首个生产级竖向切片已实施（2026-08-20）
> 关联：[个股行情查看](./stock-market-view-detailed-design.md)、[行情数据底座](./market-data-and-stock-universe-detailed-design.md)、[Tushare 适配器](./tushare-market-adapter-design.md)

## 1. 语义边界

`MinuteBar` 是连续 OHLCV 事实，不是 `PriceSnapshot`、Quote 或既有 Tencent
`IntradayMinute` 的替代名称。PriceSnapshot 是稀疏观测；Tencent 分时行的成交量和成交额是
累计值，不能通过差分或区间查询伪装成 bar。MinuteBar 只接受外部 provider 明确给出的
OHLCV；缺行不补零、不插值、不从 Quote 合成。

## 2. 冻结 schema

```ts
interface MinuteBar {
  stockId: string;
  interval: '1m' | '5m' | '15m' | '30m' | '60m';
  endedAt: Date;             // provider bucket end label, Asia/Shanghai coordinate
  open: Money;
  high: Money;
  low: Money;
  close: Money;
  volume: number;            // shares, non-negative
  amount?: number;           // CNY, provider supplied
  adjustment: 'raw';         // never mix with DailyBar qfq
  source: string;
  fetchedAt: Date;
  completeness: 'closed' | 'live';
}
```

Core schema enforces finite/non-negative volume, `low <= open/close <= high`, raw adjustment,
and `endedAt <= fetchedAt`. Primary key is `(stockId, interval, endedAt)`. A bar label is the
end of its upstream bucket; the implementation does not infer a start time from a neighboring
bar.

All session calculations use `Asia/Shanghai`: morning 09:30–11:30 and afternoon 13:00–15:00.
The lunch break is not a gap. Interior missing buckets in either session are reported; bars
outside the two sessions are discarded and surfaced as a warning. A session is `complete` only
when it spans both session ends and has no interior gaps. A live/current session is normally
`partial`; a missing provider or empty local projection is `unavailable`.

## 3. Provider capability and limits

The production adapter uses Tushare `rt_min` (doc_id=374), not the Tencent cumulative minute endpoint.
The endpoint is one A-share per request, current trading day only, OHLCV, and requires the
realtime-minute permission. The implementation requests the selected frequency and supports the
public 1/5/15/30/60-minute contract at the adapter seam; provider-specific aggregation is not invented.
The request omits `fields` because the official time column is `time` while the proxy gateway
renames it to `trade_time` and silently drops unknown field names; parsing accepts either.
Tushare documents a maximum of 1,000 rows for this realtime endpoint and a separate minute-data
permission ([rt_min](https://tushare.pro/document/2?doc_id=374),
[permissions/frequency](https://tushare.pro/document/1?doc_id=290)). A response over the limit is
marked partial rather than silently truncated.

The manager has a dedicated 15-second `(stockId, interval)` cache and a 500 requests/minute
minute limiter. Empty results are not cached. Provider errors are logged and returned to the Tool
for local fallback. No other registered source is allowed to claim `minute-bars`; in particular,
`intraday-minutes` is never an implicit fallback.

Tushare's general historical minute API is end-of-day and separately permissioned
([minute data](https://tushare.pro/document/1?doc_id=234)); this slice does not call it through the
HTTP adapter. Therefore the explicit date path is local-only and returns `unavailable` when that
date was not retained. This is an honest availability boundary, not a fabricated historical
series.

## 4. Persistence lifecycle

`minute_bars` is created by both Drizzle schema and idempotent `ensureSchema`. Drizzle and
in-memory repositories share contract tests for ordering, upsert isolation by interval, latest
Shanghai session, retention deletion, and raw-adjustment rejection. The Tool writes successful
current-session bars and opportunistically removes rows older than 30 days. There is no background
minute collector, notification trigger, or trading side effect.

## 5. Tool contract

`get_stock_minute_bars` is an `external` read of the current provider with a local persistence
side effect. Input is `stockId`, `interval` (default `1m`), and optional `date` (`YYYY-MM-DD`).
Output includes `status`, `retrieval` (`live`, `local-fallback`, `none`), bars, `gaps`, `freshness`,
`asOf`, `sources`, `warnings`, `providerScope: 'current-session-only'`, and `retentionDays: 30`.

For today, the Tool first tries the provider, persists a non-empty response, and reports partial
or live-session state without throwing when minutes are unavailable. For an explicit historical
date it never asks the current-session provider; it reads only the retained repository. Provider
failure falls back to the latest local session and marks the result stale/local-fallback. Quote
and DailyBar tools remain independent and continue to work.

## 6. Web behavior and acceptance

Market View always exposes `分时` and `分钟K` tabs plus a 1/5/15/30/60 switch. The chart consumes
MinuteBar OHLCV directly (volume is not differenced). The status strip displays live/partial,
stale/local fallback, unavailable, gaps, raw adjustment, source, and freshness. Empty or partial
minutes never become a blank “正常” chart and never hide the existing Quote or 日 K.

Tests cover core invariants, both repository implementations, adapter mapping and capability
boundaries, manager TTL/rate-limit seam, Tool fallbacks/retention, registry/API allow-list, chart
conversion, and a real browser run against the unavailable-provider state.
