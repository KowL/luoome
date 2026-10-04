import type { Holding } from '../entity/holding.js';
import type { Trade } from '../entity/trade.js';
import { InvariantError } from '../error/index.js';
import { money } from '../types/branded.js';

export const applyTradeToHolding = (
  previous: Holding | null,
  trade: Trade,
  newHoldingId: string,
): Holding => {
  if (trade.side === 'buy') {
    if (previous === null || previous.closedAt !== null) {
      return {
        id: previous?.id ?? newHoldingId,
        accountId: trade.accountId,
        stockId: trade.stockId,
        quantity: trade.quantity,
        availableQuantity: trade.quantity,
        avgCost: trade.price,
        openedAt: trade.executedAt,
        closedAt: null,
      };
    }
    const quantity = previous.quantity + trade.quantity;
    return {
      ...previous,
      quantity,
      availableQuantity: previous.availableQuantity + trade.quantity,
      avgCost: money(
        (previous.quantity * previous.avgCost + trade.quantity * trade.price) / quantity,
      ),
    };
  }
  if (previous === null || previous.closedAt !== null)
    throw new InvariantError(`无持仓可卖: ${trade.stockId}`);
  if (trade.quantity > previous.availableQuantity) {
    throw new InvariantError(
      `可卖数量不足: 可卖 ${previous.availableQuantity}，卖出 ${trade.quantity}`,
    );
  }
  const quantity = previous.quantity - trade.quantity;
  return {
    ...previous,
    quantity,
    availableQuantity: previous.availableQuantity - trade.quantity,
    ...(quantity === 0 ? { closedAt: trade.executedAt } : {}),
  };
};
