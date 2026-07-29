import { ManualGroupResolverSchema, StockGroupSchema } from '@luoome/core';
import { z } from 'zod';

import { defineTool, errInvalidInput, errNotFound } from '../define-tool.js';
import { ensureStockStub, STOCK_ID_PATTERN } from '../internal/manual-entry.js';

export const AddGroupMemberInput = z.object({
  /** 股票分组 id（kebab-case slug）。 */
  groupId: z.string().min(1),
  /** 形如 002594.SZ（代码.交易所）。 */
  stockId: z.string().regex(STOCK_ID_PATTERN, 'stockId 必须形如 002594.SZ（代码.交易所）'),
  /** 搜索候选携带的名称；新建 stock stub 时用作初值。 */
  stockName: z.string().trim().min(1).max(100).optional(),
});

export const AddGroupMemberOutput = z.object({
  group: StockGroupSchema,
  /** 新追加的 stockId，方便前端定位乐观新增行。 */
  addedStockId: z.string(),
});

/**
 * 把一只股票追加到 manual 分组的固定成员列表（write；docs/ddd/strategy-watchlist-unification-detailed-design.md §1 / §6）。
 *
 * 仅 manual kind 支持；formula/llm 由刷新机制产出成员，holdings 是活视图。
 * 实现走 update_stock_group 同款 merge 路径，只是只动 resolver.stockIds。
 *
 * 校验链：
 * 1. group 存在 → not_found
 * 2. resolver.kind === 'manual' → invalid_input
 * 3. stockId 已在分组内 → invalid_input（避免重复）
 * 4. ensureStockStub 入库（与 add_trade / add_holding 同款：未登记则用代码 stub，
 *    已有则用 stockName 补全早期 entry 的「名称=代码」占位）
 * 5. 落库（updatedAt 用 ctx.clock()）
 */
export const addGroupMemberTool = defineTool({
  name: 'add_group_member',
  description: '向 manual 股票分组追加成员（write）；非 manual 分组不支持；股票未登记时自动 stub',
  sideEffect: 'write',
  input: AddGroupMemberInput,
  output: AddGroupMemberOutput,
  handler: async (input, ctx) => {
    const existing = await ctx.repos.stockGroup.findById(input.groupId);
    if (existing === null) return errNotFound('StockGroup', input.groupId);

    const resolver = existing.resolver;
    if (resolver.kind !== 'manual') {
      return errInvalidInput(`仅 manual 分组支持添加成员；当前 kind=${resolver.kind}`);
    }

    if (resolver.stockIds.includes(input.stockId)) {
      return errInvalidInput(`stockId=${input.stockId} 已在分组 ${input.groupId} 中`);
    }

    await ensureStockStub(input.stockId, ctx, input.stockName);

    const nextResolver = ManualGroupResolverSchema.parse({
      kind: 'manual',
      stockIds: [...resolver.stockIds, input.stockId],
    });

    const group = StockGroupSchema.parse({
      ...existing,
      resolver: nextResolver,
      updatedAt: ctx.clock(),
    });
    await ctx.repos.stockGroup.save(group);
    return { group, addedStockId: input.stockId };
  },
});
