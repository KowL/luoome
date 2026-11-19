import { z } from 'zod';

import { MoneySchema } from '../types/branded.js';

/**
 * 反馈与结算是两件不同的事实，必须分表存放：
 *
 * - AdviceFeedback：用户当时点了什么（做了 / 没做 / 再等等）。只在点击时写入，
 *   是行为记录，可能缺失（用户不看就等于没反馈）。
 * - AdviceSettlement：按建议假设执行后，T+1/T+3/T+5 的日线结果。由系统计算，
 *   与用户是否点击无关。
 *
 * 分开存才能回答「建议本身对不对」而不被用户的执行力污染——
 * 这也是每周成绩单可信的前提（历史上 advice_outcomes 0 行、confidence 与盈亏无法对账）。
 */
export const AdviceFeedbackActionSchema = z.enum(['done', 'skipped', 'later']);
export type AdviceFeedbackAction = z.infer<typeof AdviceFeedbackActionSchema>;

export const AdviceFeedbackSchema = z.object({
  adviceId: z.string().min(1),
  action: AdviceFeedbackActionSchema,
  /** 「做了」时的实际成交价；缺省用建议入场区间中值作为假设成交价。 */
  fillPrice: MoneySchema.optional(),
  recordedAt: z.coerce.date(),
});
export type AdviceFeedback = z.infer<typeof AdviceFeedbackSchema>;

/** 结算时点：T+1 / T+3 / T+5（自然交易日，按本地日线取）。 */
export const SettlementHorizonSchema = z.union([z.literal(1), z.literal(3), z.literal(5)]);
export type SettlementHorizon = z.infer<typeof SettlementHorizonSchema>;

export const AdviceSettlementSchema = z.object({
  adviceId: z.string().min(1),
  horizonDays: SettlementHorizonSchema,
  /** 假设成交价（建议入场区间中值，或用户填的 fillPrice）。 */
  assumedEntryPrice: MoneySchema,
  /** 该时点的收盘价。 */
  exitPrice: MoneySchema,
  /** 相对假设成交价的收益率（0.023 = +2.3%）。 */
  returnPct: z.number().finite(),
  /** 同期沪深300 收益率，用于扣掉 beta。 */
  benchmarkReturnPct: z.number().finite(),
  /** returnPct - benchmarkReturnPct。 */
  excessPct: z.number().finite(),
  /** 是否命中：由建议方向与该时点收益共同决定。 */
  hit: z.boolean(),
  evaluatedAt: z.coerce.date(),
  /** 无法结算时的原因（停牌、缺日线等）；此时价格字段为 0 且 hit=false。 */
  note: z.string().max(500).optional(),
});
export type AdviceSettlement = z.infer<typeof AdviceSettlementSchema>;
