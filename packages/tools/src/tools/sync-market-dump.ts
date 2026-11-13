import { iterateDailyKDumpRows, readAdjustmentFactorDumpRows } from '@luoome/adapters';
import type { MarketDumpKind, RawDailyBar, ToolContext } from '@luoome/core';
import { z } from 'zod';
import { defineTool, errInvalidInput } from '../define-tool.js';

const DUMP_SOURCE = 'fuyao-dump';
const BAR_BATCH_SIZE = 5_000;

/**
 * dump 的 `date_ms` / `ex_date_ms` 是**北京时间零点**（UTC 16:00 前一天），
 * 而库内交易日键统一是 UTC 零点；不归一化会让同一交易日落成两行。
 */
const toTradingDate = (ms: number): Date => {
  const shifted = new Date(ms + 8 * 3_600_000);
  return new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()));
};

export const SyncMarketDumpInput = z.object({
  /** auto = 最近 10 个交易日日 K + 全量复权因子；单日同步走这个。 */
  kind: z.enum(['auto', 'daily-k', 'daily-k-10d', 'adjustment-factors']).default('auto'),
});

export const SyncMarketDumpOutput = z.object({
  kinds: z.array(z.enum(['daily-k', 'daily-k-10d', 'adjustment-factors'])),
  artifacts: z.array(
    z.object({
      kind: z.enum(['daily-k', 'daily-k-10d', 'adjustment-factors']),
      dumpId: z.string().min(1),
      bytes: z.number().int().nonnegative(),
      bars: z.number().int().nonnegative(),
      factors: z.number().int().nonnegative(),
    }),
  ),
  bars: z.number().int().nonnegative(),
  factors: z.number().int().nonnegative(),
  warnings: z.array(z.string().min(1).max(300)).max(8),
});

const resolveKinds = (kind: 'auto' | MarketDumpKind): MarketDumpKind[] =>
  kind === 'auto' ? ['daily-k-10d', 'adjustment-factors'] : [kind];

/**
 * 用 fuyao 全市场 Parquet dump 同步日线与复权因子。
 *
 * 日 K 是**未复权**原始价，直接落 `daily_bars`（与存储口径一致，不需要换算）；
 * 复权因子是除权除息事件，按事件前收盘算出 `factor = 除权价 / 前收盘` 后落
 * `adjustment_factors`。前复权仍由读时投影完成。
 */
export const syncMarketDumpTool = defineTool({
  name: 'sync_market_dump',
  description:
    'workflow-only：用 fuyao 全市场 dump 同步原始日线与复权因子（auto = 10 交易日增量 + 全量因子）',
  sideEffect: 'write',
  input: SyncMarketDumpInput,
  output: SyncMarketDumpOutput,
  handler: async (input, ctx: ToolContext) => {
    const adapter = ctx.adapters.marketDump;
    if (adapter === undefined) {
      return errInvalidInput('市场 dump 未配置：需要 FUYAO_API_KEY（见 .env.example）');
    }
    const kinds = resolveKinds(input.kind);
    const artifacts: z.infer<typeof SyncMarketDumpOutput>['artifacts'] = [];
    const warnings: string[] = [];
    let bars = 0;
    let factors = 0;

    for (const kind of kinds) {
      const artifact = await adapter.download(kind);
      let kindBars = 0;
      let kindFactors = 0;

      if (kind === 'adjustment-factors') {
        const events = readAdjustmentFactorDumpRows(artifact.localPath);
        const pending = [];
        for (const event of events) {
          const exDate = toTradingDate(event.exDateMs);
          const prev = await ctx.repos.dailyBar.latestRawBefore(
            event.stockId,
            new Date(exDate.getTime() - 1),
          );
          if (prev === null) continue;
          const denominator = 1 + event.perShareBonus + event.allotmentRatio;
          const exPrice =
            (prev.close - event.dividendPerShare + event.allotmentPrice * event.allotmentRatio) /
            denominator;
          if (!Number.isFinite(exPrice) || exPrice <= 0) continue;
          pending.push({
            stockId: event.stockId,
            exDate,
            factor: exPrice / prev.close,
            dividendPerShare: event.dividendPerShare,
            perShareBonus: event.perShareBonus,
            allotmentRatio: event.allotmentRatio,
            allotmentPrice: event.allotmentPrice,
            source: DUMP_SOURCE,
          });
        }
        await ctx.repos.adjustmentFactor.saveMany(pending);
        kindFactors = pending.length;
        if (events.length > pending.length) {
          warnings.push(
            `${kind}: ${events.length - pending.length} 条事件没有前收盘（早于本地日线起点），已跳过`,
          );
        }
      } else {
        let batch: RawDailyBar[] = [];
        for (const row of iterateDailyKDumpRows(artifact.localPath)) {
          batch.push({
            stockId: row.stockId,
            date: toTradingDate(row.dateMs),
            open: row.open,
            high: row.high,
            low: row.low,
            close: row.close,
            volume: Math.round(row.volume),
            source: DUMP_SOURCE,
          });
          if (batch.length >= BAR_BATCH_SIZE) {
            await ctx.repos.dailyBar.saveRawMany(batch);
            kindBars += batch.length;
            batch = [];
          }
        }
        if (batch.length > 0) {
          await ctx.repos.dailyBar.saveRawMany(batch);
          kindBars += batch.length;
        }
      }

      bars += kindBars;
      factors += kindFactors;
      artifacts.push({
        kind,
        dumpId: artifact.dumpId,
        bytes: artifact.bytes,
        bars: kindBars,
        factors: kindFactors,
      });
      ctx.logger.info('sync_market_dump: 导入完成', {
        kind,
        dumpId: artifact.dumpId,
        bars: kindBars,
        factors: kindFactors,
      });
    }

    return { kinds, artifacts, bars, factors, warnings };
  },
});
