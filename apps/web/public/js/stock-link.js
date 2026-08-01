import { buildMarketLink } from './market.js';
import { el } from './ui.js';

export const stockIdentityModel = (stock) => {
  const stockId = String(stock?.stockId ?? '');
  const suppliedName = typeof stock?.stockName === 'string' ? stock.stockName.trim() : '';
  const stockName =
    stock?.nameStatus === 'unavailable' || suppliedName.length === 0 ? '名称暂缺' : suppliedName;
  return {
    stockId,
    stockName,
    href: buildMarketLink(stockId),
    ariaLabel: `查看 ${stockName}（${stockId}）行情`,
  };
};

export const stockIdentityLink = (stock, className = '') => {
  const model = stockIdentityModel(stock);
  const link = el('a', `stock-identity-link${className.length > 0 ? ` ${className}` : ''}`, [
    el('span', 'stock-identity-name', model.stockName),
    el('span', 'stock-identity-code', model.stockId),
  ]);
  link.href = model.href;
  link.setAttribute('aria-label', model.ariaLabel);
  return link;
};
