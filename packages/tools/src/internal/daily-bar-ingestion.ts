import { createHash } from 'node:crypto';
import {
  type DailyBar,
  dateInShanghai,
  latestClosedTradingDate,
  type ToolContext,
} from '@luoome/core';

export const mapWithConcurrency = async <T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> => {
  const result = new Array<R>(items.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (cursor < items.length) {
        const index = cursor++;
        const item = items[index];
        if (item !== undefined) result[index] = await fn(item);
      }
    }),
  );
  return result;
};

const isRetryableProviderError = (error: unknown): boolean =>
  /timeout|timed out|connection reset|econnreset|rate.?limit|\b429\b/i.test(
    error instanceof Error ? error.message : String(error),
  );

/**
 * 丢弃未收盘的当日 bar：盘中快照不是收盘事实，写进 daily_bars 投影会污染后续所有读取。
 * 按交易日 key 比较，bar 的时间戳精度不参与判断。
 */
export const dropUnclosedBars = (bars: readonly DailyBar[], now: Date): DailyBar[] => {
  const closedThrough = dateInShanghai(latestClosedTradingDate(now));
  return bars.filter((bar) => dateInShanghai(bar.date) <= closedThrough);
};

export const fetchDailyBarsWithRetry = async (
  ctx: ToolContext,
  stockId: string,
  range: { readonly start: Date; readonly end: Date },
  options: { readonly maxRetries: number; readonly timeoutMs: number },
): Promise<DailyBar[]> => {
  let lastError: unknown;
  for (let attempt = 0; attempt <= options.maxRetries; attempt += 1) {
    if (ctx.abortSignal?.aborted) throw new Error('operation_cancelled');
    try {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        const bars = await Promise.race([
          ctx.adapters.market.fetchDailyBars(stockId, range),
          new Promise<never>((_, reject) => {
            timeout = setTimeout(
              () => reject(new Error(`provider_timeout: daily bars ${stockId}`)),
              options.timeoutMs,
            );
          }),
        ]);
        return dropUnclosedBars(bars, ctx.clock());
      } finally {
        if (timeout !== undefined) clearTimeout(timeout);
      }
    } catch (error) {
      lastError = error;
      if (!isRetryableProviderError(error) || attempt === options.maxRetries) throw error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
};

export const dailyBarContentHash = (
  bar: Pick<DailyBar, 'open' | 'high' | 'low' | 'close' | 'volume' | 'source'>,
): string =>
  createHash('sha256')
    .update(
      JSON.stringify({
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
        volume: bar.volume,
        source: bar.source,
      }),
    )
    .digest('hex');
