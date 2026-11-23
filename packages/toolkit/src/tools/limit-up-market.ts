import {
  buildLimitUpMarketView,
  LimitUpMarketQuerySchema,
  LimitUpMarketViewSchema,
} from '@luoome/core';

import { defineTool, errAdapterError, errInvalidInput } from '../define-tool.js';

/**
 * 涨停市场看板工具（只读）。
 *
 * 一次返回看板需要的三个维度：涨停池（所选交易日）+ 涨停统计（同日）+ 近 30 日连板矩阵
 * （接口固定窗口，不随 date 变化）。单维上游失败时该维为 null 并在 warnings 里标记，
 * 后端不拼凑、不用 0 冒充缺失。
 *
 * - sideEffect: 'read' —— 只读快照，不写库、不触发通知
 * - 数据源只有 fuyao（付费，需 FUYAO_API_KEY，且要在 plugins.json 启用 source.fuyao）；没有免费源时如实报原因，
 *   并指向免费的 limit_up_ladder（东方财富涨停池 / 连板梯队）
 */

export const LimitUpMarketInput = LimitUpMarketQuerySchema;
export const LimitUpMarketOutput = LimitUpMarketViewSchema;

export const limitUpMarketTool = defineTool({
  name: 'limit_up_market',
  description:
    '拉取指定交易日 A 股涨停市场看板：涨停池逐股明细（连板/封板时间/开板次数/封单额/涨停原因）、' +
    '涨停统计（封板率/开板家数/板位档位与晋级率）与近 30 个交易日连板矩阵（接口固定窗口，与 date 无关）。' +
    '空池 + warnings=["empty-pool"] 表示非交易日或盘前未更新；某维不可用时该维为 null 并有对应 warning。' +
    '数据源是付费的 fuyao（需 FUYAO_API_KEY）；没有配置时不要向用户推荐购买，先用免费的 limit_up_ladder 回答。',
  sideEffect: 'read',
  input: LimitUpMarketInput,
  output: LimitUpMarketOutput,
  handler: async (input, ctx) => {
    const manager = ctx.adapters.marketIntel?.limitUpMarket;
    if (manager === undefined || manager.sources.length === 0) {
      return errInvalidInput(
        '涨停市场看板没有可用数据源：已注册来源只有付费的 fuyao（需要 FUYAO_API_KEY，且 source.fuyao 已启用）。' +
          '免费替代是东方财富连板天梯（limit_up_ladder tool），有当日涨停池与连板梯队，但没有封板率统计与 30 日矩阵',
      );
    }
    const r = await manager.fetchMarket(input);
    if (!r.ok || r.data === undefined) {
      const cause = r.error?.message ?? 'unknown error';
      return errAdapterError('limit-up-market', cause, r.error?.recoverable ?? true);
    }
    // KPI 与原因分布在 core 派生，UI 只排版，避免同一口径出现第二份实现
    return buildLimitUpMarketView(r.data);
  },
});
