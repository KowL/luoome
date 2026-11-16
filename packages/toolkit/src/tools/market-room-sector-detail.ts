import {
  buildSectorDetail,
  buildSectorDetailEmpty,
  type SectorCatalogEntry,
  SectorDetailSchema,
  SectorWindowKeySchema,
  type StockSectorMembership,
  type ToolContext,
} from '@luoome/core';
import { z } from 'zod';

import { defineTool } from '../define-tool.js';
import {
  MARKET_ROOM_COVERAGE,
  marketRoomWindowStartsFromBatches,
  readMarketRoomLimitUp,
  resolveMarketRoomAnchor,
} from '../internal/market-room-anchor.js';

/**
 * 板块详情（ticket #39）：单板块走势 + 成分明细 + 多板块对照与领先顺序。
 *
 * - 只读：只组合本地已发布批次、板块目录 / 成分与当日天梯，不触发采集；
 * - 全部派生在 core（零 IO）；本 tool 只负责按时点取批次、解析板块与对照列表；
 * - 走势按批次时点由成分等权合成（本地没有板块指数序列），method 字段显式标注；
 * - 给定 `at` 取该时点及之前最近的批次，走势只使用该批次及之前的样本；
 * - 对照板块不存在时进入 unresolvedSectorIds，不伪造序列。
 */

const MAX_COMPARISONS = 5;

export const GetMarketRoomSectorDetailInput = z.object({
  sectorId: z.string().trim().min(1),
  at: z.coerce.date().optional(),
  window: SectorWindowKeySchema.default('w15'),
  compareSectorIds: z.array(z.string().trim().min(1)).max(MAX_COMPARISONS).default([]),
});
export type GetMarketRoomSectorDetailInputT = z.infer<typeof GetMarketRoomSectorDetailInput>;

export const GetMarketRoomSectorDetailOutput = z.object({
  detail: SectorDetailSchema,
});
export type GetMarketRoomSectorDetailOutputT = z.infer<typeof GetMarketRoomSectorDetailOutput>;

/** 目录：最新模式读当前 active；回放读该时点生效的目录，不拿今天的板块顶替。 */
const listActiveSectors = (
  ctx: ToolContext,
  asOf: Date | undefined,
): Promise<readonly SectorCatalogEntry[]> =>
  asOf === undefined
    ? ctx.repos.sectorCatalog.listSectors({ state: 'active' })
    : ctx.repos.sectorCatalog.listSectorsAsOf({ at: asOf });

const activeMembersBySector = (
  memberships: readonly StockSectorMembership[],
): Map<string, readonly StockSectorMembership[]> => {
  const map = new Map<string, StockSectorMembership[]>();
  for (const membership of memberships) {
    if (membership.state !== 'active') continue;
    const list = map.get(membership.sectorId) ?? [];
    list.push(membership);
    map.set(membership.sectorId, list);
  }
  return map;
};

export const getMarketRoomSectorDetailTool = defineTool({
  name: 'get_market_room_sector_detail',
  description:
    '读取单个板块的盘中详情（给定 at 时只读该时点及之前批次，走势 / 成分 / 封板数都按当时生效的信息计算）：按批次时点的成分等权合成走势（归一化到首个样本=100，method 显式标注、不用大盘指数冒充）、独立于指数的成分上涨比例、日涨幅与窗口涨幅、窗口成交占比、封板数、成分明细（日涨幅 / 窗口涨幅 / 窗口成交额增量占比 / 封板 / 停牌状态），以及多个对照板块的并列走势与领先顺序变化时点；缺失样本与口径差异逐项标注；只读不采集',
  sideEffect: 'read',
  input: GetMarketRoomSectorDetailInput,
  output: GetMarketRoomSectorDetailOutput,
  handler: async (input, ctx) => {
    const base = { window: input.window };
    const anchorResult = await resolveMarketRoomAnchor(ctx, input.at);
    if (anchorResult.kind === 'empty') {
      // 空态仍尽量带上板块身份，便于页面显示「哪个板块暂无数据」。
      const sectors = await listActiveSectors(ctx, input.at).catch(
        () => [] as SectorCatalogEntry[],
      );
      const sector = sectors.find((entry) => entry.id === input.sectorId) ?? null;
      return {
        detail: buildSectorDetailEmpty({
          ...base,
          reason: anchorResult.reason,
          sector,
          latest: anchorResult.latest,
        }),
      };
    }
    const { anchor } = anchorResult;
    const sectors = await listActiveSectors(ctx, input.at);
    if (sectors.length === 0) {
      return {
        detail: buildSectorDetailEmpty({
          ...base,
          reason: 'no_sector_catalog',
          sector: null,
          latest: anchor,
        }),
      };
    }
    const sector = sectors.find((entry) => entry.id === input.sectorId) ?? null;
    if (sector === null) {
      return {
        detail: buildSectorDetailEmpty({
          ...base,
          reason: 'sector_not_found',
          sector: null,
          latest: anchor,
        }),
      };
    }

    const compareIds = [...new Set(input.compareSectorIds)].filter(
      (sectorId) => sectorId !== sector.id,
    );
    const byId = new Map(sectors.map((entry) => [entry.id, entry]));
    const comparisons: SectorCatalogEntry[] = [];
    const unresolvedSectorIds: string[] = [];
    for (const sectorId of compareIds) {
      const comparison = byId.get(sectorId);
      if (comparison === undefined) unresolvedSectorIds.push(sectorId);
      else comparisons.push(comparison);
    }

    const detailSectorIds = [sector.id, ...comparisons.map((entry) => entry.id)];
    const memberships =
      input.at === undefined
        ? await ctx.repos.sectorCatalog.listBySectors({ sectorIds: detailSectorIds })
        : await ctx.repos.sectorCatalog.listBySectorsAsOf({
            sectorIds: detailSectorIds,
            at: input.at,
          });
    const membersBySector = activeMembersBySector(memberships);
    if ((membersBySector.get(sector.id) ?? []).length === 0) {
      return {
        detail: buildSectorDetailEmpty({
          ...base,
          reason: 'no_members',
          sector,
          latest: anchor,
        }),
      };
    }

    const dayBatches = await ctx.repos.marketSnapshotBatch.listByTradingDate({
      coverage: MARKET_ROOM_COVERAGE,
      tradingDate: anchor.tradingDate,
    });
    const batches = dayBatches.filter(
      (batch) => batch.sampledAt.getTime() <= anchor.sampledAt.getTime(),
    );
    const windowStarts = marketRoomWindowStartsFromBatches(
      batches.length === 0 ? [anchor] : batches,
      anchor,
    );
    const limitUp = await readMarketRoomLimitUp(ctx, anchor, input.at);
    return {
      detail: buildSectorDetail({
        sector,
        comparisons,
        unresolvedSectorIds,
        membersBySector,
        batches: batches.length === 0 ? [anchor] : batches,
        window: input.window,
        windowStarts,
        limitUp: limitUp.ladder,
        limitUpError: limitUp.error,
      }),
    };
  },
});
