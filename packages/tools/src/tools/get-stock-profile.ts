import { StockProfileQuerySchema, StockProfileSchema } from '@luoome/core';

import { defineTool, errAdapterError, errInvalidInput } from '../define-tool.js';

/**
 * 个股档案工具（只读）。
 *
 * - sideEffect: 'external' —— 只读快照，不写库、不触发通知
 * - 外部访问沿用 market external 白名单与显式 opt-in
 * - 错误模型：input 解析失败 → invalid_input；manager.adapter_error → adapter_error；
 *   上游无股东户数或无板块 → 正常返回（空数组表示未知，不回退到估算）
 */

export const GetStockProfileInput = StockProfileQuerySchema;
export const GetStockProfileOutput = StockProfileSchema;

export const getStockProfileTool = defineTool({
  name: 'get_stock_profile',
  description:
    '拉取单只 A 股的个股档案：股东户数（统计截止日、户数、较上期变动、户均持股与户均市值）与所属板块清单（板块名、代码、是否精确归属、入选理由）。' +
    '数据源为东方财富数据中心公开报表；股东户数与板块都可能为空数组，表示上游未披露而不是零。',
  sideEffect: 'external',
  input: GetStockProfileInput,
  output: GetStockProfileOutput,
  handler: async (input, ctx) => {
    if (ctx.stockProfile === undefined) {
      return errInvalidInput(
        'get_stock_profile tool 需要 ctx.stockProfile 注入；当前 surface 未配置 stock-profile manager',
      );
    }
    const r = await ctx.stockProfile.fetchProfile(input);
    if (!r.ok || r.data === undefined) {
      const cause = r.error?.message ?? 'unknown error';
      return errAdapterError('stock-profile', cause, r.error?.recoverable ?? true);
    }
    return r.data;
  },
});

// 注册：`toolRegistry` 与 `WorkflowToolMap` 都需要补这一行。
export const _StockProfileWorkflowToolMapEntries = {
  get_stock_profile: getStockProfileTool,
} as const satisfies Record<string, ReturnType<typeof defineTool>>;
