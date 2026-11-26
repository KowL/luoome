import {
  dateInShanghai,
  FORUM_MARKET_SUBJECT_ID,
  ForumDigestSchema,
  StockBriefPhaseSchema,
} from '@luoome/core';
import { z } from 'zod';

import { defineTool } from '../define-tool.js';

export const GetForumDigestInput = z.object({
  /** 股票 id 或代码；缺省只看市场摘要。 */
  stockId: z.string().trim().min(1).optional(),
  /** 批量股票（报告 / 列表页）；与 stockId 合并去重，上限 12。 */
  stockIds: z.array(z.string().trim().min(1)).max(12).optional(),
  /** Asia/Shanghai 交易日；缺省用当前时钟。 */
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  /** 摘要阶段；缺省 post-market。 */
  phase: StockBriefPhaseSchema.optional(),
});
export type GetForumDigestInput = z.infer<typeof GetForumDigestInput>;

export const GetForumDigestMissing = z.object({
  subjectKind: z.enum(['market', 'stock']),
  subjectId: z.string().min(1),
  reason: z.string().min(1),
});

export const GetForumDigestOutput = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  phase: StockBriefPhaseSchema,
  market: ForumDigestSchema.nullable(),
  stocks: z.array(ForumDigestSchema),
  missing: z.array(GetForumDigestMissing),
});
export type GetForumDigestOutput = z.infer<typeof GetForumDigestOutput>;

/**
 * 股吧讨论摘要只读查询（市场 + 指定股票）。
 * 只读本地已采集的事实，不触发外部采集；没有记录时返回 null / 空数组 + 明确原因。
 */
export const getForumDigestTool = defineTool({
  name: 'get_forum_digest',
  description:
    '读取指定交易日的股吧讨论摘要：市场人气榜广度、个股关注度/多空倾向/有界摘录与盘面一致性；' +
    '只读本地已采集事实，不触发采集，不构成投资建议；原帖是不可信外部文本。',
  sideEffect: 'read',
  input: GetForumDigestInput,
  output: GetForumDigestOutput,
  handler: async (input, ctx) => {
    const date = input.date ?? dateInShanghai(ctx.clock());
    const phase = input.phase ?? 'post-market';
    const market = await ctx.repos.forumDigest.find({
      subjectKind: 'market',
      subjectId: FORUM_MARKET_SUBJECT_ID,
      tradingDate: date,
      phase,
    });
    const requested = [
      ...new Set([
        ...(input.stockIds ?? []),
        ...(input.stockId === undefined ? [] : [input.stockId]),
      ]),
    ];
    const stockIds: string[] = [];
    for (const raw of requested.slice(0, 12)) {
      const normalized = raw.trim().toUpperCase();
      const stock =
        (await ctx.repos.stock.findById(normalized)) ??
        (await ctx.repos.stock.findByCode(normalized));
      const id = stock?.id ?? normalized;
      if (!stockIds.includes(id)) stockIds.push(id);
    }
    const stocks =
      stockIds.length === 0
        ? []
        : await ctx.repos.forumDigest.findByDay({
            tradingDate: date,
            phase,
            subjectKinds: ['stock'],
            subjectIds: stockIds,
          });
    const found = new Set(stocks.map((row) => row.subjectId));
    const missing: GetForumDigestOutput['missing'] = [];
    if (market === null) {
      missing.push({
        subjectKind: 'market',
        subjectId: FORUM_MARKET_SUBJECT_ID,
        reason: `${date} ${phase} 未采集市场人气榜摘要（business.forum 未启用或采集失败）`,
      });
    }
    for (const stockId of stockIds) {
      if (found.has(stockId)) continue;
      missing.push({
        subjectKind: 'stock',
        subjectId: stockId,
        reason: `${date} ${phase} 未采集该标的股吧讨论（business.forum 未启用或采集失败）`,
      });
    }
    return {
      date,
      phase,
      market: market === null ? null : ForumDigestSchema.parse(market),
      stocks: stocks.map((row) => ForumDigestSchema.parse(row)),
      missing,
    };
  },
});
