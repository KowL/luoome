import { FetchSectorQuotesQuerySchema, SectorQuoteListSchema } from '@luoome/core';

import { defineTool, errAdapterError, errInvalidInput } from '../define-tool.js';

/**
 * 行业板块行情工具（只读）。
 *
 * - sideEffect: 'read' —— 只读快照，不写库、不触发通知
 * - MCP 默认 read 类暴露（与 ARCHITECTURE §9.2 默认策略一致）
 * - 错误模型：input 解析失败 → invalid_input；manager.adapter_error → adapter_error；
 *   空列表 → 正常返回（warnings=["empty-list"]）
 */

export const FetchSectorQuotesInput = FetchSectorQuotesQuerySchema;
export const FetchSectorQuotesOutput = SectorQuoteListSchema;

export const fetchSectorQuotesTool = defineTool({
  name: 'fetch_sector_quotes',
  description:
    '拉取东方财富行业板块实时行情：板块代码/名称/最新点位/涨跌幅/成交额/上涨下跌家数/领涨股。' +
    'sort 支持 changePct（涨跌幅，默认）与 amount（成交额），均为降序；limit 默认 50 上限 200，all=true 返回完整集合。' +
    '空 items + warnings=["empty-list"] 表示无数据。',
  sideEffect: 'read',
  input: FetchSectorQuotesInput,
  output: FetchSectorQuotesOutput,
  handler: async (input, ctx) => {
    if (ctx.sectorQuote === undefined) {
      return errInvalidInput(
        'fetch_sector_quotes tool 需要 ctx.sectorQuote 注入；当前 surface 未配置 sector-quote manager',
      );
    }
    const r = await ctx.sectorQuote.fetchList(input);
    if (!r.ok || r.data === undefined) {
      // 把 manager 的 adapter_error 映射到 ToolError 'adapter_error' 而不是 throw 变 internal
      const cause = r.error?.message ?? 'unknown error';
      return errAdapterError('sector-quote', cause, r.error?.recoverable ?? true);
    }
    return r.data;
  },
});

// 注册：`toolRegistry` 与 `WorkflowToolMap` 都需要补这一行。
export const _SectorQuoteWorkflowToolMapEntries = {
  fetch_sector_quotes: fetchSectorQuotesTool,
} as const satisfies Record<string, ReturnType<typeof defineTool>>;
