/* apps/web/public/js/stock-brief.test.js —— 每日个股观察前端展示与刷新反馈。
 *
 * 覆盖：信号 chip / 规则观察标记、个股详情卡的结论·证据·时间·来源·缺口·免责渲染、
 * 首页覆盖计数与排序规则、403/429/跳过提示、手动刷新冷却，以及四个入口的接线断言。
 * DOM 渲染用假 DOM（不引入 jsdom），只断言渲染出的文本与结构。
 */

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';

import {
  briefCellNode,
  briefChipModel,
  briefConfidenceBand,
  briefConfidenceText,
  briefDateKey,
  briefEvidenceRows,
  briefGenerateFeedback,
  briefValidUntilText,
  manualRefreshAllowed,
  manualRefreshRecord,
  stockBriefCardNode,
  todayBriefModel,
  todayBriefNodes,
} from './stock-brief.js';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

const DISCLAIMER = '本内容仅技术研究，不构成投资建议；投资有风险，决策需自行承担。';

const viewFixture = (overrides = {}) => ({
  stockId: '002594.SZ',
  stockName: '比亚迪',
  date: '2026-11-24',
  phase: 'post-market',
  quality: 'partial',
  decision: 'buy',
  confidence: 64,
  horizon: 'short',
  dataAsOf: '2026-11-24T09:30:00Z',
  validUntil: '2026-11-30T09:00:00Z',
  wording: {
    label: '偏多信号',
    detail: '偏多条件成立；研究区间与量能条件由用户自行判断，价格字段均为研究参考位。',
    disclaimer: DISCLAIMER,
    isRuleOnly: false,
  },
  disclaimer: DISCLAIMER,
  isRuleOnly: false,
  premise: '均线多头排列且量能温和放大',
  counterEvidence: ['跌破风险位则偏多条件失效'],
  risks: ['短期涨幅偏大，回撤风险上升'],
  evidence: [
    {
      label: '行情收盘价',
      value: '42.1',
      source: 'eastmoney',
      dataAsOf: '2026-11-24T07:00:00Z',
      missing: false,
      reason: null,
    },
    {
      label: '分时（缺失）',
      value: null,
      source: 'local/missing',
      dataAsOf: null,
      missing: true,
      reason: '分时拉取失败：timeout',
    },
  ],
  missing: [{ dimension: 'intraday', reason: '分时拉取失败：timeout' }],
  warnings: ['部分数据维度不可用：intraday'],
  ...overrides,
});

const ruleOnlyFixture = () =>
  viewFixture({
    quality: 'rule-only',
    decision: 'watch',
    confidence: 30,
    premise: undefined,
    counterEvidence: [],
    risks: [],
    wording: {
      label: '规则观察（低置信）',
      detail: 'AI 分析不可用，仅展示确定性规则结果；置信度低，只作记录。',
      disclaimer: DISCLAIMER,
      isRuleOnly: true,
    },
    isRuleOnly: true,
    warnings: ['本条为规则观察（低置信），不是 AI 结论。'],
  });

/* ---- 假 DOM ---- */

class FakeNode {
  constructor(tagName) {
    this.tagName = tagName;
    this.children = [];
    this.attributes = {};
    this.dataset = {};
    this.className = '';
    this.textContent = '';
    this.href = '';
    this.title = '';
  }

  append(...nodes) {
    this.children.push(...nodes);
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }
}

const withFakeDom = (run) => {
  const previous = {
    document: globalThis.document,
    Node: globalThis.Node,
    window: globalThis.window,
  };
  globalThis.Node = FakeNode;
  globalThis.document = {
    createElement: (tagName) => new FakeNode(tagName),
    createTextNode: (text) => ({ textContent: text }),
  };
  globalThis.window = { location: { hash: '' } };
  try {
    return run();
  } finally {
    globalThis.document = previous.document;
    globalThis.Node = previous.Node;
    globalThis.window = previous.window;
  }
};

const textOf = (node) => {
  if (node === null || node === undefined) return '';
  if (Array.isArray(node)) return node.map(textOf).join(' ');
  const own = typeof node.textContent === 'string' ? node.textContent : '';
  const children = Array.isArray(node.children) ? node.children : [];
  return own + children.map(textOf).join(' ');
};

const classNamesOf = (node) => {
  const names = [];
  const walk = (current) => {
    if (typeof current?.className === 'string' && current.className.length > 0) {
      names.push(current.className);
    }
    for (const child of current?.children ?? []) walk(child);
  };
  walk(node);
  return names;
};

/* ---- 信号 chip 与规则观察标记 ---- */

describe('信号 chip', () => {
  it('decision 文案与 confidence 区间、数据时间来自后端投影', () => {
    const model = briefChipModel(viewFixture());
    expect(model.label).toBe('偏多信号');
    expect(model.empty).toBe(false);
    expect(model.confidence).toBe(64);
    expect(model.confidenceText).toBe('信心度 64（中）');
    expect(model.timeText).toContain('2026-11-24');
    expect(model.missingCount).toBe(1);
    expect(model.className).toBe('badge-buy');
  });

  it('规则观察必须带「规则观察（低置信）」标记，不冒充 AI 结论', () => {
    const model = briefChipModel(ruleOnlyFixture());
    expect(model.label).toBe('规则观察（低置信）');
    expect(model.isRuleOnly).toBe(true);
    expect(model.className).toBe('badge-warn');
  });

  it('没有记录时显示「暂无观察」，不给结论', () => {
    const model = briefChipModel(null);
    expect(model.label).toBe('暂无观察');
    expect(model.empty).toBe(true);
    expect(model.confidence).toBeNull();
    expect(model.confidenceText).toBe('信心度缺失');
  });

  it('confidence 区间按 <50 低 / 50–69 中 / ≥70 较高，缺失不猜', () => {
    expect(briefConfidenceBand(49)).toBe('低');
    expect(briefConfidenceBand(69)).toBe('中');
    expect(briefConfidenceBand(70)).toBe('较高');
    expect(briefConfidenceBand(undefined)).toBeNull();
    expect(briefConfidenceText(70)).toBe('信心度 70（较高）');
    expect(briefValidUntilText('2026-11-30T09:00:00Z')).toContain('2026-11-30');
    expect(briefValidUntilText(null)).toBe('有效期至 未知');
  });
});

/* ---- 个股详情卡（P2-2） ---- */

describe('个股详情卡渲染', () => {
  it('结论 / 信心度 / 周期 / 有效期 / premise / 证据 / 来源 / 时间 / 缺口 / 免责都在渲染输出里', () => {
    withFakeDom(() => {
      const node = stockBriefCardNode(viewFixture());
      const text = textOf(node);
      expect(text).toContain('偏多信号');
      expect(text).toContain('信心度 64（中）');
      expect(text).toContain('周期 短期');
      expect(text).toContain('2026-11-24 17:30');
      expect(text).toContain('有效期至 2026-11-30 17:00');
      expect(text).toContain('核心论点：');
      expect(text).toContain('均线多头排列且量能温和放大');
      expect(text).toContain('42.1');
      expect(text).toContain('eastmoney');
      expect(text).toContain('证据');
      expect(text).toContain('反证');
      expect(text).toContain('跌破风险位则偏多条件失效');
      expect(text).toContain('风险');
      expect(text).toContain('短期涨幅偏大，回撤风险上升');
      expect(text).toContain('分时：分时拉取失败：timeout');
      expect(text).toContain('confidence 是主观信心度，不是收益概率。');
      expect(text).toContain('不构成投资建议');
      expect(classNamesOf(node)).toContain('stock-brief-disclaimer');
    });
  });

  it('规则观察卡标注低置信并保留免责声明', () => {
    withFakeDom(() => {
      const text = textOf(stockBriefCardNode(ruleOnlyFixture()));
      expect(text).toContain('规则观察（低置信）');
      expect(text).toContain('不构成投资建议');
      expect(text).not.toContain('核心论点：');
    });
  });

  it('没有记录时显示「暂无观察」+ 免责，不编造证据或结论', () => {
    withFakeDom(() => {
      const view = {
        stockId: '600519.SH',
        dataAsOf: null,
        validUntil: null,
        wording: {
          label: '暂无观察',
          detail: '当前没有该标的的观察记录。',
          disclaimer: DISCLAIMER,
          isRuleOnly: false,
        },
        disclaimer: DISCLAIMER,
        isRuleOnly: false,
        evidence: [],
        missing: [],
        counterEvidence: [],
        risks: [],
        warnings: ['当日未生成该标的的观察记录；本工具不会触发生成。'],
      };
      const text = textOf(stockBriefCardNode(view));
      expect(text).toContain('暂无观察');
      expect(text).toContain('当前没有该标的的观察记录。');
      expect(text).toContain('不构成投资建议');
      expect(text).not.toContain('信心度');
      expect(text).not.toContain('证据');
    });
  });

  it('关注列表行内单元包含 chip / 信心度 / 更新时间 / 可展开缺失原因', () => {
    withFakeDom(() => {
      const node = briefCellNode(viewFixture(), { href: '#market?stockId=002594.SZ' });
      const text = textOf(node);
      expect(text).toContain('偏多信号');
      expect(text).toContain('信心度 64（中）');
      expect(text).toContain('缺失 1 项');
      expect(text).toContain('分时：分时拉取失败：timeout');
      expect(classNamesOf(node)).toContain('stock-brief-missing');
    });
  });

  it('证据行保留缺失原因，不把空缺值当 0', () => {
    const rows = briefEvidenceRows(viewFixture());
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ value: '42.1', source: 'eastmoney', missing: false });
    expect(rows[1]).toMatchObject({ value: '缺失', missing: true });
  });
});

/* ---- 首页区块（P2-4） ---- */

const todayFixture = () => ({
  date: '2026-11-24',
  items: [
    {
      ...viewFixture(),
      stockId: '002594.SZ',
      stockName: '比亚迪',
      quality: 'ai',
      confidence: 72,
    },
    {
      ...viewFixture(),
      stockId: '600519.SH',
      stockName: '贵州茅台',
      quality: 'partial',
      confidence: 55,
      missing: [],
    },
    {
      ...ruleOnlyFixture(),
      stockId: '300750.SZ',
      stockName: '宁德时代',
      confidence: 30,
    },
    {
      ...ruleOnlyFixture(),
      stockId: '601318.SH',
      stockName: '中国平安',
      quality: 'unavailable',
      decision: 'hold',
      confidence: 0,
      isRuleOnly: false,
      wording: {
        label: '暂无观察',
        detail: '数据不可用，未形成观察结论。',
        disclaimer: DISCLAIMER,
        isRuleOnly: false,
      },
      missing: [{ dimension: 'quote', reason: '行情源不可用' }],
    },
  ],
  coverage: { date: '2026-11-24' },
  budget: {
    date: '2026-11-24',
    httpCalls: 3,
    tokens: 12000,
    costUsd: 0,
    limit: { maxBriefs: 8, maxHttpCalls: 16, maxTokens: 90000 },
  },
});

describe('首页今日观察', () => {
  it('Top 5 按 confidence 降序，规则观察可上榜但带规则标记，未覆盖不入榜', () => {
    const model = todayBriefModel(todayFixture());
    expect(model.top.map((row) => row.stockId)).toEqual(['002594.SZ', '600519.SH', '300750.SZ']);
    expect(model.top[2].isRuleOnly).toBe(true);
    expect(model.top[2].label).toBe('规则观察（低置信）');
    expect(model.top[0].isRuleOnly).toBe(false);
  });

  it('有结论 / 规则观察 / 未覆盖计数与列表行数一致', () => {
    const model = todayBriefModel(todayFixture());
    expect(model.counts).toEqual({ concluded: 2, ruleOnly: 1, uncovered: 1 });
    expect(model.counts.concluded + model.counts.ruleOnly + model.counts.uncovered).toBe(
      model.total,
    );
    expect(model.top).toHaveLength(3);
  });

  it('未覆盖原因汇总来自 missing 与插件降级', () => {
    const model = todayBriefModel({
      ...todayFixture(),
      degradation: {
        reason: 'plugin_disabled',
        message: '个股分析插件未启用（plugins.json）。',
      },
    });
    expect(model.missingReasons).toContain('分时：分时拉取失败：timeout');
    expect(model.missingReasons).toContain('行情报价：行情源不可用');
    expect(model.degradation.reason).toBe('plugin_disabled');
  });

  it('渲染出计数、Top 行与免责声明', () => {
    withFakeDom(() => {
      const text = textOf(todayBriefNodes(todayFixture()));
      expect(text).toContain('有结论 2');
      expect(text).toContain('规则观察 1');
      expect(text).toContain('未覆盖 1');
      expect(text).toContain('比亚迪');
      expect(text).toContain('规则观察（低置信）');
      expect(text).toContain('今日 AI 用量 3/16 次');
      expect(text).toContain('不构成投资建议');
    });
  });
});

/* ---- 刷新反馈与冷却（P2-2 / P2-3） ---- */

describe('生成结果提示', () => {
  it('未开 write / external（403）给出开启提示，不静默失败', () => {
    const feedback = briefGenerateFeedback({
      ok: false,
      error: { kind: 'permission_denied', required: 'write' },
    });
    expect(feedback.tone).toBe('error');
    expect(feedback.message).toContain('未开启生成能力');
    expect(feedback.message).toContain('LUOOME_EXPOSE_WRITE');
  });

  it('429 预算耗尽提示额度已用完 + 预算信息 + 规则观察仍可用', () => {
    const feedback = briefGenerateFeedback({
      ok: true,
      data: {
        items: [{ stockId: '002594.SZ', action: 'budget-stopped' }],
        budget: {
          date: '2026-11-24',
          httpCalls: 16,
          tokens: 90000,
          costUsd: 0,
          limit: { maxBriefs: 8, maxHttpCalls: 16, maxTokens: 90000 },
        },
        degradation: { reason: 'rate_limited', message: '达到当日预算上限' },
      },
    });
    expect(feedback.tone).toBe('warn');
    expect(feedback.message).toContain('今日 AI 分析额度已用完，规则观察仍可用');
    expect(feedback.message).toContain('16/16 次');
  });

  it('全部跳过时提示今日已刷新且未重复调用 AI', () => {
    const feedback = briefGenerateFeedback({
      ok: true,
      data: {
        items: [
          { stockId: '002594.SZ', action: 'skip' },
          { stockId: '600519.SH', action: 'skip' },
        ],
        summary: {},
      },
    });
    expect(feedback.tone).toBe('ok');
    expect(feedback.message).toContain('今日已刷新');
    expect(feedback.message).toContain('未重复调用 AI');
    expect(feedback.message).toContain('跳过 2 只');
  });

  it('成功时区分 AI 结论 / 规则观察 / 不可用', () => {
    const feedback = briefGenerateFeedback({
      ok: true,
      data: {
        items: [
          { stockId: '002594.SZ', action: 'llm' },
          { stockId: '600519.SH', action: 'rule-only' },
          { stockId: '300750.SZ', action: 'unavailable' },
        ],
      },
    });
    expect(feedback.message).toContain('已更新 3 只');
    expect(feedback.message).toContain('AI 结论 1');
    expect(feedback.message).toContain('规则观察 1');
    expect(feedback.message).toContain('不可用 1');
  });

  it('冷却按每票 / 每列表每日 1 次', () => {
    const record = manualRefreshRecord('2026-11-24', new Date('2026-11-24T09:30:00Z'));
    expect(record.date).toBe('2026-11-24');
    expect(manualRefreshAllowed(record, '2026-11-24')).toBe(false);
    expect(manualRefreshAllowed(record, '2026-11-25')).toBe(true);
    expect(manualRefreshAllowed(null, '2026-11-24')).toBe(true);
    expect(briefDateKey(new Date('2026-11-24T16:30:00Z'))).toBe('2026-11-25');
  });
});

/* ---- 入口接线 ---- */

describe('入口接线', () => {
  it('个股页有今日观察卡与刷新按钮，读 detail、写走唯一生成入口', () => {
    const html = read('../index.html');
    const market = read('./market.js');
    expect(html).toContain('id="market-brief-card"');
    expect(html).toContain('id="market-brief-refresh"');
    expect(market).toContain('/api/stock-briefs?stockId=');
    expect(market).toContain("'/api/stock-briefs/generate'");
    expect(market).toContain("scope: 'stock'");
    expect(market).toContain('stockBriefCardNode');
  });

  it('首页只读 /api/stock-briefs/today，源码里没有 generate 调用', () => {
    const html = read('../index.html');
    const pages = read('./pages.js');
    expect(html).toContain('id="dashboard-brief-card"');
    const briefAt = html.indexOf('id="dashboard-brief-card"');
    const workspaceAt = html.indexOf('id="investment-workspace"');
    const boardAt = html.indexOf('id="dashboard-board-card"');
    expect(briefAt).toBeGreaterThan(workspaceAt);
    expect(briefAt).toBeLessThan(boardAt);
    expect(pages).toContain("'/api/stock-briefs/today'");
    expect(pages).not.toContain('stock-briefs/generate');
  });

  it('关注列表按 watchlistId 取观察，只有整列表批量刷新，没有逐票生成', () => {
    const targetPages = read('./target-pages.js');
    expect(targetPages).toContain('/api/stock-briefs?watchlistId=');
    expect(targetPages).toContain('整列表刷新观察');
    expect(targetPages.match(/stock-briefs\/generate/g)).toHaveLength(1);
    expect(targetPages).toContain('stockIds: stocks.map((stock) => stock.stockId)');
    expect(targetPages).not.toContain('添加观察');
  });

  it('作战室一次批量 stockIds，且没有生成入口', () => {
    const room = read('./market-room.js');
    expect(room).toContain("stockIds.join(',')");
    expect(room).not.toContain('stock-briefs/generate');
    expect(read('./market-room-sector-detail.js')).toContain('今日观察');
    expect(read('./market-room-roles.js')).toContain('briefCellNode');
  });
});
