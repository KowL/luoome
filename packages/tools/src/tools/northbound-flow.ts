import { NorthboundFlowQuerySchema, NorthboundFlowSeriesSchema } from '@luoome/core';

import { defineTool, errAdapterError, errInvalidInput } from '../define-tool.js';

/**
 * 北向资金历史流工具（只读）。
 *
 * - sideEffect: 'read' —— 只读序列，不写库、不触发通知
 * - MCP 默认 read 类暴露（与 ARCHITECTURE §9.2 默认策略一致）
 * - 错误模型：input 解析失败 → invalid_input；manager.adapter_error → adapter_error；
 *   空序列 / 净买入未披露 → 正常返回（以 warnings 表达）
 */

export const NorthboundFlowInput = NorthboundFlowQuerySchema;
export const NorthboundFlowOutput = NorthboundFlowSeriesSchema;

export const northboundFlowTool = defineTool({
  name: 'northbound_flow',
  description:
    '拉取截止最近交易日的北向资金（沪股通+深股通合计）日级历史序列：每日成交总额（元），' +
    '以及 2024-08-16 之前的每日净买入/买入/卖出额（之后交易所不再披露，对应字段为 null）。' +
    '入参 days（默认 30，上限 250）与可选 endDate（非交易日向前对齐）。' +
    '空 series + warnings=["empty-list"] 表示无数据。',
  sideEffect: 'read',
  input: NorthboundFlowInput,
  output: NorthboundFlowOutput,
  handler: async (input, ctx) => {
    if (ctx.northboundFlow === undefined) {
      return errInvalidInput(
        'northbound_flow tool 需要 ctx.northboundFlow 注入；当前 surface 未配置 northbound-flow manager',
      );
    }
    const r = await ctx.northboundFlow.fetchSeries(input);
    if (!r.ok || r.data === undefined) {
      // 把 manager 的 adapter_error 映射到 ToolError 'adapter_error' 而不是 throw 变 internal
      const cause = r.error?.message ?? 'unknown error';
      return errAdapterError('northbound-flow', cause, r.error?.recoverable ?? true);
    }
    return r.data;
  },
});

// 注册：`toolRegistry` 与 `WorkflowToolMap` 都需要补这一行。
export const _NorthboundFlowWorkflowToolMapEntries = {
  northbound_flow: northboundFlowTool,
} as const satisfies Record<string, ReturnType<typeof defineTool>>;
