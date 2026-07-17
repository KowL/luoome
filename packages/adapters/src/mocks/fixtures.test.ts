import {
  assertAccountInvariants,
  assertAdviceInvariants,
  assertHoldingInvariants,
  assertStockInvariants,
  assertTradeInvariants,
  STANDARD_DISCLAIMERS,
} from '@luoome/core';
import { describe, expect, it } from 'vitest';

import { DEFAULT_MOCK_NOW } from '../internal/deterministic.js';
import {
  findMockStock,
  MOCK_ACCOUNT,
  MOCK_HOLDINGS,
  MOCK_STOCK_BASE_PRICES,
  MOCK_STOCKS,
  MOCK_TRADES,
  mockAdviceFor,
} from './fixtures.js';

const fixedClock = () => new Date(DEFAULT_MOCK_NOW.getTime());

describe('MOCK_STOCKS', () => {
  it('10 A 股 + 5 港股 + 5 美股，全部过不变量', () => {
    expect(MOCK_STOCKS).toHaveLength(20);
    expect(MOCK_STOCKS.filter((s) => ['SH', 'SZ', 'BJ'].includes(s.exchange))).toHaveLength(10);
    expect(MOCK_STOCKS.filter((s) => s.exchange === 'HK')).toHaveLength(5);
    expect(MOCK_STOCKS.filter((s) => s.exchange === 'US')).toHaveLength(5);
    for (const s of MOCK_STOCKS) {
      expect(() => assertStockInvariants(s)).not.toThrow();
      expect(s.id).toBe(`${s.code}.${s.exchange}`);
      expect(s.industry).toBeDefined();
      expect(MOCK_STOCK_BASE_PRICES[s.id]).toBeDefined();
    }
  });

  it('findMockStock 支持 id 与裸代码（大小写不敏感）', () => {
    expect(findMockStock('002594.SZ')?.name).toBe('比亚迪');
    expect(findMockStock('002594')?.id).toBe('002594.SZ');
    expect(findMockStock('aapl')?.id).toBe('AAPL.US');
    expect(findMockStock('NOT-EXIST')).toBeNull();
  });
});

describe('MOCK_ACCOUNT / MOCK_HOLDINGS / MOCK_TRADES', () => {
  it('账户过不变量，uuid 固定', () => {
    expect(() => assertAccountInvariants(MOCK_ACCOUNT)).not.toThrow();
    expect(MOCK_ACCOUNT.id).toBe('f47ac10b-58cc-4372-a567-0e02b2c3d479');
  });

  it('持仓 5-8 个，引用合法，过不变量', () => {
    expect(MOCK_HOLDINGS.length).toBeGreaterThanOrEqual(5);
    expect(MOCK_HOLDINGS.length).toBeLessThanOrEqual(8);
    for (const h of MOCK_HOLDINGS) {
      expect(() => assertHoldingInvariants(h)).not.toThrow();
      expect(h.accountId).toBe(MOCK_ACCOUNT.id);
      expect(findMockStock(h.stockId)).not.toBeNull();
      expect(h.closedAt).toBeNull();
    }
  });

  it('交易与持仓一致：数量合计相等、加权成本对齐', () => {
    for (const t of MOCK_TRADES) {
      expect(() => assertTradeInvariants(t)).not.toThrow();
      expect(t.accountId).toBe(MOCK_ACCOUNT.id);
    }
    for (const h of MOCK_HOLDINGS) {
      const trades = MOCK_TRADES.filter((t) => t.stockId === h.stockId);
      expect(trades.length).toBeGreaterThanOrEqual(1);
      const totalQty = trades.reduce((sum, t) => sum + t.quantity, 0);
      expect(totalQty).toBe(h.quantity);
      const totalCost = trades.reduce((sum, t) => sum + t.quantity * t.price, 0);
      expect(totalCost / totalQty).toBeCloseTo(h.avgCost, 4);
    }
  });
});

describe('mockAdviceFor', () => {
  it.each(['002594.SZ', '00700.HK', 'AAPL.US', 'UNKNOWN-CODE'])(
    '过 assertAdviceInvariants：%s',
    (stockId) => {
      const advice = mockAdviceFor(stockId, fixedClock);
      expect(() => assertAdviceInvariants(advice)).not.toThrow();
    },
  );

  it('必含 3 条 STANDARD_DISCLAIMERS，validUntil > validFrom', () => {
    const advice = mockAdviceFor('600519.SH', fixedClock);
    expect(advice.disclaimers).toHaveLength(3);
    for (const d of STANDARD_DISCLAIMERS) {
      expect(advice.disclaimers).toContain(d);
    }
    expect(advice.validUntil.getTime()).toBeGreaterThan(advice.validFrom.getTime());
    expect(advice.confidence).toBeGreaterThanOrEqual(0);
    expect(advice.confidence).toBeLessThanOrEqual(100);
    expect(advice.subjectKind).toBe('stock');
    expect(advice.subjectId).toBe('600519.SH');
  });

  it('deterministic：同一 stockId + 同一 clock 输出一致（含 id）', () => {
    const a = mockAdviceFor('300750.SZ', fixedClock);
    const b = mockAdviceFor('300750.SZ', fixedClock);
    expect(b).toEqual(a);
    expect(a.id).toBe(b.id);
  });

  it('裸代码会解析成 fixture id', () => {
    const advice = mockAdviceFor('002594', fixedClock);
    expect(advice.subjectId).toBe('002594.SZ');
  });
});
