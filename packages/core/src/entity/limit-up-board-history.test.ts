import { describe, expect, it } from 'vitest';

import {
  type DeriveLimitUpBoardHistoryInput,
  deriveLimitUpBoardHistory,
  findBoardHistoryFact,
} from './limit-up-board-history.js';

const base: DeriveLimitUpBoardHistoryInput = {
  tradeDate: '2026-11-12',
  source: 'fuyao-limit-up',
  dataAsOf: new Date('2026-11-12T08:05:00.000Z'),
  publishedAt: new Date('2026-11-12T08:00:00.000Z'),
  fetchedAt: new Date('2026-11-12T08:05:00.000Z'),
  vintage: 'captured',
  recordedAt: new Date('2026-11-12T08:05:00.000Z'),
  sealed: [],
  broken: [],
  previousSealed: [],
};

describe('deriveLimitUpBoardHistory', () => {
  it('封板 / 炸板 / 断板三种事实', () => {
    const history = deriveLimitUpBoardHistory({
      ...base,
      sealed: [
        { stockId: '600000.SH', continueDayCnt: 3 },
        { stockId: '000001.SZ', continueDayCnt: 1 },
      ],
      broken: ['600519.SH', '000002.SZ'],
      previousSealed: [
        { stockId: '600000.SH', continueDayCnt: 2 },
        { stockId: '600519.SH', continueDayCnt: 1 },
        { stockId: '000003.SZ', continueDayCnt: 2 },
      ],
    });

    expect(history.status).toBe('complete');
    expect(findBoardHistoryFact(history, '600000.SH')).toMatchObject({
      isBroken: false,
      consecutiveBoard: 2,
      isBoardBreak: false,
    });
    expect(findBoardHistoryFact(history, '600519.SH')).toMatchObject({
      isBroken: true,
      consecutiveBoard: 1,
      isBoardBreak: true,
    });
    // 当日未触板但前一日有连板 → 断板
    expect(findBoardHistoryFact(history, '000003.SZ')).toMatchObject({
      isBroken: false,
      consecutiveBoard: 2,
      isBoardBreak: true,
    });
    expect(history.facts.find((fact) => fact.stockId === '000002.SZ')).toMatchObject({
      isBroken: true,
      consecutiveBoard: 0,
      isBoardBreak: false,
    });
  });

  it('炸板池不可用时 isBroken 保持 null，仍保留封板与连板事实', () => {
    const history = deriveLimitUpBoardHistory({
      ...base,
      sealed: [{ stockId: '600000.SH', continueDayCnt: 2 }],
      broken: null,
      previousSealed: [
        { stockId: '600000.SH', continueDayCnt: 1 },
        { stockId: '600519.SH', continueDayCnt: 2 },
      ],
    });
    expect(history.status).toBe('partial');
    expect(history.missingFields).toContain('limit-break-pool');
    expect(findBoardHistoryFact(history, '600000.SH')).toMatchObject({
      isBroken: false,
      consecutiveBoard: 1,
      isBoardBreak: false,
    });
  });

  it('上一交易日涨停池缺失时 consecutiveBoard 与断板为 null', () => {
    const history = deriveLimitUpBoardHistory({
      ...base,
      sealed: [],
      broken: ['600519.SH'],
      previousSealed: null,
    });
    expect(history.status).toBe('partial');
    expect(findBoardHistoryFact(history, '600519.SH')).toMatchObject({
      isBroken: true,
      consecutiveBoard: null,
      isBoardBreak: null,
      missingFields: ['previous-sealed'],
    });
  });

  it('当日涨停池不可用时状态 unavailable 且不产出事实', () => {
    const history = deriveLimitUpBoardHistory({
      ...base,
      sealed: null,
      broken: ['600519.SH'],
      previousSealed: [],
    });
    expect(history).toMatchObject({
      status: 'unavailable',
      facts: [],
      missingFields: ['limit-up-pool'],
    });
  });

  it('没有涨停/炸板/前一日连板时是可信的空 complete', () => {
    const history = deriveLimitUpBoardHistory(base);
    expect(history).toMatchObject({ status: 'complete', facts: [], missingFields: [] });
  });
});
