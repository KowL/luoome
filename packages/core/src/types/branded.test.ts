import { describe, expect, it } from 'vitest';

import { InvariantError } from '../error/index.js';
import {
  addMoney,
  MoneySchema,
  money,
  mulMoneyRate,
  PercentageSchema,
  percentage,
  QuantitySchema,
  quantity,
  StockCodeSchema,
  stockCode,
  subMoney,
} from './branded.js';

describe('money', () => {
  it('rounds to 4 decimals', () => {
    expect(money(1.234567)).toBe(1.2346);
    expect(money(0.1 + 0.2)).toBe(0.3);
  });

  it('accepts zero and negatives', () => {
    expect(money(0)).toBe(0);
    expect(money(-3.45678)).toBe(-3.4568);
  });

  it('rejects NaN', () => {
    expect(() => money(Number.NaN)).toThrow(InvariantError);
  });

  it('rejects ±Infinity', () => {
    expect(() => money(Number.POSITIVE_INFINITY)).toThrow(InvariantError);
    expect(() => money(Number.NEGATIVE_INFINITY)).toThrow(InvariantError);
  });
});

describe('quantity', () => {
  it('accepts non-negative integers', () => {
    expect(quantity(0)).toBe(0);
    expect(quantity(1000)).toBe(1000);
  });

  it('rejects negatives', () => {
    expect(() => quantity(-1)).toThrow(InvariantError);
  });

  it('rejects non-integers', () => {
    expect(() => quantity(1.5)).toThrow(InvariantError);
    expect(() => quantity(Number.NaN)).toThrow(InvariantError);
  });
});

describe('percentage', () => {
  it('accepts values within [-1, 10]', () => {
    expect(percentage(-1)).toBe(-1);
    expect(percentage(0)).toBe(0);
    expect(percentage(0.0523)).toBe(0.0523);
    expect(percentage(10)).toBe(10);
  });

  it('rejects out-of-range values', () => {
    expect(() => percentage(-1.0001)).toThrow(InvariantError);
    expect(() => percentage(10.0001)).toThrow(InvariantError);
    expect(() => percentage(Number.NaN)).toThrow(InvariantError);
  });
});

describe('stockCode', () => {
  it('accepts A-share and US style codes', () => {
    expect(stockCode('002594')).toBe('002594');
    expect(stockCode('AAPL')).toBe('AAPL');
  });

  it('normalizes case and trims whitespace', () => {
    expect(stockCode('  aapl ')).toBe('AAPL');
  });

  it('rejects invalid codes', () => {
    expect(() => stockCode('')).toThrow(InvariantError);
    expect(() => stockCode('   ')).toThrow(InvariantError);
    expect(() => stockCode('00259 4')).toThrow(InvariantError);
    expect(() => stockCode('00-2594')).toThrow(InvariantError);
    expect(() => stockCode('A'.repeat(13))).toThrow(InvariantError);
  });
});

describe('money arithmetic', () => {
  it('addMoney keeps 4-decimal invariant', () => {
    expect(addMoney(money(1.005), money(2.005))).toBe(3.01);
  });

  it('subMoney keeps 4-decimal invariant', () => {
    expect(subMoney(money(3.01), money(1.005))).toBe(2.005);
    expect(subMoney(money(1), money(2.5))).toBe(-1.5);
  });

  it('mulMoneyRate applies a rate and rounds', () => {
    expect(mulMoneyRate(money(100), 0.05)).toBe(5);
    expect(mulMoneyRate(money(10.3333), 3)).toBe(30.9999);
  });
});

describe('branded zod schemas', () => {
  it('MoneySchema parses and rounds', () => {
    expect(MoneySchema.parse(1.234567)).toBe(1.2346);
    expect(MoneySchema.safeParse(Number.POSITIVE_INFINITY).success).toBe(false);
    expect(MoneySchema.safeParse('12.3').success).toBe(false);
  });

  it('QuantitySchema parses non-negative integers only', () => {
    expect(QuantitySchema.parse(100)).toBe(100);
    expect(QuantitySchema.safeParse(-1).success).toBe(false);
    expect(QuantitySchema.safeParse(1.5).success).toBe(false);
  });

  it('PercentageSchema enforces range', () => {
    expect(PercentageSchema.parse(0.0523)).toBe(0.0523);
    expect(PercentageSchema.safeParse(11).success).toBe(false);
    expect(PercentageSchema.safeParse(-2).success).toBe(false);
  });

  it('StockCodeSchema normalizes and validates', () => {
    expect(StockCodeSchema.parse('aapl')).toBe('AAPL');
    expect(StockCodeSchema.safeParse('bad code!').success).toBe(false);
  });
});
