import { WatchRuleKindSchema, WatchTriggerSchema } from '@luoome/core';
import { z } from 'zod';

import { defineTool } from '../define-tool.js';

export const ListWatchTriggersInput = z.object({
  poolId: z.string().min(1).optional(),
  stockId: z.string().min(1).optional(),
  ruleKind: WatchRuleKindSchema.optional(),
  notified: z.boolean().optional(),
  since: z.coerce.date().optional(),
  limit: z.number().int().positive().max(500).default(50),
});

export const ListWatchTriggersOutput = z.object({
  triggers: z.array(WatchTriggerSchema),
  /** 过滤后、limit 前的总数。 */
  total: z.number().int().nonnegative(),
});

/**
 * 面向 UI/MCP 的触发审计读取。
 *
 * WatchTriggerRepository 目前是个人本地库，listRecent 没有 count/query contract；
 * 这里一次最多扫描 10k 条近期记录后再做细粒度过滤，避免 limit 先于 stock/rule
 * 过滤导致漏结果。达到 10k 后应演进为 repository query + count。
 */
export const listWatchTriggersTool = defineTool({
  name: 'list_watch_triggers',
  description: '查询最近盯盘触发（可按池/股票/规则/通知状态过滤，按时间倒序）',
  sideEffect: 'read',
  input: ListWatchTriggersInput,
  output: ListWatchTriggersOutput,
  handler: async (input, ctx) => {
    const recent = await ctx.repos.watchTrigger.listRecent({
      ...(input.poolId !== undefined ? { poolId: input.poolId } : {}),
      ...(input.since !== undefined ? { since: input.since } : {}),
      limit: 10_000,
    });
    const filtered = recent
      .filter((trigger) => input.stockId === undefined || trigger.stockId === input.stockId)
      .filter((trigger) => input.ruleKind === undefined || trigger.ruleKind === input.ruleKind)
      .filter((trigger) => input.notified === undefined || trigger.notified === input.notified)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id));
    return {
      triggers: z.array(WatchTriggerSchema).parse(filtered.slice(0, input.limit)),
      total: filtered.length,
    };
  },
});
