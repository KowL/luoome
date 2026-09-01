import { buildMarketLink } from './market.js';
import { el } from './ui.js';

export const marketStockIdFromCode = (code) => {
  const normalized = String(code ?? '')
    .trim()
    .toUpperCase();
  if (/^\d{6}\.(SH|SZ|BJ)$/.test(normalized)) return normalized;
  if (!/^\d{6}$/.test(normalized)) return null;
  if (/^6/.test(normalized)) return `${normalized}.SH`;
  if (/^[03]/.test(normalized)) return `${normalized}.SZ`;
  if (/^[48]/.test(normalized) || /^92/.test(normalized)) return `${normalized}.BJ`;
  return null;
};

export const stockCodeLinkModel = (code, name = '') => {
  const stockId = marketStockIdFromCode(code);
  if (stockId === null) return null;
  const stockName = typeof name === 'string' && name.trim().length > 0 ? name.trim() : stockId;
  return {
    stockId,
    href: buildMarketLink(stockId),
    ariaLabel: `查看 ${stockName}（${stockId}）行情`,
  };
};

export const stockCodeLink = (code, label = code, className = '') => {
  const model = stockCodeLinkModel(code, label);
  if (model === null) return el('span', className, label ?? '--');
  const link = el('a', `stock-code-link${className.length > 0 ? ` ${className}` : ''}`, label);
  link.href = model.href;
  link.setAttribute('aria-label', model.ariaLabel);
  return link;
};

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
