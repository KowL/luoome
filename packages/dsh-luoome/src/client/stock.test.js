import { beforeEach, describe, expect, it, vi } from 'vitest';

// DSH supplies React at runtime; keep these render/handler regressions dependency-free.
const hooks = vi.hoisted(() => ({ values: [], cursor: 0 }));
const financialRead = vi.hoisted(() => ({ state: { loading: true }, calls: 0 }));
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
  useEffect: () => {},
  useRef: () => ({ current: null }),
}));
vi.mock('./data.js', () => ({
  useStockDetail: () => ({ loading: true }),
  useStockHistory: () => ({ loading: false }),
  useStockProfile: () => ({ loading: false }),
  useStockFinancial: () => {
    financialRead.calls += 1;
    return financialRead.state;
  },
}));

import { StockDetail, StockFinancialFacts, StockHistory } from './stock.js';

const nodes = (node) =>
  typeof node !== 'object' || node === null ? [] : [node, ...node.props.children.flatMap(nodes)];
const text = (node) =>
  typeof node !== 'object' || node === null
    ? String(node ?? '')
    : node.props.children.map(text).join('');
const render = (component, props) => {
  hooks.cursor = 0;
  return component(props);
};
const candles = Array.from({ length: 65 }, (_, index) => ({
  date: new Date(Date.UTC(2026, 6, index + 1)).toISOString().slice(0, 10),
  open: 10,
  high: 12,
  low: 9,
  close: 11,
  volume: index * 100,
  source: 'fixture',
  completeness: index === 64 ? 'live' : 'closed',
}));
const marketView = {
  candles,
  movingAverages: candles.map((bar, index) => ({
    date: bar.date,
    ma20: index >= 19 ? 10.5 : null,
    ma60: index >= 59 ? 10.8 : null,
  })),
  dataStatus: {
    retrieval: 'local-fallback',
    barsAsOf: '2026-09-03',
    sources: ['fixture'],
    warnings: ['bars-local-fallback'],
  },
};

beforeEach(() => {
  hooks.values = [];
  hooks.cursor = 0;
  financialRead.state = { loading: true };
  financialRead.calls = 0;
});

describe('stock rendering and event regressions', () => {
  it('shares candle/volume x coordinates and reads actual volume and missing amount', () => {
    const tree = render(StockHistory, { marketView });
    const bars = nodes(tree).filter((node) => node.props.className === 'luo-stock-history-volume');
    const prices = nodes(tree).filter(
      (node) => node.props.className === 'luo-stock-history-candle',
    );
    expect(bars).toHaveLength(65);
    expect(bars.map((bar) => bar.props.x)).toEqual(prices.map((bar) => bar.props.x));
    expect(bars[0].props.height).toBe(0);
    expect(bars.at(-1).props.height).toBe(48);
    expect(text(tree)).toContain('6,400 股');
    expect(text(tree)).toContain('成交额 缺失');
    expect(text(tree)).toContain('未收盘');
    expect(text(tree)).toContain('本地保留日线');
    expect(text(tree)).toContain('数据范围可能不完整');
    expect(text(tree)).not.toMatch(/NaN|undefined/);
  });

  it('clips to 30 without losing tool MA values and navigates via keyboard and hover', () => {
    let tree = render(StockHistory, { marketView });
    nodes(tree)
      .find((node) => node.type === 'button' && text(node) === '30 交易日')
      .props.onClick();
    tree = render(StockHistory, { marketView });
    expect(
      nodes(tree).filter((node) => node.props.className === 'luo-stock-history-candle'),
    ).toHaveLength(30);
    let chart = nodes(tree).find((node) => node.props['data-stock-history']);
    const preventDefault = vi.fn();
    chart.props.onKeyDown({ key: 'Home', preventDefault });
    tree = render(StockHistory, { marketView });
    let readout = nodes(tree).find((node) => node.props['aria-live'] === 'polite');
    expect(text(readout)).toContain(candles[35].date);
    expect(text(readout)).toContain('MA20 10.50');
    expect(text(readout)).toContain('MA60 不足期');
    chart = nodes(tree).find((node) => node.props['data-stock-history']);
    chart.props.onKeyDown({ key: 'ArrowRight', preventDefault });
    tree = render(StockHistory, { marketView });
    readout = nodes(tree).find((node) => node.props['aria-live'] === 'polite');
    expect(text(readout)).toContain(candles[36].date);
    chart = nodes(tree).find((node) => node.props['data-stock-history']);
    chart.props.onPointerMove({
      clientX: 560,
      currentTarget: { getBoundingClientRect: () => ({ left: 0, width: 560 }) },
    });
    tree = render(StockHistory, { marketView });
    expect(text(nodes(tree).find((node) => node.props['aria-live'] === 'polite'))).toContain(
      candles[64].date,
    );
    expect(preventDefault).toHaveBeenCalledTimes(2);
  });

  it('draws no MA path for insufficient periods or old responses without averages', () => {
    const tree = render(StockHistory, {
      marketView: { ...marketView, candles: candles.slice(0, 10), movingAverages: [] },
    });
    const paths = nodes(tree).filter((node) => node.type === 'path');
    expect(paths.every((node) => !node.props.d.trim())).toBe(true);
    expect(
      render(StockHistory, { marketView: { ...marketView, candles: [] } }).props.children.join(''),
    ).toContain('缺失交易日保持未知');
  });

  it('preserves non-strategy evidence, links the code to Xueqiu, and has no lazy-read buttons', () => {
    const tree = render(StockDetail, {
      stock: { stockId: '600000.SH', stockName: '测试股票' },
      sourceLabel: '持仓',
      evidence: '原始持仓事实时间 2026-11-04',
    });
    expect(text(tree)).toContain('原始持仓事实时间 2026-11-04');
    for (const removed of ['读取历史日 K', '读取股东户数与所属板块', '读取财务快照'])
      expect(text(tree)).not.toContain(removed);
    const link = nodes(tree).find(
      (node) => node.type === 'a' && node.props.href === 'https://xueqiu.com/S/SH600000',
    );
    expect(link?.props.target).toBe('_blank');
    expect(link?.props.rel).toContain('noopener');
    expect(
      nodes(tree).find(
        (node) => node.type === 'button' && node.props['aria-label'] === '刷新个股数据',
      ),
    ).toBeTruthy();
  });

  it.each([
    ['permission_denied', '当前配置未启用财务快照读取'],
    ['invalid_input', '当前未配置财务快照数据源'],
  ])('shows explicit financial configuration error: %s', (kind, message) => {
    financialRead.state = { loading: false, data: { financial: { ok: false, error: { kind } } } };
    const tree = render(StockDetail, {
      stock: { stockId: '600000.SH', stockName: '测试股票' },
    });
    expect(financialRead.calls).toBeGreaterThan(0);
    expect(text(tree)).toContain(message);
    expect(text(tree)).not.toContain('上游缺失字段');
  });

  it('renders non-PIT disclosure, separate report dates, real zeros and missing fields', () => {
    const tree = StockFinancialFacts({
      snapshot: {
        source: 'fuyao',
        viewKind: 'current-vendor-view',
        pitStatus: 'not-ready',
        fetchedAt: '2026-11-05T02:00:00Z',
        statements: {
          incomeStatements: [
            {
              period: 'quarterly',
              periodEnd: '2026-06-30',
              reportDate: '2026-08-30',
              fields: { operating_income: 0 },
            },
          ],
        },
        indicators: {
          report: '2026Q2',
          indicators: [{ indicatorId: 'sale_gross_margin', unit: 'percent-points', value: 12.5 }],
        },
        missingFields: ['valuation.pbMrq'],
        issues: ['upstream-partial'],
      },
    });
    expect(text(tree)).toContain('非 PIT');
    expect(text(tree)).toContain('报告期末 缺失');
    expect(text(tree)).toContain('期末 2026-06-30 · 披露日 2026-08-30');
    expect(text(tree)).toContain('营业收入0.00');
    expect(text(tree)).toContain('销售毛利率12.50%');
    expect(text(tree)).toContain('归母净利润缺失');
    expect(text(tree)).toContain('valuation.pbMrq');
    expect(text(tree)).toContain('upstream-partial');
    expect(text(tree)).not.toMatch(/NaN|undefined/);
  });
});
