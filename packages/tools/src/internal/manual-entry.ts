import { type Exchange, type Stock, stockCode, type ToolContext } from '@luoome/core';

/** stockId 形态：`<代码>.<交易所>`（如 002594.SZ）。录入类 write tool 的统一约束。 */
export const STOCK_ID_PATTERN = /^[A-Z0-9]{1,12}\.(SH|SZ|BJ|HK|US)$/;

/**
 * 录入时自动补 stock stub：analyze_position 等下游 tool 依赖 stock 行存在
 * （analyze-position.ts 找不到即 not_found）。repo save 为 upsert，幂等。
 */
export const ensureStockStub = async (
  stockId: string,
  ctx: ToolContext,
  stockName?: string,
): Promise<void> => {
  const existing = await ctx.repos.stock.findById(stockId);
  const dot = stockId.lastIndexOf('.');
  const code = stockId.slice(0, dot);
  const preferredName = stockName?.trim();
  if (existing !== null) {
    // 早期手工录入只保存了代码；后续从搜索候选拿到真名时补全。
    if (
      preferredName !== undefined &&
      preferredName.length > 0 &&
      existing.name === existing.code &&
      preferredName !== existing.name
    ) {
      await ctx.repos.stock.save({ ...existing, name: preferredName });
    }
    return;
  }
  const exchange = stockId.slice(dot + 1) as Exchange;
  const stub: Stock = {
    id: stockId,
    code: stockCode(code),
    exchange,
    name: preferredName !== undefined && preferredName.length > 0 ? preferredName : code,
  };
  await ctx.repos.stock.save(stub);
};

/** 手工录入类实体的 id 生成（时间 + 随机后缀）。 */
export const manualId = (kind: 'account' | 'trade' | 'holding'): string =>
  `manual-${kind}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
