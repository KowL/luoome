/* apps/web/public/js/target-pages.test.js —— Watchlist / AlertPlan 页纯函数测试。
 * 覆盖 renderAlerts 触发时间行、Watchlist 视图派生、列表股票过滤与来源健康摘要；
 * DOM 渲染与交互由浏览器验收覆盖，不在此处断言。 */

import { describe, expect, it } from 'bun:test';

import {
  appendMemberStock,
  buildAlertPlanMutationInput,
  deriveWatchlistViews,
  parseMemberStockIds,
  sortStocksByQuote,
  stocksOfList,
  summarizeMemberSources,
  triggerMetaText,
} from './target-pages.js';

describe('批量成员输入', () => {
  it('支持中英文分隔符、换行、去重和大写规范化', () => {
    expect(parseMemberStockIds('600519.sh, 002594.SZ\n600519.SH；300750.sz')).toEqual([
      '600519.SH',
      '002594.SZ',
      '300750.SZ',
    ]);
  });

  it('搜索选择会去重，并跳过已在分组中的股票', () => {
    const first = { id: '600519.SH', code: '600519', name: '贵州茅台' };
    const second = { id: '002594.SZ', code: '002594', name: '比亚迪' };
    expect(appendMemberStock([], first, ['600519.SH'])).toEqual([]);
    expect(appendMemberStock([first], first)).toEqual([first]);
    expect(appendMemberStock([first], second)).toEqual([first, second]);
  });
});

describe('预警表单', () => {
  it('解析完整配置而不是生成固定价格阈值', () => {
    expect(
      buildAlertPlanMutationInput({
        name: '重要价位',
        watchlistId: 'watch-a',
        rulesJson: '[{"id":"level","kind":"price-level","level":88,"side":"above"}]',
        logic: 'ALL',
        triggerMode: 'daily-first',
        priority: 'important',
        cooldownMinutes: '15',
        dailyNotificationLimit: '5',
        notifyOnRecovery: 'true',
        enabled: 'true',
      }),
    ).toMatchObject({
      name: '重要价位',
      watchlistId: 'watch-a',
      rules: [{ id: 'level', kind: 'price-level', level: 88, side: 'above' }],
      logic: 'ALL',
      triggerMode: 'daily-first',
      priority: 'important',
      cooldownMinutes: 15,
      dailyNotificationLimit: 5,
      notifyOnRecovery: true,
      enabled: true,
    });
  });

  it('拒绝空规则和非法通知上限', () => {
    const base = {
      name: '预警',
      watchlistId: 'watch-a',
      rulesJson: '[]',
      logic: 'ANY',
      triggerMode: 'on-enter',
      priority: '',
      cooldownMinutes: '30',
      dailyNotificationLimit: '20',
      notifyOnRecovery: 'false',
      enabled: 'true',
    };
    expect(() => buildAlertPlanMutationInput(base)).toThrow('至少配置一条规则');
    expect(() =>
      buildAlertPlanMutationInput({ ...base, rulesJson: '[{}]', dailyNotificationLimit: '0' }),
    ).toThrow('每日通知上限');
  });

  it('编辑时可显式清除默认优先级', () => {
    const input = buildAlertPlanMutationInput(
      {
        name: '预警',
        watchlistId: 'watch-a',
        rulesJson: '[{"id":"level","kind":"price-level","level":88,"side":"above"}]',
        logic: 'ANY',
        triggerMode: 'on-enter',
        priority: '',
        cooldownMinutes: '30',
        dailyNotificationLimit: '20',
        notifyOnRecovery: 'false',
        enabled: 'true',
      },
      { editing: true },
    );

    expect(input).toHaveProperty('priority', null);
  });
});

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

const overviewFixture = {
  lists: [
    {
      watchlist: { id: 'wl-a', name: '研究候选', kind: 'personal', enabled: true },
      memberCount: 2,
      discoveredCount: 1,
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
          stage: 'watching',
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
          stage: 'discovered',
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
  archived: {
    lists: [{ id: 'wl-old', name: '旧列表', kind: 'personal', enabled: false }],
    members: [
      {
        watchlistId: 'wl-a',
        watchlistName: '研究候选',
        member: { stockId: '601398.SH', stage: 'archived', archivedAt: '2026-07-30T08:00:00.000Z' },
      },
    ],
  },
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

  it('archived 透传已归档列表与成员；空 overview 全视图兜底为空', () => {
    const views = deriveWatchlistViews(overviewFixture);
    expect(views.archived.lists).toHaveLength(1);
    expect(views.archived.members[0]?.member.stockId).toBe('601398.SH');
    expect(deriveWatchlistViews(undefined)).toEqual({
      listCards: [],
      stocks: [],
      todayChanges: [],
      archived: { lists: [], members: [] },
    });
  });
});

describe('stocksOfList', () => {
  const stocks = [
    { stockId: '600519.SH', memberships: [{ watchlistId: 'wl-a' }, { watchlistId: 'wl-b' }] },
    { stockId: '002594.SZ', memberships: [{ watchlistId: 'wl-b' }] },
    { stockId: '000001.SZ', memberships: [] },
  ];

  it('只保留 memberships 含目标列表的股票；无匹配返回空', () => {
    expect(stocksOfList(stocks, 'wl-a').map((s) => s.stockId)).toEqual(['600519.SH']);
    expect(stocksOfList(stocks, 'wl-b').map((s) => s.stockId)).toEqual(['600519.SH', '002594.SZ']);
    expect(stocksOfList(stocks, 'wl-none')).toEqual([]);
    expect(stocksOfList(undefined, 'wl-a')).toEqual([]);
  });
});

describe('sortStocksByQuote', () => {
  it('按 |changePct| 降序，无行情排最后；不改原数组', () => {
    const stocks = [
      { stockId: 'a', changePct: 1.2 },
      { stockId: 'b', changePct: null },
      { stockId: 'c', changePct: -5.4 },
      { stockId: 'd' },
      { stockId: 'e', changePct: 3.1 },
    ];
    const sorted = sortStocksByQuote(stocks);
    expect(sorted.map((s) => s.stockId)).toEqual(['c', 'e', 'a', 'b', 'd']);
    expect(stocks.map((s) => s.stockId)).toEqual(['a', 'b', 'c', 'd', 'e']);
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
