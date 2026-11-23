import type { OpeningFactResult } from './stock-facts.js';

/**
 * LLM 输出的数值可追溯校验（design §6.4）。
 * 只审计文本中的数字；结构化价格字段由 schema / judgment 校验负责。
 */
export const NUMERIC_TOLERANCE_PCT = 0.5;

const ACTIONS = /建仓|加仓|减仓|清仓|买入|卖出|满仓/g;
const FORBIDDEN_CLAIMS = /必涨|稳赚|保证|翻倍|无风险/g;

const NUMERIC_TOKEN = /(?<![\w.])\d+(?:\.\d+)?(?![\w.])/g;

const maskNonNumericTokens = (text: string): string =>
  text
    .replace(/\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?Z?)?/g, ' ')
    .replace(/\d{5,6}\.[A-Za-z]{2}/g, ' ')
    .replace(/\b\d{6}\b/g, ' ');

const textNumbers = (text: string): number[] =>
  [...maskNonNumericTokens(text).matchAll(NUMERIC_TOKEN)]
    .map((match) => Number(match[0]))
    .filter((value) => Number.isFinite(value));

const collectText = (value: unknown, key: string | undefined, out: string[]): void => {
  if (key === 'raw') return;
  if (typeof value === 'string') {
    out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectText(item, key, out);
    return;
  }
  if (value === null || typeof value !== 'object' || value instanceof Date) return;
  for (const [childKey, child] of Object.entries(value as Record<string, unknown>)) {
    collectText(child, childKey, out);
  }
};

const collectFactNumbers = (
  value: unknown,
  key: string | undefined,
  numbers: number[],
  keys: string[],
): void => {
  if (value instanceof Date || value === null) return;
  if (typeof value === 'number') {
    if (Number.isFinite(value)) numbers.push(value);
    return;
  }
  if (typeof value === 'string') {
    if (key !== undefined) keys.push(key);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectFactNumbers(item, key, numbers, keys);
    return;
  }
  if (typeof value !== 'object') return;
  for (const [childKey, child] of Object.entries(value as Record<string, unknown>)) {
    // 指标周期 / 观察窗口等结构性数字（ma20、requiredCount）从字段名补充，避免误判为编造。
    if (/\d/.test(childKey)) keys.push(childKey);
    collectFactNumbers(child, childKey, numbers, keys);
  }
};

const withinTolerance = (actual: number, expected: number): boolean => {
  if (Object.is(actual, expected)) return true;
  const basis = Math.abs(expected);
  if (basis === 0) return Math.abs(actual) <= NUMERIC_TOLERANCE_PCT / 100;
  return Math.abs(actual - expected) <= (basis * NUMERIC_TOLERANCE_PCT) / 100;
};

const allowedNumbers = (output: unknown, facts: unknown): readonly number[] => {
  const numbers: number[] = [];
  const keys: string[] = [];
  collectFactNumbers(facts, undefined, numbers, keys);
  for (const key of keys) {
    for (const match of key.matchAll(/\d+(?:\.\d+)?/g)) {
      const value = Number(match[0]);
      if (Number.isFinite(value)) numbers.push(value);
    }
  }
  const record =
    output !== null && typeof output === 'object' ? (output as Record<string, unknown>) : {};
  for (const field of ['confidence', 'targetPositionPct']) {
    const value = record[field];
    if (typeof value === 'number' && Number.isFinite(value)) numbers.push(value);
  }
  const derived = [...numbers];
  for (const left of numbers) {
    for (const right of numbers) {
      derived.push(left - right);
      if (right !== 0) {
        const ratio = left / right;
        // 只允许同量级事实之间的比与百分比；成交量/价格这类跨量级比值会把 9876 也变成合法值。
        if (Math.abs(ratio) >= 0.1 && Math.abs(ratio) <= 10) {
          derived.push(ratio);
          derived.push((ratio - 1) * 100);
        }
      }
    }
  }
  return derived;
};

const openingFactOf = (facts: unknown): OpeningFactResult | undefined => {
  if (facts === null || typeof facts !== 'object') return undefined;
  const opening = (facts as { opening?: unknown }).opening;
  if (opening === null || typeof opening !== 'object') return undefined;
  const status = (opening as { status?: unknown }).status;
  if (status !== 'ok' && status !== 'unavailable') return undefined;
  return opening as OpeningFactResult;
};

const quoteChangePct = (facts: unknown): number | undefined => {
  if (facts === null || typeof facts !== 'object') return undefined;
  const quote = (facts as { quote?: Record<string, unknown> }).quote;
  const close = quote?.close;
  const prevClose = quote?.prevClose;
  if (typeof close !== 'number' || typeof prevClose !== 'number' || prevClose <= 0)
    return undefined;
  return ((close - prevClose) / prevClose) * 100;
};

const indicatorAvailable = (
  facts: unknown,
  availableFields: readonly string[],
  field: string,
): boolean => {
  if (availableFields.includes(field)) return true;
  if (facts === null || typeof facts !== 'object') return false;
  const indicators = (facts as { indicators?: Record<string, unknown> }).indicators;
  return typeof indicators?.[field] === 'number';
};

export interface NumericAuditInput {
  readonly output: unknown;
  readonly facts: unknown;
  /** 事实包投影里实际可用字段（指标缺失时提示词不应让模型引用）。 */
  readonly availableFields?: readonly string[];
}

export const numericAuditViolations = (input: NumericAuditInput): readonly string[] => {
  const violations: string[] = [];
  const texts: string[] = [];
  collectText(input.output, undefined, texts);
  const text = texts.join('\n');
  if (text.trim().length === 0) return violations;

  const allowed = allowedNumbers(input.output, input.facts);
  const actuals = textNumbers(text);
  const unmatched = [
    ...new Set(
      actuals.filter((value) => !allowed.some((expected) => withinTolerance(value, expected))),
    ),
  ];
  for (const value of unmatched) {
    violations.push(
      `数值 ${value} 未在事实包或可派生范围内出现（容差 ${NUMERIC_TOLERANCE_PCT}%），禁止编造`,
    );
  }

  const opening = openingFactOf(input.facts);
  const openLabels = [...text.matchAll(/高开|低开|平开/g)].map((match) => match[0]);
  if (openLabels.length > 0) {
    if (opening?.status !== 'ok') {
      violations.push('缺少上一交易日收盘价时禁止判断高开/低开/平开');
    } else {
      const wrong = [...new Set(openLabels.filter((label) => label !== opening.data.label))];
      if (wrong.length > 0) {
        violations.push(
          `开盘方向与事实不符：事实为「${opening.data.label}」（${opening.data.openChangePct.toFixed(2)}%），输出出现「${wrong.join('、')}」`,
        );
      }
    }
  }

  const changePct = quoteChangePct(input.facts);
  if (changePct !== undefined) {
    for (const match of text.matchAll(/(涨|跌)\s*(\d+(?:\.\d+)?)\s*%/g)) {
      const direction = match[1];
      const claimed = Number(match[2]);
      const expectedDirection = changePct > 0 ? '涨' : changePct < 0 ? '跌' : '平';
      if (direction !== expectedDirection) {
        violations.push(`涨跌方向与事实不符：事实涨跌幅 ${changePct.toFixed(2)}%`);
        continue;
      }
      if (!withinTolerance(claimed, Math.abs(changePct))) {
        violations.push(`涨跌幅度与事实不符：事实 ${Math.abs(changePct).toFixed(2)}%`);
      }
    }
  }

  const availableFields = input.availableFields ?? [];
  const indicatorMentions: ReadonlyArray<readonly [RegExp, string, string]> = [
    [/(?:MA|ma)\s*60|60\s*日均线/, 'ma60', 'MA60'],
    [/MACD|macd/, 'macdHist', 'MACD'],
    [/RSI|rsi/, 'rsi14', 'RSI'],
    [/布林|Bollinger|BOLL/, 'bollMiddle20', '布林带'],
  ];
  for (const [pattern, field, label] of indicatorMentions) {
    if (pattern.test(text) && !indicatorAvailable(input.facts, availableFields, field)) {
      violations.push(`输出引用了不可用的指标 ${label}（${field}）`);
    }
  }

  const actionHits = [...new Set([...text.matchAll(ACTIONS)].map((match) => match[0]))];
  if (actionHits.length > 0) {
    violations.push(`输出包含操作动词：${actionHits.join('、')}；请改用信号/观察表述`);
  }
  const claimHits = [...new Set([...text.matchAll(FORBIDDEN_CLAIMS)].map((match) => match[0]))];
  if (claimHits.length > 0) {
    violations.push(`输出包含禁用词：${claimHits.join('、')}`);
  }

  return violations;
};
