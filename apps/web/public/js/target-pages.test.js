/* apps/web/public/js/target-pages.test.js —— Strategy / Watchlist / AlertPlan 页纯函数测试。
 * 覆盖 renderAlerts 触发时间行、run_strategy 命中抽取、Watchlist 总览视图派生与来源健康摘要；
 * DOM 渲染与交互由浏览器验收覆盖，不在此处断言。 */

import { describe, expect, it } from 'bun:test';

import {
  deriveWatchlistViews,
  extractRunHits,
  summarizeMemberSources,
  triggerMetaText,
} from './target-pages.js';

describe('触发条目时间行', () => {
  it('读取 WatchTriggerSchema 的 createdAt 字段', () => {
    const text = triggerMetaText({
      alertPlanId: 'plan-1',
      createdAt: '2026-07-29T08:00:00.000Z',
    });
    expect(text.startsWith('plan-1 · 数据 ')).toBe(true);
    // triggeredAt 早已不存在；误读会得到 Invalid Date
    expect(text.includes('Invalid Date')).toBe(false);
  });
});

describe('extractRunHits', () => {
  it('同股取最高分并按分数降序', () => {
    const hits = extractRunHits([
      { stockId: '600519.SH', score: '55', direction: 'bullish' },
      { stockId: '000001.SZ', score: '80', direction: 'bearish' },
      { stockId: '600519.SH', score: '72', direction: 'bullish' },
    ]);
    expect(hits).toEqual([
      { stockId: '000001.SZ', score: 80, direction: 'bearish' },
      { stockId: '600519.SH', score: 72, direction: 'bullish' },
    ]);
  });

  it('空输入返回空数组', () => {
    expect(extractRunHits(undefined)).toEqual([]);
    expect(extractRunHits([])).toEqual([]);
  });
});

const overviewFixture = {
  lists: [
    {
      watchlist: { id: 'wl-a', name: '研究候选', kind: 'personal', enabled: true },
      memberCount: 2,
      sourceHealth: { active: 2, stale: 1 },
      todayEntered: 1,
      todayExited: 0,
    },
  ],
  stocks: [
    {
      stockId: '600519.SH',
      memberships: [
        {
          watchlistId: 'wl-a',
          watchlistName: '研究候选',
          priority: 'normal',
          holding: true,
        },
      ],
    },
    {
      stockId: '002594.SZ',
      memberships: [
        {
          watchlistId: 'wl-a',
          watchlistName: '研究候选',
          priority: 'important',
          holding: false,
        },
      ],
    },
  ],
  todayChanges: [
    {
      watchlistId: 'wl-a',
      watchlistName: '研究候选',
      stockId: '600519.SH',
      direction: 'entered',
      reason: '策略入选',
      at: '2026-07-31T01:00:00.000Z',
    },
    {
      watchlistId: 'wl-a',
      watchlistName: '研究候选',
      stockId: '000001.SZ',
      direction: 'exited',
      reason: '跌出候选',
      at: '2026-07-31T02:00:00.000Z',
    },
  ],
  triggers: { urgentImportantCount: 2, latestByStock: {} },
};

describe('deriveWatchlistViews', () => {
  it('listCards 提取列表卡片字段并兜底缺省计数', () => {
    const views = deriveWatchlistViews(overviewFixture);
    expect(views.listCards).toEqual([
      {
        watchlist: overviewFixture.lists[0]?.watchlist,
        memberCount: 2,
        staleSources: 1,
        todayEntered: 1,
        todayExited: 0,
      },
    ]);
    expect(deriveWatchlistViews({ lists: [{ watchlist: { id: 'x' } }] }).listCards).toEqual([
      {
        watchlist: { id: 'x' },
        memberCount: 0,
        staleSources: 0,
        todayEntered: 0,
        todayExited: 0,
      },
    ]);
  });

  it('stocks 按 stockId 排序；todayChanges 按时间倒序', () => {
    const views = deriveWatchlistViews(overviewFixture);
    expect(views.stocks.map((stock) => stock.stockId)).toEqual(['002594.SZ', '600519.SH']);
    expect(views.todayChanges.map((change) => change.stockId)).toEqual(['000001.SZ', '600519.SH']);
  });

  it('holdings 只收有持仓来源的股票', () => {
    const views = deriveWatchlistViews(overviewFixture);
    expect(views.holdings.map((stock) => stock.stockId)).toEqual(['600519.SH']);
  });

  it('空 overview 全视图兜底为空', () => {
    expect(deriveWatchlistViews(undefined)).toEqual({
      listCards: [],
      stocks: [],
      todayChanges: [],
      holdings: [],
    });
  });
});

describe('summarizeMemberSources', () => {
  it('统计 active/stale 并取最大 dataAsOf', () => {
    const summary = summarizeMemberSources([
      { status: 'active', dataAsOf: '2026-07-30T08:00:00.000Z' },
      { status: 'stale', dataAsOf: '2026-07-31T08:00:00.000Z' },
      { status: 'ended' },
      { status: 'active', dataAsOf: '2026-07-29T08:00:00.000Z' },
    ]);
    expect(summary.active).toBe(2);
    expect(summary.stale).toBe(1);
    expect(summary.latestDataAsOf?.toISOString()).toBe('2026-07-31T08:00:00.000Z');
  });

  it('无来源 / 无有效时间时 latestDataAsOf 为 null', () => {
    expect(summarizeMemberSources(undefined)).toEqual({
      active: 0,
      stale: 0,
      latestDataAsOf: null,
    });
    expect(summarizeMemberSources([{ status: 'active', dataAsOf: 'not-a-date' }])).toEqual({
      active: 1,
      stale: 0,
      latestDataAsOf: null,
    });
  });
});
