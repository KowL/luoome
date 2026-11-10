import type { ToolResult } from '@luoome/core';

import type { BatchQuoteTarget } from './types.js';

const INDEX_QUOTES_TTL_MS = 15_000;
const INDEX_QUOTES_STALE_MS = 60_000;

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

/**
 * 指数行情缓存：dashboard 5s 轮询，push2 对高频请求突发限流（2026-07 实测），
 * 15s TTL 把请求量降到 1/3；调用失败时回退最近成功值（60s 内），避免指数条闪空。
 */
export const createIndexQuotesCache = (
  invokeTool: (name: string, input: unknown) => Promise<ToolResult<unknown>>,
): (() => Promise<ToolResult<unknown>>) => {
  let indexQuotesCache: {
    readonly at: number;
    readonly value: { indices: unknown[]; unsupported?: boolean };
  } | null = null;
  return async (): Promise<ToolResult<unknown>> => {
    const now = Date.now();
    if (indexQuotesCache !== null && now - indexQuotesCache.at < INDEX_QUOTES_TTL_MS) {
      return { ok: true, data: indexQuotesCache.value };
    }
    const result = await invokeTool('fetch_index_quotes', {});
    if (result.ok) {
      indexQuotesCache = {
        at: now,
        value: result.data as { indices: unknown[]; unsupported?: boolean },
      };
      return result;
    }
    if (indexQuotesCache !== null && now - indexQuotesCache.at < INDEX_QUOTES_STALE_MS) {
      return { ok: true, data: { ...indexQuotesCache.value, stale: true } };
    }
    return result;
  };
};
