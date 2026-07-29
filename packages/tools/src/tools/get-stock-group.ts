import { StockGroupSchema } from '@luoome/core';
import { z } from 'zod';

import { defineTool, errNotFound } from '../define-tool.js';
import { isGroupStale } from '../internal/stock-group.js';

export const GetStockGroupInput = z.object({
  id: z.string().min(1),
});

const GroupMemberView = z.object({
  stockId: z.string().min(1),
  /** 股票名称（来自 stock repo.findById；查不到 fallback 为 stockId）。详情页用。 */
  name: z.string().min(1),
  /** 进入理由：快照 reason；manual / holdings 为固定说明。 */
  reason: z.string().min(1),
  score: z.number().min(0).max(100).optional(),
  evidence: z.array(z.string()).default([]),
  dataAsOf: z.coerce.date().optional(),
  tacticSignalRef: z
    .object({
      tacticId: z.string(),
      ts: z.coerce.date(),
    })
    .optional(),
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
  changes: z.object({
    entered: z.array(z.string()),
    exited: z.array(z.string()),
  }),
});

/**
 * 分组详情（分组化起，read；docs/ddd/stock-group-design.md §6）：
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

    /** 解析单只成员的展示字段；缺失 stock 行时 name fallback 为 stockId。 */
    const memberView = async (
      stockId: string,
      reason: string,
      refreshedAt: Date,
      research: {
        score?: number;
        evidence?: readonly string[];
        dataAsOf?: Date;
        tacticSignalRef?: { tacticId: string; ts: Date };
      } = {},
    ) => {
      const stock = await ctx.repos.stock.findById(stockId);
      return {
        stockId,
        name: stock?.name ?? stockId,
        reason,
        ...(research.score === undefined ? {} : { score: research.score }),
        evidence: [...(research.evidence ?? [])],
        ...(research.dataAsOf === undefined ? {} : { dataAsOf: research.dataAsOf }),
        ...(research.tacticSignalRef === undefined
          ? {}
          : { tacticSignalRef: research.tacticSignalRef }),
        refreshedAt,
      };
    };

    if (resolver.kind === 'manual') {
      const members = await Promise.all(
        resolver.stockIds.map((stockId) => memberView(stockId, 'manual 固定成员', group.updatedAt)),
      );
      return {
        group,
        members,
        latestRefreshAt: null,
        stale: false,
        changes: { entered: [], exited: [] },
      };
    }
    if (resolver.kind === 'holdings') {
      const holdings = await ctx.repos.holding.listByAccount(resolver.accountId);
      const members = await Promise.all(
        holdings
          .filter((h) => h.closedAt === null)
          .map((h) => memberView(h.stockId, 'holdings 活视图', now)),
      );
      return {
        group,
        members,
        latestRefreshAt: null,
        stale: false,
        changes: { entered: [], exited: [] },
      };
    }

    const snapshots = await ctx.repos.groupMember.currentMembers(group.id);
    const latestRefreshAt = snapshots[0]?.createdAt ?? null;
    const members = await Promise.all(
      snapshots.map((s) =>
        memberView(s.stockId, s.reason, s.createdAt, {
          ...(s.score === undefined ? {} : { score: s.score }),
          evidence: s.evidence,
          ...(s.dataAsOf === undefined ? {} : { dataAsOf: s.dataAsOf }),
          ...(s.tacticSignalRef === undefined ? {} : { tacticSignalRef: s.tacticSignalRef }),
        }),
      ),
    );
    const latestRefreshId = snapshots[0]?.refreshId;
    const history = await ctx.repos.groupMember.listHistory(group.id);
    const previousRefreshId = history.find(
      (snapshot) => snapshot.refreshId !== latestRefreshId,
    )?.refreshId;
    const previousIds = new Set(
      previousRefreshId === undefined
        ? []
        : history
            .filter((snapshot) => snapshot.refreshId === previousRefreshId)
            .map((snapshot) => snapshot.stockId),
    );
    const currentIds = new Set(snapshots.map((snapshot) => snapshot.stockId));
    return {
      group,
      members,
      latestRefreshAt,
      stale: isGroupStale(group, latestRefreshAt, now),
      changes: {
        entered:
          previousRefreshId === undefined
            ? []
            : snapshots
                .map((snapshot) => snapshot.stockId)
                .filter((stockId) => !previousIds.has(stockId)),
        exited:
          previousRefreshId === undefined
            ? []
            : [...previousIds].filter((stockId) => !currentIds.has(stockId)).sort(),
      },
    };
  },
});
