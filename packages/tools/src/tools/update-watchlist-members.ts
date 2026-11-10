import { WatchlistMemberSchema } from '@luoome/core';
import { z } from 'zod';
import { defineTool } from '../define-tool.js';
import {
  addWatchlistMembersTool,
  archiveWatchlistMemberTool,
  updateWatchlistMemberTool,
  WatchlistMemberViewSchema,
} from './watchlist.js';

const MemberToAdd = z.object({
  stockId: z.string().min(1),
  reason: z.string().min(1).max(1000).default('用户手工添加'),
  stage: WatchlistMemberSchema.shape.stage.default('watching'),
  priority: WatchlistMemberSchema.shape.priority.default('normal'),
});

const MemberToUpdate = z.object({
  stockId: z.string().min(1),
  stage: WatchlistMemberSchema.shape.stage.exclude(['archived']).optional(),
  priority: WatchlistMemberSchema.shape.priority.optional(),
});

export const UpdateWatchlistMembersInput = z
  .object({
    watchlistId: z.string().min(1),
    add: z.array(MemberToAdd).max(100).default([]),
    update: z.array(MemberToUpdate).max(100).default([]),
    remove: z.array(z.string().min(1)).max(100).default([]),
  })
  .refine((input) => input.add.length > 0 || input.update.length > 0 || input.remove.length > 0, {
    message: '至少提供 add / update / remove 中的一项',
  });

export const UpdateWatchlistMembersOutput = z.object({
  watchlistId: z.string().min(1),
  added: z.number().int().nonnegative(),
  updated: z.number().int().nonnegative(),
  removed: z.number().int().nonnegative(),
  members: z.array(WatchlistMemberViewSchema).optional(),
});

export const updateWatchlistMembersTool = defineTool({
  name: 'update_watchlist_members',
  description:
    '批量增删改股票池成分股：add 新增（含阶段/优先级）、update 更新阶段/优先级、remove 归档；整批原子校验后逐项写入',
  sideEffect: 'write',
  input: UpdateWatchlistMembersInput,
  output: UpdateWatchlistMembersOutput,
  handler: async (input, ctx) => {
    const members: Array<z.infer<typeof WatchlistMemberViewSchema>> = [];
    let added = 0;
    let updated = 0;
    let removed = 0;
    if (input.add.length > 0) {
      const result = await addWatchlistMembersTool.execute(
        { watchlistId: input.watchlistId, members: input.add },
        ctx,
      );
      if (!result.ok) return result;
      added = result.data.created;
      members.push(...result.data.members.map((member) => WatchlistMemberViewSchema.parse(member)));
    }
    for (const item of input.update) {
      const result = await updateWatchlistMemberTool.execute(
        {
          watchlistId: input.watchlistId,
          stockId: item.stockId,
          ...(item.stage === undefined ? {} : { stage: item.stage }),
          ...(item.priority === undefined ? {} : { priority: item.priority }),
        },
        ctx,
      );
      if (!result.ok) return result;
      updated += 1;
      members.push(WatchlistMemberViewSchema.parse(result.data));
    }
    for (const stockId of input.remove) {
      const result = await archiveWatchlistMemberTool.execute(
        { watchlistId: input.watchlistId, stockId },
        ctx,
      );
      if (!result.ok) return result;
      removed += 1;
    }
    return {
      watchlistId: input.watchlistId,
      added,
      updated,
      removed,
      ...(members.length === 0 ? {} : { members }),
    };
  },
});
