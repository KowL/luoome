import { StockGroupSchema, StockPoolSchema } from '@luoome/core';
import { z } from 'zod';

import { defineTool } from '../define-tool.js';
import { getStockGroupTool } from './get-stock-group.js';

export const WatchPlanStateSchema = z.enum([
  'ready',
  'stale',
  'empty',
  'group-disabled',
  'group-missing',
]);

export const WatchPlanViewSchema = z.object({
  plan: StockPoolSchema,
  group: StockGroupSchema.nullable(),
  memberCount: z.number().int().nonnegative(),
  latestRefreshAt: z.coerce.date().nullable(),
  state: WatchPlanStateSchema,
});

export const ListWatchPlansInput = z.object({
  enabledOnly: z.boolean().default(true),
  groupId: z.string().min(1).optional(),
});

export const ListWatchPlansOutput = z.object({
  plans: z.array(WatchPlanViewSchema),
  total: z.number().int().nonnegative(),
});

/**
 * 盯盘方案读取模型：把 StockPool 的规则配置与 StockGroup 的成员状态集中到一个接口。
 * 写接口暂时保持 create/update_stock_pool 兼容，Web 不再自行拼接多个读取接口。
 */
export const listWatchPlansTool = defineTool({
  name: 'list_watch_plans',
  description: '列出盯盘方案及其成员分组、成员数和可用状态',
  sideEffect: 'read',
  input: ListWatchPlansInput,
  output: ListWatchPlansOutput,
  handler: async (input, ctx) => {
    const allPools = await ctx.repos.stockPool.list(input.enabledOnly);
    const pools =
      input.groupId === undefined
        ? allPools
        : allPools.filter((plan) => plan.groupId === input.groupId);
    const plans = await Promise.all(
      pools.map(async (plan) => {
        const detail = await getStockGroupTool.execute({ id: plan.groupId }, ctx);
        if (!detail.ok) {
          return {
            plan,
            group: null,
            memberCount: 0,
            latestRefreshAt: null,
            state: 'group-missing' as const,
          };
        }
        return {
          plan,
          group: detail.data.group,
          memberCount: detail.data.members.length,
          latestRefreshAt: detail.data.latestRefreshAt,
          state: !detail.data.group.enabled
            ? ('group-disabled' as const)
            : detail.data.stale
              ? ('stale' as const)
              : detail.data.members.length === 0
                ? ('empty' as const)
                : ('ready' as const),
        };
      }),
    );
    return { plans, total: plans.length };
  },
});
