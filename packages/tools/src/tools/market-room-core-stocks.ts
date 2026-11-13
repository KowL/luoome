import {
  buildMarketRoomCoreStocks,
  buildMarketRoomCoreStocksEmpty,
  CoreRoleKindSchema,
  dateInShanghai,
  type LimitUpLadderSample,
  MarketRoomCoreStocksSchema,
  type MarketSnapshotBatch,
  marketRoomEmptyReason,
  type SectorCatalogEntry,
  type SectorWindowKey,
  type StockSectorMembership,
  type StockSectorMembershipView,
  sectorWindowTarget,
  type ToolContext,
} from '@luoome/core';
import { z } from 'zod';

import { defineTool } from '../define-tool.js';

/**
 * 核心股角色与换位时间线（ticket #41）。
 *
 * - 只读：组合本地已发布批次、按采样时点保存的天梯事实、板块目录 / 成分，
 *   不触发采集；
 * - 派生全部在 core（零 IO），本 tool 只负责按时点取事实并补齐反查所需的题材数据；
 * - 角色与时间线在多时点上前缀复算，`at` 只返回该时点及之前的事实；
 * - 从核心股反查时先取角色持有者，再按需读取这些股票的题材与其他成员；
 * - `kind` 只筛选反查范围（启动先锋 / 成交核心 / 高度标），不影响角色计算本身。
 */

const COVERAGE = 'CN_A_SHARES_SH_SZ' as const;
const LIMIT_UP_SOURCE = 'eastmoney';
const CORE_STOCKS_WINDOW: SectorWindowKey = 'w15';

export const GetMarketRoomCoreStocksInput = z.object({
  sectorId: z.string().trim().min(1),
  at: z.coerce.date().optional(),
  /** 只反查指定角色的持有者；缺省反查全部角色。 */
  kind: CoreRoleKindSchema.optional(),
});
export type GetMarketRoomCoreStocksInputT = z.infer<typeof GetMarketRoomCoreStocksInput>;

export const GetMarketRoomCoreStocksOutput = z.object({
  coreStocks: MarketRoomCoreStocksSchema,
});
export type GetMarketRoomCoreStocksOutputT = z.infer<typeof GetMarketRoomCoreStocksOutput>;

type AnchorResult =
  | {
      readonly kind: 'empty';
      readonly reason: Parameters<typeof buildMarketRoomCoreStocksEmpty>[0]['reason'];
      readonly latest: MarketSnapshotBatch | null;
    }
  | { readonly kind: 'ready'; readonly anchor: MarketSnapshotBatch };

const resolveAnchor = async (ctx: ToolContext, at: Date | undefined): Promise<AnchorResult> => {
  if (at === undefined) {
    const latest = await ctx.repos.marketSnapshotBatch.findLatest({ coverage: COVERAGE });
    if (latest === null) return { kind: 'empty', reason: 'no_batch', latest: null };
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

const windowStartOf = (
  batches: readonly MarketSnapshotBatch[],
  anchor: MarketSnapshotBatch,
): MarketSnapshotBatch | null => {
  const target = sectorWindowTarget(anchor.sampledAt, CORE_STOCKS_WINDOW);
  return (
    [...batches].reverse().find((batch) => batch.sampledAt.getTime() <= target.getTime()) ?? null
  );
};

const readLadderSamples = async (
  ctx: ToolContext,
  tradingDate: string,
): Promise<{ readonly samples: readonly LimitUpLadderSample[]; readonly error: string | null }> => {
  try {
    const samples = await ctx.repos.limitUpLadderSample.listByTradingDate({
      tradingDate,
      source: LIMIT_UP_SOURCE,
    });
    return { samples, error: null };
  } catch (error) {
    return { samples: [], error: error instanceof Error ? error.message : String(error) };
  }
};

const groupMembers = (
  memberships: readonly StockSectorMembership[],
): Map<string, StockSectorMembership[]> => {
  const map = new Map<string, StockSectorMembership[]>();
  for (const membership of memberships) {
    if (membership.state !== 'active') continue;
    const list = map.get(membership.sectorId) ?? [];
    list.push(membership);
    map.set(membership.sectorId, list);
  }
  return map;
};

const groupMembershipsByStock = (
  views: readonly StockSectorMembershipView[],
): Map<string, StockSectorMembershipView[]> => {
  const map = new Map<string, StockSectorMembershipView[]>();
  for (const view of views) {
    const list = map.get(view.stockId) ?? [];
    list.push(view);
    map.set(view.stockId, list);
  }
  return map;
};

const readLookupFacts = async (
  ctx: ToolContext,
  sector: SectorCatalogEntry,
  stockIds: readonly string[],
): Promise<{
  readonly membershipsByStock: ReadonlyMap<string, readonly StockSectorMembershipView[]>;
  readonly membersBySector: ReadonlyMap<string, readonly StockSectorMembership[]>;
}> => {
  const empty: {
    readonly membershipsByStock: ReadonlyMap<string, readonly StockSectorMembershipView[]>;
    readonly membersBySector: ReadonlyMap<string, readonly StockSectorMembership[]>;
  } = { membershipsByStock: new Map(), membersBySector: new Map() };
  if (stockIds.length === 0) return empty;
  const views = await ctx.repos.sectorCatalog.listByStock({ stockIds: [...stockIds] });
  const membershipsByStock = groupMembershipsByStock(views);
  const sectorIds = [...new Set(views.map((view) => view.sectorId))];
  if (!sectorIds.includes(sector.id)) sectorIds.push(sector.id);
  const memberships = await ctx.repos.sectorCatalog.listBySectors({ sectorIds });
  return { membershipsByStock, membersBySector: groupMembers(memberships) };
};

export const getMarketRoomCoreStocksTool = defineTool({
  name: 'get_market_room_core_stocks',
  description:
    '读取板块的核心股角色与换位时间线：启动先锋（首次可核实异动 + 随后上涨面扩散）、成交核心（成交额最高 + 连续样本跑赢板块中位数）、高度标（天梯连板层级最高，并列按成交额），每个角色带时点 / 字段 / 数值 / 来源证据；给出核心股出现、开板、换位、退出与缺样本的时点事实；可按角色反查核心股所属题材与其他成员同期表现；只读不采集，证据不足时角色为空或并列',
  sideEffect: 'read',
  input: GetMarketRoomCoreStocksInput,
  output: GetMarketRoomCoreStocksOutput,
  handler: async (input, ctx) => {
    const anchorResult = await resolveAnchor(ctx, input.at);
    const sectors = await ctx.repos.sectorCatalog
      .listSectors({ state: 'active' })
      .catch(() => [] as SectorCatalogEntry[]);
    const sector = sectors.find((entry) => entry.id === input.sectorId) ?? null;
    if (anchorResult.kind === 'empty') {
      return {
        coreStocks: buildMarketRoomCoreStocksEmpty({
          reason: anchorResult.reason,
          sector,
          latest: anchorResult.latest,
          window: CORE_STOCKS_WINDOW,
        }),
      };
    }
    const { anchor } = anchorResult;
    if (sectors.length === 0) {
      return {
        coreStocks: buildMarketRoomCoreStocksEmpty({
          reason: 'no_sector_catalog',
          sector: null,
          latest: anchor,
          window: CORE_STOCKS_WINDOW,
        }),
      };
    }
    if (sector === null) {
      return {
        coreStocks: buildMarketRoomCoreStocksEmpty({
          reason: 'sector_not_found',
          sector: null,
          latest: anchor,
          window: CORE_STOCKS_WINDOW,
        }),
      };
    }
    const sectorMembers = await ctx.repos.sectorCatalog.listBySector({ sectorId: sector.id });
    if (sectorMembers.filter((membership) => membership.state === 'active').length === 0) {
      return {
        coreStocks: buildMarketRoomCoreStocksEmpty({
          reason: 'no_members',
          sector,
          latest: anchor,
          window: CORE_STOCKS_WINDOW,
        }),
      };
    }

    const dayBatches = await ctx.repos.marketSnapshotBatch.listByTradingDate({
      coverage: COVERAGE,
      tradingDate: anchor.tradingDate,
    });
    const batches = dayBatches.filter(
      (batch) => batch.sampledAt.getTime() <= anchor.sampledAt.getTime(),
    );
    const effectiveBatches = batches.length === 0 ? [anchor] : batches;
    const ladder = await readLadderSamples(ctx, anchor.tradingDate);
    const windowStart = windowStartOf(effectiveBatches, anchor);

    const baseInput = {
      sector,
      members: sectorMembers,
      batches: effectiveBatches,
      ladderSamples: ladder.samples,
      window: CORE_STOCKS_WINDOW,
      windowStart,
    };
    // 先算一次角色，确定要反查的核心股，再补齐题材数据。
    const initial = buildMarketRoomCoreStocks(baseInput);
    const lookupKinds = input.kind === undefined ? undefined : [input.kind];
    const roleKinds = lookupKinds ?? (['ignition', 'turnover', 'height'] as const);
    const holderIds = [
      ...new Set(
        roleKinds.flatMap((kind) => initial.roles[kind].holders.map((holder) => holder.stockId)),
      ),
    ];
    const lookupFacts = await readLookupFacts(ctx, sector, holderIds);
    const core = buildMarketRoomCoreStocks({
      ...baseInput,
      ...lookupFacts,
      ...(lookupKinds === undefined ? {} : { lookupKinds }),
    });
    if (ladder.error !== null) {
      return {
        coreStocks: {
          ...core,
          notes: [...core.notes, `ladder_samples_unavailable: ${ladder.error}`],
        },
      };
    }
    return { coreStocks: core };
  },
});
