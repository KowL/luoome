import { afterEach, describe, expect, it } from 'bun:test';

import {
  buildBacktestResultContent,
  buildRunDetailContent,
  buildStrategyHash,
  buildStrictBacktestResultContent,
  openRunDetail,
  parseBacktestStockIds,
  parseStrategyHash,
  renderInsights,
  renderRuns,
  renderSettings,
  runStrategyBacktest,
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
globalThis.window = { location: { hash: '' } };

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
    expect(section.textContent).not.toContain('v3');
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

describe('模拟回测（历史回放）', () => {
  it('规范化可选股票范围并去重', () => {
    expect(parseBacktestStockIds('600519.sh, 000001.SZ\n600519.SH')).toEqual([
      '600519.SH',
      '000001.SZ',
    ]);
    expect(parseBacktestStockIds('  ')).toBeUndefined();
  });

  it('提交历史区间并展示逐日命中与信号汇总，不宣称收益回测', async () => {
    let requestedPath;
    let requestedBody;
    globalThis.fetch = async (path, init) => {
      requestedPath = String(path);
      requestedBody = JSON.parse(init.body);
      return jsonResponse({
        ok: true,
        data: {
          sessionId: 'evaluation-session-1',
          status: 'complete',
          summary: {
            tradingDays: 2,
            completedDays: 2,
            failedDays: 0,
            vintageAvailableDays: 2,
            vintageUnavailableDays: 0,
            evaluatedCount: 200,
            selectedCount: 12,
            signalCount: 8,
            failedCount: 0,
          },
          days: [
            {
              dataAsOf: '2026-08-10T00:00:00.000Z',
              status: 'complete',
              vintageStatus: 'available',
              evaluatedCount: 100,
              selectedCount: 7,
              signalCount: 5,
              failedCount: 0,
            },
            {
              dataAsOf: '2026-08-11T00:00:00.000Z',
              status: 'complete',
              vintageStatus: 'available',
              evaluatedCount: 100,
              selectedCount: 5,
              signalCount: 3,
              failedCount: 0,
            },
          ],
        },
      });
    };
    const statuses = [];

    const result = await runStrategyBacktest(
      { id: 'ma-bullish', name: '均线多头' },
      { from: '2026-08-10', to: '2026-08-11', stockIds: ['600519.SH'] },
      (message) => statuses.push(message),
    );

    expect(result.ok).toBe(true);
    expect(requestedPath).toContain('/api/strategies/ma-bullish/backtests');
    expect(requestedBody).toEqual({
      from: '2026-08-10',
      to: '2026-08-11',
      stockIds: ['600519.SH'],
    });
    expect(modalTitle.textContent).toContain('均线多头');
    expect(modalBody.textContent).toContain('交易日2');
    expect(modalBody.textContent).toContain('累计入选12');
    expect(modalBody.textContent).toContain('2026-08-10');
    expect(modalBody.textContent).toContain('不含收益、费用、滑点和可交易性模拟');
    expect(modalBody.textContent).not.toContain('收益率');
    const evaluationButton = modalBody
      .querySelectorAll('button')
      .find((button) => button.textContent === '查看历史评估记录');
    expect(evaluationButton).toBeDefined();
    evaluationButton.click();
    expect(window.location.hash).toBe(
      '#strategies?strategyId=ma-bullish&tab=runs&scope=evaluation',
    );
    expect(modalOverlay.hidden).toBe(true);
    expect(statuses.at(-1)).toContain('历史模拟完成');
  });

  it('渲染失败交易日及数据版本不可用状态', () => {
    const node = buildBacktestResultContent({
      sessionId: 'evaluation-session-2',
      status: 'partial',
      summary: {
        tradingDays: 1,
        completedDays: 0,
        failedDays: 1,
        vintageAvailableDays: 0,
        vintageUnavailableDays: 1,
        evaluatedCount: 0,
        selectedCount: 0,
        signalCount: 0,
        failedCount: 0,
      },
      days: [
        {
          dataAsOf: '2026-08-10T00:00:00.000Z',
          status: 'failed',
          vintageStatus: 'unavailable',
          error: '历史数据不可用',
        },
      ],
    });
    expect(node.textContent).toContain('失败 1');
    expect(node.textContent).toContain('版本不可用');
    expect(node.textContent).toContain('历史数据不可用');
  });
  it('后台快照只有 session.id 时仍显示评估会话，不渲染 undefined', () => {
    const node = buildBacktestResultContent({
      session: { id: 'evaluation-session-snapshot' },
      status: 'complete',
      summary: {
        tradingDays: 0,
        completedDays: 0,
        failedDays: 0,
        vintageAvailableDays: 0,
        vintageUnavailableDays: 0,
        evaluatedCount: 0,
        selectedCount: 0,
        signalCount: 0,
        failedCount: 0,
      },
      days: [],
    });
    expect(node.textContent).toContain('Evaluation session evaluation-session-snapshot');
    expect(node.textContent).not.toContain('Evaluation session undefined');
  });

  it('历史评估取消后状态文案不冒充完成', async () => {
    globalThis.fetch = async (path) => {
      if (String(path).endsWith('/backtests')) {
        return jsonResponse({
          ok: true,
          data: {
            sessionId: 'evaluation-session-cancelled',
            status: 'queued',
            session: { id: 'evaluation-session-cancelled' },
          },
        });
      }
      return jsonResponse({
        ok: true,
        data: {
          session: { id: 'evaluation-session-cancelled', status: 'failed' },
          status: 'failed',
          summary: {
            tradingDays: 1,
            completedDays: 0,
            failedDays: 1,
            selectedCount: 0,
            signalCount: 0,
          },
          days: [],
        },
      });
    };
    const statuses = [];
    await runStrategyBacktest(
      { id: 'ma-bullish', name: '均线多头' },
      { from: '2026-08-13', to: '2026-08-14', stockIds: ['600519.SH'] },
      (message) => statuses.push(message),
    );
    expect(statuses.at(-1)).toContain('历史模拟失败或已取消');
    expect(statuses.at(-1)).not.toContain('历史模拟完成：');
  });
});

describe('严格回测', () => {
  it('门禁不完整时只展示不可用说明，不展示伪指标', () => {
    const node = buildStrictBacktestResultContent({
      id: 'strict-1',
      status: 'complete',
      resultAvailability: 'partial',
      inputFingerprint: 'a'.repeat(64),
      gateAudit: {
        status: 'partial',
        items: [
          { key: 'pit-universe', status: 'complete', detail: 'ok' },
          { key: 'tradability', status: 'unavailable', detail: 'missing' },
        ],
      },
    });
    expect(node.textContent).toContain('数据门禁未完整通过');
    expect(node.textContent).toContain('tradability');
    expect(node.textContent).toContain('不会输出伪造 Sharpe 或胜率');
    expect(node.textContent).not.toContain('最终净值');
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
    expect(node.textContent).toContain('已引用 1 项已核验事实');
    expect(node.textContent).not.toContain('runs:window');
    expect(node.textContent).not.toContain('quality');
    expect(statuses.at(-1)).toContain('fixture');
  });

  it('设置页展示并保存调度与自动推荐政策', async () => {
    let savedBody;
    globalThis.fetch = async (path, init) => {
      const url = String(path);
      if (url.endsWith('/schedule')) {
        if (init?.method === 'POST') {
          savedBody = JSON.parse(init.body);
          return jsonResponse({
            ok: true,
            data: { schedule: { ...savedBody, nextRunAt: '2026-08-11T10:00:00.000Z' } },
          });
        }
        return jsonResponse({
          ok: true,
          data: {
            schedule: {
              cron: '0 18 * * 1-5',
              timezone: 'Asia/Shanghai',
              enabled: true,
              recommendationPolicy: {
                enabled: true,
                minScore: 75,
                maxRank: 8,
                maxPerRun: 2,
                cooldownHours: 48,
                notify: true,
                channel: 'log',
                observationHorizons: ['t3', 't5', 't20'],
              },
              nextRunAt: '2026-08-10T10:00:00.000Z',
              lastRunId: 'run-internal-id',
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
          versions: [
            {
              id: 'version-internal-id',
              version: 1,
              definitionHash: 'a'.repeat(64),
              validationStatus: 'valid',
              validationErrors: [],
              definition: {},
            },
          ],
        },
      });
    };
    const node = await renderSettings(
      'phase-b-schedule',
      () => {},
      async () => {},
    );
    expect(node.textContent).toContain('自动调度');
    expect(node.textContent).toContain('自动生成策略推荐');
    expect(node.textContent).toContain('标准 5 段 cron');
    expect(node.textContent).toContain('v1');
    expect(node.textContent).not.toContain('run-internal-id');
    expect(node.textContent).not.toContain('version-internal-id');
    expect(node.textContent).not.toContain('a'.repeat(64));
    expect(node.querySelectorAll('input').map((input) => input.value)).toEqual([
      '0 18 * * 1-5',
      'Asia/Shanghai',
      '',
      '',
      '75',
      '8',
      '2',
      '48',
      '',
    ]);
    node
      .querySelectorAll('button')
      .find((button) => button.textContent === '保存调度')
      .click();
    await flush();
    expect(savedBody.recommendationPolicy).toEqual({
      enabled: true,
      minScore: 75,
      maxRank: 8,
      maxPerRun: 2,
      cooldownHours: 48,
      notify: true,
      channel: 'log',
      observationHorizons: ['t3', 't5', 't20'],
    });
  });
});
