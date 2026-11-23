import { describe, expect, it } from 'vitest';

import { normalizeStockName } from './stock.js';

describe('normalizeStockName', () => {
  it('去掉汉字之间的空白，包括全角空格', () => {
    expect(normalizeStockName('五 粮 液')).toBe('五粮液');
    expect(normalizeStockName('五　粮　液')).toBe('五粮液');
    expect(normalizeStockName('中 国  平 安')).toBe('中国平安');
  });

  it('保留英文名内的空格与中英文之间的空格', () => {
    expect(normalizeStockName('Apple Inc.')).toBe('Apple Inc.');
    expect(normalizeStockName('TCL 科技')).toBe('TCL 科技');
    expect(normalizeStockName('贵州茅台')).toBe('贵州茅台');
  });

  it('空字符串保持不变', () => {
    expect(normalizeStockName('')).toBe('');
  });
});
