import { InvariantError } from '../error/index.js';
import type { Account } from './account.js';
import { type Advice, STANDARD_DISCLAIMERS } from './advice.js';
import type { Holding } from './holding.js';
import type { Stock } from './stock.js';
import type { Trade } from './trade.js';

/**
 * 领域不变量断言（ARCHITECTURE §4.1 / §5.3，MVP-TASK §2.3）。
 * 全部抛 InvariantError；tool 层负责转成 invariant_violation ToolError。
 */

export const assertHoldingInvariants = (h: Holding): void => {
  if (!Number.isInteger(h.quantity) || h.quantity < 0) {
    throw new InvariantError('quantity < 0');
  }
  if (!Number.isInteger(h.availableQuantity) || h.availableQuantity < 0) {
    throw new InvariantError('availableQuantity < 0');
  }
  if (h.availableQuantity > h.quantity) {
    throw new InvariantError('available > total');
  }
};

export const assertTradeInvariants = (t: Trade): void => {
  if (!Number.isInteger(t.quantity) || t.quantity <= 0) {
    throw new InvariantError('trade quantity must be positive integer');
  }
  if (!(t.price > 0)) {
    throw new InvariantError('trade price must be > 0');
  }
  if (t.fee < 0) {
    throw new InvariantError('trade fee must be >= 0');
  }
};

/** Advice 不变量 5 条（MVP-TASK §2.3）。 */
export const assertAdviceInvariants = (a: Advice): void => {
  if (a.confidence < 0 || a.confidence > 100) {
    throw new InvariantError('confidence out of [0,100]');
  }
  if (a.disclaimers.length === 0) {
    throw new InvariantError('disclaimers must not be empty');
  }
  for (const required of STANDARD_DISCLAIMERS) {
    if (!a.disclaimers.includes(required)) {
      throw new InvariantError(`missing disclaimer: ${required}`);
    }
  }
  if (a.validUntil.getTime() <= a.validFrom.getTime()) {
    throw new InvariantError('validUntil must be after validFrom');
  }
  if (a.reasoning.premise.length === 0) {
    throw new InvariantError('reasoning.premise must not be empty');
  }
};

export const assertAccountInvariants = (a: Account): void => {
  if (a.id.length === 0) {
    throw new InvariantError('account id must not be empty');
  }
  if (a.name.length === 0) {
    throw new InvariantError('account name must not be empty');
  }
  if (a.currency.length !== 3) {
    throw new InvariantError('account currency must be a 3-letter ISO 4217 code');
  }
  if (a.initialCapital < 0) {
    throw new InvariantError('initialCapital < 0');
  }
};

export const assertStockInvariants = (s: Stock): void => {
  if (s.id.length === 0) {
    throw new InvariantError('stock id must not be empty');
  }
  if (s.code.length === 0) {
    throw new InvariantError('stock code must not be empty');
  }
  if (s.name.length === 0) {
    throw new InvariantError('stock name must not be empty');
  }
};
