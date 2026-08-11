export type CrossingObservation =
  | { readonly status: 'observed'; readonly daysSince: number }
  | { readonly status: 'not-observed'; readonly lowerBound: number }
  | { readonly status: 'insufficient-history'; readonly requiredLookback: number };

const smaAt = (closes: readonly number[], period: number, end: number): number | undefined => {
  const start = end - period + 1;
  if (period <= 0 || start < 0 || end >= closes.length) return undefined;
  const values = closes.slice(start, end + 1);
  if (values.some((value) => !Number.isFinite(value))) return undefined;
  return values.reduce((sum, value) => sum + value, 0) / period;
};

/**
 * 计算 close 从均线下方/相等向上穿越的时点。
 *
 * `not-observed` 是在可见窗口足够长但没有事件；它不是缺失输入，调用方应把
 * lowerBound 当作“至少这么多天未观察到”。只有历史不足时才返回 unknown。
 */
export const observeCrossingUp = (
  closes: readonly number[],
  period: number,
): CrossingObservation => {
  const requiredLookback = period + 1;
  if (period <= 0 || closes.length < requiredLookback) {
    return { status: 'insufficient-history', requiredLookback };
  }
  for (let index = closes.length - 1; index >= period; index -= 1) {
    const current = closes[index];
    const previous = closes[index - 1];
    const currentMa = smaAt(closes, period, index);
    const previousMa = smaAt(closes, period, index - 1);
    if (
      current !== undefined &&
      previous !== undefined &&
      currentMa !== undefined &&
      previousMa !== undefined &&
      current > currentMa &&
      previous <= previousMa
    ) {
      return { status: 'observed', daysSince: closes.length - 1 - index };
    }
  }
  return { status: 'not-observed', lowerBound: closes.length };
};
