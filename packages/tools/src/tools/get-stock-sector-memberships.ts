import { GetStockSectorMembershipsQuerySchema, SectorMembershipSnapshotSchema } from '@luoome/core';

import { defineTool, errAdapterError, errInvalidInput } from '../define-tool.js';

/**
 * 个股板块关系工具（外部网络读取，fuyao-data-expansion §10.2）。
 *
 * - sideEffect: 'external' —— 访问行情供应商，不写库、不触发通知
 * - 结果是**当前关系快照**：带 fetchedAt / source / contentHash；
 *   不回写历史 StockUniverseSnapshotMember.industry，不充当历史指数成分或权重
 * - 空 memberships 只表示当前无匹配，不证明股票不存在；全部为空 → warnings=['empty-list']
 * - 错误模型：input 解析失败 → invalid_input；manager.adapter_error → adapter_error
 */

export const GetStockSectorMembershipsInput = GetStockSectorMembershipsQuerySchema;
export const GetStockSectorMembershipsOutput = SectorMembershipSnapshotSchema;

export const getStockSectorMembershipsTool = defineTool({
  name: 'get_stock_sector_memberships',
  description:
    '按股票反查当前板块归属（行业 / 概念 / 地域 / 特色，保留上游 .TI 指数代码）。' +
    'stockIds 单次最多 100 只；type 缺省返回全部四类。' +
    '结果是当前关系快照（fetchedAt/source/contentHash），不是历史 PIT 成分；' +
    '空 memberships 只表示当前无匹配，不证明股票不存在。',
  sideEffect: 'external',
  input: GetStockSectorMembershipsInput,
  output: GetStockSectorMembershipsOutput,
  handler: async (input, ctx) => {
    if (ctx.sectorMembership === undefined) {
      return errInvalidInput(
        'get_stock_sector_memberships tool 需要 ctx.sectorMembership 注入；当前 surface 未配置 sector-membership manager（LUOOME_SECTOR_MEMBERSHIP_SOURCES 默认不装配）',
      );
    }
    const r = await ctx.sectorMembership.fetchMemberships(input);
    if (!r.ok || r.data === undefined) {
      const cause = r.error?.message ?? 'unknown error';
      return errAdapterError('sector-membership', cause, r.error?.recoverable ?? true);
    }
    return r.data;
  },
});

// 注册：`toolRegistry` 与 `WorkflowToolMap` 都需要补这一行。
export const _SectorMembershipWorkflowToolMapEntries = {
  get_stock_sector_memberships: getStockSectorMembershipsTool,
} as const satisfies Record<string, ReturnType<typeof defineTool>>;
