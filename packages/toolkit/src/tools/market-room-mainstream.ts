import {
  buildMainstreamStockBoard,
  buildMainstreamStockBoardEmpty,
  buildMainstreamThemeMap,
  buildMainstreamThemeMapEmpty,
  MainstreamStockBoardSchema,
  MainstreamThemeMapSchema,
  type MarketSnapshotBatch,
  SectorIntradaySortSchema,
  type SectorRankingEmptyReason,
  type SectorWindowKey,
  SectorWindowKeySchema,
  sectorWindowTarget,
} from '@luoome/core';
import { z } from 'zod';

import { defineTool } from '../define-tool.js';
import {
  readMarketRoomLadderSamples,
  readMarketRoomLimitUp,
  readMarketRoomStockUniverse,
  readMarketRoomWindowStart,
  resolveMarketRoomAnchor,
  resolveMarketRoomWindowStarts,
} from '../internal/market-room-anchor.js';

/**
 * 主流题材地图与短线核心股（v2）：固定父板块 + 版本化标准题材定义 + 原始概念成分并集行情。
 *
 * - 只读：目录、成分、锚点批次、窗口起点、天梯样本与股票目录全部来自本地已发布事实，不触发采集；
 * - 派生计算在 core（零 IO），本 tool 只负责按时点取数；地图与核心股共用同一 anchor 与同一并集；
 * - 标准题材核心股 = 领涨 / 当前窗口成交额增量最高 / 最高连板 + 当前窗口成交额增量补足，最多 5 只；
 * - 中文名只取 stockUniverse；ST 默认不参与核心股与占比分母，但保留在全部成分里；
 * - 给定 `at` 取该时点及之前最近的批次与当时生效的目录 / 成分，回放不偷偷改历史成分；
 * - 缺失样本、分母无效、窗口不可比都按缺失返回，不写 0。
 */

export const GetMarketRoomMainstreamInput = z.object({
  sort: SectorIntradaySortSchema.default('day'),
  window: SectorWindowKeySchema.default('w15'),
  at: z.coerce.date().optional(),
});
export type GetMarketRoomMainstreamInputT = z.infer<typeof GetMarketRoomMainstreamInput>;

export const GetMarketRoomMainstreamOutput = z.object({
  mainstream: MainstreamThemeMapSchema,
  stockBoard: MainstreamStockBoardSchema,
});
export type GetMarketRoomMainstreamOutputT = z.infer<typeof GetMarketRoomMainstreamOutput>;

const emptyOutput = (input: {
  readonly sort: GetMarketRoomMainstreamInputT['sort'];
  readonly window: SectorWindowKey;
  readonly reason: SectorRankingEmptyReason;
  readonly latest: MarketSnapshotBatch | null;
}): GetMarketRoomMainstreamOutputT => ({
  mainstream: buildMainstreamThemeMapEmpty({
    sort: input.sort,
    window: input.window,
    reason: input.reason,
    latest: input.latest,
  }),
  stockBoard: buildMainstreamStockBoardEmpty({
    window: input.window,
    reason: input.reason,
    latest: input.latest,
  }),
});

export const getMarketRoomMainstreamTool = defineTool({
  name: 'get_market_room_mainstream',
  description:
    '读取主流题材地图与短线核心股：固定父板块（科技 / 新能源 / 汽车与智能出行 / 医药医疗 / 消费 / 周期资源 / 金融 / 军工与高端制造 / 地产基建 / 公用事业与交通运输 / 农业）与版本化标准题材定义，主流方向无论涨跌都返回；标准题材行情与核心股都取所映射原始概念的 active 成分股票并集，同一 stockId 只计一次；每个标准题材返回日涨幅领涨代表股、最多 5 只核心股（领涨 / 当前窗口成交额增量最高 / 最高连板 / 增量补位）与全部成分的 close、日涨幅、5 / 15 分钟涨幅、今日累计成交额、窗口成交额增量、题材内窗口成交占比与环比、封板与连板；中文名只取 stockUniverse，ST 默认不参与核心股与占比分母；缺口、负修正、分母无效与窗口不可比一律缺失不补零；给定 at 时只读该时点及之前批次与当时生效的目录与成分；只读不采集',
  sideEffect: 'read',
  input: GetMarketRoomMainstreamInput,
  output: GetMarketRoomMainstreamOutput,
  handler: async (input, ctx) => {
    const base = { sort: input.sort, window: input.window };
    const anchorResult = await resolveMarketRoomAnchor(ctx, input.at);
    if (anchorResult.kind === 'empty') {
      return emptyOutput({ ...base, reason: anchorResult.reason, latest: anchorResult.latest });
    }
    const { anchor } = anchorResult;

    const sectors =
      input.at === undefined
        ? await ctx.repos.sectorCatalog.listSectors({ kinds: ['concept'] })
        : await ctx.repos.sectorCatalog.listSectorsAsOf({ kinds: ['concept'], at: input.at });
    if (sectors.length === 0) {
      return emptyOutput({ ...base, reason: 'no_sector_catalog', latest: anchor });
    }
    const sectorIds = sectors.map((sector) => sector.id);
    const members =
      input.at === undefined
        ? await ctx.repos.sectorCatalog.listBySectors({ sectorIds })
        : await ctx.repos.sectorCatalog.listBySectorsAsOf({ sectorIds, at: input.at });
    if (members.length === 0) {
      return emptyOutput({ ...base, reason: 'no_members', latest: anchor });
    }

    const windowStarts = await resolveMarketRoomWindowStarts(ctx, anchor);
    const currentStart = windowStarts[input.window];
    const previousStart =
      currentStart === null
        ? null
        : await readMarketRoomWindowStart(
            ctx,
            anchor,
            sectorWindowTarget(currentStart.sampledAt, input.window),
          );
    const previousWindowStarts: Record<SectorWindowKey, MarketSnapshotBatch | null> = {
      w5: input.window === 'w5' ? previousStart : null,
      w15: input.window === 'w15' ? previousStart : null,
    };
    const [limitUp, ladderSamples, universe] = await Promise.all([
      readMarketRoomLimitUp(ctx, anchor, input.at),
      readMarketRoomLadderSamples(ctx, anchor.tradingDate),
      readMarketRoomStockUniverse(ctx, input.at),
    ]);
    return {
      mainstream: buildMainstreamThemeMap({
        ...base,
        anchor,
        windowStarts,
        sectors,
        members,
        limitUp: limitUp.ladder,
        limitUpError: limitUp.error,
      }),
      stockBoard: buildMainstreamStockBoard({
        window: input.window,
        anchor,
        windowStarts,
        previousWindowStarts,
        sectors,
        members,
        ladderSamples: ladderSamples.samples,
        universe,
      }),
    };
  },
});
