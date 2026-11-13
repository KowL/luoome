import {
  buildSectorIntradayEmptyRanking,
  buildSectorIntradayRanking,
  dateInShanghai,
  type LimitUpLadder,
  type MarketSnapshotBatch,
  marketRoomEmptyReason,
  SectorIntradayRankingSchema,
  type SectorIntradaySort,
  SectorIntradaySortSchema,
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
 * 板块盘中榜（ticket #38）：行业 / 概念可切换，同一张榜给出日涨幅与近 5 / 15 分钟窗口涨幅，
 * 两种口径可分别排序。
 *
 * - 只读：锚点批次、窗口起点批次、成分与当日天梯全部来自本地已发布事实，不触发采集；
 * - 派生计算在 core（零 IO），本 tool 只负责按时点取批次与编排；
 * - 给定 `at` 取该时点及之前最近的批次（历史回放入口），缺省读最近一个已发布批次；
 * - 缺天梯快照、窗口不可比、分母无效都按缺失返回，不写 0。
 */

const COVERAGE = 'CN_A_SHARES_SH_SZ' as const;
/** 天梯快照来源与 `limit_up_ladder` tool 的默认源一致。 */
const LIMIT_UP_SOURCE = 'eastmoney';

export const GetMarketRoomSectorsInput = z.object({
  kind: SectorKindSchema.default('industry'),
  sort: SectorIntradaySortSchema.default('day'),
  window: SectorWindowKeySchema.default('w15'),
  at: z.coerce.date().optional(),
});
export type GetMarketRoomSectorsInputT = z.infer<typeof GetMarketRoomSectorsInput>;

export const GetMarketRoomSectorsOutput = z.object({
  ranking: SectorIntradayRankingSchema,
});
export type GetMarketRoomSectorsOutputT = z.infer<typeof GetMarketRoomSectorsOutput>;

const emptyRanking = (input: {
  readonly kind: SectorKind;
  readonly sort: SectorIntradaySort;
  readonly window: SectorWindowKey;
  readonly reason: SectorRankingEmptyReason;
  readonly latest: MarketSnapshotBatch | null;
}) => ({
  ranking: buildSectorIntradayEmptyRanking({
    kind: input.kind,
    sort: input.sort,
    window: input.window,
    reason: input.reason,
    latest: input.latest,
  }),
});

const readLimitUp = async (
  ctx: ToolContext,
  tradingDate: string,
): Promise<{ readonly ladder: LimitUpLadder | null; readonly error: string | null }> => {
  try {
    const ladder = await ctx.repos.limitUpLadderSnapshot.findByDate({
      date: tradingDate,
      source: LIMIT_UP_SOURCE,
    });
    return { ladder, error: null };
  } catch (error) {
    return { ladder: null, error: error instanceof Error ? error.message : String(error) };
  }
};

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

const resolveWindowStarts = async (
  ctx: ToolContext,
  anchor: MarketSnapshotBatch,
): Promise<Record<SectorWindowKey, MarketSnapshotBatch | null>> => {
  const read = async (key: SectorWindowKey): Promise<MarketSnapshotBatch | null> =>
    ctx.repos.marketSnapshotBatch.findAtOrBefore({
      coverage: COVERAGE,
      tradingDate: anchor.tradingDate,
      sampledAt: sectorWindowTarget(anchor.sampledAt, key),
    });
  return { w5: await read('w5'), w15: await read('w15') };
};

export const getMarketRoomSectorsTool = defineTool({
  name: 'get_market_room_sectors',
  description:
    '读取板块盘中榜：行业 / 概念可切换，同一张榜给出日涨幅（相对前收的等权均值）与近 5 / 15 分钟窗口涨幅（窗口两端价格），可按三种口径分别排序；每行带上涨 / 下跌 / 平家数、有效成分与缺失成分数、封板数与窗口成交占比及口径说明，缺失一律标注不补零；只读不采集',
  sideEffect: 'read',
  input: GetMarketRoomSectorsInput,
  output: GetMarketRoomSectorsOutput,
  handler: async (input, ctx) => {
    const base = { kind: input.kind, sort: input.sort, window: input.window };
    const anchorResult = await resolveAnchor(ctx, input.at);
    if (anchorResult.kind === 'empty') {
      return emptyRanking({ ...base, reason: anchorResult.reason, latest: anchorResult.latest });
    }
    const { anchor } = anchorResult;

    const sectors = await ctx.repos.sectorCatalog.listSectors({ kinds: [input.kind] });
    if (sectors.length === 0) {
      return emptyRanking({ ...base, reason: 'no_sector_catalog', latest: anchor });
    }
    const members = await ctx.repos.sectorCatalog.listBySectors({
      sectorIds: sectors.map((sector) => sector.id),
    });
    if (members.length === 0) {
      return emptyRanking({ ...base, reason: 'no_members', latest: anchor });
    }

    const windowStarts = await resolveWindowStarts(ctx, anchor);
    const limitUp = await readLimitUp(ctx, anchor.tradingDate);
    return {
      ranking: buildSectorIntradayRanking({
        kind: input.kind,
        sort: input.sort,
        window: input.window,
        anchor,
        windowStarts,
        sectors,
        members,
        limitUp: limitUp.ladder,
        limitUpError: limitUp.error,
      }),
    };
  },
});
