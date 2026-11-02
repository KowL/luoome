import { describe, expect, it } from 'vitest';

import { adviceHistoryMark, assertNotPresentedAsCurrent } from './advice-history.js';

/**
 * REQ-M5-03 第 1 项：历史标识的三态与**结构性一致**。
 */
const TODAY = new Date('2026-11-02T00:00:00+08:00');
const NOW = new Date('2026-11-02T10:00:00+08:00');

describe('三态判定', () => {
  it('今日 + 未过期 → current，且 staleReason 为 null', () => {
    const mark = adviceHistoryMark({
      validUntil: new Date('2026-11-10T00:00:00+08:00'),
      dataAsOf: new Date('2026-11-02T09:00:00+08:00'),
      now: NOW,
      todayStart: TODAY,
    });
    expect(mark).toEqual({ historyStatus: 'current', staleReason: null });
  });

  it('**跨日但仍有效 → historical**（可参考，但不得当今日事实）', () => {
    const mark = adviceHistoryMark({
      validUntil: new Date('2026-11-10T00:00:00+08:00'),
      dataAsOf: new Date('2026-11-01T09:00:00+08:00'),
      now: NOW,
      todayStart: TODAY,
    });
    expect(mark).toEqual({ historyStatus: 'historical', staleReason: 'data-as-of-before-today' });
  });

  it('**已过期 → expired**（该忽略）', () => {
    const mark = adviceHistoryMark({
      validUntil: new Date('2026-11-01T00:00:00+08:00'),
      dataAsOf: new Date('2026-10-31T09:00:00+08:00'),
      now: NOW,
      todayStart: TODAY,
    });
    expect(mark).toEqual({ historyStatus: 'expired', staleReason: 'valid-until-passed' });
  });

  it('**过期优先于跨日**：已失效的不说成「历史但仍可用」', () => {
    const mark = adviceHistoryMark({
      validUntil: new Date('2026-11-01T00:00:00+08:00'),
      dataAsOf: new Date('2026-11-01T09:00:00+08:00'), // 跨日
      now: NOW,
      todayStart: TODAY,
    });
    expect(mark.historyStatus).toBe('expired');
  });
});

describe('**结构性一致性**：status 与 staleReason 必须对应', () => {
  const cases = [
    { validUntil: '2026-11-10T00:00:00+08:00', dataAsOf: '2026-11-02T09:00:00+08:00' },
    { validUntil: '2026-11-10T00:00:00+08:00', dataAsOf: '2026-11-01T09:00:00+08:00' },
    { validUntil: '2026-11-01T00:00:00+08:00', dataAsOf: '2026-10-31T09:00:00+08:00' },
  ];

  it('**current ⟺ staleReason === null**（任何组合都不例外）', () => {
    for (const item of cases) {
      const mark = adviceHistoryMark({
        validUntil: new Date(item.validUntil),
        dataAsOf: new Date(item.dataAsOf),
        now: NOW,
        todayStart: TODAY,
      });
      // 这条是最重要的结构性约束：不能出现「标记为历史但说不出为什么」
      expect(mark.historyStatus === 'current').toBe(mark.staleReason === null);
    }
  });

  it('**非 current 必须有 staleReason**', () => {
    for (const item of cases) {
      const mark = adviceHistoryMark({
        validUntil: new Date(item.validUntil),
        dataAsOf: new Date(item.dataAsOf),
        now: NOW,
        todayStart: TODAY,
      });
      if (mark.historyStatus !== 'current') expect(mark.staleReason).not.toBeNull();
    }
  });
});

describe('「引用历史不得当当前事实」', () => {
  it('历史建议缺 staleReason 会被拦（构造不出来的非法态也拦）', () => {
    expect(() =>
      assertNotPresentedAsCurrent({ historyStatus: 'historical', staleReason: null }),
    ).toThrow(/不允许把历史结论当作当前事实/);
  });

  it('合法历史建议通过（有原因就能带着前提引用）', () => {
    expect(() =>
      assertNotPresentedAsCurrent({
        historyStatus: 'historical',
        staleReason: 'data-as-of-before-today',
      }),
    ).not.toThrow();
  });

  it('current 直接通过', () => {
    expect(() =>
      assertNotPresentedAsCurrent({ historyStatus: 'current', staleReason: null }),
    ).not.toThrow();
  });
});
