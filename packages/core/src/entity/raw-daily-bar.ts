import { z } from 'zod';

/**
 * 原始（未复权）日线 revision（设计 §5.3）。
 *
 * 与规范前复权 DailyBar / daily_bar_revisions 严格分离：
 * - dump 日 K 固定 interval=1d、adjusted=none、CNY；本实体只承载这种 raw 事实；
 * - 不得把本实体写入 daily_bars / daily_bar_revisions 并声称 qfq；
 * - 主键沿用 revision 思路 (stockId, date, recordedAt, contentHash)：
 *   同一 run 重放（同 recordedAt 同 hash）幂等；后到的全量 dump 用新的 recordedAt
 *   形成新 revision，不回改过去 cutoff 已可见的数据；
 * - contentHash 覆盖价格/成交量/成交额与来源身份，重复主键不同内容必须并存保留。
 */

export const RawDailyBarRevisionSchema = z
  .object({
    stockId: z.string().min(1),
    /** 交易日（上海零点）。 */
    date: z.coerce.date(),
    open: z.number().positive(),
    high: z.number().positive(),
    low: z.number().positive(),
    close: z.number().positive(),
    /** 成交量（股）；停牌占位行可为 0，仍保留为事实。 */
    volume: z.number().nonnegative(),
    /** 成交额（元）；上游缺失时保留 null，不补 0。 */
    turnover: z.number().nonnegative().nullable(),
    source: z.literal('fuyao'),
    /** 产生本 revision 的 dump 身份与内容寻址。 */
    dumpId: z.string().min(1),
    artifactSha256: z.string().regex(/^[a-f0-9]{64}$/),
    /** 本地批次记录时间（run 冻结值）；PIT cutoff 按它过滤。 */
    recordedAt: z.coerce.date(),
    contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .superRefine((bar, ctx) => {
    if (bar.high < Math.max(bar.open, bar.close)) {
      ctx.addIssue({ code: 'custom', path: ['high'], message: 'high 必须覆盖 open 与 close' });
    }
    if (bar.low > Math.min(bar.open, bar.close)) {
      ctx.addIssue({ code: 'custom', path: ['low'], message: 'low 必须低于 open 与 close' });
    }
  });
export type RawDailyBarRevision = z.infer<typeof RawDailyBarRevisionSchema>;
