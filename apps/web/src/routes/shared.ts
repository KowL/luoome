import type { ToolResult } from '@luoome/core';

import type { BatchQuoteTarget } from './types.js';

/**
 * batch_quote 聚合写回（batch_quote 上限 100 只）：整体失败降级为
 * quote 保持 null + warnings；单只失败跳过；changePct 全行统一昨收基准换算。
 */
export const applyBatchQuotes = async (
  invokeTool: (name: string, input: unknown) => Promise<ToolResult<unknown>>,
  entries: ReadonlyMap<string, BatchQuoteTarget>,
  warnings: string[],
  degradeLabel: string,
  { updateName = false, keepExistingChangePct = false } = {},
): Promise<void> => {
  const stockIds = [...entries.keys()].slice(0, 100);
  if (stockIds.length === 0) return;
  const quotesResult = await invokeTool('batch_quote', {
    stockIds,
    context: 'display',
  });
  if (!quotesResult.ok) {
    warnings.push(`batch_quote 失败（${quotesResult.error.kind}），${degradeLabel}`);
    return;
  }
  const { items } = quotesResult.data as {
    items: Array<
      | {
          stockId: string;
          stockName: string;
          status: 'ok';
          quote: { close: number; prevClose?: number; observedAt: unknown };
          retrieval: 'live' | 'local-fallback';
          freshness: 'fresh' | 'stale';
        }
      | { stockId: string; status: 'unresolved' | 'unavailable'; reason: string }
    >;
  };
  for (const result of items) {
    if (result.status !== 'ok') continue;
    const entry = entries.get(result.stockId);
    if (entry === undefined) continue;
    if (updateName) entry.name = result.stockName;
    entry.quote = {
      close: result.quote.close,
      observedAt: result.quote.observedAt,
      retrieval: result.retrieval,
      freshness: result.freshness,
    };
    const prevClose = result.quote.prevClose;
    if (
      (!keepExistingChangePct || entry.changePct === null) &&
      typeof prevClose === 'number' &&
      prevClose > 0
    ) {
      entry.changePct = ((result.quote.close - prevClose) / prevClose) * 100;
    }
  }
};
