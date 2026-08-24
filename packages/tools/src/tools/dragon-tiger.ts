import { DragonTigerListQuerySchema, DragonTigerListSchema } from '@luoome/core';

import { defineTool, errAdapterError, errInvalidInput } from '../define-tool.js';

/**
 * 龙虎榜工具（只读）。
 *
 * - sideEffect: 'read' —— 只读快照，不写库、不触发通知
 * - MCP 默认 read 类暴露（与 ARCHITECTURE §9.2 默认策略一致）
 * - 错误模型：input 解析失败 → invalid_input；manager.adapter_error → adapter_error；
 *   空榜单 / 非交易日 / 字段缺失 → 正常返回（部分以 warnings 表达）
 */

export const DragonTigerListInput = DragonTigerListQuerySchema;
export const DragonTigerListOutput = DragonTigerListSchema;

export const dragonTigerListTool = defineTool({
  name: 'dragon_tiger_list',
  description:
    '拉取指定交易日 A 股龙虎榜榜单（代码/名称/收盘价/涨跌幅/换手率/上榜原因/龙虎榜净买入/买入/卖出/成交额）。' +
    'date 缺省时取当天（非交易日回退到最近交易日）。空 entries + warnings=["non-trading-day"] 表示非交易日；' +
    'warnings=["empty-list"] 表示当日无上榜或数据未更新。',
  sideEffect: 'read',
  input: DragonTigerListInput,
  output: DragonTigerListOutput,
  handler: async (input, ctx) => {
    if (ctx.dragonTiger === undefined) {
      return errInvalidInput(
        'dragon_tiger_list tool 需要 ctx.dragonTiger 注入；当前 surface 未配置 dragon-tiger manager',
      );
    }
    const r = await ctx.dragonTiger.fetchList(input);
    if (!r.ok || r.data === undefined) {
      // 把 manager 的 adapter_error 映射到 ToolError 'adapter_error' 而不是 throw 变 internal
      const cause = r.error?.message ?? 'unknown error';
      return errAdapterError('dragon-tiger', cause, r.error?.recoverable ?? true);
    }
    return r.data;
  },
});

// 注册：`toolRegistry` 与 `WorkflowToolMap` 都需要补这一行。
// （命名加前缀避免与 limit-up-ladder.ts 的同名标记在桶导出时冲突。）
export const _DragonTigerWorkflowToolMapEntries = {
  dragon_tiger_list: dragonTigerListTool,
} as const satisfies Record<string, ReturnType<typeof defineTool>>;
