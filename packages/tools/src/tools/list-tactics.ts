import { type Tactic, TacticSchema } from '@luoome/core';
import { z } from 'zod';

import { defineTool } from '../define-tool.js';

const TacticListFilterSchema = z
  .object({
    tag: z.enum(['momentum', 'mean-reversion', 'volume', 'risk', 'pattern']).optional(),
    source: z.enum(['builtin', 'user']).optional(),
  })
  .optional();

export const ListTacticsInput = z.object({
  filter: TacticListFilterSchema,
  /** 默认 true：返回 5 个 builtin 战法 + user 战法。 */
  includeBuiltins: z.boolean().default(true),
});

export const ListTacticsOutput = z.object({
  tactics: z.array(TacticSchema),
  total: z.number().int().nonnegative(),
});

/**
 * 列出可用战法（v0.3 起，read）。
 * - 默认 includeBuiltins=true，返回 5 个内置战法 + user 战法。
 * - filter 支持按 tag / source 过滤。
 */
export const listTacticsTool = defineTool({
  name: 'list_tactics',
  description: '列出可用战法（内置 + 用户自定义），可按 tag / source 过滤',
  sideEffect: 'read',
  input: ListTacticsInput,
  output: ListTacticsOutput,
  handler: async (input, ctx) => {
    let sourceFilter = input.filter?.source;
    if (input.includeBuiltins && sourceFilter === undefined) {
      sourceFilter = undefined;
    } else if (!input.includeBuiltins) {
      sourceFilter = 'user';
    }
    const list = await ctx.repos.tactic.list({
      ...(input.filter?.tag !== undefined ? { tag: input.filter.tag } : {}),
      ...(sourceFilter !== undefined ? { source: sourceFilter } : {}),
    });
    const tactics: readonly Tactic[] = list;
    return { tactics: z.array(TacticSchema).parse(tactics), total: tactics.length };
  },
});
