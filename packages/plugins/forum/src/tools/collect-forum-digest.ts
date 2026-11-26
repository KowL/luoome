import { dateInShanghai, StockBriefPhaseSchema, type ToolContext } from '@luoome/core';
import { defineTool } from '@luoome/toolkit';
import { z } from 'zod';

import { collectForumDigests, FORUM_COLLECTION_MAX_STOCKS } from '../internal/collect.js';

export const CollectForumDigestInput = z.object({
  /** Asia/Shanghai 交易日；缺省用当前时钟。 */
  tradingDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  phase: StockBriefPhaseSchema.default('post-market'),
  /** 候选股（股票 id 或代码）；论坛不得扩池，上限 12。 */
  stockIds: z.array(z.string().trim().min(1)).max(FORUM_COLLECTION_MAX_STOCKS).optional(),
});
export type CollectForumDigestInput = z.infer<typeof CollectForumDigestInput>;

export const CollectForumDigestItem = z.object({
  subjectKind: z.enum(['market', 'stock']),
  subjectId: z.string().min(1),
  digestId: z.string().min(1).optional(),
  coverage: z.enum(['ok', 'partial', 'empty', 'unavailable']),
  reason: z.string().min(1).optional(),
});

export const CollectForumDigestOutput = z.object({
  tradingDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  phase: StockBriefPhaseSchema,
  items: z.array(CollectForumDigestItem),
});
export type CollectForumDigestOutput = z.infer<typeof CollectForumDigestOutput>;

const resolveStockIds = async (
  ctx: ToolContext,
  input: readonly string[] | undefined,
): Promise<string[]> => {
  const resolved: string[] = [];
  for (const raw of input ?? []) {
    const normalized = raw.trim().toUpperCase();
    const stock =
      (await ctx.repos.stock.findById(normalized)) ??
      (await ctx.repos.stock.findByCode(normalized));
    resolved.push(stock?.id ?? normalized);
  }
  return resolved;
};

/**
 * 采集市场 + 指定候选股的股吧讨论摘要（写库 + 外部网络，默认关闭）。
 *
 * 采集不做 LLM 推理：清洗 / 去重 / 导流过滤 / 质量门 / 倾向词表全部确定性。
 * 单源失败只落 unavailable 摘要并返回原因，不伪造 0，也不阻塞每日建议链路。
 */
export const collectForumDigestTool = defineTool({
  name: 'collect_forum_digest',
  description:
    '采集指定交易日市场人气榜广度与候选股的股吧讨论摘要（关注度、多空倾向、有界摘录、盘面一致性），' +
    '按 (subjectKind, subjectId, tradingDate, phase) 幂等落库；只使用公开股吧页面与公开人气榜，' +
    '不调用 LLM，不扩候选池，不产生交易动作。',
  sideEffect: 'write',
  requiredCapabilities: ['write', 'external'],
  input: CollectForumDigestInput,
  output: CollectForumDigestOutput,
  handler: async (input, ctx) => {
    const tradingDate = input.tradingDate ?? dateInShanghai(ctx.clock());
    const stockIds = await resolveStockIds(ctx, input.stockIds);
    const summary = await collectForumDigests(
      ctx,
      { tradingDate, phase: input.phase, stockIds },
      {
        enabled: ctx.executionPolicy?.isEnabled('business.forum') ?? false,
        now: ctx.clock,
      },
    );
    return { ...summary, items: [...summary.items] };
  },
});
