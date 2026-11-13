import {
  buildMarketRoomEventsView,
  dateInShanghai,
  detectMarketRoomEvents,
  type LimitUpLadderSample,
  type MarketRoomEvent,
  MarketRoomEventKindSchema,
  type MarketRoomEventsEmptyReason,
  type MarketRoomEventsFilters,
  type MarketRoomEventsView,
  MarketRoomEventsViewSchema,
  type SectorCatalogEntry,
  type StockSectorMembership,
  type ToolContext,
} from '@luoome/core';
import { z } from 'zod';

import { defineTool, errInvalidInput } from '../define-tool.js';

/**
 * 盘中事件流（ticket #42）：扩散 / 分化 / 换位。
 *
 * - `scanMarketRoomEvents` 在批次发布后扫描当日最近样本并幂等写入；失败只进 warnings，
 *   不回滚已发布批次，也不阻塞采集；
 * - 事件身份、阈值与证据由 core 的纯函数产出，本文件只负责取事实、写入与查询；
 * - 只读查询按交易日 + 可选时段 / 种类 / 板块过滤，事件按检测时点升序返回。
 */

const COVERAGE = 'CN_A_SHARES_SH_SZ' as const;
const LIMIT_UP_SOURCE = 'eastmoney';
const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日期必须为 YYYY-MM-DD');

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

/**
 * 批次发布后的幂等扫描：同一份数据重复扫描只落一条（仓储按事件身份去重）。
 * 任何一步失败都只返回 warning，调用方不得因此回滚批次。
 */
export const scanMarketRoomEvents = async (
  ctx: ToolContext,
  tradingDate: string,
): Promise<readonly string[]> => {
  const warnings: string[] = [];
  try {
    const batches = await ctx.repos.marketSnapshotBatch.listByTradingDate({
      coverage: COVERAGE,
      tradingDate,
    });
    if (batches.length === 0) return warnings;
    let sectors: readonly SectorCatalogEntry[];
    try {
      sectors = await ctx.repos.sectorCatalog.listSectors({ state: 'active' });
    } catch (error) {
      const cause = error instanceof Error ? error.message : String(error);
      return [`market_room_event_scan_failed: 读取板块目录失败 ${cause}`];
    }
    if (sectors.length === 0) return warnings;
    let members: readonly StockSectorMembership[];
    try {
      members = await ctx.repos.sectorCatalog.listBySectors({
        sectorIds: sectors.map((sector) => sector.id),
      });
    } catch (error) {
      const cause = error instanceof Error ? error.message : String(error);
      return [`market_room_event_scan_failed: 读取板块成分失败 ${cause}`];
    }
    if (members.length === 0) return warnings;
    const ladder = await readLadderSamples(ctx, tradingDate);
    if (ladder.error !== null) {
      warnings.push(`market_room_event_ladder_missing: ${ladder.error}`);
    }
    const events = detectMarketRoomEvents({
      tradingDate,
      batches,
      sectors,
      members,
      ladderSamples: ladder.samples,
      recordedAt: ctx.clock(),
    });
    for (const event of events) {
      try {
        await ctx.repos.marketRoomEvent.save(event);
      } catch (error) {
        const cause = error instanceof Error ? error.message : String(error);
        warnings.push(`market_room_event_save_failed: ${event.kind}/${event.id} ${cause}`);
      }
    }
    return warnings;
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    return [`market_room_event_scan_failed: ${cause}`];
  }
};

export const ListMarketRoomEventsInput = z.object({
  /** 交易日 YYYY-MM-DD；缺省取最近批次的交易日，没有批次时回退最近事件的交易日。 */
  date: dateString.optional(),
  /** 检测时点下界（含）。 */
  from: z.coerce.date().optional(),
  /** 检测时点上界（含）。 */
  to: z.coerce.date().optional(),
  /**
   * 已知时点：只返回该时点之前已记录（recordedAt <= knownAt）的事件。
   * 回放时用于截断「之后才扫描出来」的事件；缺省读全部已记录事件。
   */
  knownAt: z.coerce.date().optional(),
  /**
   * 回放里选中的事件 id：只额外放行这一条（且要求其检测时点不晚于 knownAt），
   * 不放松其它事件的 knownAt 截断。用于「点开的事件在切到其检测时点后仍可见」。
   */
  includeEventId: z.string().trim().min(1).optional(),
  kind: MarketRoomEventKindSchema.optional(),
  sectorId: z.string().trim().min(1).optional(),
});
export type ListMarketRoomEventsInputT = z.infer<typeof ListMarketRoomEventsInput>;

export const ListMarketRoomEventsOutput = z.object({
  view: MarketRoomEventsViewSchema,
});
export type ListMarketRoomEventsOutputT = z.infer<typeof ListMarketRoomEventsOutput>;

const viewOf = (input: {
  readonly tradingDate: string | null;
  readonly events: readonly MarketRoomEvent[];
  readonly filters: MarketRoomEventsFilters;
  readonly emptyReason?: MarketRoomEventsEmptyReason;
}): MarketRoomEventsView =>
  buildMarketRoomEventsView({
    tradingDate: input.tradingDate,
    events: input.events,
    filters: input.filters,
    ...(input.emptyReason === undefined ? {} : { emptyReason: input.emptyReason }),
  });

/**
 * 回放钉住的事件：只额外放行「检测样本不晚于已知时点、但记录时点更晚」的那一条。
 * 更晚检测样本的事件不会被提前放出，其它事件仍按 knownAt 截断。
 */
const readPinnedEvent = async (
  ctx: ToolContext,
  input: ListMarketRoomEventsInputT,
  tradingDate: string,
  events: readonly MarketRoomEvent[],
): Promise<MarketRoomEvent | null> => {
  if (input.includeEventId === undefined) return null;
  if (events.some((event) => event.id === input.includeEventId)) return null;
  try {
    const event = await ctx.repos.marketRoomEvent.findById(input.includeEventId);
    if (event === null || event.tradingDate !== tradingDate) return null;
    if (input.knownAt !== undefined && event.sampledAt.getTime() > input.knownAt.getTime()) {
      return null;
    }
    if (input.from !== undefined && event.sampledAt.getTime() < input.from.getTime()) return null;
    if (input.to !== undefined && event.sampledAt.getTime() > input.to.getTime()) return null;
    return event;
  } catch {
    return null;
  }
};

const resolveTradingDate = async (
  ctx: ToolContext,
  input: ListMarketRoomEventsInputT,
): Promise<string | null> => {
  if (input.date !== undefined) return input.date;
  if (input.knownAt !== undefined) return dateInShanghai(input.knownAt);
  if (input.from !== undefined) return dateInShanghai(input.from);
  if (input.to !== undefined) return dateInShanghai(input.to);
  const latestBatch = await ctx.repos.marketSnapshotBatch.findLatest({ coverage: COVERAGE });
  if (latestBatch !== null) return latestBatch.tradingDate;
  const latest = await ctx.repos.marketRoomEvent.list({ order: 'desc', limit: 1 });
  const latestEvent = latest[0];
  return latestEvent === undefined ? null : latestEvent.tradingDate;
};

export const listMarketRoomEventsTool = defineTool({
  name: 'list_market_room_events',
  description:
    '读取盘中事件流：扩散（上涨面在 N 个样本内提升、窗口为正、成交占比不降）、分化（日涨幅仍靠前但上涨面回落、窗口转负）、换位（领先板块变化且新领先者连续样本窗口跑赢旧领先者，滞回避免单次抖动）；每个事件带扫描当时的阈值与证据（板块榜单、上涨面、窗口涨幅、成交占比、天梯封板/涨停原因、已知成分、异动关键词），按检测时点升序返回；可按交易日 / 时段 / 种类 / 板块过滤；给定 knownAt 时只返回该时点之前已记录的事件（回放按当时已知截断，之后扫描出来的事件不出现）；includeEventId 只额外放行该条已选中事件（其检测时点不得晚于 knownAt），不放松其它截断；只读不采集',
  sideEffect: 'read',
  input: ListMarketRoomEventsInput,
  output: ListMarketRoomEventsOutput,
  handler: async (input, ctx) => {
    if (input.from !== undefined && input.to !== undefined && input.from > input.to) {
      return errInvalidInput('from 必须早于或等于 to');
    }
    const tradingDate = await resolveTradingDate(ctx, input);
    const filters = {
      date: input.date ?? null,
      from: input.from ?? null,
      to: input.to ?? null,
      kind: input.kind ?? null,
      sectorId: input.sectorId ?? null,
      knownAt: input.knownAt ?? null,
    };
    if (tradingDate === null) {
      return { view: viewOf({ tradingDate: null, events: [], filters, emptyReason: 'no_batch' }) };
    }
    const batches = await ctx.repos.marketSnapshotBatch.listByTradingDate({
      coverage: COVERAGE,
      tradingDate,
    });
    if (batches.length === 0) {
      return { view: viewOf({ tradingDate, events: [], filters, emptyReason: 'no_batch' }) };
    }
    const events = await ctx.repos.marketRoomEvent.list({
      tradingDate,
      ...(input.kind === undefined ? {} : { kind: input.kind }),
      ...(input.sectorId === undefined ? {} : { sectorId: input.sectorId }),
      ...(input.from === undefined ? {} : { from: input.from }),
      ...(input.to === undefined ? {} : { to: input.to }),
      ...(input.knownAt === undefined ? {} : { knownAt: input.knownAt }),
    });
    const pinned = await readPinnedEvent(ctx, input, tradingDate, events);
    const visible = pinned === null ? events : [...events, pinned];
    if (visible.length === 0) {
      return { view: viewOf({ tradingDate, events: [], filters, emptyReason: 'no_events' }) };
    }
    return { view: viewOf({ tradingDate, events: visible, filters }) };
  },
});
