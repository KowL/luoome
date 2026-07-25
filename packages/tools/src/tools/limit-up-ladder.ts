import {
  LimitUpLadderCompareInputSchema,
  LimitUpLadderCompareOutputSchema,
  LimitUpLadderQuerySchema,
  LimitUpLadderSchema,
} from '@luoome/core';
import { z } from 'zod';

import { defineTool, errInvalidInput } from '../define-tool.js';

/**
 * 连板天梯工具（Phase 1，docs/ddd/limit-up-ladder-detailed-design.md §7）。
 *
 * - sideEffect: 'read' —— 只读快照，不写库、不触发通知
 * - MCP 默认 read 类暴露（与 ARCHITECTURE §9.2 默认策略一致）
 * - 错误模型：input 解析失败 → invalid_input；manager.adapter_error → adapter_error；
 *   空 ladder / 非交易日 / 字段缺失 → 正常返回（部分以 warnings 表达）
 */

export const LimitUpLadderInput = LimitUpLadderQuerySchema;
export const LimitUpLadderOutput = LimitUpLadderSchema;

export const limitUpLadderTool = defineTool({
  name: 'limit_up_ladder',
  description:
    '拉取指定交易日 A 股（默认主板+创业板，可选科创板/北交所/ST）的涨停梯队快照。返回不可变快照。' +
    '空 levels + warnings=["non-trading-day"] 表示非交易日；warnings=["empty-ladder"] 表示盘前/数据未更新。',
  sideEffect: 'read',
  input: LimitUpLadderInput,
  output: LimitUpLadderOutput,
  handler: async (input, ctx) => {
    if (ctx.limitUpLadder === undefined) {
      return errInvalidInput(
        'limit_up_ladder tool 需要 ctx.limitUpLadder 注入；当前 surface 未配置 limit-up-ladder manager',
      );
    }
    const r = await ctx.limitUpLadder.fetchLadder(input);
    if (!r.ok || r.data === undefined) {
      // 返回 invariant_violation 之外的内部错误模型在 define-tool 里走 internal
      // 这里改用 standard 业务错误：把 adapter_error 透传给 ToolError 协议
      throw new Error(`limit_up_ladder adapter_error: ${r.error?.message ?? 'unknown error'}`);
    }
    return r.data;
  },
});

export const LimitUpLadderCompareInput = LimitUpLadderCompareInputSchema;
export const LimitUpLadderCompareOutput = LimitUpLadderCompareOutputSchema;

export const limitUpLadderCompareTool = defineTool({
  name: 'limit_up_ladder_compare',
  description:
    '对比两日 A 股涨停梯队快照（curr vs prev），返回 diff（maxLevelDelta / totalDelta / 顶级成员 added/removed/retained）。' +
    '为报告 / 仪表盘使用。',
  sideEffect: 'read',
  input: LimitUpLadderCompareInput,
  output: LimitUpLadderCompareOutput,
  handler: async (input, ctx) => {
    if (ctx.limitUpLadder === undefined) {
      return errInvalidInput('limit_up_ladder_compare tool 需要 ctx.limitUpLadder 注入');
    }
    const { date, prevDate, ...rest } = input;
    const r = await ctx.limitUpLadder.compareLadder(date, prevDate, rest);
    if (!r.ok || r.data === undefined) {
      throw new Error(
        `limit_up_ladder_compare adapter_error: ${r.error?.message ?? 'unknown error'}`,
      );
    }
    return r.data;
  },
});

// 注册：`toolRegistry` 与 `WorkflowToolMap` 都需要补这两行。
// 见 docs/ddd/limit-up-ladder-detailed-design.md §7。
export const _WorkflowToolMapEntries = {
  limit_up_ladder: limitUpLadderTool,
  limit_up_ladder_compare: limitUpLadderCompareTool,
} as const satisfies Record<string, ReturnType<typeof defineTool>>;

// 防止 z import unused 警告
void z;
