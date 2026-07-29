/* apps/web/public/js/target-pages.test.js —— Strategy / Watchlist / AlertPlan 页纯函数测试。
 * DOM 交互由浏览器验收覆盖，这里只测渲染文案的字段口径。 */

import { describe, expect, it } from 'bun:test';

import { triggerMetaText } from './target-pages.js';

describe('触发条目时间行', () => {
  it('读取 WatchTriggerSchema 的 createdAt 字段', () => {
    const text = triggerMetaText({
      alertPlanId: 'plan-1',
      createdAt: '2026-07-29T08:00:00.000Z',
    });
    expect(text.startsWith('plan-1 · data ')).toBe(true);
    // triggeredAt 早已不存在；误读会得到 Invalid Date
    expect(text.includes('Invalid Date')).toBe(false);
  });
});
