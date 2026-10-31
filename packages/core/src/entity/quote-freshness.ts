import { dateInShanghai, previousTradingDate } from '../trading-calendar.js';

/**
 * 持仓报价的**时效分档**（task-30）。
 *
 * 与市场级 `marketObservationScope`（`analysis-context.ts`）**平行但不同**，不要混用：
 * - 那个的参照系是**报告期**，回答「能不能当今日依据」（盘前复用昨收 = 正常）；
 * - 这个的参照系是**当下时刻 + 交易时段**，回答「这个价现在还算不算数」——
 *   同一份昨收数据，盘前正常、**盘中就是陈旧**。
 * 两者共享同一份日历原语（`dateInShanghai` / `previousTradingDate`），不各自维护日历。
 *
 * 阈值（日界、15:00、上一交易日）全部在这里；调用方只传 `observedAt` / `now` / `marketSession`，
 * **不传阈值、不写魔数**。
 */
export const QUOTE_FRESHNESS_TIERS = ['live', 'prior-session', 'stale', 'unknown'] as const;
export type QuoteFreshnessTier = (typeof QUOTE_FRESHNESS_TIERS)[number];

/** 交易时段（core 已有唯一实现 `computeMarketSession`）；入参是**枚举而不是布尔**。 */
export type QuoteSession = 'pre-open' | 'trading' | 'midday-break' | 'closed' | 'non-trading-day';

/** 分档结果的展示词与 tone——**措辞与配色也只在 core 生成**，client 只渲染。 */
export interface QuoteFreshness {
  readonly tier: QuoteFreshnessTier;
  readonly tone: 'factual' | 'warning';
  readonly label: string;
}

/** 该时段里「盘前 / 非交易日」——只有这两种时段，昨收才算正常。 */
const isBeforeSession = (session: QuoteSession): boolean =>
  session === 'pre-open' || session === 'non-trading-day';

/**
 * 分档：
 * - **unknown**：没有 `observedAt`——「有价但不知多旧」，比缺价更危险（用户会以为是最新的）
 * - **live**：观测落在**参照当日**（不是「15:00 之前」——盘后看到今天的收盘价仍是当日数据）
 * - **prior-session**：观测恰是**上一交易日**，且当前处于**盘前 / 非交易日**（正常背景）
 * - **stale**：其余（更早的日期，或**盘中**用了非当日数据）
 *
 * `prior-session` 的 factual **显式依赖 `session`**：不许靠「日期不同就算上一交易日」蒙对——
 * 盘中用昨收必须是 stale + warning。
 */
export const classifyQuoteFreshness = (
  observedAt: Date | undefined,
  now: Date,
  session: QuoteSession,
): QuoteFreshness => {
  if (observedAt === undefined) {
    return { tier: 'unknown', tone: 'warning', label: '报价时点未知' };
  }
  const observedDay = dateInShanghai(observedAt);
  if (observedDay === dateInShanghai(now)) {
    return { tier: 'live', tone: 'factual', label: '当日报价' };
  }
  if (observedDay === previousTradingDate(now) && isBeforeSession(session)) {
    return { tier: 'prior-session', tone: 'factual', label: '上一交易日收盘价' };
  }
  return { tier: 'stale', tone: 'warning', label: '陈旧报价' };
};

/** 该档是否算「需要用户注意」（顶层 `staleCount` 用它，避免 client 各自判档）。 */
export const isQuoteFreshnessDegraded = (freshness: QuoteFreshness): boolean =>
  freshness.tier === 'stale' || freshness.tier === 'unknown';
