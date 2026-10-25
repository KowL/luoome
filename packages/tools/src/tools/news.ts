import { FetchNewsQuerySchema, NewsListSchema } from '@luoome/core';

import { defineTool, errAdapterError, errInvalidInput } from '../define-tool.js';

/**
 * 财经要闻工具（外部网络读取，不写库、不触发通知）。
 *
 * - sideEffect: 'external' —— 调用 eastmoney / 10jqka 第三方新闻接口，本身不改本地状态；
 *   是否访问第三方是暴露面的分类依据，因此归为 external 且默认不暴露：MCP 需
 *   LUOOME_EXPOSE_EXTERNAL=true，dsh-luoome 需在 market external allowlist 显式点名。
 * - 错误模型：input 解析失败 → invalid_input；manager.adapter_error → adapter_error；
 *   空列表 → 正常返回（warnings=["empty-list"]）
 */

export const FetchNewsInput = FetchNewsQuerySchema;
export const FetchNewsOutput = NewsListSchema;

export const fetchNewsTool = defineTool({
  name: 'fetch_news',
  description:
    '分页拉取东方财富或同花顺财经要闻流：id/标题/摘要/分类/来源媒体/发布时间/原文链接，按发布时间倒序。' +
    '可选 category（宏观/市场/行业/公司/监管/海外/商品/资金/政策，标题关键词推断）与 keyword（标题/摘要包含）过滤，' +
    'source 选择数据源，page 从 1 开始，limit 默认 30 上限 100。空 items + warnings=["empty-list"] 表示无匹配。',
  sideEffect: 'external',
  input: FetchNewsInput,
  output: FetchNewsOutput,
  handler: async (input, ctx) => {
    if (ctx.news === undefined) {
      return errInvalidInput(
        'fetch_news tool 需要 ctx.news 注入；当前 surface 未配置 news manager',
      );
    }
    const r = await ctx.news.fetchNews(input);
    if (!r.ok || r.data === undefined) {
      // 把 manager 的 adapter_error 映射到 ToolError 'adapter_error' 而不是 throw 变 internal
      const cause = r.error?.message ?? 'unknown error';
      return errAdapterError('news', cause, r.error?.recoverable ?? true);
    }
    return r.data;
  },
});

// 注册：`toolRegistry` 与 `WorkflowToolMap` 都需要补这一行。
export const _NewsWorkflowToolMapEntries = {
  fetch_news: fetchNewsTool,
} as const satisfies Record<string, ReturnType<typeof defineTool>>;
