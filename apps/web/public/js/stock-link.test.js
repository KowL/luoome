import { describe, expect, it } from 'bun:test';

import { stockIdentityModel } from './stock-link.js';

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
