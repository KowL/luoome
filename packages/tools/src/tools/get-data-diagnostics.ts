// T14 / REQ-M2-04：把 CLI 独有「诊断」迁成 settings 面板内的只读读模型。
//
// 三条结论都来自**既有信号**，不新造事实：
//   1. 缺行情 —— `price_snapshots` / `daily_bars` 的最近日期（仓储直读）；
//   2. 迁移未完成 —— `schema_migrations` 与 `EXPECTED_SCHEMA_MIGRATIONS` 差集；
//   3. 连接失败 —— market adapter 的 source registry（`lastErrorKind` + `lastAttemptAt`）。
// 每条 finding 必须带**具体表名 + 字段名 + 日期**（无日期时显式 null，由 UI 显示「从未」），
// 不允许只输出「数据有问题」。
import { EXPECTED_SCHEMA_MIGRATIONS, type SourceStatus } from '@luoome/core';
import { z } from 'zod';

import { defineTool } from '../define-tool.js';
import { computeRelevantStockIds } from './sync-stock-events.js';

/** 行情快照超过 15 分钟即视为缺失（与 get_market_data_status 同一阈值口径）。 */
const QUOTE_STALE_MS = 15 * 60 * 1000;
/** 日线允许的最大滞后天数（覆盖周末与单日休市）。 */
const DAILY_BAR_LAG_DAYS = 3;
const DAILY_BAR_PROBE_STOCKS = 5;

/** 数据集 → 事实表。诊断要给出「查哪张表」，而不是只有数据集名字。 */
const DATASET_TABLES: Readonly<Record<string, string>> = Object.freeze({
  quote: 'price_snapshots',
  'realtime-index': 'price_snapshots',
  'market-snapshot': 'price_snapshots',
  'market-snapshot-envelope': 'price_snapshots',
  'daily-bar': 'daily_bars',
  'stock-universe': 'stock_universe_sync_runs',
  'limit-up-ladder': 'limit_up_ladder_snapshots',
  'dragon-tiger': 'stock_events',
  'stock-profile': 'stock_events',
  'northbound-flow': 'stock_events',
  news: 'stock_events',
  'ashare-sentiment': 'stock_events',
});

export const DataDiagnosticFindingSchema = z.object({
  code: z.enum([
    'market-quote-missing',
    'daily-bar-stale',
    'migration-incomplete',
    'source-unavailable',
  ]),
  severity: z.enum(['warn', 'bad']),
  /** 具体事实表。 */
  table: z.string(),
  /** 具体字段。 */
  field: z.string(),
  /** 结论依据的时间；null 表示「从未」。 */
  at: z.coerce.date().nullable(),
  message: z.string(),
});

export const GetDataDiagnosticsInput = z.object({});

export const GetDataDiagnosticsOutput = z.object({
  checkedAt: z.coerce.date(),
  findings: z.array(DataDiagnosticFindingSchema),
});

const iso = (value: Date | null): string =>
  value === null ? '从未' : value.toISOString().slice(0, 19).replace('T', ' ');

const dayIso = (value: Date): string => value.toISOString().slice(0, 10);

/**
 * get_data_diagnostics（T14，read）。只读，不探测上游、不写库。
 *
 * 每条结论都绑定 `table` + `field` + `at`，UI 与验收都能追溯到具体表与日期；
 * 拿不到日期时 `at` 为 null 并显示「从未」，不编造时间。
 */
export const getDataDiagnosticsTool = defineTool({
  name: 'get_data_diagnostics',
  description: '数据诊断读模型：缺行情 / 迁移未完成 / 连接失败，逐条给出表名、字段与日期',
  sideEffect: 'read',
  input: GetDataDiagnosticsInput,
  output: GetDataDiagnosticsOutput,
  handler: async (_input, ctx) => {
    const now = ctx.clock();
    const findings: z.infer<typeof DataDiagnosticFindingSchema>[] = [];
    const stockIds = await computeRelevantStockIds(ctx);

    // 1) 缺行情：price_snapshots 的最近 observed_at。
    if (stockIds.length > 0) {
      const quotes = await ctx.repos.quote.latestByStocks(stockIds);
      let latest: Date | null = null;
      for (const quote of quotes.values())
        if (latest === null || quote.observedAt.getTime() > latest.getTime())
          latest = quote.observedAt;
      if (latest === null || now.getTime() - latest.getTime() > QUOTE_STALE_MS)
        findings.push({
          code: 'market-quote-missing',
          severity: latest === null ? 'bad' : 'warn',
          table: 'price_snapshots',
          field: 'observed_at',
          at: latest,
          message:
            latest === null
              ? `表 price_snapshots 没有关注标的的行情快照（检查于 ${iso(now)}）`
              : `表 price_snapshots 最近行情时间 ${iso(latest)}，已超过 15 分钟新鲜度阈值（检查于 ${iso(now)}）`,
        });

      // 2) 日线滞后：daily_bars 的最近 trade_date。
      let latestBar: Date | null = null;
      for (const stockId of stockIds.slice(0, DAILY_BAR_PROBE_STOCKS)) {
        const bars = await ctx.repos.dailyBar.latestBefore(stockId, now, 1);
        const bar = bars[0];
        if (bar !== undefined && (latestBar === null || bar.date.getTime() > latestBar.getTime()))
          latestBar = bar.date;
      }
      const lagDays =
        latestBar === null
          ? Number.POSITIVE_INFINITY
          : Math.floor((now.getTime() - latestBar.getTime()) / 86_400_000);
      if (lagDays > DAILY_BAR_LAG_DAYS)
        findings.push({
          code: 'daily-bar-stale',
          severity: latestBar === null ? 'bad' : 'warn',
          table: 'daily_bars',
          field: 'trade_date',
          at: latestBar,
          message:
            latestBar === null
              ? `表 daily_bars 没有关注标的的日线（检查于 ${iso(now)}）`
              : `表 daily_bars 最近日线交易日 ${dayIso(latestBar)}，已滞后 ${String(lagDays)} 天（检查于 ${iso(now)}）`,
        });
    }

    // 3) 迁移未完成：schema_migrations 与期望清单的差集。
    const migrations = await ctx.repos.schemaMigration?.list();
    if (migrations !== undefined) {
      const applied = new Map(migrations.map((record) => [record.id, record.appliedAt]));
      const lastApplied =
        migrations.length === 0
          ? null
          : new Date(Math.max(...migrations.map((record) => record.appliedAt.getTime())));
      for (const id of EXPECTED_SCHEMA_MIGRATIONS)
        if (!applied.has(id))
          findings.push({
            code: 'migration-incomplete',
            severity: 'bad',
            table: 'schema_migrations',
            field: 'id',
            at: lastApplied,
            message: `表 schema_migrations 缺少 id=${id}（最近一次已应用 ${iso(lastApplied)}）`,
          });
    }

    // 4a) 连接失败（持久）：最近一次股票库同步就是失败，说明数据源连不上。
    const latestRun = await ctx.repos.stockUniverse.latestSyncRun({
      coverage: 'CN_A_SHARES_SH_SZ',
    });
    if (latestRun !== null && latestRun.status === 'failed')
      findings.push({
        code: 'source-unavailable',
        severity: 'bad',
        table: 'stock_universe_sync_runs',
        field: 'status',
        at: latestRun.finishedAt ?? latestRun.startedAt,
        message: `表 stock_universe_sync_runs 最近一次同步（source=${latestRun.source}）于 ${iso(
          latestRun.finishedAt ?? latestRun.startedAt,
        )} 失败：status=failed${latestRun.errorKind === undefined ? '' : `，errorKind=${latestRun.errorKind}`}`,
      });

    // 4b) 连接失败（进程内）：market source registry 的最近一次失败。
    const statuses: readonly SourceStatus[] = ctx.adapters.market.marketSourceStatus();
    for (const status of statuses) {
      if (status.lastErrorKind === undefined) continue;
      findings.push({
        code: 'source-unavailable',
        severity: 'bad',
        table: DATASET_TABLES[status.dataset] ?? status.dataset,
        field: 'last_error_kind',
        at: status.lastAttemptAt ?? null,
        message: `数据源 ${status.source}（dataset=${status.dataset}）最近一次尝试 ${iso(
          status.lastAttemptAt ?? null,
        )} 失败：lastErrorKind=${status.lastErrorKind}`,
      });
    }

    return { checkedAt: now, findings };
  },
});
