import {
  addWatchlistMembersTool,
  addWatchlistMemberTool,
  archiveWatchlistMemberTool,
  archiveWatchlistTool,
  type ConfirmablePluginTool,
  CreateWatchlistInput,
  createWatchlistTool,
  PluginOperationScopeError,
  updateWatchlistMemberTool,
  updateWatchlistTool,
} from '@luoome/tools';
import { z } from 'zod';

export const createWatchlistOperationPolicies = (): readonly ConfirmablePluginTool[] =>
  [
    createWatchlistTool,
    updateWatchlistTool,
    archiveWatchlistTool,
    addWatchlistMemberTool,
    addWatchlistMembersTool,
    updateWatchlistMemberTool,
    archiveWatchlistMemberTool,
  ].map((tool) => ({
    tool,
    scheduled: false,
    bind(raw, principal, operationId) {
      const input = z.record(z.string(), z.unknown()).parse(raw);
      if (input.accountId !== undefined && input.accountId !== principal.accountId)
        throw new PluginOperationScopeError('accountId');
      return tool.inputSchema.parse(
        tool.name === 'create_watchlist'
          ? { ...input, id: input.id ?? `watchlist-${operationId}` }
          : input,
      );
    },
    async receipt(raw, ctx) {
      // 成员与基础字段可被后续操作修改；没有独立业务回执时保持 unknown，不能重放写入。
      if (tool.name !== 'create_watchlist') return null;
      const input = CreateWatchlistInput.parse(raw);
      if (!input.id) return null;
      const watchlist = await ctx.repos.watchlist.findById(input.id);
      return watchlist &&
        watchlist.name === input.name &&
        watchlist.description === input.description &&
        watchlist.kind === input.kind &&
        watchlist.membershipPolicy === input.membershipPolicy &&
        watchlist.enabled === input.enabled
        ? { ok: true, data: { watchlist } }
        : null;
    },
  }));
