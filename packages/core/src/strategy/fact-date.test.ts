import { describe, expect, it } from 'vitest';

import { resolveFactDate } from './fact-date.js';

const day = (value: string): Date => new Date(`${value}T00:00:00.000Z`);

const available = (stockId: string, latestBarDate: Date) => ({
  stockId,
  status: 'available' as const,
  latestBarDate,
});

const missing = (stockId: string, latestBarDate: Date) => ({
  stockId,
  status: 'missing' as const,
  latestBarDate,
});

const failed = (stockId: string) => ({
  stockId,
  status: 'failed' as const,
  latestBarDate: undefined,
});

describe('resolveFactDate', () => {
  it('少量落后成员不再把整天事实日拖回前一天', () => {
    const members = [
      ...Array.from({ length: 999 }, (_, index) => available(`6005${index}.SH`, day('2026-10-29'))),
      available('001318.SZ', day('2026-10-28')),
    ];
    const resolution = resolveFactDate(members);
    expect(resolution).toMatchObject({
      factDate: day('2026-10-29'),
      coverageMet: true,
      laggingCount: 1,
      observedCount: 1000,
    });
    expect(resolution?.coverageRatio).toBeCloseTo(0.999, 5);
  });

  it('落后成员即使状态是 missing 也计入覆盖率分母', () => {
    const members = [
      ...Array.from({ length: 90 }, (_, index) => available(`6005${index}.SH`, day('2026-10-29'))),
      missing('001318.SZ', day('2026-10-28')),
    ];
    const resolution = resolveFactDate(members);
    expect(resolution).toMatchObject({
      factDate: day('2026-10-29'),
      coverageMet: false,
      laggingCount: 1,
      observedCount: 91,
    });
    expect(resolution?.coverageRatio).toBeCloseTo(90 / 91, 5);
  });

  it('没有 bar 日期的 failed 成员不计入覆盖率分母', () => {
    const members = [available('600519.SH', day('2026-10-29')), failed('300750.SZ')];
    expect(resolveFactDate(members)).toMatchObject({
      factDate: day('2026-10-29'),
      coverageRatio: 1,
      coverageMet: true,
      laggingCount: 0,
      observedCount: 1,
    });
  });

  it('覆盖率未达阈值时回落到众数日期并标记未达标', () => {
    const members = [
      ...Array.from({ length: 60 }, (_, index) => available(`6005${index}.SH`, day('2026-10-29'))),
      ...Array.from({ length: 40 }, (_, index) => available(`0005${index}.SZ`, day('2026-10-28'))),
    ];
    const resolution = resolveFactDate(members);
    expect(resolution).toMatchObject({
      factDate: day('2026-10-29'),
      coverageMet: false,
      laggingCount: 40,
      observedCount: 100,
    });
  });

  it('事实日期是交易日 key，bar 时间戳精度不参与判断', () => {
    const members = [available('600519.SH', new Date('2026-08-10T10:00:00.000Z'))];
    expect(resolveFactDate(members)?.factDate).toEqual(day('2026-08-10'));
  });

  it('全体落后一天时事实日就是那个更早的交易日', () => {
    const members = Array.from({ length: 10 }, (_, index) =>
      available(`6005${index}.SH`, day('2026-10-28')),
    );
    expect(resolveFactDate(members)).toMatchObject({
      factDate: day('2026-10-28'),
      coverageMet: true,
      laggingCount: 0,
    });
  });

  it('没有带 bar 日期的成员时返回 undefined', () => {
    expect(resolveFactDate([failed('600519.SH')])).toBeUndefined();
    expect(resolveFactDate([])).toBeUndefined();
  });

  it('覆盖率阈值可配置', () => {
    const members = [
      ...Array.from({ length: 60 }, (_, index) => available(`6005${index}.SH`, day('2026-10-29'))),
      ...Array.from({ length: 40 }, (_, index) => available(`0005${index}.SZ`, day('2026-10-28'))),
    ];
    expect(resolveFactDate(members, 0.5)).toMatchObject({
      factDate: day('2026-10-29'),
      coverageMet: true,
    });
  });
});
