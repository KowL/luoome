import { afterEach, describe, expect, it } from 'bun:test';

import {
  buildRunDetailContent,
  buildStrategyHash,
  openRunDetail,
  parseStrategyHash,
  renderRuns,
} from './strategy-workspace.js';

/* ============================================================
 * 极简 DOM shim：bun test 无内置 document，仓库也未引入 DOM 库，
 * 这里只实现被测路径需要的 API（createElement / classList /
 * querySelector / append / 事件）。真实浏览器行为由浏览器验收覆盖。
 * ============================================================ */

class FakeNode {
  constructor() {
    this._children = [];
    this.parentNode = null;
  }

  append(...children) {
    for (const child of children) this.appendChild(child);
  }

  appendChild(child) {
    const node = child instanceof FakeNode ? child : new FakeText(String(child));
    node.parentNode = this;
    this._children.push(node);
    return node;
  }

  replaceChildren(...children) {
    this._children = [];
    this.append(...children);
  }

  get textContent() {
    return this._children.map((child) => child.textContent).join('');
  }

  set textContent(value) {
    this._children = [];
    this.appendChild(new FakeText(String(value)));
  }
}

class FakeText extends FakeNode {
  constructor(data) {
    super();
    this.data = String(data);
  }

  get textContent() {
    return this.data;
  }

  set textContent(value) {
    this.data = String(value);
  }
}

class FakeElement extends FakeNode {
  constructor(tag) {
    super();
    this.tagName = String(tag).toUpperCase();
    this._classes = new Set();
    this._listeners = {};
    this._attrs = new Map();
    this.hidden = false;
    this.type = '';
    this.value = '';
    this.disabled = false;
    this.href = '';
    this.id = '';
  }

  get children() {
    return this._children.filter((child) => child instanceof FakeElement);
  }

  set className(value) {
    this._classes = new Set(String(value).split(/\s+/).filter(Boolean));
  }

  get className() {
    return [...this._classes].join(' ');
  }

  get classList() {
    return {
      add: (...names) => {
        for (const name of names) this._classes.add(name);
      },
      remove: (...names) => {
        for (const name of names) this._classes.delete(name);
      },
      contains: (name) => this._classes.has(name),
      toggle: (name, force) => {
        const on = force ?? !this._classes.has(name);
        if (on) this._classes.add(name);
        else this._classes.delete(name);
        return on;
      },
    };
  }

  setAttribute(name, value) {
    this._attrs.set(name, String(value));
  }

  getAttribute(name) {
    return this._attrs.get(name) ?? null;
  }

  addEventListener(type, listener) {
    this._listeners[type] = [...(this._listeners[type] ?? []), listener];
  }

  click() {
    for (const listener of this._listeners.click ?? []) listener.call(this, { target: this });
  }

  dispatch(type, event = {}) {
    for (const listener of this._listeners[type] ?? []) {
      listener.call(this, { target: this, ...event, preventDefault: () => {} });
    }
  }

  querySelectorAll(selector) {
    const matches = [];
    const visit = (node) => {
      for (const child of node._children) {
        if (!(child instanceof FakeElement)) continue;
        if (child.matches(selector)) matches.push(child);
        visit(child);
      }
    };
    visit(this);
    return matches;
  }

  matches(selector) {
    const [tag, ...classes] = selector.split('.');
    if (tag.length > 0 && tag !== this.tagName.toLowerCase()) return false;
    return classes.every((cls) => this._classes.has(cls));
  }
}

class FakeAnchor extends FakeElement {}

const byId = new Map();
globalThis.Node = FakeNode;
globalThis.HTMLAnchorElement = FakeAnchor;
globalThis.document = {
  createElement: (tag) => (tag === 'a' ? new FakeAnchor(tag) : new FakeElement(tag)),
  createTextNode: (data) => new FakeText(data),
  querySelector: (selector) =>
    selector.startsWith('#') ? (byId.get(selector.slice(1)) ?? null) : null,
};

const modalTitle = document.createElement('div');
const modalBody = document.createElement('div');
const modalOverlay = document.createElement('div');
for (const [id, node] of [
  ['modal-title', modalTitle],
  ['modal-body', modalBody],
  ['modal-overlay', modalOverlay],
]) {
  byId.set(id, node);
}

/* ============================================================ */

const jsonResponse = (body) => ({ ok: true, status: 200, json: async () => body });

const detailData = {
  stocks: [
    { stockId: '000001.SZ', stockName: '平安银行', nameStatus: 'resolved' },
    { stockId: '000009.SZ', stockName: '中国宝安', nameStatus: 'resolved' },
    { stockId: '300169.SZ', stockName: '东宝生物', nameStatus: 'resolved' },
    { stockId: '600519.SH', stockName: '贵州茅台', nameStatus: 'resolved' },
    { stockId: '601398.SH', stockName: '工商银行', nameStatus: 'resolved' },
  ],
  results: [
    {
      runId: 'run-1',
      stockId: '000001.SZ',
      selected: true,
      rank: 1,
      score: 92.5,
      ruleEvaluations: [],
      evidence: [],
      dataAsOf: '2026-07-31T15:00:00+08:00',
    },
    {
      runId: 'run-1',
      stockId: '000009.SZ',
      selected: true,
      rank: 2,
      score: 88.1,
      ruleEvaluations: [],
      evidence: [],
      dataAsOf: '2026-07-31T15:00:00+08:00',
    },
    {
      runId: 'run-1',
      stockId: '300169.SZ',
      selected: false,
      rank: 3,
      score: 60.0,
      ruleEvaluations: [],
      evidence: [],
      dataAsOf: '2026-07-31T15:00:00+08:00',
    },
    {
      runId: 'run-1',
      stockId: '600519.SH',
      selected: false,
      rank: 4,
      score: 55.0,
      ruleEvaluations: [],
      evidence: [],
      dataAsOf: '2026-07-31T15:00:00+08:00',
    },
    {
      runId: 'run-1',
      stockId: '601398.SH',
      selected: false,
      rank: 5,
      score: 50.0,
      ruleEvaluations: [],
      evidence: [],
      dataAsOf: '2026-07-31T15:00:00+08:00',
    },
  ],
  signals: [
    {
      id: 'sig-1',
      strategyId: 'breakout-volume',
      stockId: '000001.SZ',
      direction: 'long',
      score: 90,
      evidence: ['放量突破 20 日均线'],
    },
    {
      id: 'sig-2',
      strategyId: 'breakout-volume',
      stockId: '000009.SZ',
      direction: 'long',
      score: 85,
      evidence: ['放量突破 20 日均线'],
    },
  ],
};

const run = {
  id: 'run-1',
  startedAt: '2026-07-31T09:30:00+08:00',
  mode: 'formal',
  strategyVersionId: 'v3',
  status: 'complete',
  summary: {
    schemaVersion: 2,
    universeCount: 5,
    evaluatedCount: 5,
    selectedCount: 2,
    signalCount: 2,
    partialCount: 0,
    failedCount: 0,
  },
};

const flush = async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
};

afterEach(() => {
  modalOverlay.hidden = true;
  globalThis.fetch = undefined;
});

describe('strategy workspace route state', () => {
  it('round-trips durable strategy/tab/run/candidate selection and normalizes invalid values', () => {
    const parsed = parseStrategyHash(
      '#strategies?strategyId=trend-v2&tab=candidates&runId=run-2&compareRunId=run-1&view=ranking-near-miss',
    );
    expect(parsed).toEqual({
      strategyId: 'trend-v2',
      tab: 'candidates',
      runId: 'run-2',
      compareRunId: 'run-1',
      candidateView: 'ranking-near-miss',
    });
    expect(buildStrategyHash(parsed)).toBe(
      '#strategies?strategyId=trend-v2&tab=candidates&runId=run-2&compareRunId=run-1&view=ranking-near-miss',
    );
    expect(parseStrategyHash('#strategies?tab=unknown&view=nope')).toMatchObject({
      strategyId: '',
      tab: 'overview',
      candidateView: 'rule-near-miss',
    });
  });
});

describe('运行记录「查看」弹窗', () => {
  it('点击查看打开弹窗展示运行详情，而非在表格下方内联展开', async () => {
    globalThis.fetch = async (path) => {
      const url = String(path);
      if (url.includes('/api/strategies/breakout-volume/runs')) {
        return jsonResponse({ ok: true, data: { runs: [run] } });
      }
      if (url.includes('/api/strategy-runs/run-1')) {
        return jsonResponse({ ok: true, data: detailData });
      }
      return jsonResponse({ ok: false, error: { kind: 'not_found', message: '无数据' } });
    };
    const section = await renderRuns('breakout-volume');
    // 运行列表不再内联渲染详情区
    expect(section.querySelectorAll('.strategy-run-detail').length).toBe(0);
    const view = section.querySelectorAll('button').find((button) => button.textContent === '查看');
    expect(view).toBeDefined();
    view.click();
    await flush();
    // 弹窗打开并展示详情内容
    expect(modalOverlay.hidden).toBe(false);
    expect(modalBody.textContent).toContain('结果 5 · 信号 2');
    expect(modalBody.textContent).toContain('只看命中（2）');
    expect(modalBody.textContent).toContain('StrategySignal');
  });

  it('openRunDetail 拉取失败时在弹窗内展示错误', async () => {
    globalThis.fetch = async () =>
      jsonResponse({ ok: false, error: { kind: 'not_found', message: 'StrategyRun 不存在' } });
    await openRunDetail('missing-run');
    expect(modalOverlay.hidden).toBe(false);
    expect(modalBody.textContent).toContain('StrategyRun 不存在');
  });
});

describe('运行详情弹窗内容', () => {
  it('默认只渲染命中的结果，切换到全部后渲染全部', () => {
    const node = buildRunDetailContent(detailData);
    const list = node.querySelectorAll('.strategy-run-detail-results')[0];
    expect(list).toBeDefined();
    const itemCount = () => list.querySelectorAll('.strategy-run-result').length;
    // 默认只看命中（2 条）
    expect(itemCount()).toBe(2);
    // 信号区不受结果筛选影响
    expect(node.textContent).toContain('放量突破 20 日均线');
    // 切到全部
    node
      .querySelectorAll('button')
      .find((button) => button.textContent === '全部 5 条')
      .click();
    expect(itemCount()).toBe(5);
    // 切回只看命中
    node
      .querySelectorAll('button')
      .find((button) => button.textContent === '只看命中（2）')
      .click();
    expect(itemCount()).toBe(2);
  });

  it('结果行默认折叠：一行展示股票/rank/score，点击行展开规则详情', () => {
    const node = buildRunDetailContent(detailData);
    const list = node.querySelectorAll('.strategy-run-detail-results')[0];
    const row = list.querySelectorAll('.strategy-run-result')[0];
    // 折叠默认态：无 expanded 类、aria-expanded=false、详情区不显示
    expect(row.classList.contains('expanded')).toBe(false);
    expect(row.getAttribute('aria-expanded')).toBe('false');
    expect(row.getAttribute('role')).toBe('button');
    expect(row.getAttribute('tabindex')).toBe('0');
    // 一行内是 股票（名称+代码）+ rank + score，规则详情不在行首
    const head = row.querySelectorAll('.strategy-run-result-head')[0];
    expect(head.textContent).toContain('平安银行');
    expect(head.textContent).toContain('000001.SZ');
    expect(head.textContent).toContain('rank 1');
    expect(head.textContent).toContain('score 92.50');
    // 点击行展开
    row.click();
    expect(row.classList.contains('expanded')).toBe(true);
    expect(row.getAttribute('aria-expanded')).toBe('true');
    // 再点折叠
    row.click();
    expect(row.classList.contains('expanded')).toBe(false);
  });

  it('点击行内股票链接不触发展开；Enter/Space 可展开', () => {
    const node = buildRunDetailContent(detailData);
    const list = node.querySelectorAll('.strategy-run-detail-results')[0];
    const row = list.querySelectorAll('.strategy-run-result')[0];
    const link = row.querySelectorAll('.stock-identity-link')[0];
    link.click();
    expect(row.classList.contains('expanded')).toBe(false);
    row.dispatch('keydown', { key: 'Enter' });
    expect(row.classList.contains('expanded')).toBe(true);
    row.dispatch('keydown', { key: ' ' });
    expect(row.classList.contains('expanded')).toBe(false);
    row.dispatch('keydown', { key: 'x' });
    expect(row.classList.contains('expanded')).toBe(false);
  });

  it('结果列表分页：翻页 + 切换筛选回到第一页', () => {
    const node = buildRunDetailContent(detailData, { pageSize: 2 });
    const list = node.querySelectorAll('.strategy-run-detail-results')[0];
    const pager = node.querySelectorAll('.strategy-run-pagination')[0];
    const pageInfo = pager.querySelectorAll('span.mono')[0];
    const prev = pager.querySelectorAll('button').find((button) => button.textContent === '上一页');
    const next = pager.querySelectorAll('button').find((button) => button.textContent === '下一页');
    const stockIds = () =>
      list.querySelectorAll('.strategy-run-result').map((row) => row.textContent);
    // 默认命中视图 2 条只有 1 页
    expect(pageInfo.textContent).toBe('第 1 / 1 页 · 共 2 条');
    // 切到全部：第 1 页显示前 2 条
    node
      .querySelectorAll('button')
      .find((button) => button.textContent === '全部 5 条')
      .click();
    expect(list.querySelectorAll('.strategy-run-result').length).toBe(2);
    expect(pageInfo.textContent).toBe('第 1 / 3 页 · 共 5 条');
    expect(stockIds()[0]).toContain('000001.SZ');
    expect(stockIds()[1]).toContain('000009.SZ');
    expect(prev.disabled).toBe(true);
    // 下一页 → 第 2 页
    next.click();
    expect(pageInfo.textContent).toBe('第 2 / 3 页 · 共 5 条');
    expect(stockIds()[0]).toContain('300169.SZ');
    expect(stockIds()[1]).toContain('600519.SH');
    // 再下一页 → 第 3 页（1 条，下一页禁用）
    next.click();
    expect(pageInfo.textContent).toBe('第 3 / 3 页 · 共 5 条');
    expect(stockIds().length).toBe(1);
    expect(stockIds()[0]).toContain('601398.SH');
    expect(next.disabled).toBe(true);
    // 上一页 → 第 2 页
    prev.click();
    expect(pageInfo.textContent).toBe('第 2 / 3 页 · 共 5 条');
    // 在非第一页切换筛选：回到第一页，且按命中筛选
    node
      .querySelectorAll('button')
      .find((button) => button.textContent === '只看命中（2）')
      .click();
    expect(pageInfo.textContent).toBe('第 1 / 1 页 · 共 2 条');
    expect(list.querySelectorAll('.strategy-run-result').length).toBe(2);
    // 切回全部：也从第一页开始
    node
      .querySelectorAll('button')
      .find((button) => button.textContent === '全部 5 条')
      .click();
    expect(pageInfo.textContent).toBe('第 1 / 3 页 · 共 5 条');
    expect(stockIds()[0]).toContain('000001.SZ');
  });

  it('全部未命中时默认显示占位文案', () => {
    const node = buildRunDetailContent({
      stocks: [],
      results: [
        {
          runId: 'run-2',
          stockId: '300169.SZ',
          selected: false,
          ruleEvaluations: [],
          evidence: [],
          dataAsOf: '2026-07-31T15:00:00+08:00',
        },
      ],
      signals: [],
    });
    const list = node.querySelectorAll('.strategy-run-detail-results')[0];
    expect(list.querySelectorAll('.strategy-run-result').length).toBe(0);
    expect(list.textContent).toContain('无逐股结果');
    node
      .querySelectorAll('button')
      .find((button) => button.textContent === '全部 1 条')
      .click();
    expect(list.querySelectorAll('.strategy-run-result').length).toBe(1);
  });
});
