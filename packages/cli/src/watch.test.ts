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

describe('isTradingHours 文件加载集成（v0.7）', () => {
  // 2026-11-11 是周三，Shanghai 10:00 正常应该交易
  const shanghaiAt = (yyyyMmDd: string, h = 10, m = 0): Date => {
    const [y, mo, d] = yyyyMmDd.split('-').map(Number) as [number, number, number];
    const utcMs = Date.UTC(y, mo - 1, d, h - 8, m, 0, 0);
    return new Date(utcMs);
  };

  it('LUOOME_HOLIDAYS_FILE 指向合法文件 → 加载生效', async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'luoome-watch-holidays-'));
    const file = join(dir, 'holidays.json');
    writeFileSync(file, JSON.stringify({ '2026': ['2026-11-11', '2026-11-12'] }), 'utf8');
    const prevFile = process.env.LUOOME_HOLIDAYS_FILE;
    process.env.LUOOME_HOLIDAYS_FILE = file;
    _resetHolidayCache();
    try {
      expect(isTradingHours(shanghaiAt('2026-11-11', 10))).toBe(false); // 文件中 → 休市
      expect(isTradingHours(shanghaiAt('2026-11-12', 10))).toBe(false); // 文件中 → 休市
      // 内置 2026-01-01 不受文件影响（仍生效）
      expect(isTradingHours(shanghaiAt('2026-01-01', 10))).toBe(false);
      // 普通工作日不受影响
      expect(isTradingHours(shanghaiAt('2026-09-24', 10))).toBe(true);
    } finally {
      if (prevFile === undefined) delete process.env.LUOOME_HOLIDAYS_FILE;
      else process.env.LUOOME_HOLIDAYS_FILE = prevFile;
      _resetHolidayCache();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('LUOOME_HOLIDAYS_FILE 指向不存在路径 → fallback 到内置', async () => {
    const prevFile = process.env.LUOOME_HOLIDAYS_FILE;
    process.env.LUOOME_HOLIDAYS_FILE = '/nonexistent/holidays.json';
    _resetHolidayCache();
    try {
      // 内置 2026-01-01 仍生效
      expect(isTradingHours(shanghaiAt('2026-01-01', 10))).toBe(false);
      // 2027 元旦（v0.7 占位）也生效
      expect(isTradingHours(shanghaiAt('2027-01-01', 10))).toBe(false);
      // 普通工作日不受影响
      expect(isTradingHours(shanghaiAt('2026-09-24', 10))).toBe(true);
    } finally {
      if (prevFile === undefined) delete process.env.LUOOME_HOLIDAYS_FILE;
      else process.env.LUOOME_HOLIDAYS_FILE = prevFile;
      _resetHolidayCache();
    }
  });

  it('LUOOME_HOLIDAYS_FILE 指向损坏文件 → fallback 到内置', async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'luoome-watch-holidays-'));
    const file = join(dir, 'holidays.json');
    writeFileSync(file, 'not valid json {', 'utf8');
    const prevFile = process.env.LUOOME_HOLIDAYS_FILE;
    process.env.LUOOME_HOLIDAYS_FILE = file;
    _resetHolidayCache();
    try {
      // 内置仍生效
      expect(isTradingHours(shanghaiAt('2026-01-01', 10))).toBe(false);
      expect(isTradingHours(shanghaiAt('2026-09-24', 10))).toBe(true);
    } finally {
      if (prevFile === undefined) delete process.env.LUOOME_HOLIDAYS_FILE;
      else process.env.LUOOME_HOLIDAYS_FILE = prevFile;
      _resetHolidayCache();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('三层优先级：env > 文件 > 内置', async () => {
    // 文件说 2026-12-09 休市；env 把它强制定为工作日（不会清空，只是追加，
    // 通过 union 行为内置 + env 都生效）。这里验证三者 merge 后 set 是 union。
    const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'luoome-watch-holidays-'));
    const file = join(dir, 'holidays.json');
    writeFileSync(file, JSON.stringify({ '2026': ['2026-12-09'] }), 'utf8');
    const prevFile = process.env.LUOOME_HOLIDAYS_FILE;
    const prevEnv = process.env.LUOOME_A_SHARE_HOLIDAYS;
    process.env.LUOOME_HOLIDAYS_FILE = file;
    process.env.LUOOME_A_SHARE_HOLIDAYS = '2026-12-10'; // env 追加另一天
    _resetHolidayCache();
    try {
      expect(isTradingHours(shanghaiAt('2026-12-09', 10))).toBe(false); // 文件
      expect(isTradingHours(shanghaiAt('2026-12-10', 10))).toBe(false); // env
      // 同日设置两次：内置 + 文件同样说 2026-01-01 休市 → union 后仍 false
      expect(isTradingHours(shanghaiAt('2026-01-01', 10))).toBe(false);
      // 不在三层里的 → 开市
      expect(isTradingHours(shanghaiAt('2026-09-24', 10))).toBe(true);
    } finally {
      if (prevFile === undefined) delete process.env.LUOOME_HOLIDAYS_FILE;
      else process.env.LUOOME_HOLIDAYS_FILE = prevFile;
      if (prevEnv === undefined) delete process.env.LUOOME_A_SHARE_HOLIDAYS;
      else process.env.LUOOME_A_SHARE_HOLIDAYS = prevEnv;
      _resetHolidayCache();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('v0.7+ 内置 2027 元旦（周六）→ false', () => {
    expect(isTradingHours(shanghaiAt('2027-01-01', 10))).toBe(false);
  });

  it('v0.7+ 内置 2027 春节（除夕 2/6）→ false', () => {
    expect(isTradingHours(shanghaiAt('2027-02-06', 10))).toBe(false);
    expect(isTradingHours(shanghaiAt('2027-02-12', 10))).toBe(false);
  });
});
