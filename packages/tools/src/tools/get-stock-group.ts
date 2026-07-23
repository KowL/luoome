import { StockGroupSchema } from '@luoome/core';
import { z } from 'zod';

import { defineTool, errNotFound } from '../define-tool.js';
import { isGroupStale } from '../internal/stock-group.js';

export const GetStockGroupInput = z.object({
  id: z.string().min(1),
});

const GroupMemberView = z.object({
  stockId: z.string().min(1),
  /** 进入理由：快照 reason；manual / holdings 为固定说明。 */
  reason: z.string().min(1),
  refreshedAt: z.coerce.date(),
});

export const GetStockGroupOutput = z.object({
  group: StockGroupSchema,
  /** 当前成员：manual=固定列表；holdings=活跃持仓现算；formula/llm=最新快照批。 */
  members: z.array(GroupMemberView),
  /** 最新快照批的 createdAt；无快照（含 manual / holdings 组）为 null。 */
  latestRefreshAt: z.coerce.date().nullable(),
  /**
   * stale 标记（纯计算，不引入新存储）：refreshPolicy=daily 的动态分组
   * 且（从未刷新成功 或 最新批次的 Shanghai 日期 < 今日）。
   */
  stale: z.boolean(),
});

/**
 * 分组详情（分组化起，read；docs/stock-group-design.md §6）：
 * 分组 + 当前成员 + 最近 refresh 时间 + stale 标记。
 * llm 分组刷新失败标 stale 后，watch 继续用旧快照盯盘——用户从本工具感知 stale（spec §8）。
 */
export const getStockGroupTool = defineTool({
  name: 'get_stock_group',
  description: '分组详情（read）：当前成员 + 最近 refresh 时间 + stale 标记',
  sideEffect: 'read',
  input: GetStockGroupInput,
  output: GetStockGroupOutput,
  handler: async (input, ctx) => {
    const group = await ctx.repos.stockGroup.findById(input.id);
    if (group === null) return errNotFound('StockGroup', input.id);
    const now = ctx.clock();
    const resolver = group.resolver;

    if (resolver.kind === 'manual') {
      return {
        group,
        members: resolver.stockIds.map((stockId) => ({
          stockId,
          reason: 'manual 固定成员',
          refreshedAt: group.updatedAt,
        })),
        latestRefreshAt: null,
        stale: false,
      };
    }
    if (resolver.kind === 'holdings') {
      const holdings = await ctx.repos.holding.listByAccount(resolver.accountId);
      return {
        group,
        members: holdings
          .filter((h) => h.closedAt === null)
          .map((h) => ({ stockId: h.stockId, reason: 'holdings 活视图', refreshedAt: now })),
        latestRefreshAt: null,
        stale: false,
      };
    }

    const snapshots = await ctx.repos.groupMember.currentMembers(group.id);
    const latestRefreshAt = snapshots[0]?.createdAt ?? null;
    return {
      group,
      members: snapshots.map((s) => ({
        stockId: s.stockId,
        reason: s.reason,
        refreshedAt: s.createdAt,
      })),
      latestRefreshAt,
      stale: isGroupStale(group, latestRefreshAt, now),
    };
  },
});
