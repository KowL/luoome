import { assembleLadder, type LimitUpLadder, type ToolContext } from '@luoome/core';
import { describe, expect, it, vi } from 'vitest';

import { loadStockLimitUpFacts } from './limit-up-facts.js';

const snapshotFor = (date: string, asOf = new Date(`${date}T08:30:00.000Z`)): LimitUpLadder =>
  assembleLadder(
    date,
    'eastmoney',
    [
      {
        code: '600001',
        name: '测试股份',
        industry: '测试行业',
        ladderLevel: 2,
        uncategorized: false,
        firstTime: '09:30:00',
        finalTime: '14:30:00',
        reason: '--',
        price: 11,
        rawClose: 11,
        corrected: false,
        changePct: 0.1,
        limitUpDate: date,
        board: 'main_board',
      },
    ],
    [],
    asOf,
  );

const contextFor = (input: {
  readonly now: Date;
  readonly findByDate: (date: string) => Promise<LimitUpLadder | null>;
  readonly fetchLadder?: ToolContext['limitUpLadder'];
}): ToolContext =>
  ({
    clock: () => input.now,
    repos: {
      limitUpLadderSnapshot: {
        findByDate: ({ date }: { date: string }) => input.findByDate(date),
      },
    },
    ...(input.fetchLadder === undefined ? {} : { limitUpLadder: input.fetchLadder }),
  }) as unknown as ToolContext;

describe('loadStockLimitUpFacts', () => {
  it('历史回看只读取 PIT repository，不调用当前 manager', async () => {
    const fetchLadder = vi.fn();
    const fetchedAt = new Date('2026-08-14T08:30:00.000Z');
    const ctx = contextFor({
      now: new Date('2026-08-15T04:00:00.000Z'),
      findByDate: async (date) => (date === '2026-08-14' ? snapshotFor(date, fetchedAt) : null),
      fetchLadder: {
        name: 'limit-up-ladder',
        sources: ['eastmoney'],
        fetchLadder,
        compareLadder: vi.fn(),
      },
    });

    const facts = await loadStockLimitUpFacts('600001.SH', '600001', '2026-08-14', ctx);

    expect(fetchLadder).not.toHaveBeenCalled();
    expect(facts).toMatchObject({
      status: 'partial',
      coverage: 'CN_A_SHARES_SH_SZ',
      source: 'eastmoney',
      dataAsOf: new Date('2026-08-14T07:00:00.000Z'),
      fetchedAt,
      today: { date: '2026-08-14', ladderLevel: 2 },
    });
    expect(facts.missingDates).toHaveLength(29);
    expect(facts.warnings).toContain('pit-snapshots-missing:29');
  });

  it('没有可审计 PIT 快照时返回 unavailable，不把空历史当作无事件', async () => {
    const empty = assembleLadder(
      '2026-08-14',
      'eastmoney',
      [],
      ['empty-ladder'],
      new Date('2026-08-14T08:30:00.000Z'),
    );
    const ctx = contextFor({
      now: new Date('2026-08-15T04:00:00.000Z'),
      findByDate: async (date) => (date === '2026-08-14' ? empty : null),
    });

    const facts = await loadStockLimitUpFacts('600001.SH', '600001', '2026-08-14', ctx);

    expect(facts.status).toBe('unavailable');
    expect(facts.dataAsOf).toBeNull();
    expect(facts.today).toBeNull();
    expect(facts.missingDates).toHaveLength(30);
  });

  it('仅当天允许读取 manager，既往日期仍要求 PIT 快照', async () => {
    const snapshot = snapshotFor('2026-08-14');
    const fetchLadder = vi.fn(async () => ({ ok: true as const, data: snapshot }));
    const ctx = contextFor({
      now: new Date('2026-08-14T08:30:00.000Z'),
      findByDate: async () => null,
      fetchLadder: {
        name: 'limit-up-ladder',
        sources: ['eastmoney'],
        fetchLadder,
        compareLadder: vi.fn(),
      },
    });

    const facts = await loadStockLimitUpFacts('600001.SH', '600001', '2026-08-14', ctx);

    expect(fetchLadder).toHaveBeenCalledTimes(1);
    expect(facts.status).toBe('partial');
    expect(facts.today?.ladderLevel).toBe(2);
    expect(facts.missingDates).toHaveLength(29);
  });
});
