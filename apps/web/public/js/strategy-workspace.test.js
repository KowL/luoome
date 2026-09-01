import { afterEach, describe, expect, it } from 'bun:test';
import {
  buildBacktestResultContent,
  buildStrictBacktestResultContent,
  parseBacktestStockIds,
  runStrategyBacktest,
} from './strategy-workspace-backtest.js';
import { renderDecisionCycles } from './strategy-workspace-cycle.js';
import {
  appendExperimentScoringComponent,
  appendExperimentSelectionRule,
  appendExperimentSignalRule,
  buildExperimentScoreExpression,
  buildExperimentSimpleExpression,
  createExperimentBlankDefinition,
  deriveExperimentStepStates,
  invalidateExperimentCache,
  nextExperimentRuleId,
  nextExperimentScoringRuleId,
  parseExperimentStockIds,
  removeExperimentSelectionRule,
  renderStrategyExperiment,
} from './strategy-workspace-experiment.js';
import { renderInsights } from './strategy-workspace-insights.js';
import { buildStrategyHash, parseStrategyHash } from './strategy-workspace-route.js';
import { buildRunDetailContent, openRunDetail, renderRuns } from './strategy-workspace-runs.js';
import { invalidateSettingsCache, renderSettings } from './strategy-workspace-settings.js';

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

const experimentContext = {
  strategy: { id: 'experiment-ui', name: '实验 UI', status: 'active' },
  baseVersion: {
    id: 'experiment-ui-v1',
    version: 1,
    definition: experimentDefinition,
    definitionHash: 'a'.repeat(64),
    validationStatus: 'valid',
    validationErrors: [],
    createdAt: '2026-08-01T00:00:00.000Z',
    publishedAt: '2026-08-01T00:00:00.000Z',
  },
  candidateVersion: {
    id: 'experiment-ui-v2',
    version: 2,
    definition: {
      ...experimentDefinition,
      metadata: { ...experimentDefinition.metadata, style: 'breakout-plus' },
    },
    definitionHash: 'b'.repeat(64),
    parentVersionId: 'experiment-ui-v1',
    validationStatus: 'valid',
    validationErrors: [],
    createdAt: '2026-08-02T00:00:00.000Z',
  },
  definitionDiff: {
    changed: true,
    fromHash: 'a'.repeat(64),
    toHash: 'b'.repeat(64),
    changes: [
      { path: 'metadata.style', kind: 'changed', before: 'breakout', after: 'breakout-plus' },
    ],
    summary: { added: 0, removed: 0, changed: 1 },
  },
  versionState: {
    candidatePersisted: true,
    candidateValid: true,
    candidatePublished: false,
    parentMatchesBase: true,
  },
  observations: { horizon: 't5', stats: [], benchmarkCoverageRatio: 0, observationIds: [] },
  promotion: {
    policyVersion: 'strategy-promotion-v1',
    status: 'blocked',
    reasons: ['validation-days-insufficient', 'observations-insufficient'],
    metrics: {
      validationTradingDays: 0,
      vintageCoverageRatio: 0,
      completeObservationCount: 0,
      benchmarkCoverageRatio: 0,
    },
    factReferences: ['strategy:experiment-ui'],
    limitations: ['尚无独立验证事实。'],
  },
  limitations: ['当前没有独立验证 session。'],
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

  it('scoring 与 signal score 只由 catalog 生成；高级表达式在结构化模式只读', async () => {
    expect(buildExperimentScoreExpression('constant', experimentCatalog, '55')).toBe('55');
    expect(buildExperimentScoreExpression('field', experimentCatalog, 'quote.close')).toBe(
      `\${quote.close}`,
    );
    expect(buildExperimentScoreExpression('field', experimentCatalog, 'unregistered.score')).toBe(
      '',
    );
    expect(buildExperimentScoreExpression('field', experimentCatalog, 'meta.recentLimitUp')).toBe(
      '',
    );

    const advancedContext = {
      ...experimentContext,
      strategy: { id: 'experiment-score-advanced', name: 'Score advanced', status: 'active' },
      candidateVersion: {
        ...experimentContext.candidateVersion,
        definition: {
          ...experimentContext.candidateVersion.definition,
          scoring: {
            method: 'weighted-sum',
            components: [
              {
                ruleId: 'close-positive',
                score: `Math.min(100, \${quote.close})`,
                weight: 1,
              },
            ],
          },
          signals: {
            entry: [
              {
                id: 'entry-rule-1',
                name: '高级信号',
                when: 'quote.close > 0',
                score: `\${unregistered.score}`,
                direction: 'bullish',
                evidence: ['close'],
              },
            ],
            exit: [],
            risk: [],
          },
        },
      },
    };
    invalidateExperimentCache();
    globalThis.fetch = async (path) =>
      String(path).includes('/api/strategy/dsl-catalog')
        ? jsonResponse({ ok: true, data: experimentCatalog })
        : jsonResponse({ ok: true, data: advancedContext });
    const node = await renderStrategyExperiment(
      'experiment-score-advanced',
      () => {},
      async () => {},
    );
    expect(node.textContent).toContain('高级表达式只读');
    expect(node.textContent).toContain(`\${unregistered.score}`);
    expect(node.querySelectorAll('.experiment-score-advanced').length).toBeGreaterThan(0);
  });

  it('按 baseline / candidate / validation 事实展示六段流程状态', () => {
    const steps = deriveExperimentStepStates(experimentContext, {});
    expect(steps.map((step) => step.title)).toEqual([
      '基线',
      '草案',
      'Diff',
      'Trial',
      '独立验证',
      '晋级评审',
    ]);
    expect(steps.map((step) => step.status)).toEqual([
      'complete',
      'complete',
      'complete',
      'ready',
      'ready',
      'blocked',
    ]);
  });

  it('证据门禁 eligible 时展示人工评审入口，不变成自动发布', async () => {
    invalidateExperimentCache();
    const eligibleContext = {
      ...experimentContext,
      strategy: { id: 'experiment-eligible', name: 'Eligible UI', status: 'active' },
      promotion: {
        ...experimentContext.promotion,
        status: 'eligible-for-human-review',
        reasons: [],
        metrics: {
          validationTradingDays: 20,
          vintageCoverageRatio: 1,
          completeObservationCount: 30,
          benchmarkCoverageRatio: 0.9,
        },
        factReferences: ['strategy:experiment-eligible', 'strategy-evaluation:eligible-session'],
      },
      validation: {
        session: {
          id: 'eligible-session',
          strategyId: 'experiment-eligible',
          strategyVersionId: 'experiment-ui-v2',
          from: '2026-08-01T00:00:00.000Z',
          to: '2026-08-28T00:00:00.000Z',
          status: 'complete',
          definitionHash: 'b'.repeat(64),
          createdAt: '2026-08-30T00:00:00.000Z',
        },
        days: [],
        runIds: [],
        vintageCoverageRatio: 1,
      },
    };
    globalThis.fetch = async (path) =>
      String(path).includes('/api/strategy/dsl-catalog')
        ? jsonResponse({ ok: true, data: experimentCatalog })
        : jsonResponse({ ok: true, data: eligibleContext });
    const node = await renderStrategyExperiment(
      'experiment-eligible',
      () => {},
      async () => {},
    );
    expect(node.textContent).toContain('人工确认发布');
    expect(node.textContent).toContain('证据质量达到预设门禁');
    expect(deriveExperimentStepStates(eligibleContext, {}).at(-1).status).toBe('ready');
    expect(
      node.querySelectorAll('button').find((button) => button.textContent === '人工确认发布')
        .disabled,
    ).toBe(false);
  });

  it('渲染字段元数据、双模式入口、Diff 与评审门禁，不生成胜率叙事', async () => {
    invalidateExperimentCache();
    globalThis.fetch = async (path) => {
      if (String(path).includes('/api/strategy/dsl-catalog')) {
        return jsonResponse({ ok: true, data: experimentCatalog });
      }
      return jsonResponse({ ok: true, data: experimentContext });
    };
    const node = await renderStrategyExperiment(
      'experiment-ui',
      () => {},
      async () => {},
    );
    expect(node.textContent).toContain('基线 → 草案 → Diff → Trial → 独立验证 → 人工评审');
    expect(node.textContent).toContain('字段目录');
    expect(node.textContent).toContain('quote.close');
    expect(node.textContent).toContain('CNY');
    expect(node.textContent).toContain('lookback 0d');
    expect(node.textContent).toContain('实时行情');
    expect(node.textContent).toContain('缺失时保持 unknown');
    expect(node.textContent).toContain('结构化编辑');
    expect(node.textContent).toContain('JSON 高级');
    expect(node.textContent).toContain('metadata.style');
    expect(node.textContent).toContain('验证交易日');
    expect(node.textContent).not.toContain('胜率');
  });

  it('X4 分层展示四类证据，并区分缺失、不可用与真实 0 收益', async () => {
    invalidateExperimentCache();
    const observationLink = {
      observationId: 'observation-t1-zero',
      signalId: 'signal-t1-zero',
      runId: 'run-t1-zero',
      stockId: '600519.SH',
      strategyId: 'experiment-x4-ui',
      strategyVersionId: 'experiment-ui-v2',
      horizon: 't1',
    };
    const x4Context = {
      ...experimentContext,
      strategy: { id: 'experiment-x4-ui', name: 'X4 UI', status: 'active' },
      evidenceLayers: [
        {
          id: 'trial',
          title: '样本 Trial',
          status: 'memory-only',
          persisted: false,
          description: '当前页面内存。',
        },
        {
          id: 'historical-evaluation',
          title: '历史评估',
          status: 'complete',
          persisted: true,
          description: '持久化历史事实。',
        },
        {
          id: 'strict-backtest',
          title: '严格回测',
          status: 'unavailable',
          persisted: true,
          description: '数据门禁未满足。',
        },
        {
          id: 'signal-observation',
          title: '真实 SignalObservation',
          status: 'partial',
          persisted: true,
          description: '真实后续事实。',
        },
      ],
      observations: {
        horizon: 't5',
        stats: [],
        benchmarkCoverageRatio: 1,
        observationIds: ['observation-t1-zero'],
        observationLinks: [observationLink],
        horizons: [
          {
            horizon: 't1',
            total: 1,
            complete: 1,
            missing: 0,
            pending: 0,
            unavailable: 0,
            untracked: 0,
            uniqueStocks: 1,
            missingRate: 0,
            benchmarkComplete: 1,
            benchmarkTotal: 1,
            benchmarkCoverageRatio: 1,
            observationIds: ['observation-t1-zero'],
            observationLinks: [observationLink],
            averageReturnPct: 0,
            medianReturnPct: 0,
            p25ReturnPct: 0,
            p75ReturnPct: 0,
            averageMaxFavorableExcursionPct: 0,
            averageMaxAdverseExcursionPct: 0,
          },
          {
            horizon: 't3',
            total: 2,
            complete: 0,
            missing: 2,
            pending: 1,
            unavailable: 0,
            untracked: 1,
            uniqueStocks: 2,
            missingRate: 1,
            benchmarkComplete: 0,
            benchmarkTotal: 0,
            benchmarkCoverageRatio: 0,
            observationIds: [],
            observationLinks: [],
          },
        ],
      },
      realObservations: {
        status: 'unavailable',
        versionId: 'experiment-ui-v1',
        runIds: [],
        horizons: [],
        observationIds: [],
        observationLinks: [],
        limitations: ['尚无真实生产 SignalObservation。'],
      },
      strictBacktests: [],
    };
    globalThis.fetch = async (path) =>
      String(path).includes('/api/strategy/dsl-catalog')
        ? jsonResponse({ ok: true, data: experimentCatalog })
        : jsonResponse({ ok: true, data: x4Context });
    const node = await renderStrategyExperiment(
      'experiment-x4-ui',
      () => {},
      async () => {},
    );
    expect(node.textContent).toContain('四层证据，不混用');
    expect(node.querySelectorAll('.experiment-evidence-layer').length).toBe(4);
    expect(node.textContent).toContain('仅页面内存');
    expect(node.textContent).toContain('T+1');
    expect(node.textContent).toContain('T+3');
    expect(node.textContent).toContain('未建档');
    expect(node.textContent).toContain('0.00%');
    expect(node.textContent).toContain('尚无真实生产 SignalObservation');
    expect(node.textContent).toContain('严格回测');

    const noObservationContext = {
      ...x4Context,
      strategy: { id: 'experiment-x4-ui-no-observation', name: 'X4 empty facts', status: 'active' },
      observations: {
        ...x4Context.observations,
        observationIds: [],
        observationLinks: [],
        horizons: [
          {
            horizon: 't1',
            total: 2,
            complete: 0,
            missing: 2,
            pending: 0,
            unavailable: 0,
            untracked: 2,
            uniqueStocks: 2,
            missingRate: 1,
            benchmarkComplete: 0,
            benchmarkTotal: 0,
            benchmarkCoverageRatio: 0,
            observationIds: [],
            observationLinks: [],
          },
        ],
      },
      realObservations: {
        ...x4Context.realObservations,
        versionId: undefined,
      },
    };
    globalThis.fetch = async (path) =>
      String(path).includes('/api/strategy/dsl-catalog')
        ? jsonResponse({ ok: true, data: experimentCatalog })
        : jsonResponse({ ok: true, data: noObservationContext });
    const noObservationNode = await renderStrategyExperiment(
      'experiment-x4-ui-no-observation',
      () => {},
      async () => {},
    );
    expect(noObservationNode.querySelectorAll('.experiment-wide-table').length).toBe(1);
    expect(noObservationNode.textContent).toContain('0 / 2');
    expect(noObservationNode.textContent).toContain('未建档');
  });

  it('载入 EARLY_BREAKOUT_V2_DRAFT 只改变页面内存，不发送 POST', async () => {
    invalidateExperimentCache();
    const starterDefinition = {
      ...experimentDefinition,
      metadata: { ...experimentDefinition.metadata, style: 'early-breakout-v2' },
      signals: {
        ...experimentDefinition.signals,
        entry: [
          {
            id: 'starter-entry',
            name: 'Starter 入场',
            when: 'quote.close > 0',
            score: '50',
            direction: 'bullish',
            evidence: ['starter fixture'],
          },
        ],
      },
    };
    const starterContext = {
      ...experimentContext,
      strategy: { id: 'experiment-starter', name: 'Starter UI', status: 'active' },
      starterTemplate: {
        id: 'early-breakout-v2',
        name: '早期突破 V2',
        description: 'starter fixture',
        revision: 4,
        definition: starterDefinition,
        definitionHash: 'c'.repeat(64),
      },
    };
    const calls = [];
    globalThis.fetch = async (path, init) => {
      calls.push({ path: String(path), method: init?.method ?? 'GET' });
      return String(path).includes('/api/strategy/dsl-catalog')
        ? jsonResponse({ ok: true, data: experimentCatalog })
        : jsonResponse({ ok: true, data: starterContext });
    };
    const node = await renderStrategyExperiment(
      'experiment-starter',
      () => {},
      async () => {},
    );
    node
      .querySelectorAll('button')
      .find((button) => button.textContent === '载入到本地编辑器')
      .click();
    await flush();

    const rerendered = await renderStrategyExperiment(
      'experiment-starter',
      () => {},
      async () => {},
    );
    rerendered
      .querySelectorAll('button')
      .find((button) => button.textContent === 'JSON 高级')
      .click();
    const editor = rerendered
      .querySelectorAll('textarea')
      .find((textarea) => textarea.className.includes('experiment-json-editor'));
    expect(editor.value).toContain('starter-entry');
    expect(calls.filter((call) => call.method === 'POST')).toHaveLength(0);
  });

  it('严格回测经过二次确认，第二步取消时不发送 POST', async () => {
    invalidateExperimentCache();
    const strictContext = {
      ...experimentContext,
      strategy: { id: 'experiment-strict-confirm', name: 'Strict confirm UI', status: 'active' },
      validation: {
        session: {
          id: 'strict-confirm-session',
          strategyId: 'experiment-strict-confirm',
          strategyVersionId: 'experiment-ui-v2',
          from: '2026-08-01T00:00:00.000Z',
          to: '2026-08-08T00:00:00.000Z',
          status: 'complete',
          definitionHash: 'b'.repeat(64),
          createdAt: '2026-08-08T00:00:00.000Z',
        },
        days: [],
        runIds: [],
        vintageCoverageRatio: 1,
        evaluatorIdentityStatus: 'consistent',
        evaluatorIdentities: [],
      },
      strictBacktests: [],
    };
    const calls = [];
    globalThis.fetch = async (path, init) => {
      calls.push({ path: String(path), method: init?.method ?? 'GET' });
      return String(path).includes('/api/strategy/dsl-catalog')
        ? jsonResponse({ ok: true, data: experimentCatalog })
        : jsonResponse({ ok: true, data: strictContext });
    };
    const node = await renderStrategyExperiment(
      'experiment-strict-confirm',
      () => {},
      async () => {},
    );
    node
      .querySelectorAll('button')
      .find((button) => button.textContent === '创建严格回测')
      .click();
    modalBody
      .querySelectorAll('button')
      .find((button) => button.textContent === '继续填写后确认')
      .click();
    await flush();
    modalBody
      .querySelectorAll('button')
      .find((button) => button.textContent === '取消')
      .click();
    await flush();

    expect(calls.filter((call) => call.method === 'POST')).toHaveLength(0);
    expect(modalOverlay.hidden).toBe(true);
  });

  it('JSON 高级模式解析失败后仍可恢复到结构化编辑', async () => {
    invalidateExperimentCache();
    globalThis.fetch = async (path) => {
      if (String(path).includes('/api/strategy/dsl-catalog')) {
        return jsonResponse({ ok: true, data: experimentCatalog });
      }
      return jsonResponse({
        ok: true,
        data: {
          ...experimentContext,
          candidateVersion: undefined,
          versionState: {
            ...experimentContext.versionState,
            candidatePersisted: false,
            candidateValid: false,
          },
        },
      });
    };
    const node = await renderStrategyExperiment(
      'experiment-json-recovery',
      () => {},
      async () => {},
    );
    node
      .querySelectorAll('button')
      .find((button) => button.textContent === 'JSON 高级')
      .click();
    const editor = node
      .querySelectorAll('textarea')
      .find((textarea) => textarea.className.includes('experiment-json-editor'));
    expect(editor).toBeDefined();
    editor.value = '{ broken';
    editor.dispatchEvent({ type: 'input' });
    expect(node.textContent).toContain('JSON 格式无效');
    node
      .querySelectorAll('button')
      .find((button) => button.textContent === '结构化编辑')
      .click();
    expect(node.textContent).toContain('规则构建器');
  });

  it('JSON 连续输入不重挂载 textarea，保留焦点与同一编辑节点', async () => {
    invalidateExperimentCache();
    globalThis.fetch = async (path) =>
      String(path).includes('/api/strategy/dsl-catalog')
        ? jsonResponse({ ok: true, data: experimentCatalog })
        : jsonResponse({ ok: true, data: experimentContext });
    const node = await renderStrategyExperiment(
      'experiment-json-focus',
      () => {},
      async () => {},
    );
    node
      .querySelectorAll('button')
      .find((button) => button.textContent === 'JSON 高级')
      .click();
    const editor = node
      .querySelectorAll('textarea')
      .find((textarea) => textarea.className.includes('experiment-json-editor'));
    editor.focus();
    editor.value = JSON.stringify(experimentDefinition);
    editor.dispatchEvent({ type: 'input' });
    expect(
      node
        .querySelectorAll('textarea')
        .find((textarea) => textarea.className.includes('experiment-json-editor')),
    ).toBe(editor);
    expect(document.activeElement).toBe(editor);
  });

  it('Trial 外部失败后恢复按钮，不留下自动持久化假象', async () => {
    invalidateExperimentCache();
    const calls = [];
    globalThis.fetch = async (path, init) => {
      const url = String(path);
      calls.push({ url, method: init?.method ?? 'GET' });
      if (url.includes('/api/strategy/dsl-catalog'))
        return jsonResponse({ ok: true, data: experimentCatalog });
      if (url.includes('/api/strategies/experiment-trial-failure/trial')) {
        return jsonResponse({
          ok: false,
          error: { kind: 'unsupported_capability', message: '行情适配器暂不可用' },
        });
      }
      return jsonResponse({
        ok: true,
        data: {
          ...experimentContext,
          strategy: { id: 'experiment-trial-failure', name: 'Trial failure', status: 'active' },
        },
      });
    };
    const node = await renderStrategyExperiment(
      'experiment-trial-failure',
      () => {},
      async () => {},
    );
    node
      .querySelectorAll('button')
      .find((button) => button.textContent === '运行样本 Trial')
      .click();
    modalBody
      .querySelectorAll('button')
      .find((button) => button.textContent === '开始 Trial')
      .click();
    for (
      let attempt = 0;
      attempt < 20 && !node.textContent.includes('行情适配器暂不可用');
      attempt += 1
    )
      await flush();
    expect(node.textContent).toContain('Trial 失败：行情适配器暂不可用');
    expect(node.textContent).toContain('可以修复外部数据或权限后再次运行');
    expect(
      node.querySelectorAll('button').find((button) => button.textContent === '运行样本 Trial')
        .disabled,
    ).toBe(false);
    expect(calls.filter((call) => call.method === 'POST').length).toBe(1);
  });

  it('独立验证进行中展示取消入口，取消仍是显式确认动作', async () => {
    invalidateExperimentCache();
    const statuses = [];
    const runningContext = {
      ...experimentContext,
      strategy: { id: 'experiment-cancel', name: 'Cancel validation', status: 'active' },
      validation: {
        session: {
          id: 'validation-running',
          strategyId: 'experiment-cancel',
          strategyVersionId: 'experiment-ui-v2',
          from: '2026-08-01T00:00:00.000Z',
          to: '2026-08-30T00:00:00.000Z',
          status: 'running',
          definitionHash: 'b'.repeat(64),
          createdAt: '2026-08-30T00:00:00.000Z',
        },
        days: [],
        runIds: [],
        vintageCoverageRatio: 0,
      },
    };
    globalThis.fetch = async (path, init) => {
      if (String(path).includes('/api/strategy/dsl-catalog')) {
        return jsonResponse({ ok: true, data: experimentCatalog });
      }
      if (
        init?.method === 'POST' &&
        String(path).includes('/backtests/validation-running/cancel')
      ) {
        return jsonResponse({
          ok: true,
          data: { session: { ...runningContext.validation.session, status: 'failed' } },
        });
      }
      return jsonResponse({ ok: true, data: runningContext });
    };
    const node = await renderStrategyExperiment(
      'experiment-cancel',
      (message) => statuses.push(message),
      async () => {},
    );
    expect(
      await node.querySelectorAll('button').find((button) => button.textContent === '取消独立验证'),
    ).toBeDefined();
    node
      .querySelectorAll('button')
      .find((button) => button.textContent === '取消独立验证')
      .click();
    modalBody
      .querySelectorAll('button')
      .find((button) => button.textContent === '取消验证')
      .click();
    await flush();
    expect(statuses.at(-1)).toContain('已请求取消独立验证');
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
                observationHorizons: ['t1', 't5'],
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
    expect(node.textContent).toContain('自动生成并保存 AI Advice');
    expect(node.textContent).toContain('accepted + published operational run');
    expect(node.textContent).toContain('不会自动交易');
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
      't1',
      't3',
      't5',
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
      observationHorizons: ['t1', 't5'],
    });
  });

  it('Legacy V1 不静默升级，显式升级/降级取消均不发送 POST', async () => {
    invalidateSettingsCache();
    let postCount = 0;
    let savedBody;
    const statusMessages = [];
    globalThis.fetch = async (path, init) => {
      const url = String(path);
      if (url.includes('/recommendation-preflights')) {
        return jsonResponse({
          ok: true,
          data: { strategyId: 'policy-version-ui', runs: [], reasonCounts: [], limitations: [] },
        });
      }
      if (url.endsWith('/schedule')) {
        if (init?.method === 'POST') {
          postCount += 1;
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
                enabled: false,
                minScore: 70,
                maxRank: 10,
                maxPerRun: 3,
                cooldownHours: 72,
                notify: true,
                channel: 'log',
                observationHorizons: ['t3', 't5', 't20'],
              },
            },
          },
        });
      }
      return jsonResponse({
        ok: true,
        data: {
          strategy: {
            id: 'policy-version-ui',
            name: '版本切换策略',
            status: 'active',
            currentVersionId: 'v1',
          },
          versions: [],
        },
      });
    };
    const node = await renderSettings(
      'policy-version-ui',
      (message, isError) => statusMessages.push({ message, isError }),
      async () => {},
    );
    expect(node.textContent).toContain('Legacy V1');
    expect(node.textContent).toContain('不会静默升级');
    node
      .querySelectorAll('button')
      .find((button) => button.textContent === '保存调度')
      .click();
    await flush();
    expect(postCount).toBe(1);
    expect(savedBody.recommendationPolicy).not.toHaveProperty('schemaVersion');
    expect(savedBody.recommendationPolicy).not.toHaveProperty('portfolioPreflight');

    const upgrade = node
      .querySelectorAll('button')
      .find((button) => button.textContent === '启用账户预检 V2');
    upgrade.click();
    await flush();
    expect(modalBody.textContent).toContain('确认选择 Account-gated V2');
    modalBody
      .querySelectorAll('button')
      .find((button) => button.textContent === '取消')
      .click();
    await flush();
    expect(postCount).toBe(1);
    expect(node.textContent).toContain('Legacy V1');

    upgrade.click();
    await flush();
    modalBody
      .querySelectorAll('button')
      .find((button) => button.textContent === '选择 V2')
      .click();
    await flush();
    expect(node.textContent).toContain('Account-gated V2');
    expect(node.textContent).toContain('候选资格');
    expect(node.textContent).toContain('账户暴露');
    expect(node.textContent).toContain('信号冲突');
    expect(node.textContent).toContain('数据质量');
    const maxSingle = node
      .querySelectorAll('input')
      .find((input) => input.id === 'strategy-preflight-max-single-exposure');
    const maxIndustry = node
      .querySelectorAll('input')
      .find((input) => input.id === 'strategy-preflight-max-industry-exposure');
    const maxAge = node
      .querySelectorAll('input')
      .find((input) => input.id === 'strategy-preflight-max-data-age');
    expect(maxSingle.value).toBe('');
    expect(maxIndustry.value).toBe('');
    maxAge.value = '';
    node
      .querySelectorAll('button')
      .find((button) => button.textContent === '保存调度')
      .click();
    await flush();
    expect(postCount).toBe(1);
    expect(modalOverlay.hidden).toBe(true);
    expect(statusMessages[statusMessages.length - 1]).toMatchObject({
      isError: true,
    });
    expect(statusMessages[statusMessages.length - 1].message).toContain('最大数据年龄');

    maxAge.value = '31';
    node
      .querySelectorAll('button')
      .find((button) => button.textContent === '保存调度')
      .click();
    await flush();
    expect(postCount).toBe(1);
    expect(modalOverlay.hidden).toBe(true);

    maxAge.value = '1.5';
    node
      .querySelectorAll('button')
      .find((button) => button.textContent === '保存调度')
      .click();
    await flush();
    expect(postCount).toBe(1);
    expect(modalOverlay.hidden).toBe(true);

    maxAge.value = '0';
    node
      .querySelectorAll('button')
      .find((button) => button.textContent === '保存调度')
      .click();
    await flush();
    expect(modalBody.textContent).toContain('确认保存 V2');
    modalBody
      .querySelectorAll('button')
      .find((button) => button.textContent === '取消')
      .click();
    await flush();
    expect(postCount).toBe(1);

    maxAge.value = '1';

    node
      .querySelectorAll('button')
      .find((button) => button.textContent === '保存调度')
      .click();
    await flush();
    modalBody
      .querySelectorAll('button')
      .find((button) => button.textContent === '确认保存 V2')
      .click();
    await flush();
    expect(postCount).toBe(2);
    expect(savedBody.recommendationPolicy).toEqual({
      schemaVersion: 2,
      enabled: false,
      minScore: 70,
      maxRank: 10,
      maxPerRun: 3,
      cooldownHours: 72,
      notify: true,
      channel: 'log',
      observationHorizons: ['t3', 't5'],
      portfolioPreflight: {
        skipExistingHolding: true,
        requireLiquidityFacts: true,
        maxDataAgeTradingDays: 1,
        rejectOnExitSignal: true,
        rejectOnRiskSignal: true,
      },
    });

    const downgrade = node
      .querySelectorAll('button')
      .find((button) => button.textContent === '切回 Legacy V1');
    downgrade.click();
    await flush();
    expect(modalBody.textContent).toContain('会丢弃本次保存的账户预检配置');
    modalBody
      .querySelectorAll('button')
      .find((button) => button.textContent === '取消')
      .click();
    await flush();
    expect(postCount).toBe(2);
  });

  it('V2 设置刷新后无损回填，并展示历史状态、reason code 和 factCount', async () => {
    invalidateSettingsCache();
    globalThis.fetch = async (path) => {
      const url = String(path);
      if (url.includes('/recommendation-preflights')) {
        return jsonResponse({
          ok: true,
          data: {
            strategyId: 'policy-v2-refresh',
            runs: [
              {
                startedAt: '2026-08-31T09:00:00.000Z',
                finishedAt: '2026-08-31T09:01:00.000Z',
                workflowStatus: 'partial',
                total: 2,
                eligible: 1,
                skipped: 1,
                unavailable: 0,
                candidates: [
                  {
                    stockId: '000001.SZ',
                    status: 'eligible',
                    reasonCodes: [],
                    factCount: 4,
                    evaluatedAt: '2026-08-31T09:00:30.000Z',
                  },
                  {
                    stockId: '600519.SH',
                    status: 'skipped',
                    reasonCodes: ['existing-holding', 'cooldown'],
                    factCount: 2,
                    evaluatedAt: '2026-08-31T09:00:31.000Z',
                  },
                ],
              },
            ],
            reasonCounts: [
              { code: 'existing-holding', count: 1 },
              { code: 'cooldown', count: 1 },
            ],
            limitations: [],
          },
        });
      }
      if (url.endsWith('/schedule')) {
        return jsonResponse({
          ok: true,
          data: {
            schedule: {
              cron: '0 18 * * 1-5',
              timezone: 'Asia/Shanghai',
              enabled: true,
              recommendationPolicy: {
                schemaVersion: 2,
                enabled: true,
                minScore: 82,
                maxRank: 4,
                maxPerRun: 2,
                cooldownHours: 24,
                notify: false,
                channel: 'log',
                observationHorizons: ['t1'],
                portfolioPreflight: {
                  maxSinglePositionExposurePct: 12.5,
                  maxIndustryExposurePct: 35,
                  skipExistingHolding: false,
                  requireLiquidityFacts: true,
                  maxDataAgeTradingDays: 2,
                  rejectOnExitSignal: false,
                  rejectOnRiskSignal: true,
                },
              },
            },
          },
        });
      }
      return jsonResponse({
        ok: true,
        data: {
          strategy: {
            id: 'policy-v2-refresh',
            name: 'V2 回填策略',
            status: 'active',
            currentVersionId: 'v1',
          },
          versions: [],
        },
      });
    };
    const node = await renderSettings(
      'policy-v2-refresh',
      () => {},
      async () => {},
    );
    expect(node.textContent).toContain('Account-gated V2');
    expect(node.textContent).toContain('可进入 Advice 分析');
    expect(node.textContent).toContain('已有持仓');
    expect(node.textContent).toContain('existing-holding');
    expect(node.textContent).toContain('冷却中');
    expect(node.textContent).toContain('cooldown');
    expect(node.textContent).toContain('最近 1 次原因分布');
    expect(node.textContent).toContain('事实 2');
    expect(node.textContent).not.toContain('accountId');
    expect(node.textContent).not.toContain('runId');
    expect(
      node
        .querySelectorAll('input')
        .find((input) => input.id === 'strategy-preflight-max-single-exposure').value,
    ).toBe('12.5');
    expect(
      node
        .querySelectorAll('input')
        .find((input) => input.id === 'strategy-preflight-max-industry-exposure').value,
    ).toBe('35');
    expect(
      node.querySelectorAll('input').find((input) => input.id === 'strategy-preflight-max-data-age')
        .value,
    ).toBe('2');
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
