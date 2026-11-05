import { beforeEach, describe, expect, it, vi } from 'vitest';

// React is supplied by DSH; exercise component output and handlers without adding dependencies.
const hooks = vi.hoisted(() => ({ values: [], cursor: 0 }));
vi.mock('react', () => ({
  createElement: (type, props, ...children) => {
    const next = { ...props, children: children.flat(Infinity) };
    return typeof type === 'function' ? type(next) : { type, props: next };
  },
  useState: (initial) => {
    const index = hooks.cursor++;
    if (!(index in hooks.values)) hooks.values[index] = initial;
    return [
      hooks.values[index],
      (value) => {
        hooks.values[index] = value;
      },
    ];
  },
}));

import { SectorRanking } from './overview-market.js';

const nodes = (node) =>
  typeof node !== 'object' || node === null ? [] : [node, ...node.props.children.flatMap(nodes)];
const text = (node) =>
  typeof node !== 'object' || node === null
    ? String(node ?? '')
    : node.props.children.map(text).join('');
const render = (props) => {
  hooks.cursor = 0;
  return SectorRanking(props);
};
const propsFor = (item = {}, extra = {}) => ({
  data: {
    source: 'eastmoney',
    asOf: '2026-11-05T02:00:00Z',
    warnings: [],
    items: [{ code: 'BK1', name: '测试行业', price: 100, amount: 1000, changePct: 0.01, ...item }],
  },
  onStock: vi.fn(),
  ...extra,
});
const expand = (props) => {
  const tree = render(props);
  const button = nodes(tree).find((node) => node.props.className === 'luo-sector-select');
  if (!button.props['aria-expanded']) button.props.onClick();
  return render(props);
};
const linkOf = (tree) => nodes(tree).find((node) => node.props.className === 'luo-stock-link');

beforeEach(() => {
  hooks.values = [];
  hooks.cursor = 0;
});

describe('sector ranking identity and missing-data rendering', () => {
  it.each([
    ['600000', '600000.SH'],
    ['000001', '000001.SZ'],
    ['300476', '300476.SZ'],
    ['600000.SH', '600000.SH'],
    ['430047.BJ', '430047.BJ'],
  ])('opens a real leader code even without a name: %s', (leadingStockCode, stockId) => {
    const props = propsFor({ leadingStockCode });
    const tree = expand(props);
    const link = linkOf(tree);
    expect(link).toBeDefined();
    expect(text(link)).toContain(stockId);
    expect(text(tree)).not.toContain('上游未提供领涨股');
    link.props.onClick();
    expect(props.onStock).toHaveBeenCalledExactlyOnceWith({
      stockId,
      stockName: stockId,
      sourceLabel: '测试行业 · 行业领涨股',
    });
  });

  it.each([undefined, 'unknown', '881101.TI', '123456'])(
    'keeps a named leader with unknown identity as text: %s',
    (leadingStockCode) => {
      const props = propsFor(
        { leadingStockCode, leadingStockName: '名称相同的股票' },
        {
          holdings: {
            holdings: [{ holding: { stockId: '600000.SH' }, stockName: '名称相同的股票' }],
          },
          watchlist: { items: [{ stockId: '600000.SH', stockName: '名称相同的股票' }] },
        },
      );
      const tree = expand(props);
      expect(text(tree)).toContain('名称相同的股票');
      expect(linkOf(tree)).toBeUndefined();
      expect(props.onStock).not.toHaveBeenCalled();
      expect(text(tree)).not.toContain('已持仓');
      expect(text(tree)).not.toContain('当前页关注');
    },
  );

  it('keeps missing up/down counts unknown while preserving explicit zero', () => {
    const props = propsFor();
    let tree = expand(props);
    expect(text(tree)).toContain('上涨家数—');
    expect(text(tree)).toContain('下跌家数—');
    props.data.items[0] = { ...props.data.items[0], upCount: 0, downCount: 7 };
    tree = render(props);
    expect(text(tree)).toContain('上涨家数0');
    expect(text(tree)).toContain('下跌家数7');
    expect(text(tree)).not.toMatch(/undefined|NaN/);
  });

  it.each([
    ['600000.SH', '600000.SH', true, true],
    ['600000.SH', '600000.SZ', true, false],
    ['600000.SZ', '600000.SH', false, true],
    ['600001.SH', '600001.SH', false, false],
  ])(
    'uses exact stock identity for holdings and current-page watch marks: %s / %s',
    (heldId, watchedId, held, watched) => {
      const tree = expand(
        propsFor(
          { leadingStockCode: '600000', leadingStockName: '测试股票' },
          {
            holdings: { holdings: [{ holding: { stockId: heldId } }] },
            watchlist: { items: [{ stockId: watchedId }] },
          },
        ),
      );
      expect(text(tree).includes('已持仓')).toBe(held);
      expect(text(tree).includes('当前页关注')).toBe(watched);
    },
  );

  it('does not invent holdings or watch marks when the corresponding data is absent', () => {
    const tree = expand(propsFor({ leadingStockCode: '600000' }));
    expect(text(tree)).not.toContain('已持仓');
    expect(text(tree)).not.toContain('当前页关注');
  });

  it('keeps sector provenance and source warnings visible in the expanded detail', () => {
    const props = propsFor();
    props.data.warnings = ['coverage-partial'];
    const tree = expand(props);
    expect(text(tree)).toContain('来源 eastmoney · 读取于');
    expect(text(tree)).toContain('coverage-partial');
    expect(text(tree)).toContain('不代表完整成分或历史归属');
  });
});
