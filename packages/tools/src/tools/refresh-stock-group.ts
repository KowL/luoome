import { z } from 'zod';

import { defineTool, errInvalidInput, errNotFound } from '../define-tool.js';
import { refreshGroupMembers } from '../internal/stock-group.js';

export const RefreshStockGroupInput = z.object({
  groupId: z.string().min(1),
});

export const RefreshStockGroupOutput = z.object({
  groupId: z.string().min(1),
  /** true = 写了新批次；false = 保留旧快照（原因见 failureReason）。 */
  refreshed: z.boolean(),
  failureReason: z.string().optional(),
  /** 新批次 refreshId；未写批次为 null。 */
  refreshId: z.string().nullable(),
  /** 刷新后当前成员数（未写批次时为旧批成员数）。 */
  memberCount: z.number().int().nonnegative(),
  /** 相对旧批新进的 stockId。 */
  entered: z.array(z.string()),
  /** 相对旧批退出的 stockId。 */
  exited: z.array(z.string()),
});

/**
 * 手动触发单组刷新（分组化起，external；docs/stock-group-design.md §6）。
 *
 * 与 refresh-groups workflow 同款逻辑（共享 internal/stock-group.ts 的 refreshGroupMembers）：
 * formula 走 run_tactic、llm 走 resolve_llm_group；失败 / 空结果保留旧快照，绝不写空批。
 * 归 external：llm 组调 LLM、formula 组跑全市场扫描，皆有外部成本。
 *
 * manual / holdings 组无刷新动作 → invalid_input。
 */
export const refreshStockGroupTool = defineTool({
  name: 'refresh_stock_group',
  description: '手动触发单组刷新（external）；formula/llm 组重算成员写新快照批，失败保留旧批',
  sideEffect: 'external',
  input: RefreshStockGroupInput,
  output: RefreshStockGroupOutput,
  handler: async (input, ctx) => {
    const group = await ctx.repos.stockGroup.findById(input.groupId);
    if (group === null) return errNotFound('StockGroup', input.groupId);
    if (group.resolver.kind === 'manual' || group.resolver.kind === 'holdings') {
      return errInvalidInput(
        `分组 ${input.groupId} resolver kind=${group.resolver.kind} 无刷新动作（manual 直接改 stockIds；holdings 是活视图）`,
      );
    }
    const outcome = await refreshGroupMembers(group, ctx);
    return {
      groupId: group.id,
      refreshed: outcome.refreshed,
      ...(outcome.failureReason !== undefined ? { failureReason: outcome.failureReason } : {}),
      refreshId: outcome.refreshId,
      memberCount: outcome.memberCount,
      entered: [...outcome.entered],
      exited: [...outcome.exited],
    };
  },
});
