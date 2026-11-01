import { z } from 'zod';

/**
 * 三角分析的**开启门槛**（REQ-M4-02 需求 4 / 5）。
 *
 * ## 为什么两个门槛的原因码必须分开
 *
 * - `dataHealth=unavailable` → **数据不可用**：等数据恢复就能开
 * - 盘时段内 → **场景不合适**：盘中价格在动，多空论证会被行情噪声牵着走；
 *   它**不是**数据问题（数据可能完全健康），收盘后自然就能开
 *
 * 复用一个原因码会让用户按错误的线索排查：
 * 看到「数据不可用」会去查数据源，而实际上数据好好的、只是时间不对。
 * PRD 因此明文要求「返回独立原因码，**不复用 dataHealth**」。
 */

/** 数据健康档。`unavailable` = 上游不可达/全部关键事实缺失。 */
export const TriangleDataHealthSchema = z.enum(['complete', 'partial', 'unavailable']);
export type TriangleDataHealth = z.infer<typeof TriangleDataHealthSchema>;

/** 交易时段（与 `get_market_data_status` 的 `marketSession` 同口径）。 */
export const TriangleMarketSessionSchema = z.enum([
  'pre-open',
  'trading',
  'midday-break',
  'closed',
  'non-trading-day',
]);
export type TriangleMarketSession = z.infer<typeof TriangleMarketSessionSchema>;

/**
 * 门槛拒绝的原因码。**两个来源各自的码不复用。**
 */
export const TRIANGLE_BLOCK_CODES = [
  /** 数据不可用（`dataHealth=unavailable`）。 */
  'data-unavailable',
  /** 盘时段内禁止开启（场景门槛，与数据无关）。 */
  'market-session-in-trading',
] as const;
export const TriangleBlockCodeSchema = z.enum(TRIANGLE_BLOCK_CODES);
export type TriangleBlockCode = z.infer<typeof TriangleBlockCodeSchema>;

/** 单票快问场景：**标注不推荐，但不硬拦**（PRD 需求 5 后半句）。 */
export const TRIANGLE_SCENARIO = z.enum(['research', 'single-stock-quick-question']);

export const TriangleGateResultSchema = z.discriminatedUnion('allowed', [
  z
    .object({ allowed: z.literal(false), code: TriangleBlockCodeSchema, message: z.string() })
    .strict(),
  z
    .object({
      allowed: z.literal(true),
      /** 允许时也可能有提醒（如「单票快问场景不推荐」）；提醒**永不阻止**。 */
      advisories: z.array(z.string()),
      /** `partial` 时允许并**推荐**（PRD 明文）。 */
      recommended: z.boolean(),
    })
    .strict(),
]);
export type TriangleGateResult = z.infer<typeof TriangleGateResultSchema>;

/**
 * 判定能否开启。
 *
 * 顺序刻意先判数据、再判时段：数据不可用时，谈「盘中不盘中」没有意义——
 * 用户先得把数据修好。
 */
export const triangleGate = (input: {
  readonly dataHealth: TriangleDataHealth;
  readonly marketSession: TriangleMarketSession;
  readonly scenario?: z.infer<typeof TRIANGLE_SCENARIO>;
}): TriangleGateResult => {
  if (input.dataHealth === 'unavailable')
    return {
      allowed: false,
      code: 'data-unavailable',
      message: '关键数据当前不可用，无法开启三角分析；请先恢复数据源。',
    };

  // 盘时段：**只拦 trading**（含午间休市前后仍在盘中）。
  // `pre-open` / `closed` / `non-trading-day` 都可以开——收盘后正是它该用的场景。
  if (input.marketSession === 'trading' || input.marketSession === 'midday-break')
    return {
      allowed: false,
      code: 'market-session-in-trading',
      message: '盘时段内不开启三角分析（行情仍在变动，多空论证会被噪声牵动）；收盘后再来。',
    };

  const advisories: string[] = [];
  if (input.scenario === 'single-stock-quick-question')
    advisories.push('单票快问场景不推荐用三角分析——它适合有完整上下文的研究，但仍可继续。');

  return {
    allowed: true,
    advisories,
    // `partial` 允许且**推荐**：缺口会让分析产出「缺口清单 + 阻塞条件」，那正是它的价值。
    recommended: input.dataHealth === 'partial',
  };
};
