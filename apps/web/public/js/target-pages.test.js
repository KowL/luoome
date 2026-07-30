/* apps/web/public/js/target-pages.test.js —— Strategy / Watchlist / AlertPlan 页纯函数测试。
 * DOM 交互由浏览器验收覆盖，这里只测渲染文案的字段口径。 */

import { describe, expect, it } from 'bun:test';

import { extractRunHits, triggerMetaText } from './target-pages.js';

describe('触发条目时间行', () => {
  it('读取 WatchTriggerSchema 的 createdAt 字段', () => {
    const text = triggerMetaText({
      alertPlanId: 'plan-1',
      createdAt: '2026-07-29T08:00:00.000Z',
    });
    expect(text.startsWith('plan-1 · 数据 ')).toBe(true);
    // triggeredAt 早已不存在；误读会得到 Invalid Date
    expect(text.includes('Invalid Date')).toBe(false);
  });
});

describe('extractRunHits', () => {
  it('同股取最高分并按分数降序', () => {
    const hits = extractRunHits([
      { stockId: '600519.SH', score: '55', direction: 'bullish' },
      { stockId: '000001.SZ', score: '80', direction: 'bearish' },
      { stockId: '600519.SH', score: '72', direction: 'bullish' },
    ]);
    expect(hits).toEqual([
      { stockId: '000001.SZ', score: 80, direction: 'bearish' },
      { stockId: '600519.SH', score: 72, direction: 'bullish' },
    ]);
  });

  it('空输入返回空数组', () => {
    expect(extractRunHits(undefined)).toEqual([]);
    expect(extractRunHits([])).toEqual([]);
  });
});
