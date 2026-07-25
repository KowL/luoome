import { describe, expect, it } from 'vitest';

import {
  assembleLadder,
  assertLimitUpLadderInvariants,
  deriveBoard,
  diffTopLevel,
  filterAndDedupeEntries,
  isSTName,
  type LimitUpLadderEntry,
  LimitUpLadderEntrySchema,
  type LimitUpLadderQuery,
} from './limit-up-ladder.js';

// 便捷构造一个合法 entry（默认值齐全），输入参数覆盖常见差异
const makeEntry = (overrides: Partial<LimitUpLadderEntry> = {}): LimitUpLadderEntry => {
  const base: LimitUpLadderEntry = {
    code: '600519',
    name: '贵州茅台',
    industry: '白酒',
    ladderLevel: 1,
    uncategorized: false,
    firstTime: '10:30:00',
    finalTime: '14:50:00',
    reason: '涨价',
    price: 1800.0,
    rawClose: 1800.0,
    corrected: false,
    changePct: 0.1,
    limitUpDate: '2026-07-25',
    board: 'main_board',
  };
  return { ...base, ...overrides };
};

describe('deriveBoard', () => {
  it.each([
    ['600519', 'main_board'],
    ['601318', 'main_board'],
    ['603259', 'main_board'],
    ['000001', 'main_board'],
    ['002594', 'main_board'],
    ['300750', 'chinext'],
    ['301308', 'chinext'],
    ['688981', 'star'],
    ['689009', 'star'],
    ['830799', 'bse'],
    ['400006', 'bse'],
  ])('deriveBoard(%s) === %s', (code, expectBoard) => {
    expect(deriveBoard(code)).toBe(expectBoard);
  });

  it('非 6 位 code 退到 main_board（哨兵）', () => {
    expect(deriveBoard('abc')).toBe('main_board');
  });
});

describe('isSTName', () => {
  it.each([
    ['ST康美', true],
    ['*ST华塑', true],
    ['贵州茅台', false],
    ['st康美', false], // 中文 ST 要求大写
    ['', false],
  ])('isSTName(%j) === %j', (name, expected) => {
    expect(isSTName(name)).toBe(expected);
  });
});

describe('LimitUpLadderEntrySchema', () => {
  it('合法输入通过', () => {
    const r = LimitUpLadderEntrySchema.safeParse(makeEntry());
    expect(r.success).toBe(true);
  });

  it('非法 code 拒绝', () => {
    const r = LimitUpLadderEntrySchema.safeParse(makeEntry({ code: 'abc' }));
    expect(r.success).toBe(false);
  });

  it('非法 time 拒绝', () => {
    const r = LimitUpLadderEntrySchema.safeParse(makeEntry({ firstTime: '10:30' }));
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues ?? [])).toMatch(/HH:MM:SS/);
  });

  it('null time 合法', () => {
    const r = LimitUpLadderEntrySchema.safeParse(makeEntry({ firstTime: null, finalTime: null }));
    expect(r.success).toBe(true);
  });

  it('changePct 越界拒绝', () => {
    const r = LimitUpLadderEntrySchema.safeParse(makeEntry({ changePct: 0.5 }));
    expect(r.success).toBe(false);
  });

  it('price 必须 > 0', () => {
    const r = LimitUpLadderEntrySchema.safeParse(makeEntry({ price: 0 }));
    expect(r.success).toBe(false);
  });

  it('level ∈ [1,20]', () => {
    expect(LimitUpLadderEntrySchema.safeParse(makeEntry({ ladderLevel: 0 })).success).toBe(false);
    expect(LimitUpLadderEntrySchema.safeParse(makeEntry({ ladderLevel: 21 })).success).toBe(false);
  });
});

describe('filterAndDedupeEntries', () => {
  const buildQuery = (
    overrides: Partial<LimitUpLadderQuery> = {},
  ): Pick<LimitUpLadderQuery, 'includeStar' | 'includeBse' | 'includeST'> => ({
    includeStar: false,
    includeBse: false,
    includeST: false,
    ...overrides,
  });

  it('默认排除科创板 / 北交所 / ST', () => {
    const entries = [
      makeEntry({ code: '688981', board: 'star' }),
      makeEntry({ code: '830799', board: 'bse' }),
      makeEntry({ code: '000001', name: 'ST大集', board: 'main_board' }),
      makeEntry({ code: '600519' }),
    ];
    const out = filterAndDedupeEntries(entries, buildQuery());
    expect(out.map((e) => e.code)).toEqual(['600519']);
  });

  it('includeStar=true 放行科创板', () => {
    const entries = [
      makeEntry({ code: '688981', board: 'star', name: '中芯国际' }),
      makeEntry({ code: '600519' }),
    ];
    const out = filterAndDedupeEntries(entries, buildQuery({ includeStar: true }));
    expect(out.map((e) => e.code).sort()).toEqual(['600519', '688981']);
  });

  it('includeST=true 放行 ST', () => {
    const entries = [makeEntry({ code: '000001', name: 'ST大集' }), makeEntry({ code: '600519' })];
    const out = filterAndDedupeEntries(entries, buildQuery({ includeST: true }));
    expect(out.length).toBe(2);
  });

  it('同 code 跨 level 保留最深', () => {
    const entries = [
      makeEntry({ code: '600519', ladderLevel: 1 }),
      makeEntry({ code: '600519', ladderLevel: 3 }),
      makeEntry({ code: '600519', ladderLevel: 2 }),
    ];
    const out = filterAndDedupeEntries(entries, buildQuery());
    expect(out).toHaveLength(1);
    expect(out[0]?.ladderLevel).toBe(3);
  });

  it('同 code 同 level 取 changePct 高', () => {
    const entries = [
      makeEntry({ code: '600519', ladderLevel: 2, changePct: 0.05 }),
      makeEntry({ code: '600519', ladderLevel: 2, changePct: 0.099 }),
    ];
    const out = filterAndDedupeEntries(entries, buildQuery());
    expect(out[0]?.changePct).toBe(0.099);
  });
});

describe('assembleLadder', () => {
  it('按 level DESC 组装', () => {
    const e1 = makeEntry({ code: '600519', ladderLevel: 1 });
    const e2 = makeEntry({ code: '000001', ladderLevel: 3 });
    const e3 = makeEntry({ code: '300750', ladderLevel: 2 });
    const ladder = assembleLadder('2026-07-25', 'adshare', [e1, e2, e3], [], new Date());
    expect(ladder.levels.map((lv) => lv.level)).toEqual([3, 2, 1]);
    expect(ladder.levels[0]?.name).toBe('3 连板');
    expect(ladder.levels[2]?.name).toBe('首板');
    expect(ladder.total).toBe(3);
    expect(ladder.maxLevel).toBe(3);
  });

  it('空 entries → maxLevel=0', () => {
    const ladder = assembleLadder('2026-07-25', 'adshare', [], ['empty-ladder'], new Date());
    expect(ladder.levels).toHaveLength(0);
    expect(ladder.total).toBe(0);
    expect(ladder.maxLevel).toBe(0);
    expect(ladder.warnings).toEqual(['empty-ladder']);
  });

  it('同 level 内按 changePct DESC', () => {
    const e1 = makeEntry({ code: '600519', ladderLevel: 2, changePct: 0.05 });
    const e2 = makeEntry({ code: '000001', ladderLevel: 2, changePct: 0.09 });
    const ladder = assembleLadder('2026-07-25', 'adshare', [e1, e2], [], new Date());
    expect(ladder.levels[0]?.stocks[0]?.code).toBe('000001');
  });
});

describe('assertLimitUpLadderInvariants', () => {
  it('合法 ladder 通过', () => {
    const ladder = assembleLadder('2026-07-25', 'adshare', [makeEntry()], [], new Date());
    expect(() => assertLimitUpLadderInvariants(ladder, '2026-07-25')).not.toThrow();
  });

  it('changePct 越界抛错', () => {
    const ladder = assembleLadder(
      '2026-07-25',
      'adshare',
      [makeEntry({ changePct: 0.5 })],
      [],
      new Date(),
    );
    expect(() => assertLimitUpLadderInvariants(ladder)).toThrow(/changePct/);
  });

  it('price <= 0 抛错', () => {
    const ladder = assembleLadder(
      '2026-07-25',
      'adshare',
      [makeEntry({ price: 0 })],
      [],
      new Date(),
    );
    expect(() => assertLimitUpLadderInvariants(ladder)).toThrow(/price/);
  });

  it('count != stocks.length 抛错', () => {
    const ladder = {
      date: '2026-07-25',
      total: 1,
      maxLevel: 1,
      source: 'adshare' as const,
      asOf: new Date(),
      warnings: [],
      levels: [{ level: 1, name: '首板', count: 5, stocks: [makeEntry()] }],
    };
    expect(() => assertLimitUpLadderInvariants(ladder)).toThrow(/count/);
  });

  it('limitUpDate 与 baseDate 不一致抛错', () => {
    const ladder = assembleLadder(
      '2026-07-25',
      'adshare',
      [makeEntry({ limitUpDate: '2026-07-26' })],
      [],
      new Date(),
    );
    expect(() => assertLimitUpLadderInvariants(ladder, '2026-07-25')).toThrow(/limitUpDate/);
  });

  it('total != 去重 entry 数抛错', () => {
    const ladder = {
      date: '2026-07-25',
      total: 5,
      maxLevel: 1,
      source: 'adshare' as const,
      asOf: new Date(),
      warnings: [],
      levels: [{ level: 1, name: '首板', count: 1, stocks: [makeEntry()] }],
    };
    expect(() => assertLimitUpLadderInvariants(ladder)).toThrow(/total/);
  });
});

describe('diffTopLevel', () => {
  const mkLadder = (date: string, topCodes: readonly string[]): ReturnType<typeof assembleLadder> =>
    assembleLadder(
      date,
      'adshare',
      topCodes.map((code) => makeEntry({ code, ladderLevel: 5, changePct: 0.1 })),
      [],
      new Date(),
    );

  it('计算 added / removed / retained', () => {
    const curr = mkLadder('2026-07-25', ['600519', '000001', '300750']);
    const prev = mkLadder('2026-07-24', ['600519', '002594']);
    const d = diffTopLevel(curr, prev);
    expect(d.totalDelta).toBe(1); // 3 - 2
    expect(d.maxLevelDelta).toBe(0);
    expect(d.topLevelAdded).toEqual(['000001', '300750']);
    expect(d.topLevelRemoved).toEqual(['002594']);
    expect(d.topLevelRetained).toEqual(['600519']);
  });

  it('两者均无 top → diff 全空', () => {
    const empty = assembleLadder('2026-07-25', 'adshare', [], [], new Date());
    const d = diffTopLevel(empty, empty);
    expect(d.totalDelta).toBe(0);
    expect(d.maxLevelDelta).toBe(0);
    expect(d.topLevelAdded).toEqual([]);
    expect(d.topLevelRemoved).toEqual([]);
    expect(d.topLevelRetained).toEqual([]);
  });
});
