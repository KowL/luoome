import { FinancialSnapshotQuerySchema, FinancialSnapshotSchema } from '@luoome/core';

import { defineTool, errAdapterError, errInvalidInput } from '../define-tool.js';

/**
 * 财务当前快照工具（只读）。
 *
 * - sideEffect: 'external' —— 只读快照，不写库、不触发通知
 * - 外部访问沿用 market external 白名单与显式 opt-in
 * - 错误模型：input 解析失败 → invalid_input；manager.adapter_error → adapter_error；
 *   上游无数据 → 正常返回（missingFields 标记缺失）
 *
 * 设计：docs/ddd/fuyao-data-expansion-and-tushare-retirement-design.md §11.1
 *
 * 关键约束：
 * - viewKind='current-vendor-view'，pitStatus='not-ready'；
 * - 不写入 financial_fact_revisions，不进入 strict PIT 评分；
 * - 金额原币元，EPS 元/股；null 保留缺失，不补零；
 * - 季报累计值不单季化；TTM 不由当前快照临时拼接。
 */

export const GetStockFinancialSnapshotInput = FinancialSnapshotQuerySchema;
export const GetStockFinancialSnapshotOutput = FinancialSnapshotSchema;

export const getStockFinancialSnapshotTool = defineTool({
  name: 'get_stock_financial_snapshot',
  description:
    '拉取单只 A 股的财务当前快照：三大报表（利润表、资产负债表、现金流量表）、23 项财务指标（growth/profitability/solvency/operation/cash-flow）与估值快照（PE/PB/PS/PCF）。' +
    '数据源为 Fuyao（同花顺金融数据 API）；这是当前数据商视图（current-vendor-view），不是 PIT 事实，pitStatus=not-ready，不用于历史回测或生产评分。',
  sideEffect: 'external',
  input: GetStockFinancialSnapshotInput,
  output: GetStockFinancialSnapshotOutput,
  handler: async (input, ctx) => {
    if (ctx.financialSnapshot === undefined) {
      return errInvalidInput(
        'get_stock_financial_snapshot tool 需要 ctx.financialSnapshot 注入；当前 surface 未配置 financial-snapshot manager',
      );
    }
    const r = await ctx.financialSnapshot.fetchSnapshot(input);
    if (!r.ok || r.data === undefined) {
      const cause = r.error?.message ?? 'unknown error';
      return errAdapterError('financial-snapshot', cause, r.error?.recoverable ?? true);
    }
    return r.data;
  },
});

// 注册：`toolRegistry` 与 `WorkflowToolMap` 都需要补这一行。
export const _FinancialSnapshotWorkflowToolMapEntries = {
  get_stock_financial_snapshot: getStockFinancialSnapshotTool,
} as const satisfies Record<string, ReturnType<typeof defineTool>>;
