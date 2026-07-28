import { IndexQuoteSchema } from '@luoome/core';
import { z } from 'zod';

import { defineTool, errAdapterError } from '../define-tool.js';

/**
 * fetch_index_quotes（external / sideEffect）。
 * 拉主要大盘指数实时行情（指数集合由数据源决定，eastmoney 覆盖
 * 上证 / 深成 / 创业板 / 沪深300 / 科创50）。
 * 数据源未实现 fetchIndexQuotes（不支持指数行情）时返回
 * { indices: [], unsupported: true } —— 合法降级，不是错误；
 * 上游抛错按 adapter_error 转译（与 get_stock_market_view 对上游失败的 kind 用法一致）。
 */
export const FetchIndexQuotesInput = z.object({});

export const FetchIndexQuotesOutput = z.object({
  indices: z.array(IndexQuoteSchema),
  /** true 表示当前行情数据源不支持指数行情（降级信号，调用方应隐藏该区块）。 */
  unsupported: z.boolean().optional(),
});

export const fetchIndexQuotesTool = defineTool({
  name: 'fetch_index_quotes',
  description: '拉主要大盘指数实时行情；数据源不支持时返回 unsupported: true',
  sideEffect: 'external',
  input: FetchIndexQuotesInput,
  output: FetchIndexQuotesOutput,
  handler: async (_input, ctx) => {
    const market = ctx.adapters.market;
    try {
      const indices = await market.fetchIndexQuotes();
      return { indices: [...indices] };
    } catch (error) {
      const cause = error instanceof Error ? error.message : String(error);
      if (cause.includes('unsupported_capability')) {
        return { indices: [], unsupported: true };
      }
      return errAdapterError(market.name, cause, true);
    }
  },
});
