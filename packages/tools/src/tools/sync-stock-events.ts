import type { ExternalStockEvent, StockEvent, ToolContext } from '@luoome/core';
import { z } from 'zod';

import { defineTool } from '../define-tool.js';

/** Asia/Shanghai +8h（无夏令时）。 */
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;

/** allDay 事件：occursAt 归一到 Asia/Shanghai 当日 00:00（比较只按日期部分）。 */
const toShanghaiMidnight = (date: Date): Date => {
  const shifted = new Date(date.getTime() + SHANGHAI_OFFSET_MS);
  shifted.setUTCHours(0, 0, 0, 0);
  return new Date(shifted.getTime() - SHANGHAI_OFFSET_MS);
};

/**
 * 同步范围 = 持仓 ∪ enabled 分组成员快照 ∪ 存在手工事件的股票（去重，ruo 迁移 §4.2）。
 * 无关注股票时返回空数组（workflow 记 succeeded、syncedStocks=0）。
 */
export const computeRelevantStockIds = async (ctx: ToolContext): Promise<string[]> => {
  const set = new Set<string>();
  const accounts = await ctx.repos.account.list();
  for (const acc of accounts) {
    const holdings = await ctx.repos.holding.listByAccount(acc.id);
    for (const h of holdings) {
      if (h.closedAt === null) set.add(h.stockId);
    }
  }
  const groups = await ctx.repos.stockGroup.list(true);
  for (const g of groups) {
    const members = await ctx.repos.groupMember.currentMembers(g.id);
    for (const m of members) set.add(m.stockId);
  }
  for (const stockId of await ctx.repos.stockEvent.listStockIdsWithEvents()) {
    set.add(stockId);
  }
  return [...set];
};

export const SyncStockEventsInput = z.object({
  /** 缺省 = 持仓 ∪ enabled 分组成员 ∪ 手工事件股票。 */
  stockIds: z.array(z.string().min(1)).optional(),
  /** 仅同步指定 provider；缺省 = 全部已配置 provider。 */
  provider: z.string().min(1).optional(),
  /** 未来 N 天窗口，默认 90。 */
  windowDays: z.number().int().positive().max(365).default(90),
});

export const SyncProviderStatusSchema = z.object({
  provider: z.string(),
  ok: z.boolean(),
  errorKind: z.string().optional(),
  upserted: z.number().int().nonnegative(),
});

export const SyncStockEventsOutput = z.object({
  synced: z.number().int().nonnegative(),
  upserted: z.number().int().nonnegative(),
  staleMarked: z.number().int().nonnegative(),
  providerStatuses: z.array(SyncProviderStatusSchema),
});

const toStockEvent = (ext: ExternalStockEvent, providerName: string, now: Date): StockEvent => {
  const allDay = ext.allDay ?? true;
  const occursAt = allDay ? toShanghaiMidnight(ext.occursAt) : ext.occursAt;
  return {
    id: `evt_${globalThis.crypto.randomUUID().slice(0, 8)}`,
    stockId: ext.stockId,
    kind: ext.kind,
    title: ext.title,
    ...(ext.description !== undefined ? { description: ext.description } : {}),
    occursAt,
    allDay,
    importance: ext.importance,
    status: ext.status ?? 'scheduled',
    source: 'external',
    provider: providerName,
    externalId: ext.externalId,
    ...(ext.sourceUrl !== undefined ? { sourceUrl: ext.sourceUrl } : {}),
    observedAt: ext.observedAt ?? occursAt,
    fetchedAt: now,
    stale: false,
    remindBeforeDays: [],
    createdAt: now,
    updatedAt: now,
  };
};

/**
 * sync_stock_events（ruo 迁移 §4.3 / §7.2，external，原子同步）。
 *
 * 对每个 (provider, stockIds)：
 *  - 成功 → 逐条 upsert by (provider, externalId)；空列表不删旧事件（关键约束）
 *  - 失败 → 该 provider 全部相关事件 stale=true，providerStatus ok=false
 *
 * 未配置任何 provider（数据源选型未定，开放问题 1）→ synced=stockIds 数、upserted=0。
 * 完整 workflow（sync-stock-events）在此之上加 WorkflowRun 审计，不经 MCP 暴露。
 */
export const syncStockEventsTool = defineTool({
  name: 'sync_stock_events',
  description:
    '从外部数据源同步公司事件（财报 / 解禁 / 分红 …），按 (provider, externalId) 幂等 upsert',
  sideEffect: 'external',
  input: SyncStockEventsInput,
  output: SyncStockEventsOutput,
  handler: async (input, ctx) => {
    const now = ctx.clock();
    const stockIds = input.stockIds ?? (await computeRelevantStockIds(ctx));
    const providers = (ctx.eventProviders ?? []).filter(
      (p) => input.provider === undefined || p.name === input.provider,
    );
    let upserted = 0;
    let staleMarked = 0;
    const providerStatuses: z.infer<typeof SyncProviderStatusSchema>[] = [];

    for (const provider of providers) {
      if (stockIds.length === 0) {
        providerStatuses.push({ provider: provider.name, ok: true, upserted: 0 });
        continue;
      }
      try {
        const events = await provider.fetchEvents({ stockIds, windowDays: input.windowDays });
        let providerUpserted = 0;
        for (const ext of events) {
          await ctx.repos.stockEvent.upsertByExternal(toStockEvent(ext, provider.name, now));
          providerUpserted += 1;
        }
        upserted += providerUpserted;
        providerStatuses.push({ provider: provider.name, ok: true, upserted: providerUpserted });
      } catch (error) {
        const marked = await ctx.repos.stockEvent.markStaleByProvider(provider.name);
        staleMarked += marked;
        providerStatuses.push({
          provider: provider.name,
          ok: false,
          errorKind: error instanceof Error ? error.message.slice(0, 100) : 'unknown',
          upserted: 0,
        });
        ctx.logger.warn('[sync_stock_events] provider 失败，标记旧事件 stale', {
          provider: provider.name,
          marked,
        });
      }
    }

    return { synced: stockIds.length, upserted, staleMarked, providerStatuses };
  },
});
