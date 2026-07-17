import { z } from 'zod';

import { InvariantError } from '../error/index.js';

/** 名义类型工具：让 number/string 在类型层不可混算（MVP-TASK §2.2）。 */
export type Brand<T, B extends string> = T & { readonly __brand: B };

/** 元，永远 4 位小数。 */
export type Money = Brand<number, 'Money'>;
/** 股，非负整数。 */
export type Quantity = Brand<number, 'Quantity'>;
/** 比率：0.0523 = 5.23%，合法区间 [-1, 10]。 */
export type Percentage = Brand<number, 'Percentage'>;
/** 证券代码：'002594' / 'AAPL'，1-12 位大写字母数字。 */
export type StockCode = Brand<string, 'StockCode'>;

export const money = (n: number): Money => {
  if (!Number.isFinite(n)) throw new InvariantError('Money must be finite');
  return (Math.round(n * 10000) / 10000) as Money;
};

export const quantity = (n: number): Quantity => {
  if (!Number.isInteger(n) || n < 0) {
    throw new InvariantError('Quantity must be non-negative integer');
  }
  return n as Quantity;
};

export const percentage = (n: number): Percentage => {
  if (!Number.isFinite(n) || n < -1 || n > 10) {
    throw new InvariantError('Percentage out of range [-1, 10]');
  }
  return n as Percentage;
};

const STOCK_CODE_PATTERN = /^[A-Z0-9]{1,12}$/;

export const stockCode = (s: string): StockCode => {
  const normalized = s.trim().toUpperCase();
  if (!STOCK_CODE_PATTERN.test(normalized)) {
    throw new InvariantError(`Invalid stock code: ${JSON.stringify(s)}`);
  }
  return normalized as StockCode;
};

/** Money 运算必须走这三个函数，禁止直接 + - *（保证 4 位小数不变量）。 */
export const addMoney = (a: Money, b: Money): Money => money(a + b);
export const subMoney = (a: Money, b: Money): Money => money(a - b);
export const mulMoneyRate = (a: Money, rate: number): Money => money(a * rate);

/**
 * Zod schema（Zod 4.x），供 tools 输入/输出校验复用。
 * 先 refine 出合法 zod issue，再 transform 产出 branded 类型。
 */
export const MoneySchema = z
  .number()
  .refine((n) => Number.isFinite(n), { message: 'Money must be finite' })
  .transform((n) => money(n));

export const QuantitySchema = z
  .number()
  .int({ message: 'Quantity must be an integer' })
  .nonnegative({ message: 'Quantity must be non-negative' })
  .transform((n) => quantity(n));

export const PercentageSchema = z
  .number()
  .min(-1, { message: 'Percentage below -1' })
  .max(10, { message: 'Percentage above 10' })
  .transform((n) => percentage(n));

export const StockCodeSchema = z
  .string()
  .transform((s) => s.trim().toUpperCase())
  .refine((s) => STOCK_CODE_PATTERN.test(s), { message: 'Invalid stock code' })
  .transform((s) => s as StockCode);
