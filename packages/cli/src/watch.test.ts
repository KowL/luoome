import { money } from '@luoome/core';
import { describe, expect, it } from 'vitest';

import { parseEnvHolidays } from './holidays.js';
import {
  _resetHolidayCache,
  clampInterval,
  formatTriggersForLog,
  isTradingHours,
  nextRunDelayMs,
} from './watch.js';

describe('isTradingHours (Asia/Shanghai)', () => {
  // 2026-07-21 是周二
  const tuesday = (h: number, m: number): Date => {
    // 构造 UTC 时间使 Shanghai 时刻 = h:m
    // Shanghai = UTC+8 → UTC = Shanghai − 8h
    const d = new Date('2026-07-21T00:00:00.000Z');
    d.setUTCHours(h - 8, m, 0, 0);
    return d;
  };

  it('周一至周五 9:30–11:30 + 13:00–15:00 → true', () => {
    expect(isTradingHours(tuesday(9, 30))).toBe(true);
    expect(isTradingHours(tuesday(11, 30))).toBe(true);
    expect(isTradingHours(tuesday(13, 0))).toBe(true);
    expect(isTradingHours(tuesday(15, 0))).toBe(true);
    expect(isTradingHours(tuesday(10, 0))).toBe(true);
  });

  it('11:30–13:00 / 15:00–次日 9:30 → false', () => {
    expect(isTradingHours(tuesday(11, 31))).toBe(false);
    expect(isTradingHours(tuesday(12, 0))).toBe(false);
    expect(isTradingHours(tuesday(15, 1))).toBe(false);
    expect(isTradingHours(tuesday(9, 29))).toBe(false);
  });

  it('周六 / 周日 → false', () => {
    // 2026-07-25 是周六
    const sat = new Date('2026-07-25T00:00:00.000Z');
    sat.setUTCHours(10 - 8, 0, 0, 0); // Shanghai 10:00
    expect(isTradingHours(sat)).toBe(false);
    // 2026-07-26 是周日
    const sun = new Date('2026-07-26T00:00:00.000Z');
    sun.setUTCHours(10 - 8, 0, 0, 0);
    expect(isTradingHours(sun)).toBe(false);
  });
});

describe('clampInterval', () => {
  it('< 60s 提升到 60s', () => {
    expect(clampInterval(30_000)).toBe(60_000);
    expect(clampInterval(0)).toBe(60_000);
  });
  it('≥ 60s 保持原值', () => {
    expect(clampInterval(60_000)).toBe(60_000);
    expect(clampInterval(120_000)).toBe(120_000);
  });
});

describe('nextRunDelayMs', () => {
  const tuesday = (h: number, m: number): Date => {
    const d = new Date('2026-07-21T00:00:00.000Z');
    d.setUTCHours(h - 8, m, 0, 0);
    return d;
  };

  it('盘内：返回 max(interval, 60s)', () => {
    expect(nextRunDelayMs(tuesday(10, 0), 60_000)).toBe(60_000);
    expect(nextRunDelayMs(tuesday(10, 0), 90_000)).toBe(90_000);
    expect(nextRunDelayMs(tuesday(10, 0), 30_000)).toBe(60_000); // 30s 被 clamp 到 60s
  });

  it('盘外：60s 重试', () => {
    expect(nextRunDelayMs(tuesday(12, 0), 120_000)).toBe(60_000);
    expect(nextRunDelayMs(tuesday(20, 0), 300_000)).toBe(60_000);
  });
});

describe('formatTriggersForLog', () => {
  const T0 = new Date('2026-07-21T02:30:00.000Z');
  const T1 = new Date('2026-07-21T02:30:15.000Z');

  const trigger = (
    overrides: Partial<Parameters<typeof formatTriggersForLog>[0][number] & { id: string }> = {},
  ) => ({
    id: 't-1',
    poolId: 'holdings-watch',
    stockId: '002594.SZ',
    ruleKind: 'price-change' as const,
    direction: 'watch' as const,
    reason: '日内变动 5.20%',
    evidence: ['close=15.2'],
    quote: { close: money(15.2), ts: T0 },
    notified: true,
    createdAt: T1,
    ...overrides,
  });

  it('空数组 → 占位', () => {
    expect(formatTriggersForLog([])).toBe('（无触发）');
  });

  it('多触发：含表头 + 行', () => {
    const out = formatTriggersForLog([
      trigger(),
      trigger({ id: 't-2', stockId: '600519.SH', notified: false }),
    ]);
    expect(out).toContain('时间');
    expect(out).toContain('holdings-watch');
    expect(out).toContain('002594.SZ');
    expect(out).toContain('600519.SH');
    // notified=false 行尾应包含 [cool]
    expect(out).toContain('[cool]');
  });

  it('自定义 suppressedLabel 生效', () => {
    const out = formatTriggersForLog([trigger({ notified: false })], { suppressedLabel: '[冷却]' });
    expect(out).toContain('[冷却]');
    expect(out).not.toContain('[cool]');
  });
});

describe('isTradingHours 节假日历（v0.6）', () => {
  // 2026-01-01 是周四；Shanghai 10:00 在交易时段内，但元旦休市
  const shanghaiAt = (yyyyMmDd: string, h = 10, m = 0): Date => {
    const [y, mo, d] = yyyyMmDd.split('-').map(Number) as [number, number, number];
    const utcMs = Date.UTC(y, mo - 1, d, h - 8, m, 0, 0);
    return new Date(utcMs);
  };

  it('2026-01-01 元旦（周四）→ false（即使时段内）', () => {
    expect(isTradingHours(shanghaiAt('2026-01-01', 10))).toBe(false);
  });

  it('2026-02-17 春节（周二）→ false', () => {
    expect(isTradingHours(shanghaiAt('2026-02-17', 10))).toBe(false);
  });

  it('2026-10-01 国庆（周四）→ false', () => {
    expect(isTradingHours(shanghaiAt('2026-10-01', 10))).toBe(false);
  });

  it('2026-09-24 节前一天（周四）→ true（正常时段）', () => {
    expect(isTradingHours(shanghaiAt('2026-09-24', 10))).toBe(true);
  });

  it('显式空日历：2026-01-01 元旦视为交易日', () => {
    expect(isTradingHours(shanghaiAt('2026-01-01', 10), new Map())).toBe(true);
  });

  it('显式日历覆盖：自定义 2027 元旦为节假日', () => {
    const cal = parseEnvHolidays('2027-01-01');
    expect(isTradingHours(shanghaiAt('2027-01-01', 10), cal)).toBe(false);
  });

  it('LUOOME_A_SHARE_HOLIDAYS env 影响默认日历', () => {
    process.env.LUOOME_A_SHARE_HOLIDAYS = '2026-11-11'; // 周三，自定义为节假日
    _resetHolidayCache();
    try {
      expect(isTradingHours(shanghaiAt('2026-11-11', 10))).toBe(false);
      // 内置 2026-01-01 仍生效
      expect(isTradingHours(shanghaiAt('2026-01-01', 10))).toBe(false);
      // 普通工作日不受 env 影响
      expect(isTradingHours(shanghaiAt('2026-09-24', 10))).toBe(true);
    } finally {
      delete process.env.LUOOME_A_SHARE_HOLIDAYS;
      _resetHolidayCache();
    }
  });
});
