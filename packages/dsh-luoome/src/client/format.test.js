// 显示层格式化：日线口径的事实时间只显示交易日，不暴露 UTC 零点换算出的假时刻。
import { describe, expect, it } from 'vitest';
import { tradeDate, when } from './format.js';

describe('tradeDate', () => {
  it('把日线口径的 UTC 零点显示为当天日期', () => {
    // 日线适配器把交易日锚在 UTC 零点，按上海时区换算是当天 08:00。
    expect(tradeDate('2026-10-28T00:00:00.000Z')).toBe('10/28');
    expect(tradeDate('2026-10-29T00:00:00.000Z')).toBe('10/29');
  });

  it('接受毫秒时间戳与 Date', () => {
    expect(tradeDate(1793145600000)).toBe('10/28');
    expect(tradeDate(new Date('2026-10-28T00:00:00.000Z'))).toBe('10/28');
  });

  it('缺值显示占位符', () => {
    expect(tradeDate(undefined)).toBe('—');
    expect(tradeDate('not-a-date')).toBe('—');
  });

  it('与带时刻的 when 形成对照：同一时刻前者只给日期', () => {
    const value = '2026-10-28T00:00:00.000Z';
    expect(when(value)).toBe('10/28 08:00');
    expect(tradeDate(value)).toBe('10/28');
  });
});
