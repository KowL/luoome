/* apps/web/public/js/dashboard-market.test.js —— 看盘页市场行情区块纯函数单测。 */

import { describe, expect, it } from 'bun:test';

import { firstProbeDay, fmtRelativeTime, overviewStats, prevDay } from './dashboard-market.js';

describe('firstProbeDay', () => {
  it('周末回退到周五；工作日原样返回', () => {
    expect(firstProbeDay('2026-08-22')).toBe('2026-08-21'); // 周六
    expect(firstProbeDay('2026-08-23')).toBe('2026-08-21'); // 周日
    expect(firstProbeDay('2026-08-21')).toBe('2026-08-21'); // 周五
    expect(firstProbeDay('2026-08-24')).toBe('2026-08-24'); // 周一
  });
});

describe('prevDay', () => {
  it('跨月 / 跨日界正确回退', () => {
    expect(prevDay('2026-08-22')).toBe('2026-08-21');
    expect(prevDay('2026-08-01')).toBe('2026-07-31');
    expect(prevDay('2026-01-01')).toBe('2025-12-31');
  });
});

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

describe('overviewStats', () => {
  it('从情绪快照提取宽度 / 涨跌停统计', () => {
    const stats = overviewStats({
      breadth: {
        status: 'complete',
        value: { advancing: 3200, declining: 1500, unchanged: 300, total: 5000 },
      },
      limitUp: {
        status: 'complete',
        value: {
          sealedCount: 45,
          brokenCount: 12,
          brokenRate: 0.21,
          maxLadderLevel: 5,
          totalSealAmount: null,
          boardDistribution: {},
          leaders: [],
        },
      },
    });
    expect(stats).toEqual({
      advancing: 3200,
      declining: 1500,
      sealed: 45,
      maxLadderLevel: 5,
      brokenRate: 0.21,
      brokenCount: 12,
    });
  });

  it('维度 unavailable / 字段缺失 → 对应项为 null（渲染降级为 --）', () => {
    expect(overviewStats(undefined)).toEqual({
      advancing: null,
      declining: null,
      sealed: null,
      maxLadderLevel: null,
      brokenRate: null,
      brokenCount: null,
    });
    const partial = overviewStats({
      breadth: { status: 'unavailable', warnings: ['x'] },
      limitUp: {
        status: 'complete',
        value: { sealedCount: 3, brokenCount: 0, brokenRate: null, maxLadderLevel: 1 },
      },
    });
    expect(partial.advancing).toBeNull();
    expect(partial.sealed).toBe(3);
    expect(partial.brokenRate).toBeNull();
  });
});
