import { dateInShanghai, type LimitUpLadderEntry, type ToolContext } from '@luoome/core';
import { z } from 'zod';

const RecentLimitUpSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  ladderLevel: z.number().int().positive(),
  reason: z.string(),
  firstTime: z.string().nullable(),
  finalTime: z.string().nullable(),
  corrected: z.boolean(),
});

export const StockLimitUpFactsSchema = z.object({
  stockId: z.string().min(1),
  code: z.string().regex(/^\d{6}$/),
  status: z.enum(['available', 'unavailable']),
  today: RecentLimitUpSchema.nullable(),
  recent: z.array(RecentLimitUpSchema).max(30),
  asOf: z.coerce.date().nullable(),
  warnings: z.array(z.string()),
});

export type StockLimitUpFacts = z.infer<typeof StockLimitUpFactsSchema>;

const toDate = (base: string, delta: number): string => {
  const date = new Date(`${base}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() - delta);
  return date.toISOString().slice(0, 10);
};

const entryFor = (entry: LimitUpLadderEntry): z.infer<typeof RecentLimitUpSchema> => ({
  date: entry.limitUpDate,
  ladderLevel: entry.ladderLevel,
  reason: entry.reason,
  firstTime: entry.firstTime,
  finalTime: entry.finalTime,
  corrected: entry.corrected,
});

/**
 * 通过统一 manager 拉取可获得的历史日期；任何单日失败都进入 warnings，
 * 不把“上游不支持历史”伪装成正常空列表。
 */
export const loadStockLimitUpFacts = async (
  stockId: string,
  code: string,
  anchorDate: string,
  ctx: ToolContext,
): Promise<StockLimitUpFacts> => {
  if (ctx.limitUpLadder === undefined) {
    return {
      stockId,
      code,
      status: 'unavailable',
      today: null,
      recent: [],
      asOf: null,
      warnings: ['limit-up-ladder-manager-unavailable'],
    };
  }
  const warnings: string[] = [];
  const rows: Array<z.infer<typeof RecentLimitUpSchema>> = [];
  let successful = 0;
  let latestAsOf: Date | null = null;
  for (let offset = 0; offset < 30; offset += 1) {
    const date = toDate(anchorDate, offset);
    const result = await ctx.limitUpLadder.fetchLadder({
      date,
      source: 'eastmoney',
      days: 30,
      includeUncategorized: false,
      includeStar: false,
      includeBse: false,
      includeST: false,
    });
    if (!result.ok || result.data === undefined) {
      warnings.push(`${date}: ${result.error?.message ?? 'history-unavailable'}`);
      continue;
    }
    successful += 1;
    if (latestAsOf === null || result.data.asOf.getTime() > latestAsOf.getTime()) {
      latestAsOf = result.data.asOf;
    }
    const match = result.data.levels
      .flatMap((level) => level.stocks)
      .find((entry) => entry.code === code);
    if (match !== undefined) rows.push(entryFor(match));
    if (result.data.warnings.length > 0)
      warnings.push(`${date}: ${result.data.warnings.join(', ')}`);
  }
  const recent = [...new Map(rows.map((row) => [row.date, row])).values()]
    .sort((left, right) => right.date.localeCompare(left.date))
    .slice(0, 30);
  const today = recent.find((row) => row.date === anchorDate) ?? null;
  return StockLimitUpFactsSchema.parse({
    stockId,
    code,
    status: successful === 0 ? 'unavailable' : 'available',
    today,
    recent,
    asOf: latestAsOf,
    warnings: [...new Set(warnings)],
  });
};

export const currentLimitUpDate = (ctx: ToolContext): string => dateInShanghai(ctx.clock());
