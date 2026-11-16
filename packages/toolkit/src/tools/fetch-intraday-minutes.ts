import { dateInShanghai, IntradayMinuteSchema } from '@luoome/core';
import { z } from 'zod';

import { defineTool, errAdapterError } from '../define-tool.js';

/**
 * fetch_intraday_minutes（external / sideEffect）。
 * 当日分时分钟序列（瞬态视图，不落库；volume/amount 是当日累计口径）。
 * 数据源未注册 intraday-minutes capability 时返回 { supported: false, points: [] }
 * —— 合法降级（调用方隐藏分时图），不是错误；
 * 上游抛错按 adapter_error 转译（与 fetch_index_quotes 的用法一致）。
 */
export const FetchIntradayMinutesInput = z.object({
  stockId: z.string().trim().min(1),
});

export const FetchIntradayMinutesOutput = z.object({
  supported: z.boolean(),
  /** 分时序列对应的上海交易日（points 非空时给出）。 */
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  points: z.array(IntradayMinuteSchema),
});

export const fetchIntradayMinutesTool = defineTool({
  name: 'fetch_intraday_minutes',
  description: '拉当日分时分钟序列；数据源不支持时返回 supported: false',
  sideEffect: 'external',
  input: FetchIntradayMinutesInput,
  output: FetchIntradayMinutesOutput,
  handler: async (input, ctx) => {
    const market = ctx.adapters.market;
    try {
      const points = await market.fetchIntradayMinutes(input.stockId);
      const last = points.at(-1);
      return {
        supported: true,
        ...(last === undefined ? {} : { date: dateInShanghai(last.time) }),
        points: [...points],
      };
    } catch (error) {
      const cause = error instanceof Error ? error.message : String(error);
      if (cause.includes('unsupported_capability')) {
        return { supported: false, points: [] };
      }
      return errAdapterError(market.name, cause, true);
    }
  },
});
