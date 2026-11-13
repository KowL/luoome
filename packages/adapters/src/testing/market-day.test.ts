import { isAshareTradingSession } from '@luoome/core';
import { describe, expect, it } from 'vitest';

import {
  MARKET_DAY_POINTS,
  MARKET_DAY_SOURCE,
  MARKET_DAY_TRADING_DATE,
  MarketDayFixtureAdapter,
  marketDayPointFor,
  marketDaySnapshot,
} from './market-day.js';

const at = (time: string): Date => new Date(`${MARKET_DAY_TRADING_DATE}T${time}+08:00`);

describe('market-day 交易日夹具', () => {
  it('覆盖同一交易日的六个模拟时点，时点都在连续竞价时段', () => {
    expect(MARKET_DAY_POINTS).toHaveLength(6);
    expect(MARKET_DAY_POINTS.map((point) => point.label)).toEqual([
      '开盘后',
      '早盘分化',
      '上午收盘前',
      '午后开局',
      '尾盘前',
      '收盘前',
    ]);
    for (const point of MARKET_DAY_POINTS) {
      expect(point.at.toISOString().slice(0, 10)).toBe('2026-09-28');
      expect(isAshareTradingSession(point.at), point.label).toBe(true);
    }
  });

  it('同一时点重复输入得到同一快照，条目带成交额', () => {
    const first = marketDaySnapshot(1);
    const second = marketDaySnapshot(1);
    expect(second).toEqual(first);
    expect(first.source).toBe(MARKET_DAY_SOURCE);
    expect(first.completeness.complete).toBe(true);
    expect(first.items).toHaveLength(10);
    expect(first.items.every((item) => (item.amount ?? 0) > 0)).toBe(true);
    expect(first.items.every((item) => item.changePct !== undefined)).toBe(true);
  });

  it('累计成交额随时点单调递增，早盘领涨组后段回落、其余成员接力', () => {
    const snapshots = MARKET_DAY_POINTS.map((_point, index) => marketDaySnapshot(index));
    for (let index = 0; index < 10; index++) {
      const amounts = snapshots.map((snapshot) => snapshot.items[index]?.amount ?? 0);
      for (let step = 1; step < amounts.length; step++) {
        expect(amounts[step] ?? 0).toBeGreaterThan(amounts[step - 1] ?? 0);
      }
    }
    const first = (index: number): number => snapshots[index]?.items[0]?.changePct ?? 0;
    const last = (index: number): number => snapshots[index]?.items.at(-1)?.changePct ?? 0;
    expect(first(5)).toBeLessThan(first(0));
    expect(last(5)).toBeGreaterThan(last(0));
  });

  it('可控时钟选择最近模拟时点；早于首个时点拒绝', async () => {
    expect(marketDayPointFor(at('10:20')).label).toBe('早盘分化');
    expect(marketDayPointFor(at('09:36')).label).toBe('开盘后');
    expect(() => marketDayPointFor(at('09:00'))).toThrow(/不覆盖/);

    let now = at('13:20');
    const adapter = new MarketDayFixtureAdapter({ clock: () => now });
    const first = await adapter.fetchMarketSnapshotEnvelope();
    expect(first.observedAt).toEqual(at('13:15'));
    expect(adapter.envelopeCalls).toBe(1);
    now = at('14:20');
    const second = await adapter.fetchMarketSnapshotEnvelope();
    expect(second.observedAt).toEqual(at('14:15'));
    expect(adapter.envelopeCalls).toBe(2);
    const items = await adapter.fetchMarketSnapshot();
    expect(items).toEqual(second.items);
  });
});
