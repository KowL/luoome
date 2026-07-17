import { describe, expect, it } from 'vitest';

import { InvariantError } from '../error/index.js';
import { money, quantity, stockCode } from '../types/branded.js';
import type { Account } from './account.js';
import { type Advice, adviceExpiryDays, STANDARD_DISCLAIMERS } from './advice.js';
import type { Holding } from './holding.js';
import {
  assertAccountInvariants,
  assertAdviceInvariants,
  assertHoldingInvariants,
  assertStockInvariants,
  assertTradeInvariants,
} from './invariants.js';
import type { Stock } from './stock.js';
import type { Trade } from './trade.js';

const NOW = new Date('2026-07-17T02:00:00.000Z');

const validHolding = (): Holding => ({
  id: 'h1',
  accountId: 'acc1',
  stockId: 'stk1',
  quantity: 1000,
  availableQuantity: 800,
  avgCost: money(12.3456),
  openedAt: NOW,
  closedAt: null,
});

const validTrade = (): Trade => ({
  id: 't1',
  accountId: 'acc1',
  stockId: 'stk1',
  side: 'buy',
  quantity: quantity(1000),
  price: money(14.5),
  fee: money(5),
  executedAt: NOW,
  source: 'manual',
  createdAt: NOW,
});

const validAdvice = (): Advice => ({
  id: 'adv1',
  subjectKind: 'stock',
  subjectId: 'stk1',
  decision: 'hold',
  confidence: 65,
  horizon: 'short',
  reasoning: {
    premise: '短期处于箱体震荡，等待方向选择',
    evidence: ['日线 MA5/MA10/MA20 粘合'],
    counterEvidence: ['板块整体回暖'],
  },
  risks: ['大盘系统性下行风险'],
  disclaimers: [...STANDARD_DISCLAIMERS],
  sourceTool: 'analyze_stock',
  basedOn: { dataAsOf: NOW },
  validFrom: NOW,
  validUntil: new Date(NOW.getTime() + 3 * 24 * 60 * 60 * 1000),
  createdAt: NOW,
});

const validAccount = (): Account => ({
  id: 'acc1',
  name: '默认账户',
  kind: 'mock',
  currency: 'CNY',
  initialCapital: money(1_000_000),
  createdAt: NOW,
});

const validStock = (): Stock => ({
  id: 'stk1',
  code: stockCode('002594'),
  exchange: 'SZ',
  name: '比亚迪',
  industry: '汽车整车',
});

describe('STANDARD_DISCLAIMERS', () => {
  it('contains exactly 3 entries', () => {
    expect(STANDARD_DISCLAIMERS).toHaveLength(3);
  });
});

describe('adviceExpiryDays', () => {
  it('maps every horizon per ARCHITECTURE §6.5', () => {
    expect(adviceExpiryDays).toEqual({ intraday: 0, short: 3, medium: 20, long: 60 });
  });
});

describe('assertHoldingInvariants', () => {
  it('passes a valid holding', () => {
    expect(() => assertHoldingInvariants(validHolding())).not.toThrow();
  });

  it('passes when availableQuantity equals quantity', () => {
    const h = { ...validHolding(), availableQuantity: 1000 };
    expect(() => assertHoldingInvariants(h)).not.toThrow();
  });

  it('rejects negative quantity', () => {
    const h = { ...validHolding(), quantity: -1 };
    expect(() => assertHoldingInvariants(h)).toThrow(InvariantError);
  });

  it('rejects non-integer quantity', () => {
    const h = { ...validHolding(), quantity: 1.5 };
    expect(() => assertHoldingInvariants(h)).toThrow(InvariantError);
  });

  it('rejects negative availableQuantity', () => {
    const h = { ...validHolding(), availableQuantity: -1 };
    expect(() => assertHoldingInvariants(h)).toThrow(InvariantError);
  });

  it('rejects availableQuantity > quantity', () => {
    const h = { ...validHolding(), availableQuantity: 1001 };
    expect(() => assertHoldingInvariants(h)).toThrow(/available > total/);
  });
});

describe('assertTradeInvariants', () => {
  it('passes a valid trade', () => {
    expect(() => assertTradeInvariants(validTrade())).not.toThrow();
  });

  it('rejects zero quantity', () => {
    const t = { ...validTrade(), quantity: quantity(0) };
    expect(() => assertTradeInvariants(t)).toThrow(InvariantError);
  });

  it('rejects non-integer quantity', () => {
    const t = { ...validTrade(), quantity: 1.5 as Trade['quantity'] };
    expect(() => assertTradeInvariants(t)).toThrow(InvariantError);
  });

  it('rejects non-positive price', () => {
    const t = { ...validTrade(), price: money(0) };
    expect(() => assertTradeInvariants(t)).toThrow(InvariantError);
  });

  it('rejects negative fee', () => {
    const t = { ...validTrade(), fee: money(-0.01) };
    expect(() => assertTradeInvariants(t)).toThrow(InvariantError);
  });
});

describe('assertAdviceInvariants', () => {
  it('passes a valid advice', () => {
    expect(() => assertAdviceInvariants(validAdvice())).not.toThrow();
  });

  it('accepts disclaimers that are a superset of STANDARD_DISCLAIMERS', () => {
    const a = { ...validAdvice(), disclaimers: [...STANDARD_DISCLAIMERS, '额外提示'] };
    expect(() => assertAdviceInvariants(a)).not.toThrow();
  });

  it('rejects confidence < 0', () => {
    const a = { ...validAdvice(), confidence: -1 };
    expect(() => assertAdviceInvariants(a)).toThrow(/confidence/);
  });

  it('rejects confidence > 100', () => {
    const a = { ...validAdvice(), confidence: 101 };
    expect(() => assertAdviceInvariants(a)).toThrow(/confidence/);
  });

  it('accepts confidence boundary values 0 and 100', () => {
    expect(() => assertAdviceInvariants({ ...validAdvice(), confidence: 0 })).not.toThrow();
    expect(() => assertAdviceInvariants({ ...validAdvice(), confidence: 100 })).not.toThrow();
  });

  it('rejects empty disclaimers', () => {
    const a = { ...validAdvice(), disclaimers: [] };
    expect(() => assertAdviceInvariants(a)).toThrow(/disclaimers must not be empty/);
  });

  it('rejects disclaimers missing any STANDARD_DISCLAIMERS entry', () => {
    const a = { ...validAdvice(), disclaimers: [STANDARD_DISCLAIMERS[0], STANDARD_DISCLAIMERS[1]] };
    expect(() => assertAdviceInvariants(a)).toThrow(/missing disclaimer/);
  });

  it('rejects disclaimers with only unrelated text', () => {
    const a = { ...validAdvice(), disclaimers: ['仅供参考'] };
    expect(() => assertAdviceInvariants(a)).toThrow(/missing disclaimer/);
  });

  it('rejects validUntil equal to validFrom', () => {
    const a = { ...validAdvice(), validUntil: new Date(NOW.getTime()) };
    expect(() => assertAdviceInvariants(a)).toThrow(/validUntil/);
  });

  it('rejects validUntil before validFrom', () => {
    const a = { ...validAdvice(), validUntil: new Date(NOW.getTime() - 1000) };
    expect(() => assertAdviceInvariants(a)).toThrow(/validUntil/);
  });

  it('rejects empty reasoning.premise', () => {
    const a = { ...validAdvice(), reasoning: { ...validAdvice().reasoning, premise: '' } };
    expect(() => assertAdviceInvariants(a)).toThrow(/premise/);
  });
});

describe('assertAccountInvariants', () => {
  it('passes a valid account', () => {
    expect(() => assertAccountInvariants(validAccount())).not.toThrow();
  });

  it('rejects empty id / name', () => {
    expect(() => assertAccountInvariants({ ...validAccount(), id: '' })).toThrow(InvariantError);
    expect(() => assertAccountInvariants({ ...validAccount(), name: '' })).toThrow(InvariantError);
  });

  it('rejects non-ISO currency', () => {
    expect(() => assertAccountInvariants({ ...validAccount(), currency: 'CN' })).toThrow(
      InvariantError,
    );
  });

  it('rejects negative initialCapital', () => {
    expect(() => assertAccountInvariants({ ...validAccount(), initialCapital: money(-1) })).toThrow(
      InvariantError,
    );
  });
});

describe('assertStockInvariants', () => {
  it('passes a valid stock', () => {
    expect(() => assertStockInvariants(validStock())).not.toThrow();
  });

  it('rejects empty id / name', () => {
    expect(() => assertStockInvariants({ ...validStock(), id: '' })).toThrow(InvariantError);
    expect(() => assertStockInvariants({ ...validStock(), name: '' })).toThrow(InvariantError);
  });
});
