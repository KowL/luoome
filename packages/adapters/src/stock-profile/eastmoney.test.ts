import { describe, expect, it } from 'vitest';

import {
  bareStockCode,
  parseStockProfileBoards,
  parseStockProfileHolder,
  stockProfileBoardUrl,
  stockProfileHolderUrl,
} from './eastmoney.js';

/**
 * 东财个股档案协议层解析测试（股东户数 + 所属板块）。
 * 字段口径来自 2026-10-30 的真实报表响应；全程纯函数，不依赖网络。
 */

const holderFixture = {
  success: true,
  result: {
    pages: 1,
    data: [
      {
        SECURITY_CODE: '300476',
        SECUCODE: '300476.SZ',
        HOLDER_NUM: 274138,
        PRE_HOLDER_NUM: 279285,
        HOLDER_NUM_CHANGE: -5147,
        HOLDER_NUM_RATIO: -1.842920314374,
        END_DATE: '2026-10-09 00:00:00',
        AVG_MARKET_CAP: 645144.568691571,
        AVG_HOLD_NUM: 3182.91266807228,
      },
    ],
  },
};

const boardFixture = {
  success: true,
  result: {
    pages: 1,
    data: [
      {
        BOARD_CODE: '877',
        BOARD_NAME: 'PCB',
        NEW_BOARD_CODE: 'BK0877',
        BOARD_TYPE: null,
        IS_PRECISE: '1',
        BOARD_RANK: 28,
        SELECTED_BOARD_REASON: '公司具备高多层 PCB 产能。',
      },
      {
        BOARD_CODE: '867',
        BOARD_NAME: '富时罗素',
        NEW_BOARD_CODE: 'BK0867',
        BOARD_TYPE: '行业',
        IS_PRECISE: '0',
        BOARD_RANK: 14,
        SELECTED_BOARD_REASON: null,
      },
    ],
  },
};

const reportWithRows = (rows: unknown[]) => ({ success: true, result: { data: rows } });
const invalidPayload = expect.objectContaining({
  name: 'SourceExecutionError',
  kind: 'invalid_payload',
});

describe('stock profile URL', () => {
  it('股东户数按裸代码过滤，板块按带后缀代码过滤', () => {
    expect(bareStockCode('300476.SZ')).toBe('300476');
    expect(stockProfileHolderUrl('300476.SZ')).toContain('SECURITY_CODE%3D%22300476%22');
    expect(stockProfileBoardUrl('300476.SZ')).toContain('SECUCODE%3D%22300476.SZ%22');
  });
});

describe.each([
  { name: 'holder', parse: parseStockProfileHolder, fixture: holderFixture, empty: null },
  { name: 'boards', parse: parseStockProfileBoards, fixture: boardFixture, empty: [] },
])('$name report validation', ({ parse, fixture, empty }) => {
  it.each(
    [
      undefined,
      null,
      'not a report',
      [],
      {},
      { result: null },
      { success: 'true', result: null },
      { success: null, result: null },
      { success: true },
      { success: true, result: [] },
      { success: true, result: 'invalid' },
      { success: true, result: {} },
      { success: true, result: { data: null } },
      { success: true, result: { data: {} } },
      { success: true, result: { data: 'invalid' } },
    ].map((raw) => ({ raw })),
  )('拒绝畸形报表信封：$raw', ({ raw }) => {
    expect(() => parse(raw)).toThrowError(invalidPayload);
  });

  it.each([null, [], 'invalid', 42].map((row) => ({ row })))(
    '拒绝非对象数据行：$row',
    ({ row }) => {
      expect(() => parse(reportWithRows([row]))).toThrowError(invalidPayload);
      expect(() => parse(reportWithRows([...fixture.result.data, row]))).toThrowError(
        invalidPayload,
      );
    },
  );

  it('合法无数据和空行列表保持空结果', () => {
    expect(parse({ success: true, result: null }, '300476.SZ')).toEqual(empty);
    expect(parse(reportWithRows([]), '300476.SZ')).toEqual(empty);
  });

  it('报表业务失败保留 upstream_error 分类', () => {
    expect(() => parse({ success: false, result: null, message: 'bad report' })).toThrowError(
      expect.objectContaining({ name: 'SourceExecutionError', kind: 'upstream_error' }),
    );
  });

  it.each([
    { SECUCODE: '300476.SZ' },
    { SECURITY_CODE: '300476' },
    { SECUCODE: '300476.SZ', SECURITY_CODE: '300476' },
  ])('允许按完整或裸代码匹配请求股票：%j', (identity) => {
    const rows = fixture.result.data.map((row) => {
      const identified: Record<string, unknown> = { ...row };
      delete identified.SECUCODE;
      delete identified.SECURITY_CODE;
      return { ...identified, ...identity };
    });
    expect(parse(reportWithRows(rows), '300476.SZ')).toEqual(parse(fixture));
  });

  it.each([
    { SECUCODE: '600000.SH' },
    { SECURITY_CODE: '600000' },
    { SECUCODE: '300476.SH' },
    { SECUCODE: '600000.SH', SECURITY_CODE: '300476' },
    { SECUCODE: '300476.SZ', SECURITY_CODE: '600000' },
  ])('指定股票时拒绝错股或冲突代码：%j', (identity) => {
    const raw = reportWithRows(fixture.result.data.map((row) => ({ ...row, ...identity })));
    expect(() => parse(raw, '300476.SZ')).toThrowError(invalidPayload);
    expect(parse(raw)).toEqual(parse(fixture));
  });
});

describe('parseStockProfileHolder', () => {
  it('取最近一期，变动比例由百分数转小数', () => {
    const holder = parseStockProfileHolder(holderFixture);
    expect(holder).not.toBeNull();
    expect(holder?.endDate).toBe('2026-10-09');
    expect(holder?.holderNum).toBe(274138);
    expect(holder?.changePct).toBeCloseTo(-0.018429, 5);
    expect(holder?.avgShares).toBeCloseTo(3182.91266807228, 6);
    expect(holder?.avgMarketValue).toBeCloseTo(645144.568691571, 6);
  });

  it.each([
    undefined,
    null,
    '',
    20261009,
    '2026-2-09',
    '2026-02-30',
    '2026-02-29 00:00:00',
    '1900-02-29',
    '2026-04-31',
    '2026-00-09',
    '2026-13-09',
    '2026-10-00',
    '2026-10-32',
    '2026-10-09invalid',
  ])('缺失或非法统计日期抛 invalid_payload：%j', (END_DATE) => {
    expect(() =>
      parseStockProfileHolder(reportWithRows([{ ...holderFixture.result.data[0], END_DATE }])),
    ).toThrowError(invalidPayload);
  });

  it.each(['2026-10-09', '2024-02-29 00:00:00', '2000-02-29'])('接受真实日期：%s', (END_DATE) => {
    expect(
      parseStockProfileHolder(reportWithRows([{ ...holderFixture.result.data[0], END_DATE }])),
    ).toMatchObject({ endDate: END_DATE.slice(0, 10) });
  });

  it.each([undefined, null, '10', -1, 1.5, Number.NaN, Infinity, -Infinity])(
    '户数必须是非负有限整数：%s',
    (HOLDER_NUM) => {
      expect(() =>
        parseStockProfileHolder(reportWithRows([{ ...holderFixture.result.data[0], HOLDER_NUM }])),
      ).toThrowError(invalidPayload);
    },
  );

  it('允许零户数，并将缺省可选值保留为 null', () => {
    expect(
      parseStockProfileHolder(reportWithRows([{ END_DATE: '2026-10-09', HOLDER_NUM: 0 }])),
    ).toEqual({
      endDate: '2026-10-09',
      holderNum: 0,
      changePct: null,
      avgShares: null,
      avgMarketValue: null,
    });
  });

  describe.each(['AVG_HOLD_NUM', 'AVG_MARKET_CAP'])('%s', (field) => {
    it.each([-1, Number.NaN, Infinity, -Infinity, '100', false])(
      '拒绝已提供但无效的户均值：%s',
      (value) => {
        expect(() =>
          parseStockProfileHolder(
            reportWithRows([{ ...holderFixture.result.data[0], [field]: value }]),
          ),
        ).toThrowError(invalidPayload);
      },
    );

    it.each([undefined, null, 0, 1.5])('允许缺省、null 和非负有限值：%s', (value) => {
      const holder = parseStockProfileHolder(
        reportWithRows([{ ...holderFixture.result.data[0], [field]: value }]),
      );
      const parsedField = field === 'AVG_HOLD_NUM' ? 'avgShares' : 'avgMarketValue';
      expect(holder?.[parsedField]).toBe(value ?? null);
    });
  });
});

describe('parseStockProfileBoards', () => {
  it('保留精确归属、板块类型与入选理由', () => {
    const boards = parseStockProfileBoards(boardFixture);
    expect(boards).toHaveLength(2);
    expect(boards[0]).toMatchObject({
      code: 'BK0877',
      name: 'PCB',
      boardType: null,
      precise: true,
      rank: 28,
      reason: '公司具备高多层 PCB 产能。',
    });
    expect(boards[1]).toMatchObject({ boardType: '行业', precise: false, reason: null });
  });

  describe.each(['BOARD_NAME', 'NEW_BOARD_CODE'])('%s', (field) => {
    it.each([undefined, null, '', ' \t ', 123])('缺失或非法必填字段使报表失败：%s', (value) => {
      const invalidRow = { ...boardFixture.result.data[0], [field]: value };
      expect(() => parseStockProfileBoards(reportWithRows([invalidRow]))).toThrowError(
        invalidPayload,
      );
      expect(() =>
        parseStockProfileBoards(reportWithRows([...boardFixture.result.data, invalidRow])),
      ).toThrowError(invalidPayload);
    });
  });

  it('必填文本去除首尾空格后保留', () => {
    expect(
      parseStockProfileBoards(
        reportWithRows([{ BOARD_NAME: ' PCB ', NEW_BOARD_CODE: ' BK0877 ' }]),
      ),
    ).toEqual([
      {
        code: 'BK0877',
        name: 'PCB',
        boardType: null,
        precise: false,
        rank: null,
        reason: null,
      },
    ]);
  });

  it('首行匹配时仍拒绝后续错股行', () => {
    const rows = boardFixture.result.data.map((row, index) => ({
      ...row,
      SECUCODE: index === 0 ? '300476.SZ' : '600000.SH',
    }));
    expect(() => parseStockProfileBoards(reportWithRows(rows), '300476.SZ')).toThrowError(
      invalidPayload,
    );
  });
});
