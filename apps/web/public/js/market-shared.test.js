/* apps/web/public/js/market-shared.test.js —— 共用格式化口径（涨跌幅 / 上海时钟）。
 *
 * 作战室各视图原先各自实现 fmtPct / fmtClock，且 market-room.js 缺失返回 '--'、
 * 其余视图返回 null。合并到 market-shared.js 后由 missing 参数显式区分，
 * 这里同时锁定两种调用口径，避免再被静默统一成一种文案。
 */

import { describe, expect, it } from 'bun:test';

import { divergenceText, sectorRowCells } from './market-room.js';
import { memberRowCells } from './market-room-sector-detail.js';
import { formatClock, formatPct } from './market-shared.js';

describe('formatPct', () => {
  it('两位小数；signed 只在正数前加号', () => {
    expect(formatPct(1.234)).toBe('1.23%');
    expect(formatPct(1.234, true)).toBe('+1.23%');
    expect(formatPct(-1.234, true)).toBe('-1.23%');
    expect(formatPct(0, true)).toBe('0.00%');
  });

  it('非法值默认返回 null，需要占位时显式传 missing', () => {
    expect(formatPct(null)).toBeNull();
    expect(formatPct(undefined)).toBeNull();
    expect(formatPct(Number.NaN)).toBeNull();
    expect(formatPct(Number.POSITIVE_INFINITY)).toBeNull();
    expect(formatPct('1.2')).toBeNull();
    expect(formatPct(null, false, '--')).toBe('--');
    expect(formatPct(Number.NaN, true, '--')).toBe('--');
  });
});

describe('formatClock', () => {
  it('按 Asia/Shanghai 输出 HH:mm，缺省缺失占位为 --', () => {
    expect(formatClock('2026-09-28T02:15:00.000Z')).toBe('10:15');
    expect(formatClock('2026-09-28T02:15:00.000Z', null)).toBe('10:15');
    expect(formatClock(null)).toBe('--');
    expect(formatClock(undefined)).toBe('--');
    expect(formatClock('not-a-time')).toBe('--');
    expect(formatClock(null, null)).toBeNull();
  });
});

describe('调用点缺失口径（合并实现后保持不变）', () => {
  it('总览等固定占位视图写 --', () => {
    const text = divergenceText({
      divergence: {
        indexName: '上证指数',
        indexChangePct: null,
        medianChangePct: 0.5,
        divergent: false,
      },
    });
    expect(text).toBe('指数与多数个股同向：上证指数 -- / 中位数 +0.50%');
  });

  it('板块榜与成分明细的缺失仍返回 null，交给渲染层写「缺失」', () => {
    const metric = (value) => ({
      value,
      status: value === null ? 'unavailable' : 'complete',
      memberCount: 3,
      sampleCount: 3,
      missingCount: 0,
      nonTradableCount: 0,
      numeratorAmount: null,
      method: '口径',
      warnings: [],
    });
    const cells = sectorRowCells({
      rank: null,
      day: metric(null),
      window5: metric(null),
      window15: metric(null),
      turnover: metric(null),
      limitUp: { value: null },
    });
    expect(cells.day).toBeNull();
    expect(cells.window5).toBeNull();
    expect(cells.window15).toBeNull();

    const member = memberRowCells({
      stockId: '600519.SH',
      code: '600519',
      name: '贵州茅台',
      dayChangePct: null,
      windowChangePct: null,
      windowAmountDelta: null,
      windowAmountSharePct: null,
      sealed: null,
      ladderLevel: null,
      memberStatus: 'listed',
      inBatch: true,
    });
    expect(member.day).toBeNull();
    expect(member.window).toBeNull();
  });
});
