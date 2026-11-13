import {
  buildSectorAmountDistribution,
  buildSectorAmountDistributionEmpty,
  dateInShanghai,
  type MarketSnapshotBatch,
  marketRoomEmptyReason,
  type SectorAmountDistribution,
  SectorAmountDistributionSchema,
  type SectorKind,
  SectorKindSchema,
  type SectorRankingEmptyReason,
  type SectorWindowKey,
  SectorWindowKeySchema,
  sectorWindowTarget,
  type ToolContext,
} from '@luoome/core';
import { z } from 'zod';

import { defineTool } from '../define-tool.js';

/**
 * 成交分布（ticket #40）：按 5 / 15 分钟窗口给出各板块成交占比、较上一窗口的百分点变化
 * 与 CR3 集中度。
 *
 * - 只读：锚点、当前窗口起点、上一窗口起点、成分与目录全部来自本地已发布事实，不触发采集；
 * - 派生计算在 core（零 IO），本 tool 只负责按时点取批次与编排；
 * - 给定 `at` 取该时点及之前最近的批次（历史回放入口），缺省读最近一个已发布批次；
 * - 分母无效、窗口缺样本、跨午休、批次不完整一律按缺失返回，不写 0。
 */

const COVERAGE = 'CN_A_SHARES_SH_SZ' as const;

export const GetMarketRoomAmountDistributionInput = z.object({
  kind: SectorKindSchema.default('industry'),
  window: SectorWindowKeySchema.default('w15'),
  at: z.coerce.date().optional(),
});
export type GetMarketRoomAmountDistributionInputT = z.infer<
  typeof GetMarketRoomAmountDistributionInput
>;

export const GetMarketRoomAmountDistributionOutput = z.object({
  distribution: SectorAmountDistributionSchema,
});
export type GetMarketRoomAmountDistributionOutputT = z.infer<
  typeof GetMarketRoomAmountDistributionOutput
>;

const emptyDistribution = (input: {
  readonly kind: SectorKind;
  readonly window: SectorWindowKey;
  readonly reason: SectorRankingEmptyReason;
  readonly latest: MarketSnapshotBatch | null;
}): GetMarketRoomAmountDistributionOutputT => ({
  distribution: buildSectorAmountDistributionEmpty({
    kind: input.kind,
    window: input.window,
    reason: input.reason,
    latest: input.latest,
  }),
});

const resolveAnchor = async (
  ctx: ToolContext,
  at: Date | undefined,
): Promise<
  | {
      readonly kind: 'empty';
      readonly reason: SectorRankingEmptyReason;
      readonly latest: MarketSnapshotBatch | null;
    }
  | { readonly kind: 'ready'; readonly anchor: MarketSnapshotBatch }
> => {
  if (at === undefined) {
    const latest = await ctx.repos.marketSnapshotBatch.findLatest({ coverage: COVERAGE });
    if (latest === null) return { kind: 'empty', reason: 'no_batch', latest: null };
    // 未指定时点时沿用总览的空态口径：非交易日 / 盘前 / 当日无批次都不拿旧批次当当日盘面。
    const reason = marketRoomEmptyReason(ctx.clock(), latest);
    if (reason !== null) return { kind: 'empty', reason, latest };
    return { kind: 'ready', anchor: latest };
  }
  const anchor = await ctx.repos.marketSnapshotBatch.findAtOrBefore({
    coverage: COVERAGE,
    tradingDate: dateInShanghai(at),
    sampledAt: at,
  });
  if (anchor === null) return { kind: 'empty', reason: 'no_batch', latest: null };
  return { kind: 'ready', anchor };
};

/** 当前窗口起点 = 锚点 − 窗口分钟；上一窗口起点再往前一个窗口。 */
const resolveWindowStarts = async (
  ctx: ToolContext,
  anchor: MarketSnapshotBatch,
  window: SectorWindowKey,
): Promise<{
  readonly currentStart: MarketSnapshotBatch | null;
  readonly previousStart: MarketSnapshotBatch | null;
}> => {
  const read = (target: Date): Promise<MarketSnapshotBatch | null> =>
    ctx.repos.marketSnapshotBatch.findAtOrBefore({
      coverage: COVERAGE,
      tradingDate: anchor.tradingDate,
      sampledAt: target,
    });
  const currentTarget = sectorWindowTarget(anchor.sampledAt, window);
  return {
    currentStart: await read(currentTarget),
    previousStart: await read(sectorWindowTarget(currentTarget, window)),
  };
};

export const getMarketRoomAmountDistributionTool = defineTool({
  name: 'get_market_room_amount_distribution',
  description:
    '读取成交分布：按 5 / 15 分钟窗口给出行业或概念板块的窗口成交占比（成分累计成交额增量 ÷ 同期全市场去重增量）、较上一窗口的百分点环比与 CR3 集中度；每行带有效成分 / 缺失 / 停牌退市计数与口径说明，分母无效、窗口缺样本、跨午休或批次不完整时一律返回 null + 原因，绝不补零；概念成分可重叠，占比不可加总；只读不采集',
  sideEffect: 'read',
  input: GetMarketRoomAmountDistributionInput,
  output: GetMarketRoomAmountDistributionOutput,
  handler: async (input, ctx) => {
    const base = { kind: input.kind, window: input.window };
    const anchorResult = await resolveAnchor(ctx, input.at);
    if (anchorResult.kind === 'empty') {
      return emptyDistribution({
        ...base,
        reason: anchorResult.reason,
        latest: anchorResult.latest,
      });
    }
    const { anchor } = anchorResult;

    const sectors = await ctx.repos.sectorCatalog.listSectors({ kinds: [input.kind] });
    if (sectors.length === 0) {
      return emptyDistribution({ ...base, reason: 'no_sector_catalog', latest: anchor });
    }
    const members = await ctx.repos.sectorCatalog.listBySectors({
      sectorIds: sectors.map((sector) => sector.id),
    });
    if (members.length === 0) {
      return emptyDistribution({ ...base, reason: 'no_members', latest: anchor });
    }

    const { currentStart, previousStart } = await resolveWindowStarts(ctx, anchor, input.window);
    const distribution: SectorAmountDistribution = buildSectorAmountDistribution({
      kind: input.kind,
      window: input.window,
      anchor,
      currentStart,
      previousStart,
      sectors,
      members,
    });
    return { distribution };
  },
});
