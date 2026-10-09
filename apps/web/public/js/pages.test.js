import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import {
  boardStats,
  boardTriggerSummary,
  calibrationPnlText,
  calibrationRateText,
  dashboardBoardQuery,
  dashboardClosingReportNode,
  decisionLoopAttributionRate,
  errorKindLabel,
  filterAdvices,
  outcomeInputOf,
  quoteState,
  readDashboardView,
  reportDeliveryLabel,
  reportEntityHref,
  reportReviewRefreshButton,
  reportSheetNodes,
  routeAdviceId,
  routeReportId,
  routeStockId,
  sortBoardItems,
  watchRunSummaryText,
} from './pages.js';
import { adviceSubjectModel, fmtDateTime } from './ui.js';

const quote = (overrides = {}) => ({
  freshness: 'fresh',
  retrieval: 'remote',
  observedAt: '2026-02-06T06:30:12Z',
  ...overrides,
});

describe('看板单股预警覆盖口径', () => {
  const trigger = { count: 3, maxPriority: 'important' };
  it('完整覆盖显示准确次数和今日最高优先级', () => {
    const result = boardTriggerSummary(trigger, { available: true, total: 10, sampled: 10 });
    expect(result.label).toBe('3 次');
    expect(result.priority).toBe('今日最高：重要');
  });
  it('列表截断不影响完整统计', () => {
    const result = boardTriggerSummary(trigger, { available: true, total: 300, sampled: 200 });
    expect(result.label).toBe('3 次');
    expect(result.priority).toBe('今日最高：重要');
    expect(boardTriggerSummary(null, { available: true, total: 300, sampled: 200 }).label).toBe(
      '暂无',
    );
  });
  it('读取失败和成功空结果明确区分', () => {
    expect(boardTriggerSummary(null, { available: false, total: null, sampled: 0 }).label).toBe(
      '未知',
    );
    expect(boardTriggerSummary(null, { available: true, total: 0, sampled: 0 }).label).toBe('暂无');
  });
});

describe('看板偏好持久化边界', () => {
  const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  afterEach(() => {
    if (originalStorage === undefined) delete globalThis.localStorage;
    else Object.defineProperty(globalThis, 'localStorage', originalStorage);
  });
  const storage = (getItem) =>
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem } });
  const defaults = {
    scope: 'all',
    watchlistId: '',
    page: 1,
    pageSize: 10,
    sortKey: null,
    sortOrder: 'desc',
  };
  it('不同账户读取各自的范围、页码和排序', () => {
    storage((key) =>
      key === 'luoome.dashboardView:a'
        ? JSON.stringify({
            scope: 'watching',
            watchlistId: 'growth',
            page: 3,
            pageSize: 20,
            sortKey: 'changePct',
            sortOrder: 'asc',
          })
        : null,
    );
    expect(readDashboardView('a')).toEqual({
      scope: 'watching',
      watchlistId: 'growth',
      page: 3,
      pageSize: 20,
      sortKey: 'changePct',
      sortOrder: 'asc',
    });
    expect(readDashboardView('b')).toEqual(defaults);
  });
  it.each([
    'broken json',
    'null',
    '[]',
    JSON.stringify({
      scope: 'wrong',
      page: -1,
      pageSize: 999,
      watchlistId: {},
      sortKey: 'wrong',
      sortOrder: 'wrong',
    }),
  ])('无效本地存储恢复默认值 %s', (raw) => {
    storage(() => raw);
    expect(readDashboardView('a')).toEqual(defaults);
  });
  it('浏览器禁用存储时看板仍能初始化', () => {
    storage(() => {
      throw new Error('storage disabled');
    });
    expect(readDashboardView('a')).toEqual(defaults);
  });
});

describe('confidence 校准 unknown 展示', () => {
  it('无 outcome 样本时不用 0 伪装命中率和平均收益', () => {
    expect(calibrationRateText(0, 0)).toBe('--');
    expect(calibrationPnlText(0, 0)).toBe('--');
  });

  it('有 outcome 样本时保留真实的 0', () => {
    expect(calibrationRateText(0, 1)).toBe('0.00%');
    expect(calibrationPnlText(0, 1)).toBe('0.00');
  });
});

describe('盯盘最近一轮摘要', () => {
  it('读取 WatchRunSchema 的 evaluatedPools 字段', () => {
    const latest = {
      evaluatedPools: 3,
      evaluatedStocks: 12,
      triggered: 2,
      notified: 1,
    };
    expect(watchRunSummaryText(latest)).toBe(
      '评估 3 个方案 / 12 只股票 · 触发 2 · 尝试通知 1 · 渠道受理 未记录 · 无法求值 未记录',
    );
  });

  it('正常心跳仍单独呈现渠道受理和无法求值', () => {
    expect(
      watchRunSummaryText({
        evaluatedPools: 1,
        evaluatedStocks: 2,
        triggered: 1,
        notified: 1,
        channelAccepted: 0,
        unknownRules: 2,
      }),
    ).toContain('尝试通知 1 · 渠道受理 0 · 无法求值 2');
  });

  it('尚无运行记录时给占位文案', () => {
    expect(watchRunSummaryText(null)).toBe('跑一轮后显示评估指标');
  });

  it('没有可评估标的时不铺开 5 个 0', () => {
    expect(
      watchRunSummaryText({
        evaluatedPools: 0,
        evaluatedStocks: 0,
        triggered: 0,
        notified: 0,
        channelAccepted: 0,
        unknownRules: 0,
      }),
    ).toBe('最近一轮没有可评估的标的 · 运行心跳已记录');
  });
});

describe('分析错误提示中文化', () => {
  it('已知 kind 映射为中文文案', () => {
    expect(errorKindLabel({ kind: 'llm_error' })).toBe('AI 分析服务异常');
    expect(errorKindLabel({ kind: 'adapter_error' })).toBe('行情或外部服务异常');
    expect(errorKindLabel({ kind: 'not_found' })).toBe('记录不存在');
  });

  it('未知 kind 回退原始值，不查原型链', () => {
    expect(errorKindLabel({ kind: 'weird_kind' })).toBe('weird_kind');
    expect(errorKindLabel({ kind: 'toString' })).toBe('toString');
  });

  it('缺 kind 时给兜底文案', () => {
    expect(errorKindLabel(undefined)).toBe('未知错误');
    expect(errorKindLabel({})).toBe('未知错误');
  });
});

describe('行情关联深链接', () => {
  it('解析并规范化 stockId', () => {
    expect(routeStockId('#research?stockId=002594.sz')).toBe('002594.SZ');
    expect(routeStockId('#holdings')).toBeNull();
    expect(routeStockId('#advice?stockId=%20')).toBeNull();
  });

  it('Advice 同时按 stockId 和 decision 过滤', () => {
    const advices = [
      { subjectId: '002594.SZ', decision: 'buy' },
      { subjectId: '002594.SZ', decision: 'hold' },
      { subjectId: '600519.SH', decision: 'buy' },
    ];
    expect(filterAdvices(advices, 'all', '002594.SZ')).toHaveLength(2);
    expect(filterAdvices(advices, 'buy', '002594.SZ')).toEqual([advices[0]]);
    expect(filterAdvices(advices, 'buy', null)).toEqual([advices[0], advices[2]]);
  });

  it('报告 list 条目：advice 带 id 深链接到建议页，routeAdviceId 解析', () => {
    expect(reportEntityHref({ entityKind: 'advice', entityId: 'adv-1' })).toBe('#advice?id=adv-1');
    expect(reportEntityHref({ entityKind: 'advice', entityId: 'a b' })).toBe('#advice?id=a%20b');
    expect(reportEntityHref({ entityKind: 'stock', entityId: '000001.SZ' })).toBe(
      '#market?stockId=000001.SZ&range=3m',
    );
    expect(reportEntityHref({ entityKind: 'unknown-kind', entityId: 'x' })).toBeNull();
    expect(routeAdviceId('#advice?id=adv-1')).toBe('adv-1');
    expect(routeAdviceId('#advice')).toBeNull();
    expect(routeAdviceId('#advice?id=%20')).toBeNull();
  });
});

describe('Advice outcome 回填契约', () => {
  it('保留 partially_followed 并透传复盘字段', () => {
    expect(
      outcomeInputOf({
        outcome: 'partially_followed',
        pnl: '-12.5',
        benchmarkPnl: '4',
        holdingHours: '6',
        tradeIds: 'trade-1, trade-2',
        notes: '只执行一半',
      }),
    ).toEqual({
      outcome: 'partially_followed',
      pnl: -12.5,
      benchmarkPnl: 4,
      holdingHours: 6,
      tradeIds: ['trade-1', 'trade-2'],
      notes: '只执行一半',
    });
  });

  it('盈亏留空时保持 unknown，不自动写成 0', () => {
    expect(
      outcomeInputOf({
        outcome: 'partially_followed',
        pnl: '',
        benchmarkPnl: '',
        holdingHours: '',
        tradeIds: '',
        notes: '',
      }),
    ).toEqual({ outcome: 'partially_followed' });
  });
});

describe('决策闭环 Trade 归因', () => {
  it('Advice / 研究假设 / 策略版本任一显式 provenance 都计入归因率', () => {
    expect(decisionLoopAttributionRate({ total: 3, unattributed: 1 })).toBeCloseTo(2 / 3);
  });

  it('没有交易样本时保持 unknown，不显示 0%', () => {
    expect(decisionLoopAttributionRate({ total: 0, unattributed: 0 })).toBeNull();
  });
});

describe('看板纯函数', () => {
  it('价格和涨跌幅双向排序均将未知放最后，保留零值且不改变输入', () => {
    const input = [
      { stockId: 'missing', quote: null, changePct: null },
      { stockId: 'low', quote: { close: 10 }, changePct: -2 },
      { stockId: 'high', quote: { close: 30 }, changePct: 3 },
      { stockId: 'middle', quote: { close: 20 }, changePct: 0 },
    ];
    for (const key of ['price', 'changePct']) {
      expect(sortBoardItems(input, { key, order: 'asc' }).map((row) => row.stockId)).toEqual([
        'low',
        'middle',
        'high',
        'missing',
      ]);
      expect(sortBoardItems(input, { key, order: 'desc' }).map((row) => row.stockId)).toEqual([
        'high',
        'middle',
        'low',
        'missing',
      ]);
    }
    expect(input[0].stockId).toBe('missing');
  });

  const item = (stockId, changePct, holding = null) => ({
    stockId,
    name: stockId,
    quote: null,
    changePct,
    holding,
    watchlists: [],
    todayTrigger: null,
  });

  it('持仓置顶（保持原顺序），其余按 |changePct| 降序，null 排最后', () => {
    const input = [
      item('A', 1.5),
      item('H1', -0.2, { quantity: 100 }),
      item('B', null),
      item('H2', 3.0, { quantity: 200 }),
      item('C', -5.0),
      item('D', 0),
    ];
    expect(sortBoardItems(input).map((i) => i.stockId)).toEqual(['H1', 'H2', 'C', 'A', 'D', 'B']);
    // 不改动原数组
    expect(input[0].stockId).toBe('A');
  });

  it('涨 / 跌 / 平 / 未知计数（缺行情不计入平盘）', () => {
    const stats = boardStats([item('A', 1.5), item('B', -2), item('C', 0), item('D', null)]);
    expect(stats).toEqual({ up: 1, down: 1, flat: 1, unknown: 1 });
  });
});

describe('看盘页时间展示去重', () => {
  it('看板正常行情只给状态，不重复行级时间戳', () => {
    expect(quoteState(quote())).toEqual({ label: '已获取', warn: false, at: '' });
  });

  it('旧快照与本地兜底才算降级并补时间；缺时间显式标注', () => {
    const observedAt = '2026-02-06T06:30:12Z';
    const stale = quoteState(quote({ freshness: 'stale' }));
    expect(stale.label).toBe('旧快照');
    expect(stale.warn).toBe(true);
    expect(stale.at).toBe(fmtDateTime(observedAt));
    expect(quoteState(quote({ retrieval: 'local-fallback' })).label).toBe('旧快照');
    expect(quoteState(quote({ freshness: 'stale', observedAt: null })).at).toBe('时间未知');
  });
});

describe('建议卡片标的一行', () => {
  it('持仓建议只在屏上显示名称，不泄露内部 subjectId', () => {
    expect(
      adviceSubjectModel({
        subjectKind: 'position',
        subjectId: 'manual-holding-b637b869-4eb7-4063-88db-80b86efd333',
        stockName: '协创数据',
      }),
    ).toEqual({ label: '协创数据', code: '' });
  });

  it('股票建议保留交易所代码；名称缺失时退回截断代码', () => {
    expect(
      adviceSubjectModel({ subjectKind: 'stock', subjectId: '300857.SZ', stockName: '协创数据' }),
    ).toEqual({ label: '协创数据', code: '300857.SZ' });
    expect(adviceSubjectModel({ subjectKind: 'stock', subjectId: '300857.SZ' })).toEqual({
      label: '300857',
      code: '300857.SZ',
    });
  });

  it('市场 / 板块主题保留可读的 subjectId 作为名称；无名称的持仓不把 id 当代码', () => {
    expect(
      adviceSubjectModel({ subjectKind: 'market', subjectId: 'AI', stockName: undefined }),
    ).toEqual({ label: 'AI', code: '' });
    expect(
      adviceSubjectModel({
        subjectKind: 'position',
        subjectId: 'manual-holding-9f2c',
        stockName: '  ',
      }),
    ).toEqual({ label: 'manual-holding-9f2c', code: '' });
  });
});

describe('看板筛选与分页请求', () => {
  it('范围和关注列表在服务端分页前过滤，编码列表身份', () => {
    const query = new URLSearchParams(
      dashboardBoardQuery({
        scope: 'watching',
        watchlistId: 'growth-watch',
        page: 3,
        pageSize: 20,
      }),
    );
    expect(Object.fromEntries(query)).toEqual({
      scope: 'watching',
      watchlistId: 'growth-watch',
      page: '3',
      pageSize: '20',
    });
  });
  it('全部列表不发送空字符串筛选', () => {
    expect(
      new URLSearchParams(
        dashboardBoardQuery({ scope: 'holdings', watchlistId: '', page: 1, pageSize: 10 }),
      ).has('watchlistId'),
    ).toBe(false);
  });
});

describe('复盘报告阅读层级', () => {
  it('账户报告入口展示日期与渠道状态，不再展示版本标签', () => {
    const originalDocument = globalThis.document;
    const originalNode = globalThis.Node;
    class TestNode {
      constructor(tag = '', text = '') {
        this.tag = tag;
        this.children = [];
        this.text = text;
      }
      append(...children) {
        this.children.push(...children);
      }
      set textContent(value) {
        this.text = value;
      }
      get textContent() {
        return this.text + this.children.map((child) => child.textContent).join('');
      }
    }
    globalThis.Node = TestNode;
    globalThis.document = {
      createElement: (tag) => new TestNode(tag),
      createTextNode: (text) => new TestNode('', text),
    };
    try {
      const card = dashboardClosingReportNode({
        id: 'report-2',
        title: '账户收盘复盘',
        periodEnd: '2026-09-21',
        version: 2,
        status: 'partial',
        deliveryStatus: 'fallback-log',
        generatedAt: '2026-09-21T10:00:00Z',
      });
      expect(card.textContent).toContain('2026-09-21');
      expect(card.textContent).not.toContain('补充 v2');
      expect(card.textContent).not.toContain('主报告 v1');
      expect(card.textContent).toContain('部分数据待补齐');
      expect(card.textContent).toContain('仅写日志');
      expect(card.children[0].children[0].href).toBe('#reports?id=report-2');
      expect(routeReportId('#reports?id=report-2')).toBe('report-2');
      expect(reportDeliveryLabel('sent')).toBe('已提交渠道');
    } finally {
      globalThis.document = originalDocument;
      globalThis.Node = originalNode;
    }
  });

  it('正文保留有效值和零值，空项合并说明，缺口折叠且仍可追溯', () => {
    const originalDocument = globalThis.document;
    const originalNode = globalThis.Node;
    class TestNode {
      constructor(tag = '', text = '') {
        this.tag = tag;
        this.children = [];
        this.text = text;
      }
      append(...children) {
        this.children.push(...children);
      }
      set textContent(value) {
        this.text = value;
      }
      get textContent() {
        return this.text + this.children.map((child) => child.textContent).join('');
      }
    }
    globalThis.Node = TestNode;
    globalThis.document = {
      createElement: (tag) => new TestNode(tag),
      createTextNode: (text) => new TestNode('', text),
    };
    try {
      const gap = {
        dimension: 'market-pulse.breadth',
        reason: '上游样本覆盖不完整',
        retryable: true,
      };
      const nodes = reportSheetNodes({
        title: '收盘复盘',
        kind: 'closing',
        periodStart: '2026-09-21',
        periodEnd: '2026-09-21',
        dataAsOf: '2026-09-21T07:00:00Z',
        generatedAt: '2026-09-21T09:00:00Z',
        evidence: [],
        missingDimensions: [gap],
        sections: [
          {
            key: 'market-pulse',
            title: '市场脉搏',
            status: 'partial',
            missingDimensions: [gap],
            blocks: [
              {
                kind: 'metrics',
                items: [
                  { label: '封板家数', value: 0 },
                  { label: '指数样本', value: null },
                ],
              },
              {
                kind: 'table',
                columns: [
                  { key: 'name', label: '策略' },
                  { key: 'count', label: '信号数' },
                ],
                rows: [{ name: '突破', count: null }],
              },
            ],
          },
        ],
      });
      const section = nodes.find((node) => node.tag === 'section');
      expect(section.textContent).toContain('封板家数0');
      expect(section.textContent).toContain('未展示指标：指数样本');
      expect(section.textContent).toContain('未展示列：信号数');
      expect(section.textContent).not.toMatch(/不可用|market-pulse|上游样本/);
      const notes = nodes.find((node) => node.tag === 'details');
      expect(notes.textContent).toContain('上游样本覆盖不完整');
      expect(notes.textContent.split('上游样本覆盖不完整')).toHaveLength(2);
      expect(notes.open).toBeUndefined();
    } finally {
      globalThis.document = originalDocument;
      globalThis.Node = originalNode;
    }
  });
});

describe('复盘报告补充请求恢复', () => {
  const originals = new Map(
    ['document', 'Node', 'localStorage', 'sessionStorage', 'fetch'].map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  let account;
  let pending;
  let requests;
  let saved;
  let messages;
  beforeEach(() => {
    account = 'account-a';
    pending = new Map();
    requests = [];
    saved = [];
    messages = [];
    class TestNode {
      addEventListener(_name, listener) {
        this.click = listener;
      }
    }
    const values = {
      Node: TestNode,
      document: { createElement: () => new TestNode() },
      localStorage: { getItem: () => account },
      sessionStorage: {
        getItem: (key) => pending.get(key) ?? null,
        setItem: (key, value) => pending.set(key, value),
        removeItem: (key) => pending.delete(key),
      },
      fetch: async (_url, init) => {
        requests.push(init);
        return Response.json({ ok: false, error: { kind: 'internal' } });
      },
    };
    for (const [key, value] of Object.entries(values))
      Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  });
  afterEach(() => {
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  const button = () =>
    reportReviewRefreshButton(
      { id: 'report-original' },
      'account-a',
      { canRefresh: true, latestReportId: 'report-original' },
      (message) => messages.push(message),
      async (id) => saved.push(id),
    );

  it('收盘报告不再提供复盘补充入口', () => {
    expect(
      reportReviewRefreshButton(
        { id: 'closing-report', kind: 'closing' },
        'account-a',
        { canRefresh: true, latestReportId: 'closing-report' },
        () => {},
        async () => {},
      ),
    ).toBeNull();
  });

  it('丢失响应后同一按钮及重新打开均复用原请求', async () => {
    const first = button();
    await first.click();
    await first.click();
    const reopened = button();
    globalThis.fetch = async (_url, init) => {
      requests.push(init);
      return Response.json({ ok: true, data: { report: { id: 'report-next' } } });
    };
    await reopened.click();
    expect(new Set(requests.map((request) => JSON.parse(request.body).requestId)).size).toBe(1);
    expect(
      requests.every((request) => request.headers.get('x-luoome-account-id') === 'account-a'),
    ).toBe(true);
    expect(saved).toEqual(['report-next']);
    expect(pending.size).toBe(0);
  });

  it('首次明确拒绝释放请求并要求读取最新报告', async () => {
    globalThis.fetch = async () => Response.json({ ok: false, error: { kind: 'invalid_input' } });
    const refresh = button();
    await refresh.click();
    expect(pending.size).toBe(0);
    expect(refresh.disabled).toBe(true);
    expect(messages.at(-1)).toContain('重新选择最新报告');
  });

  it('曾有未知结果时，重试拒绝仍保留原请求', async () => {
    const refresh = button();
    await refresh.click();
    const original = [...pending.values()][0];
    globalThis.fetch = async () => Response.json({ ok: false, error: { kind: 'invalid_input' } });
    await refresh.click();
    expect([...pending.values()][0]).toBe(original);
    expect(refresh.disabled).toBe(false);
  });

  it('账户切换与会话存储失败均阻止发出请求', async () => {
    const refresh = button();
    account = 'account-b';
    await refresh.click();
    expect(requests).toHaveLength(0);
    account = 'account-a';
    sessionStorage.setItem = () => {
      throw new Error('disabled');
    };
    await refresh.click();
    expect(requests).toHaveLength(0);
    expect(messages.at(-1)).toContain('无法保存未决请求');
  });

  it('发送期间不会并发重发同一请求', async () => {
    let finish;
    globalThis.fetch = async (_url, init) => {
      requests.push(init);
      return new Promise((resolve) => {
        finish = resolve;
      });
    };
    const refresh = button();
    const sending = refresh.click();
    await refresh.click();
    expect(requests).toHaveLength(1);
    finish(Response.json({ ok: false, error: { kind: 'internal' } }));
    await sending;
  });
});
