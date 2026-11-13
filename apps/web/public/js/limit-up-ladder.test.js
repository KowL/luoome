/* apps/web/public/js/limit-up-ladder.test.js —— 涨停梯队页纯函数单测。 */

import { describe, expect, it } from 'bun:test';

import {
  bandCountsOfDay,
  bandOfPoolEntry,
  boardSumOfDay,
  filterMatches,
  fmtMoney,
  groupPoolByBand,
  latestLadderDateWithData,
  matrixCellStyle,
  maxBoardOfDay,
  promotionRateOf,
  shortDate,
  sortPoolEntries,
  weekdayOf,
} from './limit-up-ladder.js';

const entry = (overrides = {}) => ({
  stockId: '600327.SH',
  code: '600327',
  name: '大东方',
  isSt: false,
  isNew: false,
  price: 7.18,
  changePct: 0.099541,
  limitUpTime: '14:56',
  openTimes: null,
  reason: '百货零售',
  continueDayText: '5连板',
  continueDayCnt: 5,
  sealMoney: 27_188_276,
  maxSealMoney: 27_188_276.24,
  ...overrides,
});

const day = (date, bands) => ({ date, bands });

const band = (key, count, boardNum = Number(key.slice(0, 1)) || 7) => ({
  band: key,
  stocks: Array.from({ length: count }, (_, index) => ({
    stockId: `60000${index}.SH`,
    code: `60000${index}`,
    name: `股票${index}`,
    boardNum,
    sealedNextDay: null,
  })),
});

describe('weekdayOf', () => {
  // 回归：数组下标 0 是周日，不能用「一二三四五六日」
  it('按日期本身返回周几', () => {
    expect(weekdayOf('2026-10-16')).toBe('五');
    expect(weekdayOf('2026-11-09')).toBe('一');
    expect(weekdayOf('2026-11-12')).toBe('四');
    expect(weekdayOf('2026-11-15')).toBe('日');
  });
});

describe('shortDate / fmtMoney', () => {
  it('日期只保留月日', () => {
    expect(shortDate('2026-11-12')).toBe('11-12');
  });

  it('金额按亿 / 万收敛，缺值不补 0', () => {
    expect(fmtMoney(250_000_000)).toBe('2.50 亿');
    expect(fmtMoney(34_000)).toBe('3.4 万');
    expect(fmtMoney(500)).toBe('500');
    expect(fmtMoney(null)).toBe('--');
    expect(fmtMoney(Number.NaN)).toBe('--');
  });
});

describe('bandOfPoolEntry', () => {
  it('连板数映射到池分组，7 板以上合并', () => {
    expect(bandOfPoolEntry(entry({ continueDayCnt: 1 }))).toBe('one');
    expect(bandOfPoolEntry(entry({ continueDayCnt: 2 }))).toBe('two');
    expect(bandOfPoolEntry(entry({ continueDayCnt: 6 }))).toBe('six');
    expect(bandOfPoolEntry(entry({ continueDayCnt: 7 }))).toBe('seven_plus');
    expect(bandOfPoolEntry(entry({ continueDayCnt: 11 }))).toBe('seven_plus');
  });
});

describe('groupPoolByBand', () => {
  it('按板位分组，组内按封单额降序', () => {
    const groups = groupPoolByBand([
      entry({ code: '600001', continueDayCnt: 2, sealMoney: 100 }),
      entry({ code: '600002', continueDayCnt: 2, sealMoney: 300 }),
      entry({ code: '600003', continueDayCnt: 1, sealMoney: 50 }),
    ]);
    expect(groups.get('two')?.map((item) => item.code)).toEqual(['600002', '600001']);
    expect(groups.get('one')?.map((item) => item.code)).toEqual(['600003']);
    expect(groups.get('seven_plus')).toEqual([]);
  });
});

describe('bandCountsOfDay / boardSumOfDay / maxBoardOfDay', () => {
  it('统计各档家数并补 0，缺失档位不报错', () => {
    const sample = day('2026-11-12', [
      band('two', 3, 2),
      band('four', 1, 4),
      band('seven_plus', 2, 9),
    ]);
    expect(bandCountsOfDay(sample)).toEqual({
      two: 3,
      three: 0,
      four: 1,
      five: 0,
      six: 0,
      seven_plus: 2,
    });
    expect(boardSumOfDay(sample)).toBe(6);
    expect(maxBoardOfDay(sample)).toBe(9);
  });

  it('空日 → 0', () => {
    const empty = day('2026-11-12', []);
    expect(boardSumOfDay(empty)).toBe(0);
    expect(maxBoardOfDay(empty)).toBe(0);
  });
});

describe('latestLadderDateWithData', () => {
  it('跳过盘前无数据的当日，取最近有连板行的一天', () => {
    const ladder = {
      days: [
        day('2026-11-13', []),
        day('2026-11-12', [band('two', 2, 2)]),
        day('2026-11-11', [band('two', 5, 2)]),
      ],
    };
    expect(latestLadderDateWithData(ladder)).toBe('2026-11-12');
    expect(latestLadderDateWithData({ days: [day('2026-11-13', [])] })).toBeNull();
    expect(latestLadderDateWithData(null)).toBeNull();
  });
});

describe('filterMatches', () => {
  it('全部 / 2 板及以上 / 3 板及以上 / 首板', () => {
    expect(filterMatches(entry({ continueDayCnt: 1 }), 'all')).toBe(true);
    expect(filterMatches(entry({ continueDayCnt: 1 }), 'one')).toBe(true);
    expect(filterMatches(entry({ continueDayCnt: 2 }), 'one')).toBe(false);
    expect(filterMatches(entry({ continueDayCnt: 2 }), 'two_plus')).toBe(true);
    expect(filterMatches(entry({ continueDayCnt: 2 }), 'three_plus')).toBe(false);
    expect(filterMatches(entry({ continueDayCnt: 3 }), 'three_plus')).toBe(true);
  });
});

describe('sortPoolEntries', () => {
  const entries = [
    entry({ code: '600001', continueDayCnt: 1, sealMoney: 100, limitUpTime: '09:30' }),
    entry({ code: '600002', continueDayCnt: 3, sealMoney: 50, limitUpTime: '14:56' }),
    entry({ code: '600003', continueDayCnt: 2, sealMoney: 900, limitUpTime: null }),
  ];

  it('默认按连板降序，同层按封单额降序', () => {
    expect(
      sortPoolEntries(entries, { key: 'level', order: 'desc' }).map((item) => item.code),
    ).toEqual(['600002', '600003', '600001']);
  });

  it('支持封单额升序与封板时间排序（null 排在最后）', () => {
    expect(
      sortPoolEntries(entries, { key: 'seal', order: 'asc' }).map((item) => item.code),
    ).toEqual(['600002', '600001', '600003']);
    expect(
      sortPoolEntries(entries, { key: 'time', order: 'asc' }).map((item) => item.code),
    ).toEqual(['600001', '600002', '600003']);
  });

  it('不修改入参数组', () => {
    const original = [...entries];
    sortPoolEntries(entries, { key: 'seal', order: 'desc' });
    expect(entries).toEqual(original);
  });
});

describe('matrixCellStyle', () => {
  it('0 家不着色；最大值最深且用白字', () => {
    expect(matrixCellStyle(0, 10)).toEqual({});
    const deep = matrixCellStyle(10, 10);
    expect(deep.background).toContain('rgba(224, 72, 79');
    expect(deep.color).toBe('#fff');
    const light = matrixCellStyle(1, 20);
    expect(light.color).toBe('var(--ink)');
  });
});

describe('promotionRateOf', () => {
  const statistics = {
    pageBoards: [
      { level: 'one', stockCount: 26, promotionRate: null },
      { level: 'two', stockCount: 5, promotionRate: 0.08 },
      { level: 'five_plus', stockCount: 2, promotionRate: 1 },
    ],
  };

  it('按上游档位取晋级率；5 板及以上共用合并档', () => {
    expect(promotionRateOf('two', statistics)).toBe(0.08);
    expect(promotionRateOf('five', statistics)).toBe(1);
    expect(promotionRateOf('six', statistics)).toBe(1);
    expect(promotionRateOf('seven_plus', statistics)).toBe(1);
    expect(promotionRateOf('one', statistics)).toBeNull();
  });

  it('缺统计 → null（不显示晋级率）', () => {
    expect(promotionRateOf('two', null)).toBeNull();
    expect(promotionRateOf('two', {})).toBeNull();
  });
});
