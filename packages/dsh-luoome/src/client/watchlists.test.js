import { describe, expect, it, vi } from 'vitest';

vi.mock('react', () => ({
  Fragment: 'fragment',
  createElement: (type, props, ...children) => ({
    type,
    props: props ?? {},
    children: children.flat(),
  }),
  useEffect: vi.fn(),
  useRef: vi.fn(),
  useState: vi.fn(),
}));
vi.mock('./data.js', () => ({ dataOf: vi.fn(), errorOf: vi.fn(), usePanelState: vi.fn() }));
vi.mock('./stock.js', () => ({ StockDetail: 'StockDetail' }));
vi.mock('./primitives.js', () =>
  Object.fromEntries(
    [
      'Card',
      'Empty',
      'ErrorNote',
      'Footer',
      'Head',
      'PanelHealthBadge',
      'Pill',
      'Refresh',
      'Section',
      'SkeletonLines',
      'Stamp',
    ].map((name) => [name, name]),
  ),
);

import {
  DEFAULT_MEMBER_FILTERS,
  filterWatchlistMembers,
  WatchlistMemberFilters,
} from './watchlists.js';

const member = (stockId, stockName, priority, stage, firstAddedAt, sources) => ({
  member: {
    id: stockId,
    stockId,
    priority,
    stage,
    firstAddedAt,
    lastActivityAt: stockId === '000001.SZ' ? '2026-11-01T08:00:00Z' : firstAddedAt,
  },
  stockName,
  sources,
});
const members = [
  member('000001.SZ', '平安银行', 'normal', 'watching', '2026-10-01T08:00:00Z', [
    { kind: 'manual', status: 'active', reason: '分红观察' },
    { kind: 'strategy', status: 'ended', reason: '旧策略：VALUE' },
  ]),
  member('600036.SH', '招商银行', 'urgent', 'researching', '2026-10-03T08:00:00Z', [
    { kind: 'strategy', status: 'stale', reason: '低估值 VALUE' },
    { kind: 'ai', status: 'active', reason: '现金流质量' },
  ]),
  member('600000.SH', undefined, 'important', 'watching', '2026-10-05T08:00:00Z', [
    { kind: 'portfolio', status: 'active', reason: '持仓跟进' },
  ]),
];
const ids = (rows) => rows.map((row) => row.member.stockId);
const filter = (values) =>
  filterWatchlistMembers(members, { ...DEFAULT_MEMBER_FILTERS, ...values });
const descendants = (node) =>
  node && typeof node === 'object' ? [node, ...node.children.flatMap(descendants)] : [];

describe('关注成员搜索、筛选与排序', () => {
  it('默认优先级从紧急到普通，且不改变原始成员和来源', () => {
    const snapshot = structuredClone(members);
    expect(ids(filter({}))).toEqual(['600036.SH', '600000.SH', '000001.SZ']);
    expect(members).toEqual(snapshot);
  });

  it('搜索覆盖代码、名称和全部来源理由，并忽略大小写和首尾空白', () => {
    expect(ids(filter({ query: ' 000001.sz ' }))).toEqual(['000001.SZ']);
    expect(ids(filter({ query: '招商' }))).toEqual(['600036.SH']);
    expect(ids(filter({ query: ' value ' }))).toEqual(['600036.SH', '000001.SZ']);
    expect(ids(filter({ query: '持仓跟进' }))).toEqual(['600000.SH']);
  });

  it('阶段、来源和优先级交集筛选；保留多来源成员的完整来源', () => {
    const rows = filter({ stage: 'researching', source: 'ai', priority: 'urgent', query: 'VALUE' });
    expect(ids(rows)).toEqual(['600036.SH']);
    expect(rows[0].sources).toEqual(members[1].sources);
    expect(filter({ stage: 'watching', source: 'ai' })).toEqual([]);
  });

  it('来源类型包含待刷新来源，排除仅有已结束来源的成员', () => {
    expect(ids(filter({ source: 'strategy' }))).toEqual(['600036.SH']);
    expect(ids(filter({ source: 'manual' }))).toEqual(['000001.SZ']);
    expect(filter({ source: 'import' })).toEqual([]);
  });

  it('最近加入按 firstAddedAt 而非来源时间或最后活动时间排序', () => {
    expect(ids(filter({ sort: 'recent' }))).toEqual(['600000.SH', '600036.SH', '000001.SZ']);
  });

  it('名称排序遵循中文顺序，名称缺失时仍可稳定排序', () => {
    const named = members.slice(0, 2);
    expect(ids(filterWatchlistMembers(named, { ...DEFAULT_MEMBER_FILTERS, sort: 'name' }))).toEqual(
      ['000001.SZ', '600036.SH'],
    );
    expect(filter({ sort: 'name' })).toHaveLength(3);
    expect(filterWatchlistMembers([], DEFAULT_MEMBER_FILTERS)).toEqual([]);
  });

  it('重置默认值恢复全部成员和默认优先级排序', () => {
    expect(filter({ priority: 'normal' })).toHaveLength(1);
    expect(ids(filterWatchlistMembers(members, DEFAULT_MEMBER_FILTERS))).toEqual([
      '600036.SH',
      '600000.SH',
      '000001.SZ',
    ]);
  });
});

describe('关注筛选控件', () => {
  it('显示已加载范围和计数，所有输入发出完整筛选条件并支持重置', () => {
    const onChange = vi.fn();
    const onReset = vi.fn();
    const filters = { ...DEFAULT_MEMBER_FILTERS, query: '银行', stage: 'watching' };
    const tree = WatchlistMemberFilters({ filters, onChange, onReset, total: 3, visible: 1 });
    const nodes = descendants(tree);
    expect(nodes.find((node) => node.props.role === 'status').children.join('')).toBe(
      '显示 1 / 3 只 · 仅当前列表已加载成员',
    );
    for (const [label, key, value] of [
      ['搜索成员', 'query', 'SH'],
      ['研究阶段筛选', 'stage', 'confirmed'],
      ['来源类型筛选', 'source', 'strategy'],
      ['优先级筛选', 'priority', 'urgent'],
      ['成员排序', 'sort', 'recent'],
    ]) {
      nodes
        .find((node) => node.props['aria-label'] === label)
        .props.onChange({ target: { value } });
      expect(onChange).toHaveBeenLastCalledWith({ ...filters, [key]: value });
    }
    const reset = nodes.find((node) => node.type === 'button');
    expect(reset.props.disabled).toBe(false);
    reset.props.onClick();
    expect(onReset).toHaveBeenCalledOnce();
  });

  it('默认条件下重置禁用；只改变排序也能重置', () => {
    const render = (filters) =>
      descendants(WatchlistMemberFilters({ filters, total: 0, visible: 0 })).find(
        (node) => node.type === 'button',
      );
    expect(render(DEFAULT_MEMBER_FILTERS).props.disabled).toBe(true);
    expect(render({ ...DEFAULT_MEMBER_FILTERS, sort: 'name' }).props.disabled).toBe(false);
  });
});
