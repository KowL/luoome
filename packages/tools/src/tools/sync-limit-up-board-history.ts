import {
  dateInShanghai,
  deriveLimitUpBoardHistory,
  isHoliday,
  isWeekend,
  previousTradingDate,
  type ToolContext,
} from '@luoome/core';
import { z } from 'zod';

import { defineTool, errAdapterError, errInvalidInput } from '../define-tool.js';

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const SOURCE = 'fuyao-limit-up';

const isNonTradingDay = (date: string): boolean => {
  const instant = new Date(`${date}T12:00:00+08:00`);
  return isWeekend(instant) || isHoliday(instant);
};

export const SyncLimitUpBoardHistoryInput = z.object({
  /** 交易日（Asia/Shanghai）；缺省为今天。历史补采必须显式传入。 */
  date: z.string().regex(DATE).optional(),
});

export const SyncLimitUpBoardHistoryOutput = z.object({
  tradeDate: z.string().regex(DATE),
  status: z.enum(['complete', 'partial', 'unavailable']),
  vintage: z.enum(['captured', 'backfill']),
  facts: z.number().int().nonnegative(),
  broken: z.number().int().nonnegative(),
  boardBreaks: z.number().int().nonnegative(),
  missingFields: z.array(z.string()).max(20),
  warnings: z.array(z.string()).max(20),
});

/**
 * 采集并派生单日炸板/断板事实（workflow-only）。
 *
 * 只消费 fuyao 涨停池与炸板池的成员关系：封板 = 出现在涨停池；炸板 = 出现在炸板池且未收盘封板；
 * 断板 = 上一交易日有连板高度、当日未封板。任一必要池缺失时写 partial 并在字段上保留 null。
 */
export const syncLimitUpBoardHistoryTool = defineTool({
  name: 'sync_limit_up_board_history',
  description: 'workflow-only：按 fuyao 涨停池/炸板池采集单日炸板与断板事实，写入 PIT 历史',
  sideEffect: 'write',
  input: SyncLimitUpBoardHistoryInput,
  output: SyncLimitUpBoardHistoryOutput,
  handler: async (input, ctx: ToolContext) => {
    const adapter = ctx.adapters.limitUpBoard;
    if (adapter === undefined) {
      return errInvalidInput('炸板/断板数据源未配置：需要 FUYAO_API_KEY');
    }
    const now = ctx.clock();
    const tradeDate = input.date ?? dateInShanghai(now);
    if (isNonTradingDay(tradeDate)) {
      return errInvalidInput(`非交易日不采集炸板/断板事实：${tradeDate}`);
    }
    const previousDate = previousTradingDate(new Date(`${tradeDate}T12:00:00+08:00`));
    const warnings: string[] = [];

    let sealed: Awaited<ReturnType<typeof adapter.fetchLimitUpPool>>;
    try {
      sealed = await adapter.fetchLimitUpPool(tradeDate);
    } catch (error) {
      return errAdapterError(
        SOURCE,
        `涨停池不可用：${error instanceof Error ? error.message : String(error)}`,
        true,
      );
    }

    let broken: readonly string[] | null = null;
    let breakPublishedAt: Date | undefined;
    try {
      const breakPool = await adapter.fetchLimitBreakPool(tradeDate);
      broken = breakPool.stockIds;
      breakPublishedAt = breakPool.publishedAt;
    } catch (error) {
      warnings.push(`炸板池不可用：${error instanceof Error ? error.message : String(error)}`);
    }

    let previousSealed: Awaited<ReturnType<typeof adapter.fetchLimitUpPool>>['rows'] | null = null;
    let previousPublishedAt: Date | undefined;
    try {
      const previousPool = await adapter.fetchLimitUpPool(previousDate);
      previousSealed = previousPool.rows;
      previousPublishedAt = previousPool.publishedAt;
    } catch (error) {
      warnings.push(
        `${previousDate} 涨停池不可用：${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const publishedAt = new Date(
      Math.max(
        sealed.publishedAt.getTime(),
        breakPublishedAt?.getTime() ?? 0,
        previousPublishedAt?.getTime() ?? 0,
      ),
    );
    const history = deriveLimitUpBoardHistory({
      tradeDate,
      source: SOURCE,
      dataAsOf: publishedAt,
      publishedAt,
      fetchedAt: sealed.fetchedAt,
      vintage: tradeDate === dateInShanghai(now) ? 'captured' : 'backfill',
      recordedAt: now,
      sealed: sealed.rows,
      broken,
      previousSealed,
      warnings,
    });
    await ctx.repos.limitUpBoardHistory.save(history);

    return {
      tradeDate,
      status: history.status,
      vintage: history.vintage,
      facts: history.facts.length,
      broken: history.facts.filter((fact) => fact.isBroken === true).length,
      boardBreaks: history.facts.filter((fact) => fact.isBoardBreak === true).length,
      missingFields: history.missingFields,
      warnings: history.warnings,
    };
  },
});
