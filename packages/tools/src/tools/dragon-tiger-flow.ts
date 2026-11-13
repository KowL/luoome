import { DragonTigerFlowQuerySchema, DragonTigerFlowSchema } from '@luoome/core';

import { defineTool, errAdapterError, errInvalidInput } from '../define-tool.js';

/**
 * 龙虎榜资金流向拓扑工具（只读）。
 *
 * - 数据源：同花顺（fuyao）龙虎榜，按交易日拉全榜后跨日聚合
 * - 输出：概念累计净额轨迹 + 机构 / 游资 / 其他拆解 + 概念内个股正负贡献
 * - 口径：一股多概念按概念数等分净额（守恒）；默认只纳入 1 日榜，避免与 3 日榜重复
 * - 错误模型：未配置 FUYAO_API_KEY → invalid_input；上游失败 → adapter_error
 */

export const DragonTigerFlowInput = DragonTigerFlowQuerySchema;
export const DragonTigerFlowOutput = DragonTigerFlowSchema;

export const dragonTigerFlowTool = defineTool({
  name: 'dragon_tiger_flow',
  description:
    '拉取近 N 个交易日（5/10/20，默认 10）A 股龙虎榜的概念级资金流向：' +
    '每个概念的逐日累计净额轨迹、区间净额排行、机构/游资/其他拆解，以及概念内正负贡献个股。' +
    '一只股票属于多个概念时按概念数等分净额（概念总额守恒）；默认只纳入 1 日榜（rangeDays=1）。' +
    'board 支持 all（全榜）/ org（机构）/ hot（游资）。数据源为同花顺龙虎榜，需要 FUYAO_API_KEY。',
  sideEffect: 'read',
  input: DragonTigerFlowInput,
  output: DragonTigerFlowOutput,
  handler: async (input, ctx) => {
    if (ctx.adapters.marketIntel?.dragonTigerFlow === undefined) {
      return errInvalidInput(
        'dragon_tiger_flow tool 需要 ctx.adapters.marketIntel?.dragonTigerFlow 注入；当前 surface 未配置 fuyao 龙虎榜资金流向（需要 FUYAO_API_KEY）',
      );
    }
    const r = await ctx.adapters.marketIntel.dragonTigerFlow.fetchFlow(input);
    if (!r.ok || r.data === undefined) {
      const cause = r.error?.message ?? 'unknown error';
      return errAdapterError('dragon-tiger-flow', cause, r.error?.recoverable ?? true);
    }
    return r.data;
  },
});

// 注册：`toolRegistry` 与 `WorkflowToolMap` 都需要补这一行。
export const _DragonTigerFlowWorkflowToolMapEntries = {
  dragon_tiger_flow: dragonTigerFlowTool,
} as const satisfies Record<string, ReturnType<typeof defineTool>>;
