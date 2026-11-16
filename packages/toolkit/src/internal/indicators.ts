import { type DailyBar, observeCrossingUp, type TechnicalIndicators } from '@luoome/core';

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

const smaAt = (values: readonly number[], period: number, endIndex: number): number | undefined => {
  const start = endIndex - period + 1;
  if (period <= 0 || start < 0 || endIndex >= values.length) return undefined;
  let sum = 0;
  for (let index = start; index <= endIndex; index += 1) {
    const value = values[index];
    if (value === undefined) return undefined;
    sum += value;
  }
  return sum / period;
};

const consecutiveDaysAboveMa = (closes: readonly number[], period: number): number | undefined => {
  if (closes.length < period) return undefined;
  let count = 0;
  for (let index = closes.length - 1; index >= period - 1; index -= 1) {
    const close = closes[index];
    const average = smaAt(closes, period, index);
    if (close === undefined || average === undefined || close <= average) break;
    count += 1;
  }
  return count;
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

/** 由日线序列计算 MA / RSI / MACD / 量能 / 均线交叉 / Bollinger 快照。 */
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
  const close = closes.at(-1);
  assign('close', close);
  if (close !== undefined) {
    const close20 = closes.at(-20);
    if (close20 !== undefined && close20 !== 0) {
      assign('momentum20Pct', (close / close20 - 1) * 100);
    }
    if (out.ma20 !== undefined && out.ma20 !== 0) {
      assign('maDistance20Pct', ((close - out.ma20) / out.ma20) * 100);
    }
    if (out.ma60 !== undefined && out.ma60 !== 0) {
      assign('maDistance60Pct', ((close - out.ma60) / out.ma60) * 100);
    }
  }
  const ma20Cross = observeCrossingUp(closes, 20);
  const ma60Cross = observeCrossingUp(closes, 60);
  assign(
    'daysSinceMa20CrossUp',
    ma20Cross.status === 'observed'
      ? ma20Cross.daysSince
      : ma20Cross.status === 'not-observed'
        ? ma20Cross.lowerBound
        : undefined,
  );
  assign(
    'daysSinceMa60CrossUp',
    ma60Cross.status === 'observed'
      ? ma60Cross.daysSince
      : ma60Cross.status === 'not-observed'
        ? ma60Cross.lowerBound
        : undefined,
  );
  assign('daysAboveMa20', consecutiveDaysAboveMa(closes, 20));
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
    const middle = recent20.reduce((sum, value) => sum + value, 0) / recent20.length;
    const variance =
      recent20.reduce((sum, value) => sum + (value - middle) ** 2, 0) / (recent20.length - 1);
    const standardDeviation = Math.sqrt(variance);
    const upper = middle + 2 * standardDeviation;
    const lower = middle - 2 * standardDeviation;
    const width = upper - lower;
    assign('bollMiddle20', middle);
    assign('bollUpper20', upper);
    assign('bollLower20', lower);
    if (middle !== 0) assign('bollBandwidth20Pct', (width / middle) * 100);
    if (close !== undefined) {
      assign('bollPosition20', width === 0 ? 0.5 : (close - lower) / width);
    }
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
