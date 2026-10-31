/**
 * 持仓价格的**渲染判据**（apps/web 侧）。
 *
 * `apps/web` 是独立技术栈，不能 import `@luoome/core`，所以这里按 **语义** 复刻
 * `packages/dsh-luoome/src/client/projection.js` 的 `holdingPriceView`——
 * 两处必须表达同一件事，改动时请同步改两边。
 *
 * ## 为什么必须看 `priceStatus`
 *
 * REQ-M3-09 / S3 的纪律：**判据来自服务端字段，不从字段缺失反推**。
 * 缺价时出参里 `currentPrice` / `marketValue` / `pnl` / `pnlPct` 这些键**直接缺席**，
 * 但「缺席」也能由别的 bug 造成（漏字段、旧载荷、序列化丢键）。用
 * `currentPrice === undefined` 去推断「缺价」等于把**任何**字段问题都说成缺价。
 *
 * 只有服务端明说 `priceStatus: 'unpriced'` 才是缺价；`priceStatus: 'priced'` 才允许渲染数字。
 * 没有 `priceStatus` 的老载荷 → `canShowNumbers: false`（**不编数字**）。
 */

/**
 * @param {unknown} item 持仓项（`list_holdings` 输出元素）
 * @returns {{ unpriced: boolean, unavailableText: string | null, canShowNumbers: boolean }}
 */
export const holdingPriceView = (item) => {
  const unpriced = item?.priceStatus === 'unpriced';
  return {
    unpriced,
    /** 缺价时的展示文案；有价时为 null（由各渲染点照旧格式化数字）。 */
    unavailableText: unpriced ? (item?.priceUnavailableReason ?? '缺价') : null,
    /** 是否允许渲染数字字段（缺价 / 无 priceStatus 一律 false）。 */
    canShowNumbers: item?.priceStatus === 'priced',
  };
};

/**
 * 汇总层：任一条缺价 → 合计缺席，展示「含缺价持仓（N）」而不是 0。
 *
 * 与 `projection.js` 的 `holdingsTotalsView` 同语义。
 */
export const holdingsTotalsView = (summary) => {
  const unpricedCount = Number.isInteger(summary?.unpricedCount) ? summary.unpricedCount : 0;
  return {
    unpricedCount,
    partiallyUnpriced: unpricedCount > 0,
    note: unpricedCount > 0 ? `含缺价持仓（${unpricedCount}）` : null,
    canShowTotals: unpricedCount === 0 && summary?.totalValue !== undefined,
  };
};

/**
 * 排序键：缺价持仓必须**排在末尾**，不参与数值排序。
 *
 * 为什么需要这层：直接 `item.pnlPct ?? null` 再让通用比较器处理，`null` 会落到
 * 「等于任何数」或「排最前」这些反直觉位置。缺价不是「最小的值」，是**没有值**。
 *
 * @param {unknown} item
 * @param {'currentPrice' | 'pnlPct'} key
 * @returns {number | null} 参与排序的数值；`null` 表示不可比较（调用方须排到末尾）
 */
export const holdingSortValue = (item, key) => {
  const view = holdingPriceView(item);
  if (!view.canShowNumbers) return null;
  const value = item?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
};

/**
 * 持仓报价时点的**渲染**（task-30）。
 *
 * **不在这里判档位**：`quoteFreshness.tier/tone/label` 全部由服务端（core 的
 * `classifyQuoteFreshness`）算好，本函数只把结论渲染成一段可显示的文字。
 * 阈值（日界、15:00、上一交易日、盘前/盘中）**一个字都不许在这里出现**——
 * 否则就是第二份判定，正是 task-26 消灭过的那种。
 *
 * 与 `holdingPriceView` 的区别：那个是「渲染判据」（缺不缺价、能不能出数字），
 * 这个是「渲染服务端已判好的结论」。
 *
 * @param {unknown} item 持仓项（`list_holdings` 输出元素）
 * @returns {{ tone: 'factual' | 'warning', text: string, tier: string }}
 */
export const quoteFreshnessView = (item) => {
  const freshness = item?.quoteFreshness;
  const observedAt =
    typeof item?.quoteObservedAt === 'string' && item.quoteObservedAt.length > 0
      ? item.quoteObservedAt
      : null;
  // 服务端没给分档（老载荷）：显示「时点未知」，不假装是最新的。
  if (freshness === undefined || freshness === null)
    return { tone: 'warning', tier: 'unknown', text: '时点未知' };
  const label =
    typeof freshness.label === 'string' && freshness.label.length > 0
      ? freshness.label
      : '时点未知';
  return {
    tone: freshness.tone === 'warning' ? 'warning' : 'factual',
    tier: typeof freshness.tier === 'string' ? freshness.tier : 'unknown',
    text: `${label} · ${observedAt ?? '时点未知'}`,
  };
};
