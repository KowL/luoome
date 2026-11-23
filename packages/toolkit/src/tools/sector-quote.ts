import { FetchSectorQuotesQuerySchema, SectorQuoteListSchema } from '@luoome/core';

import { defineTool, errAdapterError, errInvalidInput } from '../define-tool.js';

/**
 * 行业板块行情工具（只读）。
 *
 * - sideEffect: 'external' —— 只读快照，不写库、不触发通知
 * - MCP 默认 read 类暴露（与 ARCHITECTURE §9.2 默认策略一致）
 * - 错误模型：input 解析失败 → invalid_input；manager.adapter_error → adapter_error；
 *   空列表 → 正常返回（warnings=["empty-list"]）
 * - source 是实际命中数据源（东方财富→新浪财经回退），不是请求参数；
 *   新浪板块代码为 new_xxx、缺涨跌家数，且不支持板块成分/详情
 */

export const FetchSectorQuotesInput = FetchSectorQuotesQuerySchema;
export const FetchSectorQuotesOutput = SectorQuoteListSchema;

export const fetchSectorQuotesTool = defineTool({
  name: 'fetch_sector_quotes',
  description:
    '拉取行业板块实时行情（默认东方财富，不可达时回退新浪财经）：板块代码/名称/最新点位/涨跌幅/成交额/上涨下跌家数/领涨股。' +
    'sort 支持 changePct（涨跌幅，默认）与 amount（成交额），均为降序；limit 默认 50 上限 200，all=true 返回完整集合。' +
    '结果 source 为实际命中来源：source=sina 时没有涨跌家数（upCount/downCount 缺失），板块代码是 new_xxx（东财为 BKxxxx），' +
    '两套体系不互通，该来源不支持板块成分/详情查询。空 items + warnings=["empty-list"] 表示无数据。',
  sideEffect: 'external',
  input: FetchSectorQuotesInput,
  output: FetchSectorQuotesOutput,
  handler: async (input, ctx) => {
    if (ctx.adapters.marketIntel?.sectorQuote === undefined) {
      return errInvalidInput(
        'fetch_sector_quotes tool 需要 ctx.adapters.marketIntel?.sectorQuote 注入；当前 surface 未配置 sector-quote manager',
      );
    }
    const r = await ctx.adapters.marketIntel?.sectorQuote.fetchList(input);
    if (!r.ok || r.data === undefined) {
      // 把 manager 的 adapter_error 映射到 ToolError 'adapter_error' 而不是 throw 变 internal
      const cause = r.error?.message ?? 'unknown error';
      return errAdapterError('sector-quote', cause, r.error?.recoverable ?? true);
    }
    return r.data;
  },
});
