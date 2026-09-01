import { createHash } from 'node:crypto';
import type { DailyBar, ToolContext } from '@luoome/core';

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

export const fetchDailyBarsWithRetry = async (
  ctx: ToolContext,
  stockId: string,
  range: { readonly start: Date; readonly end: Date },
  options: { readonly maxRetries: number; readonly timeoutMs: number },
): Promise<DailyBar[]> => {
  let lastError: unknown;
  for (let attempt = 0; attempt <= options.maxRetries; attempt += 1) {
    try {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          ctx.adapters.market.fetchDailyBars(stockId, range),
          new Promise<never>((_, reject) => {
            timeout = setTimeout(
              () => reject(new Error(`provider_timeout: daily bars ${stockId}`)),
              options.timeoutMs,
            );
          }),
        ]);
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
