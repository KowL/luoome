import { z } from 'zod';

/**
 * 数据溯源值对象（ruo 能力迁移 Phase 1，PRD 决策 13 / 详设 §3.3）。
 *
 * 描述「这条数据从哪来、对应什么时间、是否新鲜」。Phase 1 嵌入点：
 * - StockEvent（展开为列：provider / observedAt / fetchedAt / stale）
 * - 行情状态读模型（get_market_data_status）
 *
 * Quote 自 Phase 3 起直接携带 observedAt / fetchedAt / timestampSource；
 * 此值对象继续承载需要 freshness、fallback 和错误信息的读模型。
 */

export const DataFreshnessSchema = z.enum(['fresh', 'stale', 'unknown', 'unavailable']);
export type DataFreshness = z.infer<typeof DataFreshnessSchema>;

export const DataProvenanceSchema = z.object({
  provider: z.string().min(1),
  /** 数据实际对应时间（≠ 抓取时间）。 */
  observedAt: z.coerce.date(),
  /** 抓取时间。 */
  fetchedAt: z.coerce.date(),
  freshness: DataFreshnessSchema,
  /** 主源失败降级时的原 provider。 */
  fallbackFrom: z.string().optional(),
  errorKind: z.string().optional(),
  errorMessage: z.string().max(300).optional(),
});

export type DataProvenance = z.infer<typeof DataProvenanceSchema>;
