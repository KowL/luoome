import {
  assertThemeLibraryRotationInvariants,
  buildThemeLibraryRotation,
  buildThemeLibraryRotationEmpty,
  type SectorMemberStatus,
  SectorWindowKeySchema,
  type ThemeLibraryEmptyReason,
  ThemeLibraryRotationSchema,
  type ThemeLibraryThemeRow,
} from '@luoome/core';
import { z } from 'zod';

import { defineTool } from '../define-tool.js';
import {
  MARKET_ROOM_COVERAGE,
  marketRoomWindowStartsFromBatches,
  readMarketRoomLimitUp,
  readMarketRoomStockUniverse,
  resolveMarketRoomAnchor,
} from '../internal/market-room-anchor.js';

/**
 * 作战室「题材」视图：只读系统题材库，按固定顺序展示已启用题材。
 *
 * - 只读本地已发布批次与题材库；不读原始概念目录，也不触发采集；
 * - 日 / 5 / 15 分钟涨幅与日内走势都按各批次当时生效的成分计算，缺口不插值；
 * - 成分、批次与名称都一次性批量读取，不逐题材逐分钟查询数据库；
 * - 给定 at 时只使用该时点及之前的批次与当时生效成分，回放不应用未来变更。
 */

export const GetMarketRoomThemesInput = z.object({
  window: SectorWindowKeySchema.default('w15'),
  /** 只给该题材返回成分明细；缺省时只返回题材指标与走势，避免整库成分一次铺开。 */
  themeId: z.string().trim().min(1).optional(),
  at: z.coerce.date().optional(),
});
export type GetMarketRoomThemesInputT = z.infer<typeof GetMarketRoomThemesInput>;

export const GetMarketRoomThemesOutput = z.object({
  rotation: ThemeLibraryRotationSchema,
});
export type GetMarketRoomThemesOutputT = z.infer<typeof GetMarketRoomThemesOutput>;

const EMPTY = (input: {
  readonly window: GetMarketRoomThemesInputT['window'];
  readonly reason: ThemeLibraryEmptyReason;
  readonly latest: Parameters<typeof buildThemeLibraryRotationEmpty>[0]['latest'];
  readonly batches?: Parameters<typeof buildThemeLibraryRotationEmpty>[0]['batches'];
}) => ({
  rotation: buildThemeLibraryRotationEmpty({
    window: input.window,
    reason: input.reason,
    latest: input.latest,
    ...(input.batches === undefined ? {} : { batches: input.batches }),
  }),
});

export const getMarketRoomThemesTool = defineTool({
  name: 'get_market_room_themes',
  description:
    '读取作战室系统题材行情：按当前有效成分和最新行情批次，按固定顺序返回日涨幅、近 5 / 15 分钟涨幅、按批次合成的日内走势、轮动卡前五只个股摘要与当日可选批次时间轴；给定 at 时只读该时点及之前批次与当时生效成分，不使用未来增删；缺口不插值、不补零；只读不采集',
  sideEffect: 'read',
  input: GetMarketRoomThemesInput,
  output: GetMarketRoomThemesOutput,
  handler: async (input, ctx) => {
    const anchorResult = await resolveMarketRoomAnchor(ctx, input.at);
    if (anchorResult.kind === 'empty') {
      return EMPTY({
        window: input.window,
        reason: anchorResult.reason as ThemeLibraryEmptyReason,
        latest: anchorResult.latest,
      });
    }
    const { anchor } = anchorResult;
    const [themes, sources, members] = await Promise.all([
      ctx.repos.themeLibrary.listThemes({ state: 'all' }),
      ctx.repos.themeLibrary.listSources(),
      ctx.repos.themeLibrary.listMembers(),
    ]);
    if (themes.length === 0) {
      return EMPTY({ window: input.window, reason: 'no_theme_library', latest: anchor });
    }
    if (!themes.some((theme) => theme.state === 'active')) {
      return EMPTY({ window: input.window, reason: 'no_active_theme', latest: anchor });
    }

    const dayBatches = await ctx.repos.marketSnapshotBatch.listByTradingDate({
      coverage: MARKET_ROOM_COVERAGE,
      tradingDate: anchor.tradingDate,
    });
    // 时间轴列当日全部已发布批次（回拖后仍能向前选）；走势与窗口起点内部只取锚点及之前。
    const batches = dayBatches.length === 0 ? [anchor] : dayBatches;
    const windowStarts = marketRoomWindowStartsFromBatches(batches, anchor);
    const [universe, limitUp] = await Promise.all([
      readMarketRoomStockUniverse(ctx, input.at),
      readMarketRoomLimitUp(ctx, anchor, input.at),
    ]);
    const statusByStock = new Map<string, SectorMemberStatus>();
    const namesByStock = new Map<string, string>();
    for (const entry of universe) {
      namesByStock.set(entry.stockId, entry.name);
      statusByStock.set(entry.stockId, entry.listingStatus);
    }
    const rotation = buildThemeLibraryRotation({
      window: input.window,
      anchor,
      windowStarts,
      batches,
      themes,
      sources,
      members,
      statusByStock,
      namesByStock,
      limitUp: limitUp.ladder,
      limitUpError: limitUp.error,
      membershipAt: input.at === undefined ? ctx.clock() : anchor.sampledAt,
      detailThemeId: input.themeId ?? null,
    });
    assertThemeLibraryRotationInvariants(rotation);
    return { rotation };
  },
});

export type { ThemeLibraryThemeRow };
