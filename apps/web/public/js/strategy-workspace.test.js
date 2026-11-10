import { afterEach, describe, expect, it } from 'bun:test';
import { alertNumber, createAlertRulesEditor, newAlertRule } from './alert-rule-editor.js';
import { closeModal, promptDialog } from './modal.js';
import { buildStrictBacktestResultContent } from './strategy-workspace-backtest.js';
import { renderDecisionCycles } from './strategy-workspace-cycle.js';
import {
  appendExperimentScoringComponent,
  appendExperimentSelectionRule,
  appendExperimentSignalRule,
  buildExperimentSimpleExpression,
  createExperimentBlankDefinition,
  createStrategyDefinitionEditor,
  nextExperimentRuleId,
  nextExperimentScoringRuleId,
  parseExperimentStockIds,
  removeExperimentSelectionRule,
} from './strategy-workspace-experiment.js';
import { renderInsights } from './strategy-workspace-insights.js';
import {
  ADVANCED_TABS,
  BASIC_TABS,
  buildStrategyHash,
  parseStrategyHash,
  STRATEGY_TABS,
} from './strategy-workspace-route.js';
import { buildRunDetailContent, openRunDetail, renderRuns } from './strategy-workspace-runs.js';

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
    const active = globalThis.document?.activeElement;
    const contains = (node, target) =>
      node === target || (node?._children ?? []).some((child) => contains(child, target));
    if (active !== null && active !== undefined && contains(this, active)) {
      globalThis.document.activeElement = null;
    }
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

  dispatchEvent(event) {
    for (const listener of this._listeners[event.type] ?? []) {
      listener.call(this, { ...event, target: this, currentTarget: this });
    }
    return true;
  }

  focus() {
    document.activeElement = this;
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
  activeElement: null,
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

const experimentCatalog = {
  schemaVersion: 1,
  fields: [
    {
      path: 'quote.close',
      type: 'number',
      unit: 'CNY',
      requiredLookback: 0,
      dataSource: 'quote',
      coverage: ['CN_A_SHARES_SH_SZ'],
      operators: ['==', '>', '>=', '<', '<=', '+'],
    },
    {
      path: 'meta.recentLimitUp',
      type: 'boolean',
      dataSource: 'meta',
      coverage: ['CN_A_SHARES_SH_SZ'],
      operators: ['==', '!=', '&&'],
    },
  ],
  limits: { selectionRules: null, scoringComponents: null, signalRulesPerScope: null },
};

const experimentDefinition = {
  schemaVersion: 1,
  metadata: { horizon: 'short', style: 'breakout' },
  universe: { coverage: 'CN_A_SHARES_SH_SZ', excludeStockIds: [] },
  selection: {
    logic: 'all',
    rules: [
      {
        id: 'close-positive',
        name: '收盘价有效',
        when: 'quote.close > 0',
        evidence: [String.raw`quote.close = \${quote.close}`],
      },
    ],
  },
  scoring: {
    method: 'weighted-sum',
    components: [{ ruleId: 'close-positive', score: '50', weight: 1 }],
  },
  signals: { entry: [], exit: [], risk: [] },
};

const flush = async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
};

afterEach(() => {
  modalOverlay.hidden = true;
  document.activeElement = null;
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
    expect(parseStrategyHash('#strategies?strategyId=s1&tab=cycle').tab).toBe('cycle');
    expect(buildStrategyHash({ strategyId: 's1', tab: 'cycle', runId: 'run-1' })).toBe(
      '#strategies?strategyId=s1&tab=cycle&runId=run-1',
    );
  });

  it('高级 tab 收深：基础 + 高级恰好覆盖全部 tab，高级 tab 直接 URL 仍可解析', () => {
    expect([...BASIC_TABS, ...ADVANCED_TABS].sort()).toEqual([...STRATEGY_TABS].sort());
    expect(BASIC_TABS).toEqual(['overview', 'pool', 'runs', 'settings']);
    expect(ADVANCED_TABS).toEqual(['insights', 'cycle']);
    for (const tab of ADVANCED_TABS) {
      expect(parseStrategyHash(`#strategies?strategyId=s1&tab=${tab}`).tab).toBe(tab);
    }
  });
});

describe('Strategy Experiment Lab', () => {
  it('只使用 catalog 生成结构化表达式，并规范化样本股票', () => {
    const field = experimentCatalog.fields[0];
    expect(buildExperimentSimpleExpression(field, '>', ' 10 ')).toBe('quote.close > 10');
    expect(buildExperimentSimpleExpression(experimentCatalog.fields[1], '==', 'FALSE')).toBe(
      'meta.recentLimitUp == false',
    );
    expect(createExperimentBlankDefinition(experimentCatalog).selection.rules[0].when).toBe(
      'quote.close > 0',
    );
    expect(
      createExperimentBlankDefinition(experimentCatalog).selection.rules[0].when,
    ).not.toContain('unregistered');
    expect(parseExperimentStockIds('600519.sh, 000001.SZ\n600519.SH； 300750.sz')).toEqual([
      '600519.SH',
      '000001.SZ',
      '300750.SZ',
    ]);
  });

  it('新增/删除规则保持唯一 id，并同步清理 scoring 引用与权重', () => {
    const definition = createExperimentBlankDefinition(experimentCatalog);
    definition.selection.rules.push({
      id: 'selection-2',
      name: '第二条',
      when: 'meta.recentLimitUp == true',
      evidence: ['recent limit up'],
    });
    definition.scoring.components.push({ ruleId: 'selection-2', score: '60', weight: 0.5 });
    definition.scoring.components[0].weight = 0.5;
    definition.signals.entry.push({
      id: 'entry-rule-1',
      name: '入场',
      when: 'quote.close > 0',
      score: '60',
      direction: 'bullish',
      evidence: ['close'],
    });

    expect(nextExperimentRuleId(definition.selection.rules, 'selection')).toBe('selection-3');
    expect(nextExperimentRuleId(definition.signals.entry, 'entry-rule')).toBe('entry-rule-2');
    expect(
      nextExperimentScoringRuleId(definition.selection.rules, definition.scoring.components),
    ).toBe(undefined);

    const removed = removeExperimentSelectionRule(definition, 'selection-1');
    expect(removed.selection.rules.map((rule) => rule.id)).toEqual(['selection-2']);
    expect(removed.scoring.components).toEqual([
      expect.objectContaining({ ruleId: 'selection-2', weight: 1 }),
    ]);
    expect(removed.scoring.components.map((component) => component.ruleId)).toEqual([
      'selection-2',
    ]);

    const added = appendExperimentSelectionRule(removed, experimentCatalog);
    expect(added.selection.rules.map((rule) => rule.id)).toEqual(['selection-2', 'selection-3']);
    const withScoring = appendExperimentScoringComponent(added);
    expect(withScoring.scoring.components.map((component) => component.ruleId)).toEqual([
      'selection-2',
      'selection-3',
    ]);
    expect(
      withScoring.scoring.components.reduce((sum, component) => sum + component.weight, 0),
    ).toBe(1);
    expect(appendExperimentScoringComponent(withScoring)).toEqual(withScoring);

    const withSignal = appendExperimentSignalRule(withScoring, experimentCatalog, 'entry');
    expect(withSignal.signals.entry.map((rule) => rule.id)).toEqual([
      'entry-rule-1',
      'entry-rule-2',
    ]);
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

describe('执行记录「重跑」按钮', () => {
  const withheldRun = {
    ...run,
    id: 'run-withheld',
    scope: 'operational',
    publication: { status: 'withheld', reasons: ['acceptance-rejected'] },
  };
  const publishedRun = {
    ...run,
    id: 'run-published',
    scope: 'operational',
    publication: { status: 'published', reasons: [] },
  };

  const waitFor = async (cond) => {
    for (let i = 0; i < 50 && !cond(); i += 1) await flush();
    expect(cond()).toBe(true);
  };

  it('withheld 行显示「重跑」，published 行不显示', async () => {
    globalThis.fetch = async (path) => {
      const url = String(path);
      if (url.includes('/api/strategies/rerun-demo/runs')) {
        return jsonResponse({ ok: true, data: { runs: [withheldRun, publishedRun] } });
      }
      return jsonResponse({ ok: false, error: { kind: 'not_found', message: '无数据' } });
    };
    const section = await renderRuns('rerun-demo');
    const reruns = section
      .querySelectorAll('button')
      .filter((button) => button.textContent === '重跑');
    expect(reruns.length).toBe(1);
    expect(section.textContent).toContain('暂不发布');
    expect(section.textContent).toContain('已发布');
  });

  it('确认重跑后 POST /run 且列表重新拉取渲染', async () => {
    const calls = [];
    globalThis.fetch = async (path, init) => {
      const url = String(path);
      calls.push({ url, method: init?.method ?? 'GET', body: init?.body });
      if (url.includes('/api/strategies/rerun-ok/runs')) {
        return jsonResponse({ ok: true, data: { runs: [withheldRun] } });
      }
      if (url.includes('/api/strategies/rerun-ok/run')) {
        return jsonResponse({
          ok: true,
          data: {
            run: { id: 'run-new', status: 'complete', publication: { status: 'published' } },
            results: [{}],
            signals: [{}, {}],
          },
        });
      }
      return jsonResponse({ ok: false, error: { kind: 'not_found', message: '无数据' } });
    };
    const section = await renderRuns('rerun-ok');
    const rerun = section
      .querySelectorAll('button')
      .find((button) => button.textContent === '重跑');
    expect(rerun).toBeDefined();
    rerun.click();
    const confirm = modalBody
      .querySelectorAll('button')
      .find((button) => button.textContent === '开始重跑');
    expect(confirm).toBeDefined();
    confirm.click();
    await waitFor(() => section.textContent.includes('已发布；结果 1，信号 2'));
    const post = calls.find((call) => call.method === 'POST');
    expect(post.url).toBe('/api/strategies/rerun-ok/run');
    expect(JSON.parse(post.body)).toEqual({ persist: true });
    const listFetches = calls.filter(
      (call) => call.method === 'GET' && call.url.includes('/api/strategies/rerun-ok/runs'),
    );
    expect(listFetches.length).toBe(2);
  });

  it('重跑失败时状态行展示错误且不重新拉取列表', async () => {
    const calls = [];
    globalThis.fetch = async (path, init) => {
      const url = String(path);
      calls.push({ url, method: init?.method ?? 'GET' });
      if (url.includes('/api/strategies/rerun-fail/runs')) {
        return jsonResponse({ ok: true, data: { runs: [withheldRun] } });
      }
      if (url.includes('/api/strategies/rerun-fail/run')) {
        return jsonResponse({
          ok: false,
          error: { kind: 'invalid_input', message: '同一 StrategyVersion 已有正式运行执行中' },
        });
      }
      return jsonResponse({ ok: false, error: { kind: 'not_found', message: '无数据' } });
    };
    const section = await renderRuns('rerun-fail');
    section
      .querySelectorAll('button')
      .find((button) => button.textContent === '重跑')
      .click();
    modalBody
      .querySelectorAll('button')
      .find((button) => button.textContent === '开始重跑')
      .click();
    await waitFor(() => section.textContent.includes('同一 StrategyVersion 已有正式运行执行中'));
    const listFetches = calls.filter(
      (call) => call.method === 'GET' && call.url.includes('/api/strategies/rerun-fail/runs'),
    );
    expect(listFetches.length).toBe(1);
    const rerun = section
      .querySelectorAll('button')
      .find((button) => button.textContent === '重跑');
    expect(rerun.disabled).toBe(false);
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

  it('闭环 tab 展示事实、阶段 Advice 与显式 Trade 链接，并保留未知状态', async () => {
    globalThis.fetch = async (path) => {
      expect(String(path)).toContain('/decision-cycles');
      return jsonResponse({
        ok: true,
        data: {
          total: 1,
          factsAsOf: '2026-08-08T10:00:00.000Z',
          evidenceIds: ['result-fact', 'obs-t1', 'advice-1', 'trade-1'],
          unknowns: ['T3 尚未完成'],
          limitations: ['仅显式 Advice 关系可归因'],
          cycles: [
            {
              stockId: '600519.SH',
              runId: 'run-cycle-1',
              strategyVersionId: 'version-cycle-1',
              result: { score: 82, rank: 1, evidence: ['result-fact'] },
              run: {
                status: 'complete',
                publication: { status: 'published' },
                dataAsOf: '2026-08-07T10:00:00.000Z',
              },
              signals: [
                { id: 'signal-1', direction: 'bullish', score: 80, evidence: ['signal fact'] },
              ],
              observationProgress: [
                {
                  horizon: 't1',
                  status: 'complete',
                  completeCount: 1,
                  pendingCount: 0,
                  unavailableCount: 0,
                  observationIds: ['obs-t1'],
                  benchmarkStatus: 'complete',
                },
                {
                  horizon: 't3',
                  status: 'pending',
                  completeCount: 0,
                  pendingCount: 1,
                  unavailableCount: 0,
                  observationIds: [],
                  benchmarkStatus: 'unavailable',
                  unavailableReasons: ['等待收盘'],
                },
                {
                  horizon: 't5',
                  status: 'unavailable',
                  completeCount: 0,
                  pendingCount: 0,
                  unavailableCount: 1,
                  observationIds: [],
                  benchmarkStatus: 'unavailable',
                  unavailableReasons: ['无数据'],
                },
                {
                  horizon: 't20',
                  status: 'unavailable',
                  completeCount: 0,
                  pendingCount: 0,
                  unavailableCount: 1,
                  observationIds: [],
                  benchmarkStatus: 'unavailable',
                  unavailableReasons: ['无数据'],
                },
              ],
              observations: [
                {
                  id: 'obs-t1',
                  returnPct: 0.05,
                  maxFavorableExcursionPct: 0.08,
                  maxAdverseExcursionPct: -0.02,
                  benchmarkReturnPct: 0.01,
                  benchmarkStatus: 'complete',
                },
              ],
              advices: [
                {
                  id: 'advice-1',
                  decision: 'watch',
                  confidence: 76,
                  validFrom: '2026-08-07T10:00:00.000Z',
                  validUntil: '2026-08-10T10:00:00.000Z',
                  basedOn: { strategy: { recommendationTrigger: 'run' } },
                  reasoning: { premise: '等待事实确认' },
                },
              ],
              trades: [
                {
                  id: 'trade-1',
                  side: 'buy',
                  quantity: 100,
                  price: 100,
                  executedAt: '2026-08-08T10:00:00.000Z',
                },
              ],
              tradeLinks: [
                { tradeId: 'trade-1', adviceId: 'advice-1', relation: 'trade.adviceId' },
              ],
              evidenceIds: ['result-fact', 'obs-t1', 'advice-1', 'trade-1'],
              unknowns: ['T3 尚未完成'],
              limitations: ['仅显式 Advice 关系可归因'],
              factsAsOf: '2026-08-08T10:00:00.000Z',
            },
          ],
        },
      });
    };
    const node = await renderDecisionCycles('cycle-ui-strategy', { runId: 'run-cycle-1' });
    expect(node.textContent).toContain('策略候选闭环');
    expect(node.textContent).toContain('事实 / 事后观察');
    expect(node.textContent).toContain('T3');
    expect(node.textContent).not.toContain('T20');
    expect(node.textContent).toContain('待观察');
    expect(node.textContent).toContain('AI Advice / 决策快照');
    expect(node.textContent).toContain('已过期');
    expect(node.textContent).toContain('Outcome 待回填');
    expect(node.textContent).toContain('trade-1');
    expect(node.textContent).toContain('Unknown');
    expect(node.textContent).not.toContain('概率');
  });
});

describe('共享规则表单', () => {
  const click = (root, text) =>
    root
      .querySelectorAll('button')
      .find((button) => button.textContent === text)
      .click();
  it('策略表单不改写复杂条件、内部身份和扩展配置', () => {
    const definition = structuredClone(experimentDefinition);
    definition.selection.rules[0].when = 'quote.close > 10 && quote.close < 100';
    const editor = createStrategyDefinitionEditor(definition, experimentCatalog);
    expect(editor.getValue()).toEqual(definition);
    expect(editor.root.textContent).not.toContain(definition.selection.rules[0].id);
    const expression = editor.root
      .querySelectorAll('textarea')
      .find((input) => input.className === 'experiment-expression-input');
    expression.value = 'quote.close > 20 && quote.close < 100';
    expression.dispatchEvent({ type: 'input' });
    expect(editor.getValue().selection.rules[0].when).toBe(expression.value);
    expect(definition.selection.rules[0].when).toContain('> 10');
  });
  it('无效 JSON 保留用户输入并阻止读取旧定义，修正后恢复表单', () => {
    const editor = createStrategyDefinitionEditor(experimentDefinition, experimentCatalog);
    click(editor.root, 'JSON 高级');
    const json = editor.root.querySelectorAll('textarea')[0];
    json.value = '{ broken';
    json.dispatchEvent({ type: 'input' });
    click(editor.root, '结构化编辑');
    click(editor.root, 'JSON 高级');
    expect(json.value).toBe('{ broken');
    expect(() => editor.getValue()).toThrow();
    json.value = JSON.stringify(experimentDefinition);
    json.dispatchEvent({ type: 'input' });
    click(editor.root, '结构化编辑');
    expect(editor.getValue()).toEqual(experimentDefinition);
  });
  it('连续修改策略风格、周期和股票范围不会相互覆盖', () => {
    const editor = createStrategyDefinitionEditor(experimentDefinition, experimentCatalog);
    const inputs = editor.root.querySelectorAll('input');
    inputs[0].value = 'momentum';
    inputs[0].dispatchEvent({ type: 'input' });
    const horizon = editor.root.querySelectorAll('select')[0];
    horizon.value = 'long';
    horizon.dispatchEvent({ type: 'change' });
    const textareas = editor.root.querySelectorAll('textarea');
    textareas[0].value = '600519.SH';
    textareas[0].dispatchEvent({ type: 'input' });
    textareas[1].value = '000001.SZ';
    textareas[1].dispatchEvent({ type: 'input' });
    expect(editor.getValue().metadata).toEqual({
      ...experimentDefinition.metadata,
      style: 'momentum',
      horizon: 'long',
    });
    expect(editor.getValue().universe.includeStockIds).toEqual(['600519.SH']);
    expect(editor.getValue().universe.excludeStockIds).toEqual(['000001.SZ']);
  });
  it('预警百分比用百分数输入，往返保留规则身份与可选过滤', () => {
    const rules = [
      {
        id: 'loss-rule',
        kind: 'cost-threshold',
        stopLossPct: 0.05,
        takeProfitPct: 0.15,
        priority: 'urgent',
      },
      {
        id: 'signal-rule',
        kind: 'strategy-signal',
        strategyId: 's1',
        minScore: 60,
        ruleId: 'signal-original',
        direction: 'bullish',
      },
    ];
    const editor = createAlertRulesEditor(rules, { strategies: [{ id: 's1', name: '趋势研究' }] });
    expect(editor.getValue()).toEqual(rules);
    const input = editor.root.querySelectorAll('input')[0];
    expect(input.value).toBe('5');
    input.value = '8';
    expect(editor.getValue()[0].stopLossPct).toBe(0.08);
    expect(editor.getValue()[1].ruleId).toBe('signal-original');
  });
  it('增删预警自动生成不同标识，删除到零条阻止保存', () => {
    const editor = createAlertRulesEditor([newAlertRule('price-level', 'original-rule')]);
    click(editor.root, '添加条件');
    const rules = editor.getValue();
    expect(rules[0].id).toBe('original-rule');
    expect(rules[1].id).not.toBe('original-rule');
    click(editor.root, '删除条件');
    click(editor.root, '删除条件');
    expect(() => editor.getValue()).toThrow('至少添加');
  });
  it('预警切换 JSON 无效时保留文本；清空成本阈值或填错百分比不能保存', () => {
    const editor = createAlertRulesEditor([newAlertRule('cost-threshold', 'loss-rule')]);
    const input = editor.root.querySelectorAll('input')[0];
    input.value = '';
    expect(() => editor.getValue()).toThrow('至少填写');
    input.value = '101';
    expect(() => editor.getValue()).toThrow('超出范围');
    input.value = '5';
    click(editor.root, '高级 JSON');
    const json = editor.root.querySelectorAll('textarea')[0];
    json.value = '[bad';
    click(editor.root, '表单编辑');
    expect(json.value).toBe('[bad');
    expect(() => editor.getValue()).toThrow();
  });
  it('数字空值不被转成零', () => {
    expect(() => alertNumber('', '幅度')).toThrow('请填写');
  });
});

describe('表单提交失败恢复', () => {
  it('服务端拒绝时保留输入，成功重试才关闭弹窗', async () => {
    let fail = true;
    let requests = 0;
    const pending = promptDialog({
      title: '测试',
      fields: [{ key: 'name', label: '名称', value: '原配置' }],
      onSubmit: async () => {
        requests++;
        if (fail) throw new Error('配置校验失败');
      },
    });
    const input = modalBody.querySelectorAll('input')[0];
    input.value = '修改后的配置';
    modalBody
      .querySelectorAll('button')
      .find((button) => button.textContent === '确定')
      .click();
    await flush();
    expect(modalOverlay.hidden).toBe(false);
    expect(input.value).toBe('修改后的配置');
    expect(modalBody.textContent).toContain('配置校验失败');
    fail = false;
    modalBody
      .querySelectorAll('button')
      .find((button) => button.textContent === '确定')
      .click();
    expect(await pending).toEqual({ name: '修改后的配置' });
    expect(requests).toBe(2);
    expect(modalOverlay.hidden).toBe(true);
  });
  it('多行证据中回车不会意外提交', async () => {
    const pending = promptDialog({
      title: '证据',
      fields: [{ key: 'evidence', label: '证据', multiline: true }],
    });
    modalBody.querySelectorAll('textarea')[0].dispatchEvent({
      type: 'keydown',
      key: 'Enter',
      preventDefault: () => {
        throw new Error('不应阻止换行');
      },
    });
    expect(modalOverlay.hidden).toBe(false);
    closeModal();
    expect(await pending).toBeNull();
  });
});
