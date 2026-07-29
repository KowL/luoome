import { StockGroupSchema } from '@luoome/core';
import { z } from 'zod';

import { defineTool } from '../define-tool.js';
import { isGroupStale } from '../internal/stock-group.js';

export const ListStockGroupsInput = z.object({
  /** true 仅返回 enabled=true；默认 false 返回全部。 */
  enabledOnly: z.boolean().default(false),
  /** true 时附带当前成员数（holdings 组现算活跃持仓数）。 */
  includeMemberCount: z.boolean().default(false),
});

export const ListStockGroupsOutput = z.object({
  groups: z.array(
    z.object({
      group: StockGroupSchema,
      memberCount: z.number().int().nonnegative().optional(),
      latestRefreshAt: z.coerce.date().optional(),
      dataAsOf: z.coerce.date().optional(),
      stale: z.boolean().optional(),
    }),
  ),
  total: z.number().int().nonnegative(),
});

/**
 * 列出股票分组（分组化起，read；docs/ddd/stock-group-design.md §6）。
 * 默认返回全部（按 id 升序）；includeMemberCount=true 时计算当前成员数：
 * manual → resolver.stockIds 长度；holdings → 活跃持仓数（活视图现算）；
 * formula / llm → 最新快照批成员数。
 */
export const listStockGroupsTool = defineTool({
  name: 'list_stock_groups',
  description: '列出股票分组（read）；可选附带当前成员数',
  sideEffect: 'read',
  input: ListStockGroupsInput,
  output: ListStockGroupsOutput,
  handler: async (input, ctx) => {
    const groups = await ctx.repos.stockGroup.list(input.enabledOnly);
    const out: Array<{
      group: (typeof groups)[number];
      memberCount?: number;
      latestRefreshAt?: Date;
      dataAsOf?: Date;
      stale?: boolean;
    }> = [];
    for (const group of groups) {
      if (!input.includeMemberCount) {
        out.push({ group });
        continue;
      }
      const resolver = group.resolver;
      let memberCount: number;
      if (resolver.kind === 'manual') {
        memberCount = resolver.stockIds.length;
      } else if (resolver.kind === 'holdings') {
        const holdings = await ctx.repos.holding.listByAccount(resolver.accountId);
        memberCount = holdings.filter((h) => h.closedAt === null).length;
      } else {
        const members = await ctx.repos.groupMember.currentMembers(group.id);
        memberCount = members.length;
        const latestRefreshAt = members[0]?.createdAt;
        const dataTimes = members
          .map((member) => member.dataAsOf?.getTime())
          .filter((value): value is number => value !== undefined);
        out.push({
          group,
          memberCount,
          ...(latestRefreshAt === undefined ? {} : { latestRefreshAt }),
          ...(dataTimes.length === 0 ? {} : { dataAsOf: new Date(Math.min(...dataTimes)) }),
          stale: isGroupStale(group, latestRefreshAt ?? null, ctx.clock()),
        });
        continue;
      }
      out.push({ group, memberCount });
    }
    return { groups: out, total: out.length };
  },
});
