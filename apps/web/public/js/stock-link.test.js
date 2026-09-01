import { describe, expect, it } from 'bun:test';

import { marketStockIdFromCode, stockCodeLinkModel, stockIdentityModel } from './stock-link.js';

describe('stock code market link', () => {
  it('maps Shanghai, Shenzhen and Beijing six-digit codes to canonical stock ids', () => {
    expect(marketStockIdFromCode('600519')).toBe('600519.SH');
    expect(marketStockIdFromCode('300857')).toBe('300857.SZ');
    expect(marketStockIdFromCode('920000')).toBe('920000.BJ');
    expect(marketStockIdFromCode('300857.SZ')).toBe('300857.SZ');
  });

  it('builds the default market link and rejects unknown code shapes', () => {
    expect(stockCodeLinkModel('002716', '湖南白银')).toEqual({
      stockId: '002716.SZ',
      href: '#market?stockId=002716.SZ&range=3m',
      ariaLabel: '查看 湖南白银（002716.SZ）行情',
    });
    expect(stockCodeLinkModel('BK0732', '贵金属')).toBeNull();
  });
});

describe('stock identity link', () => {
  it('keeps name above full code and links both to the default 3m market view', () => {
    expect(stockIdentityModel({ stockId: '002594.SZ', stockName: '比亚迪' })).toEqual({
      stockId: '002594.SZ',
      stockName: '比亚迪',
      href: '#market?stockId=002594.SZ&range=3m',
      ariaLabel: '查看 比亚迪（002594.SZ）行情',
    });
    expect(
      stockIdentityModel({
        stockId: '600519.SH',
        stockName: '',
        nameStatus: 'unavailable',
      }).stockName,
    ).toBe('名称暂缺');
  });
});
