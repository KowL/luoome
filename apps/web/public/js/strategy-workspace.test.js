import { afterEach, describe, expect, it } from 'bun:test';

import {
  buildRunDetailContent,
  buildStrategyHash,
  openRunDetail,
  parseStrategyHash,
  renderInsights,
  renderRuns,
  renderSettings,
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

const byId = new Map();
globalThis.Node = FakeNode;
globalThis.document = {
  createElement: (tag) => new FakeElement(tag),
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
    { stockId: '300169.SZ', stockName: '天晟新材', nameStatus: 'resolved' },
  ],
  signals: [
    {
      id: 'sig-1',
      strategyId: 'breakout-volume',
      stockId: '000001.SZ',
      direction: 'bullish',
      score: 67.60499999999999,
      evidence: ['放量突破 20 日均线'],
    },
    {
      id: 'sig-2',
      strategyId: 'breakout-volume',
      stockId: '000009.SZ',
      direction: 'bullish',
      score: 54.963,
      evidence: ['量比 volRatio5_20=1.8321'],
    },
  ],
};

const run = {
  id: 'run-1',
  startedAt: '2026-07-31T09:30:00+08:00',
  mode: 'scan',
  strategyVersionId: 'v3',
  status: 'complete',
  summary: {
    schemaVersion: 3,
    dataHealth: 'partial',
    universeCount: 5,
    evaluatedCount: 5,
    selectedCount: 2,
    signalCount: 2,
    incompleteCount: 1,
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
  it('round-trips durable strategy/tab/run selection and normalizes invalid values', () => {
    const parsed = parseStrategyHash(
      '#strategies?strategyId=trend-v2&tab=pool&runId=run-2&compareRunId=run-1',
    );
    expect(parsed).toEqual({
      strategyId: 'trend-v2',
      tab: 'pool',
      runId: 'run-2',
      compareRunId: 'run-1',
    });
    expect(buildStrategyHash(parsed)).toBe(
      '#strategies?strategyId=trend-v2&tab=pool&runId=run-2&compareRunId=run-1',
    );
    expect(parseStrategyHash('#strategies?tab=unknown&view=nope')).toMatchObject({
      strategyId: '',
      tab: 'overview',
    });
    // 已下线的候选池 tab 与 view 参数回退到默认值且不再写回 hash
    expect(parseStrategyHash('#strategies?tab=candidates&view=incomplete')).toMatchObject({
      tab: 'overview',
    });
    expect(buildStrategyHash({ strategyId: 's1', tab: 'pool' })).toBe(
      '#strategies?strategyId=s1&tab=pool',
    );
  });
});

describe('运行记录「查看」弹窗', () => {
  it('点击查看打开弹窗只展示信号列表，而非在表格下方内联展开', async () => {
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
    expect(section.textContent).toContain('已完成');
    expect(section.textContent).toContain('数据 部分可用');
    expect(section.textContent).toContain('不完整 1');
    // 运行列表不再内联渲染详情区
    expect(section.querySelectorAll('.strategy-run-detail').length).toBe(0);
    const view = section.querySelectorAll('button').find((button) => button.textContent === '查看');
    expect(view).toBeDefined();
    view.click();
    await flush();
    // 弹窗打开，内容只有信号列表：无筛选 tab / 结果行 / 分页栏
    expect(modalOverlay.hidden).toBe(false);
    expect(modalBody.querySelectorAll('.strategy-run-detail-tabs').length).toBe(0);
    expect(modalBody.querySelectorAll('.strategy-run-result').length).toBe(0);
    expect(modalBody.querySelectorAll('.strategy-run-pagination').length).toBe(0);
    expect(modalBody.textContent).toContain('信号 2');
    expect(modalBody.textContent).toContain('StrategySignal');
    expect(modalBody.textContent).toContain('平安银行');
    expect(modalBody.textContent).toContain('放量突破 20 日均线');
  });

  it('openRunDetail 拉取失败时在弹窗内展示错误', async () => {
    globalThis.fetch = async () =>
      jsonResponse({ ok: false, error: { kind: 'not_found', message: 'StrategyRun 不存在' } });
    await openRunDetail('missing-run');
    expect(modalOverlay.hidden).toBe(false);
    expect(modalBody.textContent).toContain('StrategyRun 不存在');
  });
});

describe('运行详情弹窗信号列表', () => {
  it('渲染股票 / direction · score / evidence，score 保留两位小数', () => {
    const node = buildRunDetailContent(detailData);
    const rows = node.querySelectorAll('.entity-item');
    expect(rows.length).toBe(2);
    expect(rows[0].textContent).toContain('平安银行');
    expect(rows[0].textContent).toContain('000001.SZ');
    expect(rows[0].textContent).toContain('bullish · score 67.60');
    expect(rows[0].textContent).toContain('放量突破 20 日均线');
    expect(rows[1].textContent).toContain('bullish · score 54.96');
    expect(rows[1].textContent).toContain('量比 volRatio5_20=1.8321');
  });

  it('无信号时显示占位文案', () => {
    const node = buildRunDetailContent({ stocks: [], signals: [] });
    expect(node.textContent).toContain('信号 0');
    expect(node.textContent).toContain('无信号');
  });
});

describe('Phase B 洞察与调度', () => {
  it('先展示确定性事实，再由显式按钮生成带事实引用的 AI 解读', async () => {
    globalThis.fetch = async (path, init) => {
      const url = String(path);
      if (url.includes('/insights/generate') && init?.method === 'POST') {
        return jsonResponse({
          ok: true,
          data: {
            provider: 'fixture',
            insight: {
              headline: '策略事实观察',
              summary: '只解释已有事实。',
              findings: [
                {
                  kind: 'trend',
                  title: '运行稳定',
                  detail: '近期有一条可用运行。',
                  factRefs: ['runs:window'],
                },
              ],
              risks: ['样本少'],
              limitations: ['不是回测'],
              disclaimer: '仅供研究，不构成投资建议。',
            },
          },
        });
      }
      return jsonResponse({
        ok: true,
        data: {
          window: { days: 30 },
          factsAsOf: '2026-08-08T10:00:00.000Z',
          runs: { total: 1, usable: 1, failed: 0 },
          currentSelection: {
            selectedCount: 1,
            averageScore: 82,
            industries: [{ name: '食品饮料', count: 1, share: 1 }],
          },
          blockers: [{ ruleId: 'quality', ruleName: '质量门槛', count: 1 }],
          observations: [
            {
              horizon: 't1',
              total: 1,
              complete: 1,
              missingRate: 0,
              benchmarkStatus: 'unavailable',
              averageReturnPct: 0.05,
            },
          ],
          alertPlans: [{ name: '质量预警', enabled: true, ruleCount: 1 }],
          limitations: ['事实观察不是回测。'],
        },
      });
    };
    const statuses = [];
    const node = await renderInsights('phase-b-insight', (message) => statuses.push(message));
    expect(node.textContent).toContain('真实信号观察');
    expect(node.textContent).toContain('5.00%');
    expect(node.textContent).toContain('质量门槛');
    expect(node.textContent).not.toContain('运行稳定');

    node
      .querySelectorAll('button')
      .find((button) => button.textContent === '生成 AI 解读')
      .click();
    await flush();
    expect(node.textContent).toContain('运行稳定');
    expect(node.textContent).toContain('runs:window');
    expect(statuses.at(-1)).toContain('fixture');
  });

  it('设置页展示可生效的 cron、时区和下一次计划', async () => {
    globalThis.fetch = async (path) => {
      const url = String(path);
      if (url.endsWith('/schedule')) {
        return jsonResponse({
          ok: true,
          data: {
            schedule: {
              cron: '0 18 * * 1-5',
              timezone: 'Asia/Shanghai',
              enabled: true,
              nextRunAt: '2026-08-10T10:00:00.000Z',
            },
          },
        });
      }
      return jsonResponse({
        ok: true,
        data: {
          strategy: {
            id: 'phase-b-schedule',
            name: '调度策略',
            status: 'active',
            currentVersionId: 'v1',
          },
          versions: [],
        },
      });
    };
    const node = await renderSettings(
      'phase-b-schedule',
      () => {},
      async () => {},
    );
    expect(node.textContent).toContain('自动调度');
    expect(node.textContent).toContain('标准 5 段 cron');
    expect(node.querySelectorAll('input').map((input) => input.value)).toEqual([
      '0 18 * * 1-5',
      'Asia/Shanghai',
      '',
    ]);
  });
});
