/* apps/web/public/js/dashboard-news.test.js —— 首页「财经要闻」纯函数单测。 */

import { describe, expect, it } from 'bun:test';

import { fmtRelativeTime, shouldLoadNewsOnScroll } from './dashboard-news.js';

describe('fmtRelativeTime', () => {
  const now = new Date('2026-08-22T12:00:00+08:00');

  it('刚刚 / 分钟 / 小时 / 天 / 日期回退', () => {
    expect(fmtRelativeTime('2026-08-22T11:59:40+08:00', now)).toBe('刚刚');
    expect(fmtRelativeTime('2026-08-22T11:30:00+08:00', now)).toBe('30 分钟前');
    expect(fmtRelativeTime('2026-08-22T09:00:00+08:00', now)).toBe('3 小时前');
    expect(fmtRelativeTime('2026-08-20T12:00:00+08:00', now)).toBe('2 天前');
    expect(fmtRelativeTime('2026-08-01T12:00:00+08:00', now)).toBe('2026-08-01');
  });

  it('非法时间与未来时间不 crash', () => {
    expect(fmtRelativeTime('not-a-date', now)).toBe('--');
    expect(fmtRelativeTime('2026-08-22T13:00:00+08:00', now)).toBe('刚刚');
  });
});

describe('shouldLoadNewsOnScroll', () => {
  it('仅在接近列表底部时加载下一页', () => {
    const nearBottom = { scrollHeight: 370, scrollTop: 0, clientHeight: 330 };
    expect(shouldLoadNewsOnScroll(nearBottom)).toBe(true);
    expect(shouldLoadNewsOnScroll({ scrollHeight: 700, scrollTop: 100, clientHeight: 330 })).toBe(
      false,
    );
  });
});
