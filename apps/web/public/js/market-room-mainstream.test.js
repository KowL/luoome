/* apps/web/public/js/market-room-mainstream.test.js —— 主流题材地图纯函数与结构断言。 */

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';

import {
  intradayGeometry,
  mainstreamCoverageText,
  mainstreamDelayText,
  mainstreamEmptyText,
  mainstreamHash,
  mainstreamHashWithoutStock,
  mainstreamHashWithoutTheme,
  mainstreamMetaText,
  mainstreamParamsFromHash,
  mainstreamQuery,
  mainstreamStockCoverageText,
  mainstreamStockHash,
  mainstreamThemeHash,
  newCoreStockIds,
  sortConstituents,
  sortMainstreamThemes,
  stockRoleLabels,
  stockSealedText,
  visibleConstituents,
} from './market-room-mainstream.js';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const at = '2026-09-28T02:15:00.000Z';

const metric = (value, overrides = {}) => ({
  value,
  status: value === null ? 'unavailable' : 'complete',
  memberCount: 4,
  sampleCount: 3,
  missingCount: 1,
  nonTradableCount: 0,
  thinSample: false,
  advancing: 2,
  declining: 1,
  unchanged: 0,
  method: 'fixture',
  warnings: [],
  ...overrides,
});

const row = (overrides = {}) => ({
  themeId: 'ai-computing',
  name: 'AI与算力',
  day: metric(1.2),
  window5: metric(0.5),
  window15: metric(-0.8),
  turnover: metric(12.34),
  ...overrides,
});

describe('mainstreamParamsFromHash', () => {
  it('默认排序 / 方向 / 窗口与回放时点全部显式解析', () => {
    expect(mainstreamParamsFromHash('#market-room')).toEqual({
      sort: 'day',
      window: 'w15',
      dir: 'up',
      theme: null,
      stock: null,
      at: null,
    });
    expect(
      mainstreamParamsFromHash(
        `#market-room?tab=overview&sort=window5&window=w5&dir=down&theme=ai-computing&stock=600519.SH&at=${encodeURIComponent(at)}`,
      ),
    ).toEqual({
      sort: 'window5',
      window: 'w5',
      dir: 'down',
      theme: 'ai-computing',
      stock: '600519.SH',
      at: new Date(at),
    });
  });

  it('非法值回退默认，不把坏参数带到请求里', () => {
    expect(mainstreamParamsFromHash('#market-room?sort=month&window=m5&dir=sideways')).toEqual({
      sort: 'day',
      window: 'w15',
      dir: 'up',
      theme: null,
      stock: null,
      at: null,
    });
  });
});

describe('mainstreamQuery / mainstreamHash', () => {
  it('成交占比只在前端排序，接口仍用合法 sort；回放时点随请求带上', () => {
    expect(mainstreamQuery({ sort: 'amount', window: 'w15', dir: 'down', at: null })).toBe(
      '?sort=day&window=w15',
    );
    expect(mainstreamQuery({ sort: 'window5', window: 'w5', dir: 'up', at })).toBe(
      `?sort=window5&window=w5&at=${encodeURIComponent(at)}`,
    );
  });

  it('深链接保留排序 / 方向 / 窗口 / at', () => {
    expect(mainstreamHash({ sort: 'amount', window: 'w5', dir: 'down', at })).toBe(
      `market-room?tab=overview&sort=amount&dir=down&window=w5&at=${encodeURIComponent(at)}`,
    );
  });

  it('展开题材与弹窗股票分别写进 theme / stock，关闭只移除对应参数', () => {
    const base = { sort: 'day', window: 'w15', dir: 'up', at: null };
    const openedTheme = mainstreamThemeHash(base, 'ai-computing');
    expect(openedTheme).toContain('theme=ai-computing');
    expect(mainstreamParamsFromHash(`#${openedTheme}`).theme).toBe('ai-computing');
    const withStock = mainstreamStockHash({ ...base, theme: 'ai-computing' }, '600519.SH');
    expect(withStock).toContain('theme=ai-computing');
    expect(withStock).toContain('stock=600519.SH');
    expect(mainstreamHashWithoutStock(mainstreamParamsFromHash(`#${withStock}`))).not.toContain(
      'stock=',
    );
    expect(mainstreamHashWithoutTheme(mainstreamParamsFromHash(`#${withStock}`))).not.toContain(
      'theme=',
    );
  });
});

describe('sortMainstreamThemes', () => {
  const themes = [
    row({ themeId: 'a', name: 'A', day: metric(1), turnover: metric(5) }),
    row({ themeId: 'b', name: 'B', day: metric(-2), turnover: metric(20) }),
    row({ themeId: 'c', name: 'C', day: metric(null), turnover: metric(null) }),
    row({ themeId: 'd', name: 'D', day: metric(3), turnover: metric(1) }),
  ];

  it('领涨降序、领跌升序，缺失恒在最后', () => {
    expect(sortMainstreamThemes(themes, 'day', 'up').map((theme) => theme.themeId)).toEqual([
      'd',
      'a',
      'b',
      'c',
    ]);
    expect(sortMainstreamThemes(themes, 'day', 'down').map((theme) => theme.themeId)).toEqual([
      'b',
      'a',
      'd',
      'c',
    ]);
  });

  it('成交占比排序忽略领跌切换，缺失不参与', () => {
    expect(sortMainstreamThemes(themes, 'amount', 'down').map((theme) => theme.themeId)).toEqual([
      'b',
      'a',
      'd',
      'c',
    ]);
  });
});

describe('主流题材地图文案', () => {
  const map = {
    state: 'ready',
    ruleVersion: 'mainstream-themes@test',
    tradingDate: '2026-09-28',
    anchor: { tradingDate: '2026-09-28', sampledAt: at },
    coverage: {
      parentCount: 11,
      themeCount: 44,
      mappedVendorCodeCount: 338,
      matchedVendorCodeCount: 300,
      missingVendorCodeCount: 38,
      catalogConceptCount: 390,
      unmappedConceptCount: 52,
    },
    parents: [],
    notes: [],
  };

  it('空态写原因与最近批次，不伪造行情', () => {
    expect(
      mainstreamEmptyText({
        state: 'empty',
        emptyReason: 'no_batch',
        anchor: { tradingDate: '2026-09-28', sampledAt: at },
      }),
    ).toBe('尚无已发布的盘中批次 · 最近批次 2026-09-28 10:15');
    expect(mainstreamEmptyText(map)).toBeNull();
  });

  it('页头带分类版本与排序口径', () => {
    const text = mainstreamMetaText(map, { sort: 'day', window: 'w15', dir: 'down', at: null });
    expect(text).toContain('分类版本 mainstream-themes@test');
    expect(text).toContain('按日涨幅（领跌）');
  });

  it('覆盖统计写清未映射与缺失来源边界', () => {
    const text = mainstreamCoverageText(map);
    expect(text).toContain('固定 11 个父板块');
    expect(text).toContain('44 个标准题材');
    expect(text).toContain('映射 300 / 390 个原始概念');
    expect(text).toContain('52 个未映射概念保留在原始概念视图');
  });
});

describe('作战室总览接入主流题材地图', () => {
  it('总览读取 mainstream 接口，不再用 top40 概念卡决定展示方向', () => {
    const room = read('./market-room.js');
    const mainstream = read('./market-room-mainstream.js');
    expect(room).toContain('renderMainstreamPane');
    expect(room).toContain('fetchMainstream');
    expect(room).not.toContain('rotationBoard');
    expect(mainstream).toContain('/api/market/room/mainstream');
    const board = read('./market-room-board.js');
    expect(board).not.toContain('OVERVIEW_CONCEPT_LIMIT');
  });

  it('服务端暴露只读 mainstream API', () => {
    const routes = read('../../src/routes/market.ts');
    expect(routes).toContain("app.get('/api/market/room/mainstream'");
    expect(routes).toContain("invokeTool('get_market_room_mainstream'");
  });
});

describe('短线核心股与全部成分纯函数', () => {
  const row = (overrides = {}) => ({
    stockId: '600519.SH',
    code: '600519',
    name: '贵州茅台',
    nameSource: 'stock_universe',
    isSt: false,
    memberStatus: 'listed',
    close: 1500,
    dayChangePct: 3,
    window5ChangePct: 0.5,
    window15ChangePct: 1.2,
    todayAmount: 1e8,
    window5AmountDelta: 1e7,
    window15AmountDelta: 2e7,
    windowAmountDelta: 2e7,
    sharePct: 20,
    previousSharePct: 18,
    shareDeltaPp: 2,
    amountDeltaChange: 5e6,
    shareReason: null,
    sealed: true,
    ladderLevel: 2,
    firstTime: '09:35:00',
    brokenBoard: false,
    brokenBoardReason: null,
    roles: ['leader'],
    ...overrides,
  });

  it('全部成分默认按近 15 分钟增量降序，缺失恒最后', () => {
    const rows = [
      row({ stockId: 'a', code: '000001', window15AmountDelta: 1, dayChangePct: 1 }),
      row({ stockId: 'b', code: '000002', window15AmountDelta: null, dayChangePct: 2 }),
      row({ stockId: 'c', code: '000003', window15AmountDelta: 5, dayChangePct: 5 }),
    ];
    expect(sortConstituents(rows).map((entry) => entry.stockId)).toEqual(['c', 'a', 'b']);
    expect(sortConstituents(rows, 'day').map((entry) => entry.stockId)).toEqual(['c', 'b', 'a']);
    expect(sortMainstreamThemes).toBeTypeOf('function');
  });

  it('ST 默认隐藏，开关只影响全部成分', () => {
    const rows = [row({ stockId: 'a' }), row({ stockId: 'b', isSt: true })];
    expect(visibleConstituents(rows).map((entry) => entry.stockId)).toEqual(['a']);
    expect(visibleConstituents(rows, true).map((entry) => entry.stockId)).toEqual(['a', 'b']);
  });

  it('新进标记只比较上一份核心股名单，首次加载不标', () => {
    const core = [row({ stockId: 'a' }), row({ stockId: 'b' })];
    expect(newCoreStockIds(null, core)).toEqual([]);
    expect(newCoreStockIds(new Set(['a']), core)).toEqual(['b']);
    expect(newCoreStockIds(new Set(['a', 'b']), core)).toEqual([]);
  });

  it('封板文案区分缺失 / 未封 / 炸板 / 连板，不把缺失写成 false', () => {
    expect(stockSealedText(row({ sealed: null, ladderLevel: null }))).toBe('封板缺失');
    expect(stockSealedText(row({ sealed: false, ladderLevel: null }))).toBe('未封');
    expect(stockSealedText(row({ sealed: false, brokenBoard: true }))).toBe('炸板');
    expect(stockSealedText(row({ sealed: true, ladderLevel: 3 }))).toBe('封板 3 板');
    expect(stockRoleLabels(['height', 'leader'])).toEqual(['领涨', '高度']);
  });

  it('1 分钟几何：缺口断线、成交额柱缺失不插值', () => {
    const series = {
      points: [
        { sampledAt: '2026-09-28T02:10:00.000Z', close: 10, amountDelta: null, gapBefore: false },
        { sampledAt: '2026-09-28T02:11:00.000Z', close: 10.2, amountDelta: 100, gapBefore: false },
        { sampledAt: '2026-09-28T02:13:00.000Z', close: 10.4, amountDelta: null, gapBefore: true },
        { sampledAt: '2026-09-28T02:14:00.000Z', close: 10.5, amountDelta: 80, gapBefore: false },
      ],
    };
    const geometry = intradayGeometry(series, { width: 300 });
    expect(geometry.paths).toHaveLength(2);
    expect(geometry.pointCount).toBe(4);
    expect(geometry.gapCount).toBe(1);
    expect(geometry.bars).toHaveLength(2);
    expect(geometry.min).toBe(10);
    expect(geometry.max).toBe(10.5);
  });

  it('数据延迟使用批次时点计算，不把前端时间当行情时间', () => {
    const board = {
      state: 'ready',
      anchor: { sampledAt: '2026-09-28T02:15:00.000Z' },
    };
    expect(mainstreamDelayText(board, new Date('2026-09-28T02:18:00.000Z').getTime())).toBe(
      '批次 10:15 · 数据延迟约 3 分钟',
    );
    expect(mainstreamDelayText({ state: 'empty', anchor: null })).toBeNull();
  });

  it('核心股覆盖统计写清 ST / 停牌 / 缺报价 / 名称缺失边界', () => {
    const text = mainstreamStockCoverageText({
      state: 'ready',
      coverage: {
        themeWithConstituentsCount: 10,
        constituentCount: 100,
        stCount: 3,
        nonTradableCount: 2,
        missingQuoteCount: 1,
        unnamedCount: 4,
        universeCount: 5000,
      },
    });
    expect(text).toContain('ST 3');
    expect(text).toContain('停牌退市 2');
    expect(text).toContain('缺报价 1');
    expect(text).toContain('中文名缺失 4');
  });
});

describe('作战室短线核心股交互接线', () => {
  it('内联展开 / 全部成分 / 弹窗 / 同批次序列 / 60 秒可见刷新都已接线', () => {
    const mainstream = read('./market-room-mainstream.js');
    const room = read('./market-room.js');
    const routes = read('../../src/routes/market.ts');
    expect(mainstream).toContain('room-core-list');
    expect(mainstream).toContain('room-constituent-table');
    expect(mainstream).toContain('data-stock-id');
    expect(mainstream).toContain('/api/market/room/stock-series');
    expect(mainstream).toContain('openModal');
    expect(mainstream).toContain('closeModal');
    expect(mainstream).toContain('MutationObserver');
    expect(mainstream).toContain('显示 ST');
    expect(mainstream).toContain('mainstreamHashWithoutStock');
    expect(mainstream).toContain('mainstreamHashWithoutTheme');
    expect(room).toContain('bindVisibilityRefresh');
    expect(room).toContain("document.visibilityState === 'visible'");
    expect(room).toContain('window.scrollY');
    expect(room).toContain('stockBoard');
    expect(routes).toContain("app.get('/api/market/room/stock-series'");
    expect(routes).toContain("invokeTool('get_market_room_stock_series'");
  });
});
