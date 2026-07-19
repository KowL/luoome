import type { DailyBar, TechnicalIndicators } from '@luoome/core';

/**
 * 简化技术指标计算（ARCHITECTURE §6.3 step 1 的 v0.1 实现）。
 * 只依赖日线收盘价 / 成交量，纯函数、无外部依赖；
 * 样本不足时对应字段缺省（不填 0，避免误导 LLM）。
 */

const sma = (values: readonly number[], period: number): number | undefined => {
  if (period <= 0 || values.length < period) return undefined;
  const slice = values.slice(values.length - period);
  return slice.reduce((sum, v) => sum + v, 0) / period;
};

/** EMA 序列（与 values 等长，首元素以 values[0] 为种子递推）。 */
const emaSeries = (values: readonly number[], period: number): number[] => {
  const first = values[0];
  if (first === undefined) return [];
  const k = 2 / (period + 1);
  const out: number[] = [first];
  let prev = first;
  for (let i = 1; i < values.length; i++) {
    const value = values[i];
    if (value === undefined) break;
    prev = value * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
};

/** RSI（简单均值口径），样本不足返回 undefined。 */
const rsi = (closes: readonly number[], period: number): number | undefined => {
  if (closes.length <= period) return undefined;
  let gain = 0;
  let loss = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const current = closes[i];
    const previous = closes[i - 1];
    if (current === undefined || previous === undefined) continue;
    const diff = current - previous;
    if (diff >= 0) gain += diff;
    else loss -= diff;
  }
  if (loss === 0) return 100;
  const rs = gain / loss;
  return 100 - 100 / (1 + rs);
};

/** 由日线序列计算 MA / RSI / MACD / 量能均线快照。 */
export const computeSimpleIndicators = (bars: readonly DailyBar[]): TechnicalIndicators => {
  const closes = bars.map((b) => b.close);
  const volumes = bars.map((b) => b.volume);
  const out: Record<string, number> = {};

  const assign = (key: string, value: number | undefined): void => {
    if (value !== undefined && Number.isFinite(value)) out[key] = value;
  };

  assign('ma5', sma(closes, 5));
  assign('ma10', sma(closes, 10));
  assign('ma20', sma(closes, 20));
  assign('ma60', sma(closes, 60));
  assign('rsi14', rsi(closes, 14));
  assign('volMa5', sma(volumes, 5));
  assign('volMa20', sma(volumes, 20));

  // v0.2 扩字段：volRatio5_20 / high20 / low20，供战法 DSL 用（见 KNOWN_INDICATOR_KEYS）。
  if (out.volMa5 !== undefined && out.volMa20 !== undefined && out.volMa20 !== 0) {
    assign('volRatio5_20', out.volMa5 / out.volMa20);
  }
  if (closes.length >= 20) {
    const recent20 = closes.slice(closes.length - 20);
    assign('high20', Math.max(...recent20));
    assign('low20', Math.min(...recent20));
  }

  // MACD(12,26,9)：dif = ema12 - ema26；dea = dif 的 ema9；hist = dif - dea。
  if (closes.length >= 2) {
    const ema12 = emaSeries(closes, 12);
    const ema26 = emaSeries(closes, 26);
    const difSeries = ema12.map((v, i) => v - (ema26[i] ?? 0));
    const deaSeries = emaSeries(difSeries, 9);
    const dif = difSeries[difSeries.length - 1];
    const dea = deaSeries[deaSeries.length - 1];
    if (dif !== undefined) out.macdDif = dif;
    if (dea !== undefined) out.macdDea = dea;
    if (dif !== undefined && dea !== undefined) out.macdHist = dif - dea;
  }

  return out;
};
