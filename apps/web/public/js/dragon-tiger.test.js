/* apps/web/public/js/dragon-tiger.test.js —— 龙虎榜页纯函数单测。 */

import { describe, expect, it } from 'bun:test';

import {
  filterEntries,
  formatPct,
  formatSignedAmount,
  groupEntriesByStock,
  summarizeEntries,
  warningText,
} from './dragon-tiger.js';

const entry = (code, changePct, netAmount = 0) => ({
  code,
  name: `股票${code}`,
  close: 10,
  changePct,
  turnoverRate: 0.1,
  reason: '日涨幅偏离值达7%的证券',
  netAmount,
  buyAmount: 0,
  sellAmount: 0,
  amount: 1000,
  tradeDate: '2026-08-21',
});

describe('formatPct', () => {
  it('小数 → 带符号百分比；0 不带符号', () => {
    expect(formatPct(0.0321)).toBe('+3.21%');
    expect(formatPct(-0.1)).toBe('-10.00%');
    expect(formatPct(0)).toBe('0.00%');
  });

  it('非数字 → --', () => {
    expect(formatPct(Number.NaN)).toBe('--');
    expect(formatPct(undefined)).toBe('--');
  });
});

describe('formatSignedAmount', () => {
  it('正 / 负 / 零（元 → 万 / 亿）', () => {
    expect(formatSignedAmount(120_000_000)).toBe('+1.20亿');
    expect(formatSignedAmount(-35_000_000)).toBe('-3500.00万');
    expect(formatSignedAmount(0)).toBe('0');
  });

  it('非数字 → --', () => {
    expect(formatSignedAmount(Number.NaN)).toBe('--');
    expect(formatSignedAmount(null)).toBe('--');
  });
});

describe('filterEntries', () => {
  const entries = [entry('600001', 0.05), entry('600002', -0.03), entry('600003', 0)];

  it('all 原样返回；up 只留正；down 只留负；0 不计涨跌', () => {
    expect(filterEntries(entries, 'all')).toHaveLength(3);
    expect(filterEntries(entries, 'up').map((e) => e.code)).toEqual(['600001']);
    expect(filterEntries(entries, 'down').map((e) => e.code)).toEqual(['600002']);
  });

  it('非法输入 → 空数组', () => {
    expect(filterEntries(null, 'all')).toEqual([]);
    expect(filterEntries(undefined, 'up')).toEqual([]);
  });
});

describe('groupEntriesByStock', () => {
  it('同一股票多条上榜原因合并，聚合金额不重复计算且明细完整保留', () => {
    const first = {
      ...entry('600001', 0.05, 100),
      buyAmount: 300,
      sellAmount: 200,
      amount: 10_000,
      reason: '日涨幅偏离值达7%的证券',
    };
    const second = {
      ...entry('600001', 0.05, -40),
      buyAmount: 120,
      sellAmount: 160,
      amount: 10_000,
      reason: '连续三个交易日内涨幅偏离值累计达20%',
    };

    const groups = groupEntriesByStock([first, second, entry('600002', -0.03)]);

    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({
      code: '600001',
      reasonCount: 2,
      netAmount: 100,
      buyAmount: 300,
      sellAmount: 200,
      amount: 10_000,
    });
    expect(groups[0].details).toEqual([first, second]);
    expect(groups[1].details).toHaveLength(1);
  });

  it('非法输入或缺少代码 → 空数组 / 跳过无效条目', () => {
    expect(groupEntriesByStock(null)).toEqual([]);
    expect(groupEntriesByStock([{ name: '无代码' }])).toEqual([]);
  });
});

describe('summarizeEntries', () => {
  it('统计上涨 / 下跌家数与净买入合计', () => {
    const s = summarizeEntries([
      entry('600001', 0.05, 100),
      entry('600002', -0.03, -40),
      entry('600003', 0, 10),
    ]);
    expect(s.up).toBe(1);
    expect(s.down).toBe(1);
    expect(s.netSum).toBe(70);
  });

  it('空 / 非法输入 → 全零', () => {
    expect(summarizeEntries([])).toEqual({ up: 0, down: 0, netSum: 0 });
    expect(summarizeEntries(null)).toEqual({ up: 0, down: 0, netSum: 0 });
  });
});

describe('warningText', () => {
  it('non-trading-day 优先；empty-list 次之；其它原样拼接', () => {
    expect(warningText(['non-trading-day'])).toContain('非 A 股交易日');
    expect(warningText(['empty-list'])).toContain('无上榜数据');
    expect(warningText(['non-trading-day', 'empty-list'])).toContain('非 A 股交易日');
    expect(warningText(['other-flag'])).toBe('状态：other-flag');
  });

  it('无警告 / 非法输入 → 空串', () => {
    expect(warningText([])).toBe('');
    expect(warningText(undefined)).toBe('');
  });
});
