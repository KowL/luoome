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
  });

  it('服务端暴露只读总览 API 与 /market/room 页面路由', () => {
    expect(marketRoutes).toContain("app.get('/api/market/room/overview'");
    expect(marketRoutes).toContain("callTool('get_market_room_overview', {})");
    expect(marketRoutes).toContain("app.get('/market/room'");
  });
});
