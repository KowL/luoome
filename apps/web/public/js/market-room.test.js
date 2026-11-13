/* apps/web/public/js/market-room.test.js —— 作战室页面纯函数与入口结构断言。 */

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';

import {
  amountSummary,
  breadthCountsText,
  breadthMedianText,
  breadthSampleText,
  divergenceText,
  emptyStateText,
  overviewMetaText,
  roomTabFromHash,
  sectorBreadthText,
  sectorDetailFacts,
  sectorDetailNotes,
  sectorEmptyText,
  sectorHash,
  sectorMetaText,
  sectorParamsFromHash,
  sectorQuery,
  sectorRowCells,
  sectorSampleText,
  windowSpanText,
} from './market-room.js';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

const breadthValue = (overrides = {}) => ({
  advancing: 6,
  declining: 3,
  unchanged: 1,
  classifiedCount: 10,
  missingChangePctCount: 0,
  sampleCount: 10,
  expectedCount: 10,
  medianChangePct: 0.5,
  ...overrides,
});

describe('roomTabFromHash', () => {
  it('三视图 tab 可从深链接读取，非法值回退总览', () => {
    expect(roomTabFromHash('#market-room')).toBe('overview');
    expect(roomTabFromHash('#market-room?tab=overview')).toBe('overview');
    expect(roomTabFromHash('#market-room?tab=sectors')).toBe('sectors');
    expect(roomTabFromHash('#market-room?tab=turnover')).toBe('turnover');
    expect(roomTabFromHash('#market-room?tab=unknown')).toBe('overview');
    expect(roomTabFromHash('')).toBe('overview');
  });
});

describe('宽度口径文案', () => {
  it('涨跌平与中位数分开写，中位数缺失不写 0.00%', () => {
    expect(breadthCountsText(breadthValue())).toBe('上涨 6 · 下跌 3 · 平 1');
    expect(breadthMedianText(breadthValue())).toBe('个股涨幅中位数 +0.50%');
    expect(breadthMedianText(breadthValue({ medianChangePct: -1.25 }))).toBe(
      '个股涨幅中位数 -1.25%',
    );
    const missing = breadthMedianText(breadthValue({ medianChangePct: null, classifiedCount: 0 }));
    expect(missing).toBe('个股涨幅中位数缺失');
    expect(missing).not.toContain('0.00%');
  });

  it('统计口径带样本数、分母与缺失数', () => {
    expect(breadthSampleText(breadthValue({ missingChangePctCount: 2, classifiedCount: 8 }))).toBe(
      '样本 10 只 / 期望 10 只 · 参与分类 8 只 · 缺涨幅 2 只',
    );
  });

  it('维度缺失时文案为 null，由渲染层显示缺失原因', () => {
    expect(breadthCountsText(undefined)).toBeNull();
    expect(breadthMedianText(null)).toBeNull();
    expect(breadthSampleText(undefined)).toBeNull();
  });

  it('指数与多数个股背离 / 同向分别提示，无基准指数时不编造', () => {
    const divergent = divergenceText(
      breadthValue({
        medianChangePct: -0.8,
        divergence: {
          indexCode: '000001',
          indexName: '上证指数',
          indexChangePct: 0.42,
          medianChangePct: -0.8,
          divergent: true,
        },
      }),
    );
    expect(divergent).toContain('指数与多数个股背离');
    expect(divergent).toContain('上证指数 +0.42%');
    expect(divergent).toContain('中位数 -0.80%');

    const aligned = divergenceText(
      breadthValue({
        divergence: {
          indexCode: '000001',
          indexName: '上证指数',
          indexChangePct: -0.42,
          medianChangePct: 0.5,
          divergent: false,
        },
      }),
    );
    expect(aligned).toContain('同向');
    expect(divergenceText(breadthValue())).toBeNull();
  });
});

describe('成交额对比文案', () => {
  it('有可比基准时给出放量结论与基准时刻', () => {
    const summary = amountSummary({
      status: 'complete',
      value: {
        currentAmount: 120_000_000,
        currentSampleCount: 10,
        currentMissingAmountCount: 0,
        currentTotalCount: 10,
        comparison: {
          previousTradingDate: '2026-09-24',
          previousSampledAt: '2026-09-24T02:15:00.000Z',
          previousAmount: 96_000_000,
          previousSampleCount: 10,
          deltaAmount: 24_000_000,
          deltaPct: 25,
          verdict: 'expanded',
        },
      },
    });
    expect(summary.current).toBe('累计成交额 1.20亿');
    expect(summary.previous).toContain('昨日同时点 9600.00万');
    expect(summary.previous).toContain('2026-09-24 10:15');
    expect(summary.verdict).toBe('放量 +25.00%');
    expect(summary.sample).toBe('样本 10 只 · 缺成交额 0 只');
  });

  it('缩量 / 持平均按后端结论展示', () => {
    const verdictOf = (verdict, deltaPct) =>
      amountSummary({
        status: 'complete',
        value: {
          currentAmount: 80_000_000,
          currentSampleCount: 10,
          currentMissingAmountCount: 0,
          currentTotalCount: 10,
          comparison: {
            previousTradingDate: '2026-09-24',
            previousSampledAt: '2026-09-24T02:15:00.000Z',
            previousAmount: 100_000_000,
            previousSampleCount: 10,
            deltaAmount: -20_000_000,
            deltaPct,
            verdict,
          },
        },
      }).verdict;
    expect(verdictOf('contracted', -20)).toBe('缩量 -20.00%');
    expect(verdictOf('flat', 0)).toBe('持平 0.00%');
  });

  it('缺少昨日同时点时只显示缺失，不显示 0 或缩量', () => {
    const summary = amountSummary({
      status: 'partial',
      warnings: ['missing_previous_batch: 缺少 2026-09-24 10:15 的已发布批次，不做昨日同时点对比'],
      value: {
        currentAmount: 60_000_000,
        currentSampleCount: 8,
        currentMissingAmountCount: 2,
        currentTotalCount: 10,
      },
    });
    expect(summary.current).toBe('累计成交额 6000.00万');
    expect(summary.previous).toBe('昨日同时点缺失');
    expect(summary.verdict).toBeNull();
    expect(summary.sample).toBe('样本 8 只 · 缺成交额 2 只');
    const rendered = [summary.current, summary.previous, summary.verdict ?? ''].join(' ');
    expect(rendered).not.toContain('缩量');
    expect(rendered).not.toContain('0.00%');
  });

  it('维度整体缺失时不产出数字', () => {
    expect(
      amountSummary({ status: 'unavailable', warnings: ['missing_amount: 无样本'] }),
    ).toBeNull();
  });
});

describe('空态与页头文案', () => {
  const latestBatch = { tradingDate: '2026-09-24', sampledAt: '2026-09-24T06:50:00.000Z' };

  it('无批次 / 盘前 / 非交易日 / 当日无批次分别给出明确文案', () => {
    expect(emptyStateText({ state: 'empty', emptyReason: 'no_batch', latestBatch: null })).toBe(
      '尚无已发布的盘中批次',
    );
    expect(emptyStateText({ state: 'empty', emptyReason: 'pre_open', latestBatch })).toContain(
      '盘前',
    );
    expect(emptyStateText({ state: 'empty', emptyReason: 'pre_open', latestBatch })).toContain(
      '最近批次 2026-09-24 14:50',
    );
    expect(
      emptyStateText({ state: 'empty', emptyReason: 'non_trading_day', latestBatch }),
    ).toContain('非交易日');
    expect(
      emptyStateText({ state: 'empty', emptyReason: 'no_today_batch', latestBatch }),
    ).toContain('今日尚无已发布批次');
  });

  it('ready 没有空态文案；页头写覆盖范围、交易日与数据时点', () => {
    const ready = {
      state: 'ready',
      tradingDate: '2026-09-28',
      coverage: {
        status: 'complete',
        warnings: [],
        value: {
          coverage: 'CN_A_SHARES_SH_SZ',
          tradingDate: '2026-09-28',
          sampledAt: '2026-09-28T02:15:00.000Z',
          receivedCount: 10,
          expectedCount: 10,
        },
      },
    };
    expect(emptyStateText(ready)).toBeNull();
    expect(overviewMetaText(ready)).toBe('沪深 A 股 · 交易日 2026-09-28 · 数据时点 10:15');
    expect(
      overviewMetaText({ state: 'empty', emptyReason: 'non_trading_day', latestBatch: null }),
    ).toContain('非交易日');
  });
});

describe('作战室页面入口结构', () => {
  const html = read('../index.html');
  const appJs = read('./app.js');
  const marketRoutes = read('../../src/routes/market.ts');

  it('侧栏有「作战室」菜单项，#route-market-room section 存在', () => {
    expect(html).toContain('href="#market-room" data-route="market-room"><span>作战室</span>');
    expect(html).toContain('id="route-market-room"');
    expect(html).toContain('data-route="market-room"');
  });

  it('app.js 接入 market-room 路由并负责 teardown（60s 刷新）', () => {
    expect(appJs).toContain("'market-room'");
    expect(appJs).toContain(
      "import { renderMarketRoom, teardownMarketRoom } from './market-room.js'",
    );
    expect(appJs).toContain('teardownMarketRoom();');
    expect(appJs).toContain('renderMarketRoom(setStatus)');
    // 直接访问 /market/room 时按 pathname 归到同一路由
    expect(appJs).toContain("path === 'market/room'");
  });

  it('market-room.js 只读总览接口，60s 刷新且页面隐藏跳过', () => {
    const room = read('./market-room.js');
    expect(room).toContain('/api/market/room/overview');
    expect(room).not.toContain('/api/market/room/collect');
    expect(room).toContain('60_000');
    expect(room).toContain("document.visibilityState !== 'visible'");
    expect(room).toContain('teardownMarketRoom');
    expect(room).toContain("sectors: '板块追踪'");
    expect(room).toContain("turnover: '成交分布'");
    // 板块榜同样只读：按口径拼查询参数，不触发采集。
    expect(room).toContain('/api/market/room/sectors');
    expect(room).toContain('sectorQuery');
  });

  it('服务端暴露只读总览 / 板块榜 API 与 /market/room 页面路由', () => {
    expect(marketRoutes).toContain("app.get('/api/market/room/overview'");
    expect(marketRoutes).toContain("callTool('get_market_room_overview', {})");
    expect(marketRoutes).toContain("app.get('/api/market/room/sectors'");
    expect(marketRoutes).toContain("invokeTool('get_market_room_sectors'");
    expect(marketRoutes).toContain("app.get('/market/room'");
  });
});

const sectorMetric = (overrides = {}) => ({
  value: 1.25,
  status: 'complete',
  memberCount: 4,
  sampleCount: 3,
  missingCount: 1,
  nonTradableCount: 0,
  thinSample: false,
  method:
    '日涨幅 = 板块 active 成分 changePct 等权均值（相对前收）；停牌 / 退市与缺涨幅成分剔除，不计作 0',
  warnings: [],
  ...overrides,
});

const sectorRow = (overrides = {}) => ({
  sectorId: 'sec-1',
  kind: 'industry',
  vendorCode: '881273.TI',
  name: '白酒',
  rank: 1,
  day: { ...sectorMetric(), advancing: 2, declining: 1, unchanged: 0 },
  window5: sectorMetric({ value: -0.4 }),
  window15: sectorMetric({
    value: null,
    status: 'unavailable',
    warnings: ['window_start_missing: 缺批次'],
  }),
  turnover: sectorMetric({
    value: 12.34,
    numeratorAmount: 400,
    method: '窗口成交占比 = 成分增量 ÷ 全市场去重增量',
  }),
  limitUp: { value: 2, status: 'complete', method: '封板数 = 天梯里出现的成分', warnings: [] },
  ...overrides,
});

const sectorRanking = (overrides = {}) => ({
  state: 'ready',
  kind: 'industry',
  sort: 'day',
  window: 'w15',
  tradingDate: '2026-09-28',
  anchor: { sampledAt: '2026-09-28T02:15:00.000Z' },
  windows: {
    w5: {
      key: 'w5',
      minutes: 5,
      status: 'complete',
      targetSampledAt: '2026-09-28T02:10:00.000Z',
      startSampledAt: '2026-09-28T02:10:00.000Z',
      spanMs: 300000,
      reason: null,
      warnings: [],
    },
    w15: {
      key: 'w15',
      minutes: 15,
      status: 'unavailable',
      targetSampledAt: '2026-09-28T02:00:00.000Z',
      startSampledAt: null,
      spanMs: null,
      reason: 'window_start_missing: 10:00 及之前没有已发布批次',
      warnings: [],
    },
  },
  turnover: {
    window: 'w15',
    status: 'unavailable',
    reason: 'window_start_missing: 缺窗口起点',
    marketAmountDelta: null,
    marketSampleCount: 0,
    marketTotalCount: 10,
    method: '窗口成交占比',
    warnings: [],
  },
  limitUp: {
    status: 'complete',
    reason: null,
    tradingDate: '2026-09-28',
    source: 'eastmoney',
    total: 2,
    maxLevel: 1,
    method: '封板数',
    warnings: [],
  },
  coverage: { sectorCount: 2, rowCount: 1, omittedSectorCount: 1 },
  rows: [sectorRow()],
  notes: ['概念间成分可重叠，各板块占比不可加总为市场总量。'],
  ...overrides,
});

describe('板块追踪深链接与请求参数', () => {
  it('默认行业 / 日涨幅 / 15 分钟占比窗口，非法值回退默认', () => {
    expect(sectorParamsFromHash('#market-room?tab=sectors')).toEqual({
      kind: 'industry',
      sort: 'day',
      window: 'w15',
    });
    expect(
      sectorParamsFromHash('#market-room?tab=sectors&kind=concept&sort=window5&window=w5'),
    ).toEqual({
      kind: 'concept',
      sort: 'window5',
      window: 'w5',
    });
    expect(sectorParamsFromHash('#market-room?tab=sectors&kind=futures&sort=amount')).toEqual({
      kind: 'industry',
      sort: 'day',
      window: 'w15',
    });
  });

  it('请求路径与深链接互相对应，口径显式带在 URL 上', () => {
    const params = { kind: 'concept', sort: 'window15', window: 'w5' };
    expect(sectorQuery(params)).toBe('?kind=concept&sort=window15&window=w5');
    expect(sectorHash(params)).toBe('market-room?tab=sectors&kind=concept&sort=window15&window=w5');
    expect(sectorQuery(sectorParamsFromHash(`#${sectorHash(params)}`))).toBe(sectorQuery(params));
  });
});

describe('板块行文案与缺失态', () => {
  it('同一行同时给出三种口径的数值，缺失写 null 由渲染层显示缺失', () => {
    const row = sectorRow();
    const cells = sectorRowCells(row);
    expect(cells).toMatchObject({
      rank: '1',
      day: '+1.25%',
      window5: '-0.40%',
      window15: null,
      limitUp: '2',
      turnover: '12.34%',
      breadth: '上涨 2 / 有效 3',
      breadthSub: '成分 4 · 缺失 1 · 停牌退市 0',
    });
    expect(cells.window15).not.toBe('0.00%');
  });

  it('缺失口径不编造数字：null 值、无排名与空样本都明确', () => {
    const row = sectorRow({
      rank: null,
      day: sectorMetric({
        value: null,
        status: 'unavailable',
        sampleCount: 0,
        missingCount: 4,
        advancing: 0,
        declining: 0,
        unchanged: 0,
      }),
    });
    const cells = sectorRowCells(row);
    expect(cells.rank).toBe('—');
    expect(cells.day).toBeNull();
    expect(cells.breadth).toBe('上涨 0 / 有效 0');
    expect(sectorBreadthText(row.day)).toBe('上涨 0 · 下跌 0 · 平 0');
    expect(sectorSampleText(row.day)).toBe('有效 0 / 成分 4 · 缺失 4 · 停牌退市 0');
  });

  it('窗口两端与跨度写明；不可比时给出原因而不是 0', () => {
    const ready = {
      status: 'complete',
      startSampledAt: '2026-09-28T02:10:00.000Z',
      spanMs: 300000,
      reason: null,
    };
    expect(windowSpanText(ready)).toBe('10:10 → 10:15 · 5 分钟');
    const unavailable = {
      status: 'unavailable',
      startSampledAt: null,
      spanMs: null,
      reason: 'window_crosses_lunch_break: 跨午休',
    };
    expect(windowSpanText(unavailable)).toBe('缺失：window_crosses_lunch_break: 跨午休');
    expect(windowSpanText(undefined)).toBe('窗口缺失');
  });
});

describe('板块展开明细与口径说明', () => {
  it('展开行同时给出上涨家数、有效成分分母、封板数与成交占比', () => {
    const ranking = sectorRanking();
    const facts = sectorDetailFacts(ranking.rows[0], ranking);
    const byLabel = Object.fromEntries(facts.map((fact) => [fact.label, fact.value]));
    expect(byLabel['日涨幅']).toBe('+1.25%');
    expect(byLabel['近 5 分钟']).toBe('-0.40%');
    expect(byLabel['近 15 分钟']).toBe('缺失');
    expect(byLabel['上涨 / 下跌 / 平']).toBe('上涨 2 · 下跌 1 · 平 0');
    expect(byLabel['有效成分（分母）']).toBe('有效 3 / 成分 4 · 缺失 1 · 停牌退市 0');
    expect(byLabel['封板数']).toBe('2 只');
    expect(byLabel['窗口成交占比']).toBe('12.34%');
    expect(byLabel['成分增量 / 全市场增量']).toBe('缺失');
    expect(byLabel['窗口起点（5 分钟）']).toBe('10:10 → 10:15 · 5 分钟');
    expect(byLabel['窗口起点（15 分钟）']).toContain('window_start_missing');
  });

  it('分母有效时给出分子 / 分母，缺失原因进入说明且去重', () => {
    const ranking = sectorRanking({
      turnover: {
        window: 'w5',
        status: 'complete',
        reason: null,
        marketAmountDelta: 600,
        marketSampleCount: 10,
        marketTotalCount: 10,
        method: '窗口成交占比',
        warnings: [],
      },
      windows: {
        w5: {
          key: 'w5',
          minutes: 5,
          status: 'complete',
          targetSampledAt: '2026-09-28T02:10:00.000Z',
          startSampledAt: '2026-09-28T02:10:00.000Z',
          spanMs: 300000,
          reason: null,
          warnings: [],
        },
        w15: {
          key: 'w15',
          minutes: 15,
          status: 'complete',
          targetSampledAt: '2026-09-28T02:00:00.000Z',
          startSampledAt: '2026-09-28T02:00:00.000Z',
          spanMs: 900000,
          reason: null,
          warnings: [],
        },
      },
    });
    const facts = sectorDetailFacts(ranking.rows[0], ranking);
    expect(facts.find((fact) => fact.label === '成分增量 / 全市场增量')?.value).toBe('400 / 600');
    const notes = sectorDetailNotes(ranking.rows[0], ranking);
    expect(notes.some((note) => note.includes('不可加总'))).toBe(true);
    expect(notes.some((note) => note.includes('缺批次'))).toBe(true);
    expect(new Set(notes).size).toBe(notes.length);
  });

  it('空态与页头文案区分批次 / 目录 / 成分三类缺失', () => {
    const empty = { state: 'empty', emptyReason: 'no_sector_catalog', anchor: null };
    expect(sectorEmptyText(empty)).toContain('目录尚未同步');
    expect(sectorEmptyText({ state: 'empty', emptyReason: 'no_batch', anchor: null })).toBe(
      '尚无已发布的盘中批次',
    );
    expect(sectorEmptyText(sectorRanking())).toBeNull();
    expect(sectorMetaText(sectorRanking())).toBe(
      '行业 · 交易日 2026-09-28 · 数据时点 10:15 · 按日涨幅排序 · 占比窗口 15 分钟',
    );
    expect(
      sectorMetaText(
        sectorRanking({ state: 'empty', emptyReason: 'non_trading_day', anchor: null }),
      ),
    ).toContain('非交易日');
    expect(sectorMetaText(null)).toContain('刷新失败');
  });
});
