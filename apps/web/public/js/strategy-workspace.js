import { callApi } from './api.js';
import { changeClass } from './market-shared.js';
import { closeModal, confirmDialog, openModal, promptDialog } from './modal.js';
import { stockIdentityLink } from './stock-link.js';
import {
  $,
  createPagination,
  el,
  fmtDateTime,
  fmtNum,
  fmtSigned,
  mount,
  sortableHeader,
} from './ui.js';

const STRATEGY_TABS = new Set([
  'overview',
  'experiment',
  'pool',
  'runs',
  'insights',
  'cycle',
  'settings',
]);

export const parseStrategyHash = (hash) => {
  const raw = String(hash ?? '').replace(/^#/, '');
  const queryIndex = raw.indexOf('?');
  const params = new URLSearchParams(queryIndex === -1 ? '' : raw.slice(queryIndex + 1));
  const tab = params.get('tab') ?? 'overview';
  const scope = params.get('scope');
  return {
    strategyId: params.get('strategyId') ?? '',
    tab: STRATEGY_TABS.has(tab) ? tab : 'overview',
    ...(scope === 'evaluation' ? { scope: 'evaluation' } : {}),
    ...(params.has('runId') ? { runId: params.get('runId') ?? '' } : {}),
    ...(params.has('compareRunId') ? { compareRunId: params.get('compareRunId') ?? '' } : {}),
  };
};

export const buildStrategyHash = (state) => {
  const params = new URLSearchParams();
  if (state.strategyId) params.set('strategyId', state.strategyId);
  params.set('tab', STRATEGY_TABS.has(state.tab) ? state.tab : 'overview');
  if (state.scope === 'evaluation') params.set('scope', 'evaluation');
  if (state.runId) params.set('runId', state.runId);
  if (state.compareRunId) params.set('compareRunId', state.compareRunId);
  return `#strategies?${params.toString()}`;
};

const TAB_LABELS = {
  overview: '概览',
  experiment: '实验',
  pool: '股票池',
  runs: '执行记录',
  insights: 'AI 洞察',
  cycle: '闭环',
  settings: '设置',
};
const STRATEGY_STATUS = {
  active: ['运行中', 'badge-active'],
  draft: ['草稿', 'badge-draft'],
  paused: ['已暂停', 'badge-paused'],
  archived: ['已归档', 'badge-neutral'],
};
const RUN_STATUS = {
  complete: ['已完成', 'badge-active'],
  partial: ['已完成（历史）', 'badge-important'],
  failed: ['失败', 'badge-pos'],
  running: ['运行中', 'badge-neutral'],
};
const RUN_SCOPE = {
  operational: ['生产', 'badge-active'],
  evaluation: ['历史评估', 'badge-neutral'],
};
const PUBLICATION_STATUS = {
  published: ['已发布', 'badge-active'],
  withheld: ['暂不发布', 'badge-important'],
  'non-publishing': ['不进入当前', 'badge-neutral'],
};
const DATA_HEALTH = {
  complete: '完整',
  partial: '部分可用',
  unavailable: '不可用',
};
const RULE_STATUS = {
  matched: ['命中', 'badge-active'],
  'not-matched': ['未命中', 'badge-neutral'],
  unknown: ['数据缺失', 'badge-important'],
  error: ['求值错误', 'badge-pos'],
};
const RESULT_VIEW_STATUS = {
  selected: ['入选', 'badge-active'],
  incomplete: ['数据不完整', 'badge-important'],
  excluded: ['未入选', 'badge-neutral'],
};

const EXPERIMENT_HORIZONS = ['t1', 't3', 't5'];
const EXPERIMENT_STATUS = {
  'not-started': ['未开始', 'experiment-status-idle'],
  ready: ['待执行', 'experiment-status-ready'],
  eligible: ['可评审', 'experiment-status-ready'],
  'memory-only': ['仅页面内存', 'experiment-status-ready'],
  running: ['进行中', 'experiment-status-running'],
  complete: ['已完成', 'experiment-status-complete'],
  blocked: ['受阻', 'experiment-status-blocked'],
  unavailable: ['不可用', 'experiment-status-unavailable'],
};
const EXPERIMENT_REASON_LABELS = {
  'base-version-missing': '缺少基线版本',
  'candidate-version-missing': '缺少未发布候选版本',
  'candidate-already-published': '候选版本已发布',
  'candidate-not-valid': '候选版本尚未通过校验',
  'candidate-parent-mismatch': '候选版本未从当前基线派生',
  'definition-unchanged': '定义没有产生变化',
  'validation-session-missing': '缺少独立验证会话',
  'validation-version-mismatch': '验证版本与候选不一致',
  'validation-not-complete': '独立验证尚未完成',
  'validation-days-insufficient': '独立验证交易日不足',
  'pit-vintage-coverage-insufficient': 'PIT vintage 覆盖不足',
  'observations-insufficient': '完整观察样本不足',
  'benchmark-coverage-insufficient': 'benchmark 覆盖不足',
};
const EXPERIMENT_DATA_SOURCE_LABELS = {
  quote: '实时行情',
  'daily-bars': '前复权日线',
  meta: '派生元数据',
  'limit-up-ladder': '涨停梯队',
};
const EXPERIMENT_TYPE_LABELS = {
  number: '数值',
  boolean: '布尔',
  string: '文本',
};
const EXPERIMENT_CHANGE_LABELS = {
  added: '新增',
  removed: '移除',
  changed: '变更',
};
const EXPERIMENT_SIGNAL_SCOPES = [
  ['entry', '入场'],
  ['exit', '退出'],
  ['risk', '风险'],
];

const RECOMMENDATION_POLICY_V2_DEFAULTS = {
  skipExistingHolding: true,
  requireLiquidityFacts: true,
  maxDataAgeTradingDays: 1,
  rejectOnExitSignal: true,
  rejectOnRiskSignal: true,
};

const PREFLIGHT_REASON_LABELS = {
  'run-not-publishable': '运行未达到发布门槛',
  'account-facts-unavailable': '账户事实不可用',
  'candidate-data-unavailable': '候选数据不可用',
  'candidate-data-stale': '候选数据过旧',
  'signal-facts-unavailable': '信号事实不可用',
  'entry-exit-conflict': '入场 / 退出冲突',
  'entry-risk-conflict': '入场 / 风险冲突',
  'exit-risk-conflict': '退出 / 风险冲突',
  'exit-signal': '存在退出信号',
  'risk-signal': '存在风险信号',
  'holding-facts-unavailable': '持仓事实不可用',
  'existing-holding': '已有持仓',
  'same-strategy-duplicate-exposure': '同策略重复暴露',
  'strategy-exposure-facts-unavailable': '策略暴露事实不可用',
  'single-position-exposure-unavailable': '单仓暴露不可用',
  'single-position-exposure-exceeded': '单仓暴露超过阈值',
  'industry-facts-unavailable': '行业事实不可用',
  'industry-exposure-unavailable': '行业暴露不可用',
  'industry-exposure-exceeded': '行业暴露超过阈值',
  'portfolio-valuation-unavailable': '组合估值不可用',
  'liquidity-facts-unavailable': '流动性事实不可用',
  'cooldown-facts-unavailable': '冷却事实不可用',
  cooldown: '冷却中',
};

const PREFLIGHT_STATUS = {
  eligible: ['可进入 Advice 分析', 'badge-active'],
  skipped: ['已跳过', 'badge-important'],
  unavailable: ['事实不可用', 'badge-neutral'],
};

let requestEpoch = 0;
const responseCache = new Map();
const experimentStateByStrategy = new Map();

export const invalidateStrategyWorkspaceCache = () => responseCache.clear();

const errorText = (result) => {
  const error = result?.error;
  if (error === undefined) return '请求失败';
  if (error.message) return error.message;
  if (error.cause) return error.cause;
  if (error.entity) return `${error.entity}不存在`;
  return error.kind ?? '请求失败';
};

const cachedGet = async (path) => {
  if (responseCache.has(path)) return responseCache.get(path);
  const pending = callApi(path);
  responseCache.set(path, pending);
  const result = await pending;
  if (!result.ok) responseCache.delete(path);
  return result;
};

const post = (path, body) => callApi(path, { method: 'POST', body: JSON.stringify(body) });

const cloneDefinition = (definition) => {
  if (definition === undefined || definition === null) return undefined;
  return JSON.parse(JSON.stringify(definition));
};

const fieldByPath = (catalog, path) => (catalog?.fields ?? []).find((field) => field.path === path);

const SIMPLE_COMPARISON_OPERATORS = ['>', '>=', '==', '===', '<', '<=', '!=', '!=='];
const STRUCTURED_FIELD_TYPES = ['number', 'boolean'];

const conditionOperators = (field) => {
  if (field === undefined) return [];
  return SIMPLE_COMPARISON_OPERATORS.filter((operator) => field.operators?.includes(operator));
};

const defaultField = (catalog) =>
  (catalog?.fields ?? []).find((field) => field.type === 'number') ??
  (catalog?.fields ?? []).find((field) => field.type === 'boolean');

const structuredFields = (catalog) =>
  (catalog?.fields ?? []).filter((field) => STRUCTURED_FIELD_TYPES.includes(field.type));

const numericFields = (catalog) =>
  (catalog?.fields ?? []).filter((field) => field.type === 'number');

const defaultFieldValue = (field) => {
  if (field?.type === 'boolean') return 'true';
  if (field?.type === 'number') return '0';
  return '';
};

const defaultFieldOperator = (field) => conditionOperators(field)[0] ?? '==';

/**
 * 结构化编辑器只拼接来自 catalog 的字段和运算符，不在浏览器执行表达式。
 * 最终定义仍由服务端 schema / Field Registry 校验。
 */
export const buildExperimentSimpleExpression = (field, operator, value) => {
  if (
    field === undefined ||
    typeof field.path !== 'string' ||
    !['number', 'boolean'].includes(field.type) ||
    !SIMPLE_COMPARISON_OPERATORS.includes(operator) ||
    !field.operators?.includes(operator)
  ) {
    return '';
  }
  const rendered =
    field.type === 'boolean'
      ? String(value).trim().toLowerCase() === 'true'
        ? 'true'
        : 'false'
      : field.type === 'number'
        ? String(value).trim()
        : String(value).trim();
  return `${field.path} ${operator} ${rendered}`.trim();
};

const SIMPLE_EXPRESSION_RE =
  /^\s*([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)\s*(===|!==|==|!=|<=|>=|<|>)\s*(true|false|-?(?:\d+(?:\.\d*)?|\.\d+))\s*$/;

const parseSimpleExpression = (expression, catalog) => {
  const match = String(expression ?? '').match(SIMPLE_EXPRESSION_RE);
  if (match === null) return undefined;
  const field = fieldByPath(catalog, match[1]);
  if (
    field === undefined ||
    !['number', 'boolean'].includes(field.type) ||
    !SIMPLE_COMPARISON_OPERATORS.includes(match[2]) ||
    !field.operators?.includes(match[2])
  )
    return undefined;
  if (field.type === 'boolean' && match[3] !== 'true' && match[3] !== 'false') return undefined;
  if (field.type === 'number' && (match[3] === 'true' || match[3] === 'false')) return undefined;
  return { field, operator: match[2], value: match[3] };
};

const SCORE_LITERAL_RE = /^-?(?:\d+(?:\.\d*)?|\.\d+)$/;
const SCORE_FIELD_RE =
  /^(?:\$\{([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)\}|([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*))$/;

const normalizeScoreLiteral = (value) => {
  const text = String(value ?? '').trim();
  if (!SCORE_LITERAL_RE.test(text)) return undefined;
  const number = Number(text);
  return Number.isFinite(number) && number >= 0 && number <= 100 ? String(number) : undefined;
};

const parseSimpleScoreExpression = (expression, catalog) => {
  const text = String(expression ?? '').trim();
  const literal = normalizeScoreLiteral(text);
  if (literal !== undefined) return { mode: 'constant', value: literal };
  const match = text.match(SCORE_FIELD_RE);
  if (match === null) return undefined;
  const field = fieldByPath(catalog, match[1] ?? match[2]);
  return field?.type === 'number' ? { mode: 'field', field, value: field.path } : undefined;
};

/** 结构化模式只能从当前 catalog 生成固定分数或已注册数值字段引用。 */
export const buildExperimentScoreExpression = (mode, catalog, value) => {
  if (mode === 'constant') return normalizeScoreLiteral(value) ?? '';
  if (mode !== 'field') return '';
  const field = fieldByPath(catalog, value);
  return field?.type === 'number' ? `\${${field.path}}` : '';
};

/** 以 prefix 的最高已用序号递增，删除规则后也不会与现存 id 碰撞。 */
export const nextExperimentRuleId = (rules, prefix) => {
  const ids = new Set((rules ?? []).map((rule) => String(rule?.id ?? '')));
  const pattern = new RegExp(
    `^${String(prefix).replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}-(\\d+)$`,
  );
  let next = 0;
  for (const id of ids) {
    const match = id.match(pattern);
    if (match !== null) next = Math.max(next, Number(match[1]));
  }
  let candidate = `${prefix}-${Math.max(1, next + 1)}`;
  while (ids.has(candidate)) {
    next += 1;
    candidate = `${prefix}-${next}`;
  }
  return candidate;
};

export const nextExperimentScoringRuleId = (selectionRules, components) => {
  const used = new Set((components ?? []).map((component) => component?.ruleId));
  return (selectionRules ?? []).find((rule) => !used.has(rule.id))?.id;
};

const normalizeScoringComponents = (components) => {
  if (components.length === 0) return [];
  const rawWeights = components.map((component) => Number(component.weight));
  const total = rawWeights.reduce(
    (sum, weight) => (Number.isFinite(weight) && weight > 0 ? sum + weight : sum),
    0,
  );
  const usable = total > 0 && rawWeights.every((weight) => Number.isFinite(weight) && weight > 0);
  const weights = usable ? rawWeights : components.map(() => 1);
  const weightTotal = usable ? total : components.length;
  let allocated = 0;
  return components.map((component, index) => {
    const weight = index === components.length - 1 ? 1 - allocated : weights[index] / weightTotal;
    allocated += weight;
    return { ...component, weight };
  });
};

/** 删除 selection rule 时同步清理 scoring 引用，并保持剩余权重可通过 schema。 */
export const removeExperimentSelectionRule = (definition, ruleId) => {
  const selection = definition.selection ?? { logic: 'all', rules: [] };
  const nextRules = (selection.rules ?? []).filter((rule) => rule.id !== ruleId);
  const nextDefinition = {
    ...definition,
    selection: { ...selection, rules: nextRules },
  };
  const scoring = definition.scoring;
  if (scoring === undefined) return nextDefinition;
  const seen = new Set();
  const validIds = new Set(nextRules.map((rule) => rule.id));
  const components = (scoring.components ?? []).filter((component) => {
    if (!validIds.has(component.ruleId) || seen.has(component.ruleId)) return false;
    seen.add(component.ruleId);
    return true;
  });
  if (components.length === 0) {
    const { scoring: _removed, ...withoutScoring } = nextDefinition;
    return withoutScoring;
  }
  return {
    ...nextDefinition,
    scoring: { ...scoring, components: normalizeScoringComponents(components) },
  };
};

const replaceExperimentDefinition = (target, next) => {
  for (const key of Object.keys(target)) {
    if (!(key in next)) delete target[key];
  }
  Object.assign(target, next);
};

const makeSimpleRule = (catalog, idPrefix, idOrIndex = 1) => {
  const id = typeof idOrIndex === 'number' ? `${idPrefix}-${idOrIndex}` : idOrIndex;
  const field = defaultField(catalog);
  if (field === undefined) {
    return {
      id,
      name: id,
      when: 'true',
      evidence: ['规则已启用'],
    };
  }
  const value = defaultFieldValue(field);
  return {
    id,
    name: `${EXPERIMENT_TYPE_LABELS[field.type] ?? '字段'}条件`,
    when: buildExperimentSimpleExpression(field, defaultFieldOperator(field), value),
    evidence: [`${field.path} = \${${field.path}}`],
  };
};

const makeSimpleSignal = (catalog, scope, idOrIndex = 1) => {
  const rule = makeSimpleRule(catalog, `${scope}-rule`, idOrIndex);
  return {
    ...rule,
    name: `${scope === 'entry' ? '入场' : scope === 'exit' ? '退出' : '风险'}条件`,
    score: '60',
    direction: scope === 'exit' ? 'bearish' : 'bullish',
    emission: { mode: 'level', cooldownTradingDays: 0 },
  };
};

export const createExperimentBlankDefinition = (catalog) => {
  const selectionRule = makeSimpleRule(catalog, 'selection', 'selection-1');
  return {
    schemaVersion: 1,
    metadata: { horizon: 'short' },
    universe: { coverage: 'CN_A_SHARES_SH_SZ', excludeStockIds: [] },
    selection: { logic: 'all', rules: [selectionRule] },
    scoring: {
      method: 'weighted-sum',
      components: [{ ruleId: selectionRule.id, score: '50', weight: 1 }],
    },
    signals: { entry: [], exit: [], risk: [] },
  };
};

export const appendExperimentSelectionRule = (definition, catalog) => {
  const selection = definition.selection ?? { logic: 'all', rules: [] };
  const rules = selection.rules ?? [];
  const id = nextExperimentRuleId(rules, 'selection');
  return {
    ...definition,
    selection: {
      ...selection,
      rules: [...rules, makeSimpleRule(catalog, 'selection', id)],
    },
  };
};

export const appendExperimentSignalRule = (definition, catalog, scope) => {
  const signals = definition.signals ?? { entry: [], exit: [], risk: [] };
  const rules = Array.isArray(signals[scope]) ? signals[scope] : [];
  const id = nextExperimentRuleId(rules, `${scope}-rule`);
  return {
    ...definition,
    signals: {
      ...signals,
      [scope]: [...rules, makeSimpleSignal(catalog, scope, id)],
    },
  };
};

export const appendExperimentScoringComponent = (definition) => {
  const scoring = definition.scoring;
  if (scoring === undefined) return definition;
  const selectionRules = definition.selection?.rules ?? [];
  const ruleId = nextExperimentScoringRuleId(selectionRules, scoring.components ?? []);
  if (ruleId === undefined) return definition;
  const components = normalizeScoringComponents([
    ...(scoring.components ?? []),
    { ruleId, score: '50', weight: 1 },
  ]);
  return { ...definition, scoring: { ...scoring, components } };
};

export const parseExperimentStockIds = (value) => {
  const stockIds = [
    ...new Set(
      String(value ?? '')
        .split(/[\s,，;；]+/)
        .map((stockId) => stockId.trim().toUpperCase())
        .filter(Boolean),
    ),
  ];
  return stockIds;
};

const experimentVersionState = (context) => context?.versionState ?? {};

export const deriveExperimentStepStates = (context = {}, localState = {}) => {
  const versionState = experimentVersionState(context);
  const baseAvailable = context?.baseVersion !== undefined;
  const candidateAvailable = versionState.candidatePersisted === true;
  const validationStatus = context?.validation?.session?.status;
  const validationRunning = validationStatus === 'queued' || validationStatus === 'running';
  const validationFinished = ['complete', 'partial'].includes(validationStatus);
  const validationFailed = ['failed', 'cancelled'].includes(validationStatus);
  const diffAvailable =
    context?.definitionDiff !== undefined || localState.proposedDraft?.diff !== undefined;
  const reviewStatus = context?.promotion?.status;
  return [
    {
      id: 'baseline',
      title: '基线',
      status: baseAvailable ? 'complete' : 'unavailable',
      detail: baseAvailable
        ? `v${context.baseVersion.version} · 已发布`
        : '没有 current published 版本',
    },
    {
      id: 'draft',
      title: '草案',
      status: localState.proposalRunning
        ? 'running'
        : candidateAvailable
          ? 'complete'
          : baseAvailable
            ? 'ready'
            : 'blocked',
      detail: candidateAvailable
        ? `v${context.candidateVersion?.version ?? '--'} · 已持久化`
        : localState.proposedDraft !== undefined
          ? '未持久化草案预览'
          : baseAvailable
            ? '结构化编辑器可用'
            : '先建立基线',
    },
    {
      id: 'diff',
      title: 'Diff',
      status: diffAvailable ? 'complete' : candidateAvailable ? 'ready' : 'blocked',
      detail: diffAvailable
        ? '服务端定义差异'
        : candidateAvailable
          ? '等待读取差异'
          : '保存草案后生成',
    },
    {
      id: 'trial',
      title: 'Trial',
      status: localState.trialRunning
        ? 'running'
        : localState.trial !== undefined
          ? 'complete'
          : candidateAvailable
            ? 'ready'
            : 'blocked',
      detail:
        localState.trial !== undefined
          ? '当前页面内存 · 未持久化'
          : candidateAvailable
            ? '相同样本对照试算'
            : '先保存候选版本',
    },
    {
      id: 'validation',
      title: '独立验证',
      status: validationRunning
        ? 'running'
        : validationFinished
          ? 'complete'
          : validationFailed
            ? 'unavailable'
            : candidateAvailable
              ? 'ready'
              : 'blocked',
      detail: validationRunning
        ? '后台任务进行中'
        : context?.validation?.session?.id !== undefined
          ? `${validationStatus ?? '未知'} · ${context.validation.session.id}`
          : '历史区间逐日验证',
    },
    {
      id: 'review',
      title: '晋级评审',
      status:
        reviewStatus === 'eligible-for-human-review'
          ? 'ready'
          : candidateAvailable
            ? 'blocked'
            : 'blocked',
      detail:
        reviewStatus === 'eligible-for-human-review'
          ? '证据完整，可人工评审'
          : '证据不足或尚无候选',
    },
  ];
};

const badge = (config, fallback) =>
  el('span', `badge ${config?.[1] ?? 'badge-neutral'}`, config?.[0] ?? fallback);

const navigate = (state, patch) => {
  const next = { ...state, ...patch };
  window.location.hash = buildStrategyHash(next);
};

const metric = (label, value, note = '') =>
  el('div', 'strategy-metric', [
    el('span', 'strategy-metric-label', label),
    el('strong', 'strategy-metric-value', value === undefined ? '--' : String(value)),
    ...(note.length === 0 ? [] : [el('small', null, note)]),
  ]);

const renderHealthBanner = (workspace) => {
  const warnings = [...(workspace.warnings ?? [])];
  const latest = workspace.latestAttempt;
  if (latest?.publication?.status && latest.publication.status !== 'published') {
    warnings.unshift(
      `最近尝试：${PUBLICATION_STATUS[latest.publication.status]?.[0] ?? latest.publication.status} · ${latest.publication.reasons?.join('、') || '无发布原因'}`,
    );
  }
  if (workspace.overview.health === 'partial') {
    warnings.unshift('本次运行已完成；部分标的数据不可用，股票池仅展示已明确命中的标的。');
  }
  if (warnings.length === 0) return null;
  return el(
    'div',
    `strategy-health-banner ${workspace.overview.health === 'failed' ? 'danger' : 'warning'}`,
    warnings.map((warning) => el('p', null, warning)),
  );
};

const ruleInputsText = (evaluation) => {
  if (!Array.isArray(evaluation.inputs) || evaluation.inputs.length === 0) return '无输入快照';
  return evaluation.inputs
    .map((input) =>
      input.status === 'missing'
        ? `${input.path}=缺失`
        : `${input.path}=${JSON.stringify(input.value)}`,
    )
    .join(' · ');
};

const ruleEvaluationPanel = (result) => {
  const panel = el('div', 'strategy-rule-evaluation');
  const evaluations = Array.isArray(result.ruleEvaluations) ? result.ruleEvaluations : [];
  if (evaluations.length === 0) {
    panel.append(el('p', 'placeholder', '该结果没有规则解释。'));
    return panel;
  }
  for (const [index, evaluation] of evaluations.entries()) {
    const status = RULE_STATUS[evaluation.status];
    const isV2 = evaluation.schemaVersion === 2;
    panel.append(
      el('article', 'strategy-rule-item', [
        el('div', 'flex gap-2', [
          el('strong', null, `规则 ${index + 1}`),
          badge(status, evaluation.status),
          ...(isV2 ? [el('span', 'badge badge-neutral', evaluation.scope)] : []),
        ]),
        ...(isV2
          ? [
              el('code', 'strategy-expression', evaluation.expression),
              el('div', 'strategy-rule-inputs', ruleInputsText(evaluation)),
              el('p', null, evaluation.explanation?.message ?? '解释不可用'),
            ]
          : [el('p', 'status warning', '历史运行未保存详细解释，请重新运行当前版本。')]),
        ...(evaluation.error ? [el('p', 'status error', evaluation.error)] : []),
        ...((evaluation.evidence ?? []).length === 0
          ? []
          : [el('p', 'muted', `证据：${evaluation.evidence.join('；')}`)]),
      ]),
    );
  }
  return panel;
};

const addToWatchlist = async (stock, setStatus) => {
  const watchlists = await callApi('/api/watchlists');
  if (!watchlists.ok) {
    setStatus(errorText(watchlists), true);
    return;
  }
  const options = (watchlists.data.items ?? [])
    .filter(({ watchlist }) => watchlist.enabled && watchlist.kind !== 'system')
    .map(({ watchlist }) => ({ value: watchlist.id, label: watchlist.name }));
  if (options.length === 0) {
    setStatus('没有可手工添加的 Watchlist', true);
    return;
  }
  const values = await promptDialog({
    title: `加入 Watchlist · ${stock.stockName}`,
    fields: [{ key: 'watchlistId', label: '目标列表', value: options[0].value, options }],
    confirmLabel: '加入',
  });
  if (values === null) return;
  const result = await post(`/api/watchlists/${encodeURIComponent(values.watchlistId)}/members`, {
    stockId: stock.stockId,
    stage: 'discovered',
    priority: 'normal',
  });
  setStatus(result.ok ? `${stock.stockName} 已加入 Watchlist` : errorText(result), !result.ok);
};

const resultReason = (view) => {
  if (view.kind === 'rule-near-miss') {
    return `未满足 ${view.blockingRuleIds.length} 条选股规则`;
  }
  if (view.kind === 'ranking-near-miss') {
    return `距 Top ${view.distance?.positionsAway ?? '--'} 位`;
  }
  if (view.kind === 'incomplete') return '数据或解释不完整';
  return view.result.selected ? '已入选' : '未入选';
};

const renderResultTable = (payload, setStatus, sortState, onSort) => {
  if ((payload.rows ?? []).length === 0) {
    return el('div', 'strategy-empty-state', [
      el('strong', null, '当前视图为空'),
      el('p', 'muted', `数据截止 ${fmtDateTime(payload.dataAsOf)}`),
    ]);
  }
  const body = el('tbody');
  for (const row of payload.rows) {
    const result = row.view.result;
    const detailId = `strategy-rule-${result.runId}-${result.stockId}`.replace(
      /[^a-zA-Z0-9_-]/g,
      '-',
    );
    const detailRow = el('tr', 'strategy-rule-row');
    detailRow.hidden = true;
    const detailCell = el('td');
    detailCell.colSpan = 9;
    detailCell.append(ruleEvaluationPanel(result));
    detailRow.append(detailCell);
    const explain = el('button', 'btn btn-outline btn-sm', '规则解释');
    explain.type = 'button';
    explain.setAttribute('aria-expanded', 'false');
    explain.setAttribute('aria-controls', detailId);
    explain.addEventListener('click', () => {
      detailRow.hidden = !detailRow.hidden;
      explain.setAttribute('aria-expanded', String(!detailRow.hidden));
    });
    detailRow.id = detailId;
    const research = el('a', 'btn btn-outline btn-sm', '研究档案');
    research.href = `#research?stockId=${encodeURIComponent(row.stock.stockId)}`;
    const watchlist = el('button', 'btn btn-outline btn-sm', '加入 Watchlist');
    watchlist.type = 'button';
    watchlist.addEventListener('click', () => void addToWatchlist(row.stock, setStatus));
    const quote = row.quote;
    const changePct = quote?.changePct;
    body.append(
      el('tr', null, [
        el('td', null, stockIdentityLink(row.stock)),
        el('td', 'num mono', typeof quote?.price === 'number' ? fmtNum(quote.price, 2) : '--'),
        el(
          'td',
          `num mono ${changeClass(changePct)}`,
          typeof changePct === 'number' ? `${fmtSigned(changePct)}%` : '--',
        ),
        el('td', 'num mono', result.rank ?? '--'),
        el('td', 'num mono', typeof result.score === 'number' ? result.score.toFixed(2) : '--'),
        el('td', null, resultReason(row.view)),
        el('td', 'mono muted', fmtDateTime(result.dataAsOf)),
        el('td', null, badge(RESULT_VIEW_STATUS[row.view.kind], row.view.kind)),
        el('td', null, el('div', 'row-actions', [explain, research, watchlist])),
      ]),
      detailRow,
    );
  }
  return el('div', 'table-wrap strategy-result-table', [
    el('table', 'table', [
      el(
        'thead',
        null,
        el('tr', null, [
          el('th', null, '股票'),
          sortableHeader('价格', 'price', sortState, onSort),
          sortableHeader('涨幅', 'change-pct', sortState, onSort),
          sortableHeader('排名', 'rank', sortState, onSort),
          sortableHeader('规则分', 'score', sortState, onSort),
          el('th', null, '状态 / 距离'),
          el('th', null, '数据截止'),
          el('th', null, '结果'),
          el('th', null, '操作'),
        ]),
      ),
      body,
    ]),
  ]);
};

const renderOverview = (workspace, state) => {
  const overview = workspace.overview;
  const current = workspace.currentRun;
  if (current === undefined) {
    const settings = el('button', 'btn btn-primary btn-sm', '前往设置');
    settings.type = 'button';
    settings.addEventListener('click', () => navigate(state, { tab: 'settings' }));
    return el('div', 'strategy-empty-state', [
      el('span', 'section-kicker', 'NO USABLE RUN'),
      el('h3', null, '尚无可用运行'),
      el('p', null, '发布有效版本后可进行样本试跑或正式运行。试跑不会成为当前股票池。'),
      settings,
    ]);
  }
  const grid = el('div', 'strategy-summary-grid', [
    metric('当前股票', overview.selectedCount),
    metric(
      '新增 / 退出',
      overview.enteredCount === undefined
        ? '--'
        : `${overview.enteredCount} / ${overview.exitedCount}`,
    ),
    metric(
      '当前发布',
      PUBLICATION_STATUS[current.publication?.status]?.[0] ?? 'legacy/unknown',
      current.scope === 'evaluation' ? '历史评估不会进入 operational current' : '',
    ),
  ]);
  const providers = (current.providerStatuses ?? []).map((provider) =>
    el('span', `badge ${provider.ok ? 'badge-active' : 'badge-important'}`, provider.provider),
  );

  return el('div', null, [
    grid,
    el('section', 'strategy-overview-audit', [
      el('div', null, [
        el('span', 'strategy-metric-label', '当前完成运行'),
        el('strong', 'mono', fmtDateTime(current.finishedAt ?? current.startedAt)),
      ]),
      el('div', null, [
        el('span', 'strategy-metric-label', '数据截止'),
        el('strong', 'mono', fmtDateTime(current.dataAsOf)),
      ]),
      el('div', null, [
        el('span', 'strategy-metric-label', '数据来源'),
        el('div', 'flex gap-2', providers),
      ]),
      el('div', null, [
        el('span', 'strategy-metric-label', '验收 / 覆盖'),
        el(
          'strong',
          'mono',
          current.summary?.schemaVersion === 4
            ? `${Math.round(current.summary.acceptance.metrics.evaluatedRatio * 100)}% · 失败 ${Math.round(current.summary.acceptance.metrics.failedRatio * 100)}%`
            : '历史运行未保存 V4 验收',
        ),
      ]),
    ]),
  ]);
};

const DEFAULT_POOL_PAGE_SIZE = 30;

const renderPool = async (strategyId, setStatus) => {
  const search = el('input');
  search.type = 'search';
  search.placeholder = '搜索代码或名称';
  const searchBtn = el('button', 'btn btn-primary btn-sm', '搜索');
  searchBtn.type = 'button';
  const count = el('span', 'entity-count', '--');
  const list = el('div', 'strategy-pool-list');
  let query = '';
  let epoch = 0;
  let render;
  let sortState = { key: 'rank', order: 'asc' };
  const onSort = (key) => {
    sortState = {
      key,
      order: sortState.key === key && sortState.order === 'asc' ? 'desc' : 'asc',
    };
    pager.setState({ page: 1 });
    void render();
  };
  const pager = createPagination({
    pageSize: DEFAULT_POOL_PAGE_SIZE,
    onChange: () => {
      if (render !== undefined) void render();
    },
  });
  render = async () => {
    const current = ++epoch;
    const { page, pageSize } = pager.getState();
    const params = new URLSearchParams({
      view: 'selected',
      sort: sortState.key,
      order: sortState.order,
      offset: String((page - 1) * pageSize),
      limit: String(pageSize),
    });
    if (query.length > 0) params.set('query', query);
    const result = await cachedGet(
      `/api/strategies/${encodeURIComponent(strategyId)}/results?${params.toString()}`,
    );
    if (epoch !== current) return;
    if (!result.ok) {
      mount(list, el('p', 'status error', errorText(result)));
      return;
    }
    count.textContent = `${result.data.total} 只`;
    pager.setState({ total: result.data.total });
    pager.root.hidden = result.data.total === 0;
    mount(list, renderResultTable(result.data, setStatus, sortState, onSort));
  };
  const doSearch = () => {
    query = search.value.trim();
    pager.setState({ page: 1 });
    void render();
  };
  searchBtn.addEventListener('click', doSearch);
  search.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    doSearch();
  });
  const root = el('div', null, [
    el('div', 'strategy-tab-heading', [
      el('div', null, [
        el('h3', null, '当前股票池'),
        el('p', 'muted', '来自最近一次持久化可用运行'),
      ]),
      el('div', 'row-actions', [search, searchBtn, count]),
    ]),
    list,
    pager.root,
  ]);
  await render();
  return root;
};

const runSummaryText = (run) => {
  const summary = run.summary ?? {};
  if (summary.schemaVersion === 4 || summary.schemaVersion === 3) {
    return `数据 ${DATA_HEALTH[summary.dataHealth] ?? summary.dataHealth} · 覆盖 ${summary.universeCount} · 求值 ${summary.evaluatedCount} · 入选 ${summary.selectedCount} · 信号 ${summary.signalCount} · 不完整 ${summary.incompleteCount} · 失败 ${summary.failedCount}`;
  }
  if (summary.schemaVersion === 2) {
    return `覆盖 ${summary.universeCount} · 求值 ${summary.evaluatedCount} · 入选 ${summary.selectedCount} · 信号 ${summary.signalCount} · 不完整 ${summary.partialCount} · 失败 ${summary.failedCount}`;
  }
  return '历史运行摘要不完整';
};

/**
 * 运行详情弹窗内容：StrategySignal 信号列表。
 * @param {object} data GET /api/strategy-runs/:id 的 data
 * @returns {HTMLElement} 可直接放入弹窗 body 的节点
 */
const signalRow = (identity) => (signal) =>
  el('div', 'entity-item', [
    stockIdentityLink(identity(signal.stockId)),
    el('span', 'mono', `${signal.direction} · score ${fmtNum(signal.score)}`),
    el('p', 'muted', (signal.evidence ?? []).join('；')),
  ]);

export const buildRunDetailContent = (data) => {
  const identityById = new Map((data.stocks ?? []).map((stock) => [stock.stockId, stock]));
  const identity = (stockId) =>
    identityById.get(stockId) ?? { stockId, stockName: '名称暂缺', nameStatus: 'unavailable' };
  const signals = data.signals ?? [];
  const listContainer = el('div', 'paginated-list');
  function renderPage() {
    const { page, pageSize } = pagination.getState();
    mount(
      listContainer,
      signals.slice((page - 1) * pageSize, page * pageSize).map(signalRow(identity)),
    );
  }
  const pagination = createPagination({ total: signals.length, onChange: renderPage });
  renderPage();
  return el('div', 'strategy-run-detail', [
    el('p', 'muted', `信号 ${signals.length}`),
    el('h4', null, 'StrategySignal'),
    ...(signals.length === 0
      ? [el('p', 'placeholder', '无信号')]
      : [listContainer, pagination.root]),
  ]);
};

/** 点击运行记录「查看」：拉取运行详情并以弹窗展示。 */
export const openRunDetail = async (runId) => {
  const detail = await cachedGet(`/api/strategy-runs/${encodeURIComponent(runId)}`);
  openModal(
    '运行详情',
    detail.ok ? buildRunDetailContent(detail.data) : el('p', 'status error', errorText(detail)),
  );
};

const renderDiff = async (strategyId) => {
  const result = await cachedGet(
    `/api/strategy-runs/compare?strategyId=${encodeURIComponent(strategyId)}`,
  );
  if (!result.ok) return el('p', 'placeholder', '至少需要两次可用运行后才能比较。');
  const { diff, warnings } = result.data;
  const strip = el('div', 'strategy-diff-strip', [
    metric('新增', diff.summary.entered),
    metric('退出', diff.summary.exited),
    metric('候选转正', diff.summary.candidatePromoted),
    metric('排名变化', diff.summary.rankChanged),
    metric('数据待确认', diff.summary.dataUnavailable ?? 0),
  ]);
  const rows = diff.rows.filter((row) => !row.changes.includes('stayed') || row.changes.length > 1);
  const table =
    rows.length === 0
      ? el('p', 'placeholder', '两次可用运行没有实质变化。')
      : el('div', 'table-wrap', [
          el('table', 'table', [
            el(
              'thead',
              null,
              el('tr', null, [
                el('th', null, '股票'),
                el('th', null, '变化'),
                el('th', 'num', '排名 Δ'),
                el('th', 'num', '规则分 Δ'),
              ]),
            ),
            el(
              'tbody',
              null,
              rows.map((row) =>
                el('tr', null, [
                  el('td', null, stockIdentityLink(row.stock)),
                  el('td', null, row.changes.join(' · ')),
                  el('td', 'num mono', row.rankDelta ?? '--'),
                  el('td', 'num mono', row.scoreDelta ?? '--'),
                ]),
              ),
            ),
          ]),
        ]);
  return el('section', 'strategy-diff', [
    el('div', 'strategy-tab-heading', [el('h3', null, '最近两次可用运行对比')]),
    ...(warnings ?? []).map((warning) => el('p', 'status warning', warning)),
    strip,
    table,
  ]);
};

const runRow = (run, onRerun) => {
  const view = el('button', 'btn btn-outline btn-sm', '查看');
  view.type = 'button';
  view.addEventListener('click', () => void openRunDetail(run.id));
  const actions = [view];
  if (run.publication?.status === 'withheld' && onRerun !== undefined) {
    const rerun = el('button', 'btn btn-outline btn-sm', '重跑');
    rerun.type = 'button';
    rerun.addEventListener('click', () => void onRerun(rerun));
    actions.push(rerun);
  }
  return el('tr', null, [
    el('td', 'mono', fmtDateTime(run.startedAt)),
    el('td', null, run.mode),
    el('td', null, badge(RUN_SCOPE[run.scope] ?? null, run.scope ?? 'legacy')),
    el(
      'td',
      null,
      badge(
        PUBLICATION_STATUS[run.publication?.status] ?? null,
        run.publication?.status ?? 'legacy/unknown',
      ),
    ),
    el('td', null, badge(RUN_STATUS[run.status], run.status)),
    el('td', 'muted', runSummaryText(run)),
    el('td', null, actions),
  ]);
};

/**
 * withheld 行的一键重跑：触发一次新的正式运行（mode=scan、persist），
 * 新运行仍走完整验收门——验收通过才发布替换 current，否则保留现有已发布结果。
 */
const rerunStrategy = async (strategyId, button, setLine, reload) => {
  const confirmed = await confirmDialog({
    title: '重跑策略',
    message:
      '将重新执行全市场扫描并原子落库。只有运行验收通过才会发布并替换当前结果；验收未通过或执行失败时保留现有已发布结果。',
    confirmLabel: '开始重跑',
  });
  if (!confirmed) return;
  button.disabled = true;
  button.textContent = '重跑中…';
  setLine('策略重跑中…');
  const result = await post(`/api/strategies/${encodeURIComponent(strategyId)}/run`, {
    persist: true,
  });
  button.disabled = false;
  button.textContent = '重跑';
  if (!result.ok) {
    setLine(errorText(result), true);
    return;
  }
  responseCache.clear();
  const run = result.data?.run ?? {};
  const statusText = RUN_STATUS[run.status]?.[0] ?? String(run.status ?? '完成');
  const publicationText = PUBLICATION_STATUS[run.publication?.status]?.[0];
  const resultsCount = result.data?.results?.length ?? 0;
  const signalsCount = result.data?.signals?.length ?? 0;
  setLine(
    `重跑${statusText}${publicationText === undefined ? '' : `，${publicationText}`}；结果 ${resultsCount}，信号 ${signalsCount}`,
  );
  await reload();
};

export const renderRuns = async (strategyId, scope = 'operational') => {
  const path = `/api/strategies/${encodeURIComponent(strategyId)}/runs?scope=${encodeURIComponent(scope)}`;
  const result = await cachedGet(path);
  if (!result.ok) return el('p', 'status error', errorText(result));
  const statusLine = el('p', 'status');
  statusLine.hidden = true;
  const setLine = (text, isError = false) => {
    statusLine.textContent = text;
    statusLine.className = isError ? 'status error' : 'status';
    statusLine.hidden = text.length === 0;
  };
  let runs = result.data.runs ?? [];
  const tbody = el('tbody');
  function renderPage() {
    const { page, pageSize } = pagination.getState();
    mount(
      tbody,
      runs.slice((page - 1) * pageSize, page * pageSize).map((run) => runRow(run, rerun)),
    );
  }
  const pagination = createPagination({ total: runs.length, onChange: renderPage });
  const reload = async () => {
    responseCache.delete(path);
    const fresh = await cachedGet(path);
    if (!fresh.ok) {
      setLine(errorText(fresh), true);
      return;
    }
    runs = fresh.data.runs ?? [];
    pagination.setState({ total: runs.length, page: 1 });
    renderPage();
  };
  const rerun = (button) => rerunStrategy(strategyId, button, setLine, reload);
  renderPage();
  const tableWrap = el('div', 'table-wrap strategy-run-timeline', [
    el('table', 'table', [
      el(
        'thead',
        null,
        el('tr', null, [
          el('th', null, '时间'),
          el('th', null, '模式'),
          el('th', null, '范围'),
          el('th', null, '发布'),
          el('th', null, '状态'),
          el('th', null, '摘要'),
          el('th', null, '操作'),
        ]),
      ),
      tbody,
    ]),
  ]);
  return el('div', null, [
    statusLine,
    tableWrap,
    pagination.root,
    ...(scope === 'operational'
      ? [await renderDiff(strategyId)]
      : [el('p', 'muted', '历史评估结果与生产 current 隔离；请选择具体运行后再做显式对比。')]),
  ]);
};

const pct = (value) => (value === undefined ? '--' : `${fmtNum(value * 100, 2)}%`);

const CYCLE_STATUS = {
  complete: ['完整', 'badge-active'],
  pending: ['待观察', 'badge-important'],
  unavailable: ['不可用', 'badge-pos'],
};

const cycleLink = (href, label, className = 'btn btn-outline btn-sm') => {
  const link = el('a', className, label);
  link.href = href;
  return link;
};

const observationFactText = (observation) => {
  const values = [
    `收益 ${pct(observation.returnPct)}`,
    `MFE ${pct(observation.maxFavorableExcursionPct)}`,
    `MAE ${pct(observation.maxAdverseExcursionPct)}`,
    `基准 ${observation.benchmarkStatus === 'complete' ? pct(observation.benchmarkReturnPct) : '不可用'}`,
  ];
  return values.join(' · ');
};

const adviceValidityText = (advice) =>
  new Date(advice.validUntil).getTime() < Date.now() ? '已过期' : '有效';

const renderCycleCard = (cycle, strategyId) => {
  const stock = stockIdentityLink({
    stockId: cycle.stockId,
    stockName: cycle.stockId,
    nameStatus: 'unavailable',
  });
  const progress = cycle.observationProgress ?? [];
  const observationsById = new Map((cycle.observations ?? []).map((row) => [row.id, row]));
  const adviceRows = cycle.advices ?? [];
  const tradeRows = cycle.trades ?? [];
  const tradeLinks = cycle.tradeLinks ?? [];
  const insightHref = buildStrategyHash({
    strategyId,
    tab: 'insights',
    scope: 'operational',
    runId: cycle.runId,
  });
  const timeline = el('ol', 'strategy-cycle-timeline', [
    el('li', 'strategy-cycle-stage strategy-cycle-fact', [
      el('div', 'strategy-cycle-stage-head', [
        el('span', 'strategy-cycle-type', '事实 / 入选结果'),
        el(
          'span',
          'mono muted',
          `score ${cycle.result.score ?? '--'} · rank ${cycle.result.rank ?? '--'}`,
        ),
      ]),
      el('p', null, 'StrategyResult 已明确入选；以下事实均绑定本次 run。'),
      el('p', 'mono muted', `证据：${(cycle.result.evidence ?? []).join('、') || '无'}`),
    ]),
    el('li', 'strategy-cycle-stage strategy-cycle-fact', [
      el('div', 'strategy-cycle-stage-head', [
        el('span', 'strategy-cycle-type', '事实 / emitted StrategySignal'),
        el('span', 'mono muted', `${(cycle.signals ?? []).length} 条`),
      ]),
      ...((cycle.signals ?? []).length === 0
        ? [el('p', 'placeholder', '本周期没有 emitted signal。')]
        : (cycle.signals ?? []).map((signal) =>
            el('article', 'strategy-cycle-fact-row', [
              el('strong', 'mono', signal.id),
              el('span', null, `${signal.direction} · score ${fmtNum(signal.score)}`),
              el('p', 'muted', (signal.evidence ?? []).join('；')),
            ]),
          )),
    ]),
    el('li', 'strategy-cycle-stage strategy-cycle-fact', [
      el('div', 'strategy-cycle-stage-head', [
        el('span', 'strategy-cycle-type', '事实 / 事后观察'),
        el('span', 'muted', '不是回测'),
      ]),
      el(
        'div',
        'strategy-cycle-horizons',
        ['t1', 't3', 't5'].map((horizon) => {
          const item = progress.find((row) => row.horizon === horizon) ?? {
            horizon,
            status: 'unavailable',
            observationIds: [],
            completeCount: 0,
            pendingCount: 0,
            unavailableCount: 0,
            benchmarkStatus: 'unavailable',
            unavailableReasons: ['尚无观察记录'],
          };
          const facts = (item.observationIds ?? [])
            .map((id) => observationsById.get(id))
            .filter(Boolean);
          return el('article', 'strategy-cycle-horizon', [
            el('div', 'strategy-cycle-stage-head', [
              el('strong', null, horizon.toUpperCase()),
              badge(CYCLE_STATUS[item.status], item.status),
            ]),
            el(
              'p',
              'mono muted',
              `完整 ${item.completeCount ?? 0} · 待观察 ${item.pendingCount ?? 0} · 不可用 ${item.unavailableCount ?? 0}`,
            ),
            ...(facts.length === 0
              ? [el('p', 'muted', item.unavailableReasons?.join('；') || '事实不可用')]
              : facts.map((observation) =>
                  el('p', 'muted', `${observation.id} · ${observationFactText(observation)}`),
                )),
            el(
              'small',
              'muted',
              `benchmark ${item.benchmarkStatus === 'complete' ? '可用' : '不可用'} · due ${fmtDateTime(item.dueAt)}`,
            ),
          ]);
        }),
      ),
    ]),
    el('li', 'strategy-cycle-stage strategy-cycle-ai', [
      el('div', 'strategy-cycle-stage-head', [
        el('span', 'strategy-cycle-type', 'AI 洞察 / 解释'),
        cycleLink(insightHref, '查看事实与 AI 洞察'),
      ]),
      el('p', null, 'AI 洞察只解释已核验事实并保留证据引用；此处不把解释改写成买卖建议。'),
    ]),
    el('li', 'strategy-cycle-stage strategy-cycle-advice', [
      el('div', 'strategy-cycle-stage-head', [
        el('span', 'strategy-cycle-type', 'AI Advice / 决策快照'),
        cycleLink(`#advice?stockId=${encodeURIComponent(cycle.stockId)}`, '打开 Advice 页面'),
      ]),
      ...(adviceRows.length === 0
        ? [
            el(
              'p',
              'placeholder',
              '本周期没有 Advice；自动生成需要用户显式启用推荐策略且满足生产运行门禁。',
            ),
          ]
        : adviceRows.map((advice) => {
            const trigger = advice.basedOn?.strategy?.recommendationTrigger ?? '--';
            const outcome = advice.outcome;
            const outcomeSummary =
              outcome === undefined
                ? 'Outcome 待回填'
                : [
                    `Outcome ${outcome.outcome}`,
                    ...(outcome.pnl === undefined ? [] : [`PnL ${fmtSigned(outcome.pnl)}`]),
                    ...(outcome.benchmarkPnl === undefined
                      ? []
                      : [`基准 ${fmtSigned(outcome.benchmarkPnl)}`]),
                  ].join(' · ');
            return el('article', 'strategy-cycle-advice-row', [
              el('div', 'strategy-cycle-stage-head', [
                el('strong', null, `${advice.decision} · confidence ${advice.confidence}/100`),
                el('span', 'badge badge-neutral', `阶段 ${trigger}`),
              ]),
              el('p', null, advice.reasoning?.premise ?? '无 Advice premise'),
              el(
                'p',
                'muted',
                `${adviceValidityText(advice)} ${fmtDateTime(advice.validFrom)} → ${fmtDateTime(advice.validUntil)} · ${outcomeSummary}`,
              ),
              ...(outcome?.tradeIds?.length
                ? [el('p', 'mono muted', `显式 Trade IDs：${outcome.tradeIds.join('、')}`)]
                : []),
              cycleLink(
                `#advice?stockId=${encodeURIComponent(cycle.stockId)}`,
                `Advice ${advice.id.slice(0, 10)}…`,
              ),
            ]);
          })),
    ]),
    el('li', 'strategy-cycle-stage strategy-cycle-trade', [
      el('div', 'strategy-cycle-stage-head', [
        el('span', 'strategy-cycle-type', '用户行动 / 显式 Trade'),
        cycleLink('#review', '打开全局复盘'),
      ]),
      ...(tradeRows.length === 0
        ? [
            el(
              'p',
              'placeholder',
              '当前账户没有通过 Advice ID 或 AdviceOutcome.tradeIds 显式关联的 Trade。',
            ),
          ]
        : tradeRows.map((trade) => {
            const links = tradeLinks.filter((link) => link.tradeId === trade.id);
            return el('article', 'strategy-cycle-trade-row', [
              el('strong', 'mono', trade.id),
              el('span', null, `${trade.side} · ${trade.quantity} @ ${trade.price}`),
              el('span', 'muted', fmtDateTime(trade.executedAt)),
              el('small', 'muted', links.map((link) => link.relation).join('、')),
            ]);
          })),
    ]),
  ]);
  const audit = el('details', 'strategy-cycle-audit', [
    el('summary', null, '证据、未知项与限制'),
    el(
      'p',
      'mono muted',
      `factsAsOf ${fmtDateTime(cycle.factsAsOf)} · evidence ${cycle.evidenceIds?.length ?? 0}`,
    ),
    el('p', null, `Evidence IDs：${(cycle.evidenceIds ?? []).join('、') || '无'}`),
    ...(cycle.unknowns?.length
      ? [el('p', 'status warning', `Unknown：${cycle.unknowns.join('；')}`)]
      : []),
    ...(cycle.limitations?.length
      ? [el('p', 'muted', `限制：${cycle.limitations.join('；')}`)]
      : []),
  ]);
  return el('article', 'strategy-cycle-card', [
    el('header', 'strategy-cycle-head', [
      el('div', null, [
        stock,
        el('p', 'mono muted', `run ${cycle.runId} · version ${cycle.strategyVersionId}`),
      ]),
      el('div', 'strategy-cycle-run-meta', [
        badge(RUN_STATUS[cycle.run?.status], cycle.run?.status ?? '--'),
        badge(
          PUBLICATION_STATUS[cycle.run?.publication?.status],
          cycle.run?.publication?.status ?? '--',
        ),
        el('span', 'mono muted', `数据截止 ${fmtDateTime(cycle.run?.dataAsOf)}`),
      ]),
    ]),
    timeline,
    audit,
  ]);
};

export const renderDecisionCycles = async (strategyId, state = {}) => {
  const params = new URLSearchParams({ limit: '50' });
  if (state.runId) params.set('runId', state.runId);
  if (state.stockId) params.set('stockId', state.stockId);
  const result = await cachedGet(
    `/api/strategies/${encodeURIComponent(strategyId)}/decision-cycles?${params.toString()}`,
  );
  if (!result.ok) return el('p', 'status error', errorText(result));
  const payload = result.data;
  const cycles = payload.cycles ?? [];
  const header = el('div', 'strategy-tab-heading', [
    el('div', null, [
      el('span', 'section-kicker', 'DECISION CYCLE'),
      el('h3', null, '策略候选闭环'),
      el(
        'p',
        'muted',
        '按 strategyId + runId + stockId 派生；观察是事后事实，Advice 是可选决策快照。',
      ),
    ]),
    cycleLink('#review', '全局复盘'),
  ]);
  if (cycles.length === 0) {
    return el('div', 'strategy-cycle-grid', [
      header,
      el('div', 'strategy-empty-state', [
        el('strong', null, '暂无可展示的生产候选周期'),
        el(
          'p',
          'muted',
          '仅 published operational run 的 selected StrategyResult 进入闭环；replay、evaluation、withheld 和未发布运行会被排除。',
        ),
        ...(payload.unknowns?.length
          ? [el('p', 'status warning', payload.unknowns.join('；'))]
          : []),
      ]),
    ]);
  }
  return el('div', 'strategy-cycle-grid', [
    header,
    el(
      'p',
      'mono muted',
      `共 ${payload.total} 个周期 · factsAsOf ${fmtDateTime(payload.factsAsOf)} · evidence ${payload.evidenceIds?.length ?? 0}`,
    ),
    ...cycles.map((cycle) => renderCycleCard(cycle, strategyId)),
    ...(payload.limitations?.length
      ? [
          el(
            'div',
            'strategy-health-banner warning',
            payload.limitations.map((item) => el('p', null, item)),
          ),
        ]
      : []),
  ]);
};

const renderInsightNarrative = (insight) =>
  el('section', 'strategy-insight-narrative', [
    el('span', 'section-kicker', 'AI EXPLANATION'),
    el('h3', null, insight.headline),
    el('p', null, insight.summary),
    ...(insight.findings ?? []).map((finding) =>
      el('article', 'strategy-insight-finding', [
        el('div', 'flex gap-2', [
          el('strong', null, finding.title),
          badge(
            finding.kind === 'risk'
              ? ['风险', 'badge-important']
              : finding.kind === 'limitation'
                ? ['限制', 'badge-neutral']
                : ['趋势', 'badge-active'],
            finding.kind,
          ),
        ]),
        el('p', null, finding.detail),
        el('small', 'muted', `已引用 ${finding.factRefs.length} 项已核验事实`),
      ]),
    ),
    ...(insight.risks?.length
      ? [el('p', 'status warning', `风险：${insight.risks.join('；')}`)]
      : []),
    el('p', 'muted', insight.disclaimer),
  ]);

export const renderInsights = async (
  strategyId,
  setStatus = () => {},
  scope = 'operational',
  state = parseStrategyHash(typeof window === 'undefined' ? '' : window.location.hash),
) => {
  const path = `/api/strategies/${encodeURIComponent(strategyId)}/insights?scope=${encodeURIComponent(scope)}`;
  const result = await cachedGet(path);
  if (!result.ok) return el('p', 'status error', errorText(result));
  const facts = result.data;
  const output = el('div', 'strategy-insight-output');
  const generate = el('button', 'btn btn-primary btn-sm', '生成 AI 解读');
  generate.type = 'button';
  generate.addEventListener('click', async () => {
    generate.disabled = true;
    setStatus('正在基于已核验事实生成解读…');
    const generated = await post(
      `/api/strategies/${encodeURIComponent(strategyId)}/insights/generate`,
      { windowDays: facts.window.days, scope },
    );
    generate.disabled = false;
    if (!generated.ok) {
      setStatus(errorText(generated), true);
      return;
    }
    output.replaceChildren(renderInsightNarrative(generated.data.insight));
    setStatus(`AI 解读已生成 · ${generated.data.provider}`);
  });
  const observationRows = facts.observations.map((item) =>
    el('tr', null, [
      el('td', 'mono', item.horizon.toUpperCase()),
      el('td', null, `${item.complete}/${item.total}`),
      el('td', null, item.uniqueStocks ?? '--'),
      el('td', null, pct(item.averageReturnPct)),
      el('td', null, pct(item.medianReturnPct)),
      el('td', null, pct(item.p25ReturnPct)),
      el('td', null, pct(item.p75ReturnPct)),
      el('td', null, pct(item.averageExcessReturnPct)),
      el('td', null, pct(item.averageMaxFavorableExcursionPct)),
      el('td', null, pct(item.averageMaxAdverseExcursionPct)),
      el('td', null, item.total === 0 ? '--' : pct(item.missingRate)),
      el('td', null, item.benchmarkStatus === 'complete' ? '可用' : '不可用'),
      el('td', null, item.observedAsOf ? fmtDateTime(item.observedAsOf) : '--'),
    ]),
  );
  const groupedRows = (facts.groupedObservations ?? [])
    .slice(0, 36)
    .map((item) =>
      el('tr', null, [
        el('td', null, item.dimension),
        el('td', null, item.group),
        el('td', 'mono', item.horizon.toUpperCase()),
        el('td', null, `${item.complete}/${item.total}`),
        el('td', null, item.uniqueStocks ?? '--'),
        el('td', null, pct(item.averageReturnPct)),
        el('td', null, pct(item.medianReturnPct)),
        el('td', null, pct(item.p25ReturnPct)),
        el('td', null, pct(item.p75ReturnPct)),
        el('td', null, pct(item.averageMaxFavorableExcursionPct)),
        el('td', null, pct(item.averageMaxAdverseExcursionPct)),
        el('td', null, item.total === 0 ? '--' : pct(item.missingRate)),
        el('td', null, item.benchmarkStatus === 'complete' ? '可用' : '不可用'),
        el('td', null, item.observedAsOf ? fmtDateTime(item.observedAsOf) : '--'),
      ]),
    );
  return el('div', 'strategy-insight-grid', [
    el('div', 'strategy-tab-heading', [
      el('div', null, [
        el('span', 'section-kicker', 'FACT-BASED INSIGHTS'),
        el('h3', null, '策略事实与真实表现'),
        el(
          'p',
          'muted',
          `范围：${facts.scope === 'evaluation' ? '历史评估' : '生产'} · 近 ${facts.window.days} 天 · 事实截止 ${fmtDateTime(facts.factsAsOf)} · 观察截止 ${facts.observationAsOf ? fmtDateTime(facts.observationAsOf) : '暂无'}`,
        ),
      ]),
      el('div', 'row-actions', [
        ...['operational', 'evaluation'].map((candidate) => {
          const button = el(
            'button',
            `btn btn-outline btn-sm${candidate === scope ? ' active' : ''}`,
            candidate === 'evaluation' ? '历史评估' : '生产事实',
          );
          button.type = 'button';
          button.addEventListener('click', () => {
            window.location.hash = buildStrategyHash({ ...state, scope: candidate });
          });
          return button;
        }),
        generate,
      ]),
    ]),
    el('div', 'strategy-summary-grid', [
      metric('运行次数', facts.runs.total, `可用 ${facts.runs.usable} · 失败 ${facts.runs.failed}`),
      metric('当前明确命中', facts.currentSelection.selectedCount),
      metric(
        '平均评分',
        facts.currentSelection.averageScore === undefined
          ? '--'
          : fmtNum(facts.currentSelection.averageScore, 2),
      ),
      metric('关联预警', facts.alertPlans.length),
    ]),
    el('section', 'strategy-insight-section', [
      el('h4', null, '真实信号观察'),
      el(
        'p',
        'muted',
        '样本口径：同一股票、同一基准交易日、同一观察周期只保留一个可追溯事实；缺失 benchmark 保持不可用，不回填为 0。',
      ),
      el('div', 'table-wrap', [
        el('table', 'table', [
          el(
            'thead',
            null,
            el(
              'tr',
              null,
              [
                '周期',
                '完整样本',
                '唯一股票',
                '平均收益',
                '中位收益',
                'P25',
                'P75',
                '平均超额',
                '平均最大有利',
                '平均最大不利',
                '缺失率',
                '基准',
                '观察截止',
              ].map((label) => el('th', null, label)),
            ),
          ),
          el('tbody', null, observationRows),
        ]),
      ]),
      el('p', 'muted', '事后事实观察不是回测；未包含成交、费用、滑点和可交易性假设。'),
    ]),
    ...(groupedRows.length === 0
      ? []
      : [
          el('section', 'strategy-insight-section', [
            el('h4', null, '去相关分组统计'),
            el('div', 'table-wrap', [
              el('table', 'table', [
                el(
                  'thead',
                  null,
                  el(
                    'tr',
                    null,
                    [
                      '维度',
                      '分组',
                      '周期',
                      '完整样本',
                      '唯一股票',
                      '平均收益',
                      '中位收益',
                      'P25',
                      'P75',
                      '平均最大有利',
                      '平均最大不利',
                      '缺失率',
                      '基准',
                      '观察截止',
                    ].map((label) => el('th', null, label)),
                  ),
                ),
                el('tbody', null, groupedRows),
              ]),
            ]),
          ]),
        ]),
    el('div', 'strategy-insight-columns', [
      el('section', 'strategy-insight-section', [
        el('h4', null, '高频规则阻断'),
        ...(facts.blockers.length === 0
          ? [el('p', 'placeholder', '暂无明确阻断事实。')]
          : facts.blockers.map((item) =>
              el('article', 'entity-item', [
                el('strong', null, item.ruleName),
                el('span', 'mono muted', `${item.count} 次`),
              ]),
            )),
      ]),
      el('section', 'strategy-insight-section', [
        el('h4', null, '当前行业分布'),
        ...(facts.currentSelection.industries.length === 0
          ? [el('p', 'placeholder', '当前没有明确命中标的。')]
          : facts.currentSelection.industries.map((item) =>
              el('article', 'entity-item', [
                el('strong', null, item.name),
                el('span', 'mono muted', `${item.count} 只 · ${pct(item.share)}`),
              ]),
            )),
      ]),
      el('section', 'strategy-insight-section', [
        el('h4', null, '关联 AlertPlan'),
        ...(facts.alertPlans.length === 0
          ? [el('p', 'placeholder', '尚未关联预警方案。')]
          : facts.alertPlans.map((item) =>
              el('article', 'entity-item', [
                el('strong', null, item.name),
                badge(item.enabled ? ['已启用', 'badge-active'] : ['已停用', 'badge-neutral'], ''),
                el('span', 'mono muted', `${item.ruleCount} 条策略信号规则`),
              ]),
            )),
      ]),
    ]),
    el(
      'div',
      'strategy-health-banner warning',
      facts.limitations.map((limitation) => el('p', null, limitation)),
    ),
    output,
  ]);
};

const experimentDateText = (date) => {
  const value = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(value.getTime())) return '';
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
};

const experimentDefaultDates = () => {
  const to = new Date();
  const from = new Date(to);
  from.setDate(from.getDate() - 30);
  return { from: experimentDateText(from), to: experimentDateText(to) };
};

const experimentStateFor = (strategyId, context, catalog) => {
  let state = experimentStateByStrategy.get(strategyId);
  if (state === undefined) {
    const dates = experimentDefaultDates();
    state = {
      mode: 'structured',
      horizon: context?.observations?.horizon ?? 't5',
      definition: undefined,
      seedVersionId: undefined,
      baseVersionId: undefined,
      candidateVersionId: undefined,
      dirty: false,
      changeSummary: 'Web 实验室创建规则草案',
      trialStockIds: '600519.SH, 000001.SZ',
      validationFrom: dates.from,
      validationTo: dates.to,
      trainingSessionId: undefined,
      validationSessionId: undefined,
      proposedDraft: undefined,
      trial: undefined,
      proposalRunning: false,
      trialRunning: false,
      validationRunning: false,
      strictBacktestRunning: false,
      publishRunning: false,
      createRunning: false,
      validationError: undefined,
      proposalError: undefined,
      trialError: undefined,
      strictBacktestError: undefined,
      jsonError: undefined,
    };
    experimentStateByStrategy.set(strategyId, state);
  }
  const base = context?.baseVersion;
  const candidate = context?.candidateVersion;
  const seedVersionId = candidate?.id ?? base?.id;
  if (state.definition === undefined || (!state.dirty && state.seedVersionId !== seedVersionId)) {
    state.definition =
      cloneDefinition(candidate?.definition ?? base?.definition) ??
      createExperimentBlankDefinition(catalog);
    state.seedVersionId = seedVersionId;
    state.proposedDraft = undefined;
    state.jsonError = undefined;
  }
  state.baseVersionId = base?.id;
  state.candidateVersionId = candidate?.id;
  state.catalog = catalog;
  return state;
};

const compactHash = (value) => {
  const text = String(value ?? '');
  return text.length > 16 ? `${text.slice(0, 8)}…${text.slice(-8)}` : text || '--';
};

const experimentStatusBadge = (status) => {
  const config = EXPERIMENT_STATUS[status];
  return badge(config, status ?? '未知');
};

const experimentFieldLabel = (field) =>
  `${field.path} · ${EXPERIMENT_TYPE_LABELS[field.type] ?? field.type}`;

const experimentFieldMeta = (field) => {
  if (field === undefined)
    return el('small', 'experiment-field-meta', '当前 catalog 没有可用字段。');
  const lookback =
    field.requiredLookback === undefined ? 'lookback —' : `lookback ${field.requiredLookback}d`;
  const source = EXPERIMENT_DATA_SOURCE_LABELS[field.dataSource] ?? field.dataSource;
  const unit = field.unit === undefined ? '单位 —' : `单位 ${field.unit}`;
  return el(
    'small',
    'experiment-field-meta',
    `${field.path} · ${EXPERIMENT_TYPE_LABELS[field.type] ?? field.type} · ${unit} · ${lookback} · ${source}`,
  );
};

const experimentValueText = (value) => {
  if (value === undefined) return '—';
  if (typeof value === 'string') return value;
  const json = JSON.stringify(value);
  return json === undefined ? String(value) : json;
};

const experimentControl = (label, control, note) =>
  el('label', 'experiment-control', [
    el('span', 'experiment-control-label', label),
    control,
    ...(note === undefined ? [] : [el('small', 'experiment-field-meta', note)]),
  ]);

const experimentButton = (label, className, onClick) => {
  const button = el('button', className, label);
  button.type = 'button';
  button.addEventListener('click', () => void onClick());
  return button;
};

const selectOptions = (options, value) => {
  const select = document.createElement('select');
  for (const option of options) {
    const node = document.createElement('option');
    if (typeof option === 'string') {
      node.value = option;
      node.textContent = option;
      node.selected = option === value;
    } else {
      node.value = option.value;
      node.textContent = option.label;
      node.selected = option.value === value;
    }
    select.append(node);
  }
  select.value = value ?? options[0]?.value ?? options[0] ?? '';
  return select;
};

const markExperimentDefinitionChanged = (state) => {
  state.dirty = true;
  state.proposedDraft = undefined;
  state.proposalError = undefined;
  state.trial = undefined;
  state.trialError = undefined;
};

const renderExperimentCatalog = (catalog) => {
  const fields = catalog?.fields ?? [];
  const search = el('input', 'experiment-catalog-search');
  search.type = 'search';
  search.placeholder = '过滤字段路径 / 数据源';
  const list = el('div', 'experiment-catalog-list');
  const renderFields = (query = '') => {
    const normalized = query.trim().toLowerCase();
    const visible = fields.filter((field) =>
      [field.path, field.dataSource, field.unit, field.type].some((item) =>
        String(item ?? '')
          .toLowerCase()
          .includes(normalized),
      ),
    );
    list.replaceChildren(
      ...(visible.length === 0
        ? [el('p', 'placeholder', '没有匹配的注册字段。')]
        : visible.map((field) =>
            el('article', 'experiment-catalog-field', [
              el('div', 'experiment-catalog-field-head', [
                el('strong', 'mono', field.path),
                badge(
                  [EXPERIMENT_TYPE_LABELS[field.type] ?? field.type, 'badge-neutral'],
                  field.type,
                ),
              ]),
              el('p', 'experiment-field-meta', [
                `${field.unit ?? '单位未声明'} · lookback ${field.requiredLookback === undefined ? '—' : `${field.requiredLookback}d`} · ${EXPERIMENT_DATA_SOURCE_LABELS[field.dataSource] ?? field.dataSource}`,
              ]),
              el('p', 'experiment-catalog-risk', '缺失时保持 unknown / 不可用，不回填为 0。'),
              el('p', 'experiment-catalog-operators', [
                el('span', 'muted', 'operators '),
                el('code', null, (field.operators ?? []).join('  ')),
              ]),
            ]),
          )),
    );
  };
  search.addEventListener('input', () => renderFields(search.value));
  renderFields();
  return el('aside', 'experiment-surface experiment-catalog-panel', [
    el('div', 'experiment-panel-heading', [
      el('div', null, [el('span', 'section-kicker', 'FIELD REGISTRY'), el('h3', null, '字段目录')]),
      el('span', 'experiment-panel-count', `${fields.length} 个字段`),
    ]),
    el('p', 'muted', '结构化控件只从服务端 catalog 取字段与 operators；未知字段不会被生成。'),
    search,
    list,
  ]);
};

const renderExperimentStepRail = (context, state) =>
  el(
    'ol',
    'experiment-step-rail',
    deriveExperimentStepStates(context, state).map((step, index) =>
      el('li', `experiment-step experiment-step-${step.status}`, [
        el('span', 'experiment-step-index', String(index + 1).padStart(2, '0')),
        el('div', 'experiment-step-copy', [
          el('div', 'experiment-step-head', [
            el('strong', null, step.title),
            experimentStatusBadge(step.status),
          ]),
          el('small', 'muted', step.detail),
        ]),
      ]),
    ),
  );

const renderExperimentVersionFacts = (context) => {
  const base = context?.baseVersion;
  const candidate = context?.candidateVersion;
  const state = context?.versionState ?? {};
  const versionCard = (label, version, status) =>
    el('article', 'experiment-version-card', [
      el('span', 'section-kicker', label),
      el('div', 'experiment-version-title', [
        el('strong', null, version === undefined ? '未找到' : `v${version.version}`),
        ...(version === undefined
          ? []
          : [
              badge(
                status === 'base'
                  ? ['已发布', 'badge-active']
                  : version.validationStatus === 'valid'
                    ? ['有效', 'badge-active']
                    : ['待校验', 'badge-neutral'],
                version.validationStatus,
              ),
            ]),
      ]),
      el('p', 'mono muted', version?.id ?? '—'),
      el('p', 'mono experiment-hash', `hash ${compactHash(version?.definitionHash)}`),
      ...(status === 'candidate'
        ? [
            el(
              'p',
              'muted',
              version === undefined
                ? '创建持久化草案后继续。'
                : state.candidatePublished
                  ? '当前候选已发布；请重新创建下一版。'
                  : `parent ${compactHash(version?.parentVersionId)}`,
            ),
          ]
        : [
            el(
              'p',
              'muted',
              version === undefined
                ? '需要先建立 current published 基线。'
                : '作为本次实验的比较起点。',
            ),
          ]),
    ]);
  return el('div', 'experiment-version-facts', [
    versionCard('BASELINE / CURRENT', base, 'base'),
    versionCard('CANDIDATE / UNPUBLISHED', candidate, 'candidate'),
  ]);
};

const renderExperimentDiff = (context, state) => {
  const diff = context?.definitionDiff ?? state.proposedDraft?.diff;
  if (diff === undefined) {
    return el('section', 'experiment-surface experiment-diff-panel', [
      el('div', 'experiment-panel-heading', [
        el('h3', null, '定义 Diff'),
        experimentStatusBadge('blocked'),
      ]),
      el('p', 'placeholder', '保存持久化草案或生成未持久化草案后，服务端会给出字段级差异。'),
    ]);
  }
  const changes = diff.changes ?? [];
  return el('section', 'experiment-surface experiment-diff-panel', [
    el('div', 'experiment-panel-heading', [
      el('div', null, [
        el('span', 'section-kicker', 'DEFINITION DIFF'),
        el('h3', null, '变更审阅'),
      ]),
      diff.changed
        ? badge(['有变更', 'badge-important'], '')
        : badge(['无变更', 'badge-neutral'], ''),
    ]),
    el('div', 'experiment-summary-strip', [
      metric('新增', diff.summary?.added ?? 0),
      metric('移除', diff.summary?.removed ?? 0),
      metric('变更', diff.summary?.changed ?? 0),
      metric('from', compactHash(diff.fromHash)),
      metric('to', compactHash(diff.toHash)),
    ]),
    changes.length === 0
      ? el('p', 'placeholder', '两个定义的规范化 JSON 相同。')
      : el('div', 'table-wrap experiment-table-wrap', [
          el('table', 'table experiment-table', [
            el(
              'thead',
              null,
              el(
                'tr',
                null,
                ['路径', '类型', '基线', '候选'].map((label) => el('th', null, label)),
              ),
            ),
            el(
              'tbody',
              null,
              changes
                .slice(0, 100)
                .map((change) =>
                  el('tr', null, [
                    el('td', 'mono', change.path),
                    el(
                      'td',
                      null,
                      badge(
                        [
                          EXPERIMENT_CHANGE_LABELS[change.kind] ?? change.kind,
                          change.kind === 'removed'
                            ? 'badge-pos'
                            : change.kind === 'added'
                              ? 'badge-active'
                              : 'badge-important',
                        ],
                        change.kind,
                      ),
                    ),
                    el('td', 'experiment-diff-value', experimentValueText(change.before)),
                    el('td', 'experiment-diff-value', experimentValueText(change.after)),
                  ]),
                ),
            ),
          ]),
        ]),
    ...(changes.length > 100
      ? [el('p', 'muted', `仅展示前 100 项差异，共 ${changes.length} 项。`)]
      : []),
  ]);
};

const renderExperimentRuleCondition = (rule, catalog, changed, rebuild) => {
  const parsed = parseSimpleExpression(rule.when, catalog);
  const field = parsed?.field ?? defaultField(catalog);
  const fieldOptions = structuredFields(catalog).map((item) => ({
    value: item.path,
    label: experimentFieldLabel(item),
  }));
  const fieldSelect = selectOptions(fieldOptions, field?.path);
  const operatorOptions = conditionOperators(field);
  const operatorSelect = selectOptions(
    operatorOptions,
    parsed?.operator ?? defaultFieldOperator(field),
  );
  const value = el('input', 'experiment-rule-value');
  value.type = field?.type === 'number' ? 'number' : 'text';
  value.step = 'any';
  value.value = parsed?.value ?? defaultFieldValue(field);
  const updateExpression = () => {
    const selectedField = fieldByPath(catalog, fieldSelect.value);
    if (selectedField === undefined) return;
    rule.when = buildExperimentSimpleExpression(selectedField, operatorSelect.value, value.value);
    changed();
  };
  fieldSelect.addEventListener('change', () => {
    const selectedField = fieldByPath(catalog, fieldSelect.value);
    const nextOperator = defaultFieldOperator(selectedField);
    rule.when = buildExperimentSimpleExpression(
      selectedField,
      nextOperator,
      defaultFieldValue(selectedField),
    );
    changed();
    rebuild();
  });
  operatorSelect.addEventListener('change', updateExpression);
  value.addEventListener('input', updateExpression);
  if (field === undefined || parsed === undefined) {
    return el('div', 'experiment-condition-block', [
      el('div', 'experiment-advanced-expression', [
        el('span', 'section-kicker', 'ADVANCED EXPRESSION'),
        el('code', null, rule.when || '未填写'),
      ]),
      el(
        'p',
        'muted',
        '该表达式包含结构化编辑器暂不展开的语法；请切换到 JSON 高级模式编辑，服务端会负责校验。',
      ),
    ]);
  }
  return el('div', 'experiment-condition-block', [
    el('div', 'experiment-condition-grid', [
      experimentControl('字段', fieldSelect),
      experimentControl('运算符', operatorSelect),
      experimentControl('值', value),
    ]),
    experimentFieldMeta(field),
  ]);
};

const renderExperimentScoreEditor = (label, target, catalog, changed, rebuild) => {
  const parsed = parseSimpleScoreExpression(target.score, catalog);
  if (parsed === undefined) {
    return el('div', 'experiment-score-advanced experiment-advanced-expression', [
      el('span', 'experiment-control-label', label),
      el('code', null, target.score || '未填写'),
      el('small', 'experiment-field-meta', '高级表达式只读；如需修改请切换到 JSON 高级模式。'),
    ]);
  }
  const modes = selectOptions(
    [
      { value: 'constant', label: '固定分数' },
      ...(numericFields(catalog).length === 0 ? [] : [{ value: 'field', label: '注册字段值' }]),
    ],
    parsed.mode,
  );
  const value =
    parsed.mode === 'field'
      ? selectOptions(
          numericFields(catalog).map((field) => ({
            value: field.path,
            label: experimentFieldLabel(field),
          })),
          parsed.value,
        )
      : el('input');
  if (parsed.mode === 'constant') {
    value.type = 'number';
    value.min = '0';
    value.max = '100';
    value.step = 'any';
    value.value = parsed.value;
    value.addEventListener('input', () => {
      const next = normalizeScoreLiteral(value.value);
      if (next !== undefined) {
        target.score = next;
        changed();
      }
    });
  } else {
    value.addEventListener('change', () => {
      target.score = buildExperimentScoreExpression('field', catalog, value.value);
      changed();
    });
  }
  modes.addEventListener('change', () => {
    const nextMode = modes.value;
    target.score =
      nextMode === 'field'
        ? buildExperimentScoreExpression('field', catalog, numericFields(catalog)[0]?.path)
        : '50';
    changed();
    rebuild();
  });
  return el('div', 'experiment-score-editor', [
    experimentControl('表达式类型', modes),
    experimentControl(label, value, parsed.mode === 'constant' ? '范围 0–100。' : undefined),
    ...(parsed.mode === 'field' ? [experimentFieldMeta(parsed.field)] : []),
  ]);
};

const renderExperimentRuleCard = (rule, catalog, changed, rebuild, options = {}) => {
  const name = el('input');
  name.type = 'text';
  name.value = rule.name ?? rule.id ?? '';
  name.addEventListener('input', () => {
    rule.name = name.value;
    changed();
  });
  const evidence = el('textarea');
  evidence.rows = 2;
  evidence.value = Array.isArray(rule.evidence) ? rule.evidence.join('\n') : '';
  evidence.addEventListener('input', () => {
    rule.evidence = evidence.value
      .split(/\n+|；/)
      .map((item) => item.trim())
      .filter(Boolean);
    changed();
  });
  const controls = [
    experimentControl('规则名', name),
    renderExperimentRuleCondition(rule, catalog, changed, rebuild),
    experimentControl('证据模板', evidence, '每行一条；仅用于解释，不执行模板。'),
  ];
  if (options.signal === true) {
    const direction = selectOptions(
      [
        { value: 'bullish', label: 'bullish / 看多' },
        { value: 'bearish', label: 'bearish / 看空' },
        { value: 'neutral', label: 'neutral / 中性' },
      ],
      rule.direction ?? 'bullish',
    );
    direction.addEventListener('change', () => {
      rule.direction = direction.value;
      changed();
    });
    const emission = rule.emission ?? { mode: 'level', cooldownTradingDays: 0 };
    const emissionMode = selectOptions(
      [
        { value: 'level', label: 'level / 持续' },
        { value: 'edge', label: 'edge / 边沿' },
      ],
      emission.mode ?? 'level',
    );
    emissionMode.addEventListener('change', () => {
      rule.emission = { ...emission, mode: emissionMode.value };
      changed();
    });
    const cooldown = el('input');
    cooldown.type = 'number';
    cooldown.min = '0';
    cooldown.max = '60';
    cooldown.value = String(emission.cooldownTradingDays ?? 0);
    cooldown.addEventListener('input', () => {
      rule.emission = { ...emission, cooldownTradingDays: Number(cooldown.value) || 0 };
      changed();
    });
    controls.push(
      el('div', 'experiment-condition-grid', [
        renderExperimentScoreEditor('信号分数', rule, catalog, changed, rebuild),
        experimentControl('方向', direction),
        experimentControl('发射模式', emissionMode),
        experimentControl('冷却交易日', cooldown),
      ]),
    );
  }
  const remove =
    options.onRemove === undefined
      ? null
      : experimentButton('移除', 'btn btn-ghost btn-sm experiment-remove-button', options.onRemove);
  return el('article', 'experiment-rule-card', [
    el('div', 'experiment-rule-card-head', [
      el('div', null, [
        el('span', 'section-kicker', options.signal === true ? 'SIGNAL RULE' : 'SELECTION RULE'),
        el('strong', 'mono', rule.id ?? 'new-rule'),
      ]),
      ...(remove === null ? [] : [remove]),
    ]),
    ...controls,
  ]);
};

const renderExperimentSelection = (definition, catalog, changed, rebuild) => {
  const selection = definition.selection ?? { logic: 'all', rules: [] };
  const logic = selectOptions(
    [
      { value: 'all', label: 'all / 全部满足' },
      { value: 'any', label: 'any / 任一满足' },
    ],
    selection.logic ?? 'all',
  );
  logic.addEventListener('change', () => {
    definition.selection = { ...selection, logic: logic.value };
    changed();
  });
  const rules = Array.isArray(selection.rules) ? selection.rules : [];
  const add = experimentButton('添加选择规则', 'btn btn-outline btn-sm', async () => {
    Object.assign(definition, appendExperimentSelectionRule(definition, catalog));
    changed();
    rebuild();
  });
  return el('section', 'experiment-builder-section', [
    el('div', 'experiment-section-heading', [
      el('div', null, [
        el('span', 'section-kicker', '01 / SELECTION'),
        el('h4', null, '股票池选择'),
      ]),
      el('div', 'experiment-inline-actions', [experimentControl('逻辑', logic), add]),
    ]),
    ...(rules.length === 0
      ? [el('p', 'placeholder', '还没有选择规则；全市场 coverage 仍由服务端决定。')]
      : rules.map((rule) =>
          renderExperimentRuleCard(rule, catalog, changed, rebuild, {
            onRemove: () => {
              replaceExperimentDefinition(
                definition,
                removeExperimentSelectionRule(definition, rule.id),
              );
              changed();
              rebuild();
            },
          }),
        )),
  ]);
};

const renderExperimentScoring = (definition, catalog, changed, rebuild) => {
  const scoring = definition.scoring;
  const selectionRules = definition.selection?.rules ?? [];
  if (scoring === undefined) {
    const enable = experimentButton('启用加权评分', 'btn btn-outline btn-sm', async () => {
      definition.scoring = {
        method: 'weighted-sum',
        components:
          selectionRules.length === 0
            ? []
            : [{ ruleId: selectionRules[0].id, score: '50', weight: 1 }],
      };
      changed();
      rebuild();
    });
    enable.disabled = selectionRules.length === 0;
    return el('section', 'experiment-builder-section', [
      el('div', 'experiment-section-heading', [
        el('div', null, [el('span', 'section-kicker', '02 / SCORING'), el('h4', null, '评分聚合')]),
        enable,
      ]),
      el(
        'p',
        'muted',
        selectionRules.length === 0
          ? '先添加至少一条 selection rule，再启用加权评分。'
          : '可选；启用后权重由服务端 schema 校验，前端不替代领域规则。',
      ),
    ]);
  }
  const components = Array.isArray(scoring.components) ? scoring.components : [];
  const total = components.reduce((sum, component) => sum + (Number(component.weight) || 0), 0);
  const nextRuleId = nextExperimentScoringRuleId(selectionRules, components);
  const add = experimentButton('添加评分项', 'btn btn-outline btn-sm', async () => {
    Object.assign(definition, appendExperimentScoringComponent(definition));
    changed();
    rebuild();
  });
  add.disabled = nextRuleId === undefined;
  return el('section', 'experiment-builder-section', [
    el('div', 'experiment-section-heading', [
      el('div', null, [el('span', 'section-kicker', '02 / SCORING'), el('h4', null, '评分聚合')]),
      el('div', 'experiment-inline-actions', [
        el('span', 'mono muted', `权重合计 ${total.toFixed(2)}`),
        add,
      ]),
    ]),
    ...(components.length === 0
      ? [el('p', 'placeholder', '暂无评分项；服务端会拒绝无法通过 schema 的定义。')]
      : components.map((component, index) => {
          const usedByOther = new Set(
            components.filter((_, itemIndex) => itemIndex !== index).map((item) => item.ruleId),
          );
          const ruleId = selectOptions(
            selectionRules
              .filter((rule) => rule.id === component.ruleId || !usedByOther.has(rule.id))
              .map((rule) => ({ value: rule.id, label: rule.id })),
            component.ruleId,
          );
          ruleId.addEventListener('change', () => {
            component.ruleId = ruleId.value;
            changed();
          });
          const weight = el('input');
          weight.type = 'number';
          weight.min = '0.0001';
          weight.max = '1';
          weight.step = '0.01';
          weight.value = String(component.weight ?? 1);
          weight.addEventListener('input', () => {
            component.weight = Number(weight.value) || 0;
            changed();
          });
          const remove = experimentButton(
            '移除',
            'btn btn-ghost btn-sm experiment-remove-button',
            async () => {
              const remaining = components.filter((_, itemIndex) => itemIndex !== index);
              if (remaining.length === 0) {
                delete definition.scoring;
              } else {
                definition.scoring = {
                  ...scoring,
                  components: normalizeScoringComponents(remaining),
                };
              }
              changed();
              rebuild();
            },
          );
          return el('article', 'experiment-score-row', [
            experimentControl('引用规则', ruleId),
            renderExperimentScoreEditor('分数表达式', component, catalog, changed, rebuild),
            experimentControl('权重', weight),
            remove,
          ]);
        })),
    el('p', 'muted', '保存前请审阅权重合计；最终合法性仍由服务端校验。'),
  ]);
};

const renderExperimentSignals = (definition, catalog, changed, rebuild) => {
  const signals = definition.signals ?? { entry: [], exit: [], risk: [] };
  const scopes = EXPERIMENT_SIGNAL_SCOPES.map(([scope, label]) => {
    const rules = Array.isArray(signals[scope]) ? signals[scope] : [];
    const add = experimentButton(`添加${label}规则`, 'btn btn-outline btn-sm', async () => {
      Object.assign(definition, appendExperimentSignalRule(definition, catalog, scope));
      changed();
      rebuild();
    });
    return el('div', 'experiment-signal-scope', [
      el('div', 'experiment-signal-scope-head', [el('strong', null, label), add]),
      ...(rules.length === 0
        ? [el('p', 'placeholder', `暂无${label}信号；这是可选区。`)]
        : rules.map((rule, index) =>
            renderExperimentRuleCard(rule, catalog, changed, rebuild, {
              signal: true,
              onRemove: () => {
                definition.signals = {
                  ...definition.signals,
                  [scope]: rules.filter((_, itemIndex) => itemIndex !== index),
                };
                changed();
                rebuild();
              },
            }),
          )),
    ]);
  });
  return el('section', 'experiment-builder-section', [
    el('div', 'experiment-section-heading', [
      el('div', null, [el('span', 'section-kicker', '03 / SIGNALS'), el('h4', null, '信号规则')]),
      el('span', 'muted', '入场 / 退出 / 风险'),
    ]),
    ...scopes,
  ]);
};

const renderExperimentStructured = (state, catalog, changed, rebuild) => {
  const definition = state.definition ?? createExperimentBlankDefinition(catalog);
  state.definition = definition;
  const metadata = definition.metadata ?? {};
  const universe = definition.universe ?? { coverage: 'CN_A_SHARES_SH_SZ', excludeStockIds: [] };
  const style = el('input');
  style.type = 'text';
  style.value = metadata.style ?? '';
  style.placeholder = '例如：breakout / quality';
  style.addEventListener('input', () => {
    definition.metadata = { ...metadata, style: style.value || undefined };
    changed();
  });
  const horizon = selectOptions(
    [
      { value: 'intraday', label: '盘中' },
      { value: 'short', label: '短期' },
      { value: 'medium', label: '中期' },
      { value: 'long', label: '长期' },
    ],
    metadata.horizon ?? 'short',
  );
  horizon.addEventListener('change', () => {
    definition.metadata = { ...metadata, horizon: horizon.value };
    changed();
  });
  const include = el('textarea');
  include.rows = 2;
  include.value = (universe.includeStockIds ?? []).join(', ');
  include.placeholder = '可选：600519.SH, 000001.SZ';
  include.addEventListener('input', () => {
    const ids = parseExperimentStockIds(include.value);
    definition.universe = {
      ...universe,
      ...(ids.length === 0 ? { includeStockIds: undefined } : { includeStockIds: ids }),
    };
    if (ids.length === 0) delete definition.universe.includeStockIds;
    changed();
  });
  const exclude = el('textarea');
  exclude.rows = 2;
  exclude.value = (universe.excludeStockIds ?? []).join(', ');
  exclude.placeholder = '可选：688xxx.SH';
  exclude.addEventListener('input', () => {
    definition.universe = { ...universe, excludeStockIds: parseExperimentStockIds(exclude.value) };
    changed();
  });
  return el('div', 'experiment-structured-editor', [
    el('section', 'experiment-builder-section experiment-metadata-section', [
      el('div', 'experiment-section-heading', [
        el('div', null, [
          el('span', 'section-kicker', '00 / METADATA'),
          el('h4', null, '实验定义'),
        ]),
        el('span', 'badge badge-neutral', 'server validated'),
      ]),
      el('div', 'experiment-field-grid', [
        experimentControl('风格标签', style),
        experimentControl('策略周期', horizon),
        experimentControl(
          'Universe coverage',
          Object.assign(el('input'), {
            value: universe.coverage ?? 'CN_A_SHARES_SH_SZ',
            readOnly: true,
          }),
          '固定为 CN_A_SHARES_SH_SZ；编辑器不会改写覆盖白名单。',
        ),
      ]),
      el('div', 'experiment-field-grid', [
        experimentControl('包含股票', include),
        experimentControl('排除股票', exclude),
      ]),
    ]),
    renderExperimentSelection(definition, catalog, changed, rebuild),
    renderExperimentScoring(definition, catalog, changed, rebuild),
    renderExperimentSignals(definition, catalog, changed, rebuild),
  ]);
};

const renderExperimentDefinitionEditor = (state, catalog) => {
  const summary = el('input', 'experiment-summary-input');
  summary.type = 'text';
  summary.value = state.changeSummary;
  summary.placeholder = '说明这次规则变化（保存时写入审计）';
  summary.addEventListener('input', () => {
    state.changeSummary = summary.value;
  });
  const json = el('textarea', 'experiment-json-editor');
  json.rows = 24;
  json.wrap = 'off';
  json.value = JSON.stringify(state.definition, null, 2);
  const structuredHost = el('div');
  const bodyHost = el('div', 'experiment-editor-body');
  const error = el('p', 'status error');
  const status = el('p', 'experiment-editor-status muted');
  let rebuildStructured = () => {};
  const rebuildJsonText = () => {
    json.value = JSON.stringify(state.definition, null, 2);
  };
  const markChanged = (syncJson = true) => {
    markExperimentDefinitionChanged(state);
    if (syncJson) rebuildJsonText();
    status.textContent = '本地定义已修改；尚未保存到服务端。';
    error.textContent = state.jsonError ?? '';
    error.hidden = state.jsonError === undefined;
  };
  const rebuildStructuredEditor = () => {
    structuredHost.replaceChildren(
      renderExperimentStructured(state, catalog, markChanged, rebuildStructured),
    );
  };
  rebuildStructured = rebuildStructuredEditor;
  const renderJsonError = () => {
    error.textContent = state.jsonError ?? '';
    error.hidden = state.jsonError === undefined;
  };
  const renderBody = () => {
    structuredHost.replaceChildren();
    if (state.mode === 'json') {
      renderJsonError();
      bodyHost.replaceChildren(
        json,
        error,
        el('p', 'muted', 'JSON 高级模式不会在浏览器执行表达式；保存与校验仍由服务端完成。'),
      );
    } else {
      rebuildStructuredEditor();
      bodyHost.replaceChildren(structuredHost, ...(state.jsonError === undefined ? [] : [error]));
    }
  };
  json.addEventListener('input', () => {
    try {
      const parsed = JSON.parse(json.value);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('策略定义必须是 JSON 对象');
      }
      state.definition = parsed;
      state.jsonError = undefined;
      markChanged(false);
      status.textContent = 'JSON 已解析；切换结构化模式可继续审阅。';
      rebuildStructuredEditor();
    } catch (cause) {
      state.jsonError = `JSON 格式无效：${cause instanceof Error ? cause.message : '无法解析'}`;
      error.textContent = state.jsonError;
      error.hidden = false;
    }
  });
  const structured = experimentButton('结构化编辑', 'btn btn-outline btn-sm', async () => {
    state.mode = 'structured';
    renderBody();
  });
  const advanced = experimentButton('JSON 高级', 'btn btn-outline btn-sm', async () => {
    state.mode = 'json';
    rebuildJsonText();
    renderBody();
  });
  renderBody();
  const modes = el('div', 'experiment-mode-switch', [structured, advanced]);
  return el('section', 'experiment-surface experiment-editor-panel', [
    el('div', 'experiment-panel-heading', [
      el('div', null, [
        el('span', 'section-kicker', 'DRAFT BUILDER'),
        el('h3', null, '规则构建器'),
      ]),
      modes,
    ]),
    el(
      'p',
      'muted',
      '先在本地编辑；“生成未持久化草案”只做外部分析，“保存为持久化草案”才写入版本库。',
    ),
    experimentControl('变更说明', summary),
    status,
    bodyHost,
  ]);
};

const renderExperimentCoverage = (data, title = '数据覆盖') => {
  const summary = data?.summary ?? {};
  return el('div', 'experiment-coverage', [
    el('div', 'experiment-coverage-head', [
      el('strong', null, title),
      el('span', 'mono muted', data?.persisted === false ? 'persisted=false' : ''),
    ]),
    el('div', 'experiment-coverage-grid', [
      metric('范围', data?.stockIds?.length ?? summary.universeCount ?? 0, '只'),
      metric('求值', summary.evaluatedCount ?? 0),
      metric('入选', summary.selectedCount ?? 0),
      metric('信号', summary.signalCount ?? 0),
      metric('不完整', summary.incompleteCount ?? summary.partialCount ?? 0),
      metric('失败', summary.failedCount ?? 0),
    ]),
    el(
      'p',
      'muted',
      `dataHealth ${DATA_HEALTH[summary.dataHealth] ?? summary.dataHealth ?? '未知'} · 缺失数据保持不可用。`,
    ),
  ]);
};

const renderExperimentRunDiff = (diff) => {
  if (diff === undefined) return el('p', 'placeholder', '本次试算没有返回 diff。');
  const summary = diff.summary ?? {};
  const rows = diff.rows ?? [];
  return el('div', 'experiment-run-diff', [
    el('div', 'experiment-summary-strip', [
      metric('新增入选', summary.entered ?? 0),
      metric('退出入选', summary.exited ?? 0),
      metric('留存', summary.stayed ?? 0),
      metric('排名变化', summary.rankChanged ?? 0),
      metric('评分变化', summary.scoreChanged ?? 0),
      metric('数据不可用', summary.dataUnavailable ?? 0),
    ]),
    rows.length === 0
      ? el('p', 'placeholder', '样本范围内没有可比较的变化。')
      : el('div', 'table-wrap experiment-table-wrap', [
          el('table', 'table experiment-table', [
            el(
              'thead',
              null,
              el(
                'tr',
                null,
                ['股票', '变化', '基线', '候选'].map((label) => el('th', null, label)),
              ),
            ),
            el(
              'tbody',
              null,
              rows
                .slice(0, 50)
                .map((row) =>
                  el('tr', null, [
                    el('td', 'mono', row.stockId),
                    el('td', null, (row.changes ?? []).join(' · ') || '无'),
                    el('td', null, row.before?.status ?? '—'),
                    el('td', null, row.after?.status ?? '—'),
                  ]),
                ),
            ),
          ]),
        ]),
  ]);
};

const renderExperimentScoringBreakdown = (payload) => {
  const rows = (payload?.results ?? []).flatMap((result) =>
    (result.scoringBreakdown ?? []).map((item) => ({ stockId: result.stockId, ...item })),
  );
  return el('div', 'experiment-scoring-breakdown', [
    el('div', 'experiment-section-heading', [
      el('div', null, [el('span', 'section-kicker', 'SCORING TRACE'), el('h4', null, '评分贡献')]),
      el('span', 'muted', `${rows.length} 条组件记录`),
    ]),
    rows.length === 0
      ? el('p', 'placeholder', '本次结果没有 scoringBreakdown；不会猜测评分贡献。')
      : el('div', 'table-wrap experiment-table-wrap', [
          el('table', 'table experiment-table', [
            el(
              'thead',
              null,
              el(
                'tr',
                null,
                ['股票', '规则', '状态', '输入', 'raw score', 'contribution'].map((label) =>
                  el('th', null, label),
                ),
              ),
            ),
            el(
              'tbody',
              null,
              rows
                .slice(0, 100)
                .map((row) =>
                  el('tr', null, [
                    el('td', 'mono', row.stockId ?? '—'),
                    el('td', 'mono', row.ruleId ?? '—'),
                    el('td', null, row.status ?? '—'),
                    el('td', 'experiment-diff-value', ruleInputsText(row)),
                    el('td', null, row.rawScore ?? '—'),
                    el('td', null, row.contribution ?? '—'),
                  ]),
                ),
            ),
          ]),
        ]),
  ]);
};

const renderExperimentTrial = (state, context, strategyId, setStatus) => {
  const candidate = context?.candidateVersion;
  const canTrial =
    candidate !== undefined &&
    context?.baseVersion !== undefined &&
    context?.versionState?.candidateValid === true;
  const stockIds = el('textarea');
  stockIds.rows = 2;
  stockIds.value = state.trialStockIds;
  stockIds.placeholder = '600519.SH, 000001.SZ';
  stockIds.addEventListener('input', () => {
    state.trialStockIds = stockIds.value;
  });
  const output = el('div', 'experiment-trial-output');
  const start = experimentButton('运行样本 Trial', 'btn btn-primary btn-sm', async () => {
    const ids = parseExperimentStockIds(stockIds.value);
    if (ids.length === 0) {
      state.trialError = '至少填写一只样本股票。';
      output.replaceChildren(el('p', 'status error', state.trialError));
      return;
    }
    if (!canTrial) {
      state.trialError = '需要同时存在 baseline，并先通过候选版本静态校验。';
      output.replaceChildren(el('p', 'status error', state.trialError));
      return;
    }
    const confirmed = await confirmDialog({
      title: '运行样本 Trial',
      message:
        '将用同一组股票分别试算 baseline 与 candidate。结果只保留在当前页面内存，不写入正式运行记录。',
      confirmLabel: '开始 Trial',
    });
    if (!confirmed) return;
    start.disabled = true;
    state.trialRunning = true;
    state.trialError = undefined;
    output.replaceChildren(el('p', 'muted', '正在读取外部行情并比较同一样本…'));
    setStatus('样本 Trial 运行中…');
    const result = await post(`/api/strategies/${encodeURIComponent(strategyId)}/trial`, {
      baseVersionId: context.baseVersion.id,
      draftVersionId: candidate.id,
      stockIds: ids,
      mode: 'scan',
    });
    state.trialRunning = false;
    start.disabled = false;
    if (!result.ok) {
      state.trialError = errorText(result);
      output.replaceChildren(
        el('p', 'status error', `Trial 失败：${state.trialError}`),
        el('p', 'muted', '可以修复外部数据或权限后再次运行；不会自动创建正式 run。'),
      );
      setStatus(state.trialError, true);
      return;
    }
    state.trial = result.data;
    output.replaceChildren(
      el('p', 'status success', 'Trial 已完成；结果仅存在当前页面内存。'),
      el('div', 'experiment-trial-columns', [
        renderExperimentCoverage(result.data.base, 'Baseline coverage'),
        renderExperimentCoverage(result.data.draft, 'Candidate coverage'),
      ]),
      renderExperimentRunDiff(result.data.diff),
      renderExperimentScoringBreakdown(result.data.draft),
      el(
        'p',
        'muted',
        `mode ${result.data.draft?.run?.mode ?? 'scan'} · persisted=${result.data.persisted === false ? 'false' : 'unknown'} · 未写入 StrategyRun。`,
      ),
    );
    setStatus('样本 Trial 已完成（未持久化）');
  });
  if (!canTrial) start.disabled = true;
  if (state.trialRunning) start.disabled = true;
  if (state.trial !== undefined) {
    output.append(
      el(
        'p',
        'status success',
        '上一次 Trial 结果仍在当前页面内存；刷新页面后不会作为正式事实保留。',
      ),
      el('div', 'experiment-trial-columns', [
        renderExperimentCoverage(state.trial.base, 'Baseline coverage'),
        renderExperimentCoverage(state.trial.draft, 'Candidate coverage'),
      ]),
      renderExperimentRunDiff(state.trial.diff),
      renderExperimentScoringBreakdown(state.trial.draft),
    );
  }
  return el('section', 'experiment-surface experiment-trial-panel', [
    el('div', 'experiment-panel-heading', [
      el('div', null, [
        el('span', 'section-kicker', 'TRIAL / MEMORY ONLY'),
        el('h3', null, '同样本对照试算'),
      ]),
      start,
    ]),
    el(
      'p',
      'muted',
      candidate === undefined
        ? '保存候选版本后可用；未持久化草案不能直接进入 Trial。'
        : canTrial
          ? 'Trial 使用外部行情，结果不进入正式运行、股票池或晋级证据。'
          : '候选版本尚未通过静态校验；通过后可运行同样本对照。',
    ),
    experimentControl('样本股票', stockIds, '最多 500 只；逗号、空格、换行均可。'),
    ...(state.trialError === undefined
      ? []
      : [el('p', 'status error', `最近失败：${state.trialError}`)]),
    output,
  ]);
};

const EXPERIMENT_EVIDENCE_STATUS_LABELS = {
  'not-started': ['未开始', 'experiment-status-idle'],
  'memory-only': ['仅页面内存', 'experiment-status-ready'],
  running: ['进行中', 'experiment-status-running'],
  complete: ['完整', 'experiment-status-complete'],
  partial: ['部分可用', 'experiment-status-ready'],
  unavailable: ['不可用', 'experiment-status-unavailable'],
};

const experimentEvidenceStatus = (status) =>
  badge(EXPERIMENT_EVIDENCE_STATUS_LABELS[status], status ?? '未知');

const defaultExperimentEvidenceLayers = () => [
  {
    id: 'trial',
    title: '样本 Trial',
    status: 'not-started',
    persisted: false,
    description: '当前页面内存中的同样本对照。',
  },
  {
    id: 'historical-evaluation',
    title: '历史评估',
    status: 'not-started',
    persisted: true,
    description: '逐交易日历史评估 session。',
  },
  {
    id: 'strict-backtest',
    title: '严格回测',
    status: 'not-started',
    persisted: true,
    description: '通过数据门禁后才显示组合指标。',
  },
  {
    id: 'signal-observation',
    title: '真实 SignalObservation',
    status: 'unavailable',
    persisted: true,
    description: '来自信号的 T+1/T+3/T+5 后续事实。',
  },
];

const renderExperimentEvidenceLayers = (context, state) => {
  const contextLayers = context?.evidenceLayers ?? defaultExperimentEvidenceLayers();
  const layers = contextLayers.map((layer) =>
    layer.id === 'trial' && state.trial !== undefined ? { ...layer, status: 'complete' } : layer,
  );
  return el('section', 'experiment-surface experiment-evidence-layers-panel', [
    el('div', 'experiment-panel-heading', [
      el('div', null, [
        el('span', 'section-kicker', 'EVIDENCE MAP / FOUR LAYERS'),
        el('h3', null, '四层证据，不混用'),
      ]),
      el('span', 'experiment-panel-count', 'scope separated'),
    ]),
    el(
      'p',
      'muted',
      'Trial 是页面内存；历史评估是持久化覆盖；严格回测受数据门禁约束；SignalObservation 只记录真实后续事实。',
    ),
    el(
      'div',
      'experiment-evidence-layer-grid',
      layers.map((layer) =>
        el('article', `experiment-evidence-layer experiment-evidence-layer-${layer.id}`, [
          el('div', 'experiment-evidence-layer-head', [
            el('span', 'section-kicker', layer.id.replaceAll('-', ' / ').toUpperCase()),
            experimentEvidenceStatus(layer.status),
          ]),
          el('h4', null, layer.title),
          el('p', 'muted', layer.description),
          el(
            'span',
            'mono experiment-evidence-persistence',
            layer.persisted ? 'persisted=true' : 'persisted=false · refresh clears trial',
          ),
        ]),
      ),
    ),
  ]);
};

const observationMetricText = (value) => (value === undefined ? '--' : pct(value));

const experimentHorizonLabel = (horizon) =>
  String(horizon).startsWith('t') ? `T+${String(horizon).slice(1)}` : String(horizon).toUpperCase();

const experimentHorizonRows = (horizons) =>
  EXPERIMENT_HORIZONS.map(
    (horizon) =>
      horizons?.find((row) => row.horizon === horizon) ?? {
        horizon,
        total: 0,
        complete: 0,
        missing: 0,
        pending: 0,
        unavailable: 0,
        untracked: 0,
        uniqueStocks: 0,
        missingRate: 0,
        benchmarkComplete: 0,
        benchmarkTotal: 0,
        benchmarkCoverageRatio: 0,
        observationIds: [],
        observationLinks: [],
      },
  );

const renderExperimentObservationTable = (horizons) => {
  const rows = experimentHorizonRows(horizons);
  return el('div', 'table-wrap experiment-table-wrap experiment-observation-table-wrap', [
    el('table', 'table experiment-table experiment-wide-table', [
      el(
        'thead',
        null,
        el(
          'tr',
          null,
          [
            '周期',
            '完整 / 总计',
            '缺失',
            'pending',
            'unavailable',
            '未建档',
            'benchmark',
            'P25 / 中位 / P75',
            '平均 MFE / MAE',
            '事实引用',
          ].map((label) => el('th', null, label)),
        ),
      ),
      el(
        'tbody',
        null,
        rows.map((row) => {
          const hasRows = row.total > 0;
          const benchmarkText = hasRows
            ? `${row.benchmarkComplete}/${row.benchmarkTotal} · ${pct(row.benchmarkCoverageRatio)}`
            : '--';
          const returnText = [row.p25ReturnPct, row.medianReturnPct, row.p75ReturnPct]
            .map(observationMetricText)
            .join(' / ');
          const excursionText = [
            row.averageMaxFavorableExcursionPct,
            row.averageMaxAdverseExcursionPct,
          ]
            .map(observationMetricText)
            .join(' / ');
          const links = row.observationLinks ?? [];
          const ids = row.observationIds ?? [];
          return el('tr', null, [
            el('td', 'mono', experimentHorizonLabel(row.horizon)),
            el('td', 'num mono', hasRows ? `${row.complete} / ${row.total}` : '--'),
            el('td', 'num mono', hasRows ? `${row.missing} · ${pct(row.missingRate)}` : '--'),
            el('td', 'num mono', hasRows ? row.pending : '--'),
            el('td', 'num mono', hasRows ? row.unavailable : '--'),
            el('td', 'num mono', hasRows ? row.untracked : '--'),
            el('td', 'num mono', benchmarkText),
            el('td', 'num mono', returnText),
            el('td', 'num mono', excursionText),
            el(
              'td',
              null,
              ids.length === 0
                ? el('span', 'muted', '--')
                : el('details', 'experiment-inline-facts', [
                    el('summary', null, `${ids.length} 个 observation`),
                    el(
                      'pre',
                      null,
                      links.length > 0
                        ? links
                            .map(
                              (link) =>
                                `${link.observationId} → signal ${link.signalId} → run ${link.runId} · ${link.stockId} · version ${link.strategyVersionId}`,
                            )
                            .join('\n')
                        : ids.join('\n'),
                    ),
                  ]),
            ),
          ]);
        }),
      ),
    ]),
  ]);
};

const renderExperimentObservationLayer = (title, kicker, data, emptyText) => {
  const layer = data ?? {};
  const horizons = layer.horizons ?? [];
  const ids = layer.observationIds ?? [];
  const links = layer.observationLinks ?? [];
  const hasExpectedSamples = horizons.some((row) => row.total > 0);
  return el('section', 'experiment-surface experiment-observation-panel', [
    el('div', 'experiment-panel-heading', [
      el('div', null, [el('span', 'section-kicker', kicker), el('h3', null, title)]),
      experimentEvidenceStatus(layer.status ?? 'unavailable'),
    ]),
    el('div', 'experiment-summary-strip experiment-observation-summary', [
      metric('Observation IDs', ids.length),
      metric('可追溯 links', links.length),
      metric('runs', layer.runIds?.length ?? 0),
      metric('version', layer.versionId ?? '--'),
    ]),
    ...(hasExpectedSamples
      ? [renderExperimentObservationTable(horizons)]
      : [el('p', 'status warning', emptyText)]),
    ...(layer.limitations ?? []).map((limitation) => el('p', 'muted', limitation)),
  ]);
};

const renderExperimentObservations = (context) => {
  const evaluationLayer = {
    status:
      context?.evidenceLayers?.find((layer) => layer.id === 'signal-observation')?.status ??
      (context?.observations?.observationIds?.length > 0 ? 'complete' : 'unavailable'),
    versionId: context?.candidateVersion?.id,
    runIds: context?.validation?.runIds ?? [],
    horizons: context?.observations?.horizons ?? [],
    observationIds: context?.observations?.observationIds ?? [],
    observationLinks: context?.observations?.observationLinks ?? [],
    limitations: [],
  };
  return el('div', 'experiment-observation-stack', [
    renderExperimentObservationLayer(
      '历史评估 SignalObservation',
      'SIGNAL FACTS / EVALUATION',
      evaluationLayer,
      '当前验证区间没有可用的 SignalObservation；missing/unavailable 不代表收益为 0。',
    ),
    renderExperimentObservationLayer(
      '发布后真实反馈',
      'SIGNAL FACTS / OPERATIONAL',
      context?.realObservations,
      '尚无已发布版本对应的 production SignalObservation；页面不会把它补成 0 或模拟事实。',
    ),
  ]);
};

const renderExperimentStrictBacktests = (context, state, setStatus, refresh) => {
  const candidate = context?.candidateVersion;
  const validationSessionId = context?.validation?.session?.id;
  const runs = context?.strictBacktests ?? [];
  const canCreate =
    candidate !== undefined &&
    typeof validationSessionId === 'string' &&
    context?.versionState?.candidateValid === true;
  const create = experimentButton('创建严格回测', 'btn btn-outline btn-sm', async () => {
    if (!canCreate || candidate === undefined || validationSessionId === undefined) return;
    const values = await promptDialog({
      title: `严格回测 · ${candidate.id}`,
      fields: [
        { key: 'initialCash', label: '初始资金', value: '1000000' },
        { key: 'commissionBps', label: '佣金（bps）', value: '3' },
        { key: 'minimumCommission', label: '最低佣金', value: '5' },
        { key: 'sellStampDutyBps', label: '卖出印花税（bps）', value: '5' },
        { key: 'buySlippageBps', label: '买入滑点（bps）', value: '2' },
        { key: 'sellSlippageBps', label: '卖出滑点（bps）', value: '2' },
      ],
      confirmLabel: '继续填写后确认',
      note: `将绑定 validation session ${validationSessionId}。严格回测只在数据门禁完整时输出组合指标。`,
    });
    if (values === null) return;
    const confirmed = await confirmDialog({
      title: '确认创建严格回测',
      message:
        '这是独立的持久化回测运行。它不会发布 StrategyVersion、创建 Advice、发送通知或执行 Trade；门禁不完整时只保留不可用/部分状态。',
      confirmLabel: '创建并检查门禁',
    });
    if (!confirmed) return;
    state.strictBacktestRunning = true;
    state.strictBacktestError = undefined;
    create.disabled = true;
    const result = await runStrictStrategyBacktest(
      context.strategy,
      {
        evaluationSessionId: validationSessionId,
        initialCash: Number(values.initialCash),
        costs: {
          commissionBps: Number(values.commissionBps),
          minimumCommission: Number(values.minimumCommission),
          sellStampDutyBps: Number(values.sellStampDutyBps),
          buySlippageBps: Number(values.buySlippageBps),
          sellSlippageBps: Number(values.sellSlippageBps),
        },
      },
      setStatus,
    );
    state.strictBacktestRunning = false;
    create.disabled = false;
    if (!result.ok) {
      state.strictBacktestError = errorText(result);
      setStatus(state.strictBacktestError, true);
      return;
    }
    responseCache.clear();
    await refresh();
  });
  if (!canCreate || state.strictBacktestRunning) create.disabled = true;
  return el('section', 'experiment-surface experiment-strict-panel', [
    el('div', 'experiment-panel-heading', [
      el('div', null, [
        el('span', 'section-kicker', 'STRICT BACKTEST / GATED'),
        el('h3', null, '严格回测'),
      ]),
      create,
    ]),
    el(
      'p',
      'muted',
      canCreate
        ? '使用当前候选与独立验证 session；先审计 PIT、修订、费用、滑点、可交易性、公司行动、基准和求值器身份。'
        : '需要有效候选与独立验证 session；未满足条件时不会伪造组合收益指标。',
    ),
    ...(state.strictBacktestError === undefined
      ? []
      : [el('p', 'status error', `最近失败：${state.strictBacktestError}`)]),
    ...(runs.length === 0
      ? [el('p', 'placeholder', '尚无当前候选绑定的严格回测运行。')]
      : runs.map((run) =>
          el('details', 'experiment-strict-run', [
            el(
              'summary',
              null,
              `${run.id} · ${run.status} · gate=${run.gateAudit?.status ?? 'unknown'} · result=${run.resultAvailability}`,
            ),
            buildStrictBacktestResultContent(run),
          ]),
        )),
  ]);
};

const validationStatusText = (status) =>
  ({
    running: '进行中',
    complete: '已完成',
    partial: '部分完成',
    failed: '失败',
  })[status] ??
  status ??
  '未知';

const renderExperimentValidation = (state, context, strategyId, setStatus, refresh) => {
  const candidate = context?.candidateVersion;
  const validate = experimentButton('静态校验候选', 'btn btn-outline btn-sm', async () => {
    if (candidate === undefined || context?.versionState?.candidatePublished === true) return;
    const confirmed = await confirmDialog({
      title: '静态校验候选版本',
      message:
        '将按服务端 Strategy DSL 与 Field Registry 检查字段、表达式和 lookback，并回写 validationStatus。不会运行行情。',
      confirmLabel: '开始校验',
    });
    if (!confirmed) return;
    validate.disabled = true;
    const result = await post(`/api/strategies/${encodeURIComponent(strategyId)}/validate`, {
      versionId: candidate.id,
    });
    validate.disabled = false;
    if (!result.ok) {
      state.validationError = errorText(result);
      setStatus(state.validationError, true);
      return;
    }
    state.validationError = undefined;
    responseCache.clear();
    setStatus(
      result.data.version.validationStatus === 'valid'
        ? '候选版本静态校验通过'
        : '候选版本静态校验未通过',
      result.data.version.validationStatus !== 'valid',
    );
    await refresh();
  });
  if (candidate === undefined || context?.versionState?.candidatePublished === true)
    validate.disabled = true;
  const from = el('input');
  from.type = 'date';
  from.value = state.validationFrom;
  from.addEventListener('input', () => {
    state.validationFrom = from.value;
  });
  const to = el('input');
  to.type = 'date';
  to.value = state.validationTo;
  to.addEventListener('input', () => {
    state.validationTo = to.value;
  });
  const trainingSession = el('input');
  trainingSession.type = 'text';
  trainingSession.value = state.trainingSessionId ?? '';
  trainingSession.placeholder = '可选：training session ID';
  trainingSession.addEventListener('change', async () => {
    const value = trainingSession.value.trim();
    state.trainingSessionId = value.length === 0 ? undefined : value;
    responseCache.clear();
    await refresh();
  });
  const start = experimentButton('启动独立验证', 'btn btn-primary btn-sm', async () => {
    if (candidate === undefined) return;
    const confirmed = await confirmDialog({
      title: '启动独立验证',
      message:
        '将创建历史区间的逐交易日 evaluation session。它会落库为验证证据，不会替换当前生产股票池。',
      confirmLabel: '开始验证',
    });
    if (!confirmed) return;
    start.disabled = true;
    state.validationRunning = true;
    state.validationError = undefined;
    setStatus('独立验证已排队…');
    const result = await post(`/api/strategies/${encodeURIComponent(strategyId)}/backtests`, {
      versionId: candidate.id,
      from: state.validationFrom,
      to: state.validationTo,
    });
    if (!result.ok) {
      state.validationRunning = false;
      start.disabled = false;
      state.validationError = errorText(result);
      setStatus(state.validationError, true);
      await refresh();
      return;
    }
    state.validationSessionId = result.data?.sessionId ?? result.data?.session?.id;
    responseCache.clear();
    await refresh();
    if (typeof state.validationSessionId === 'string') {
      void pollExperimentValidation(state, strategyId, setStatus, refresh);
    }
  });
  if (
    state.validationRunning ||
    candidate === undefined ||
    context?.versionState?.candidateValid !== true
  )
    start.disabled = true;
  const validation = context?.validation;
  const session = validation?.session;
  const summary = context?.promotion?.metrics ?? {};
  const days = validation?.days ?? [];
  const progress =
    session === undefined
      ? el('p', 'placeholder', candidate === undefined ? '先保存候选版本。' : '尚无独立验证会话。')
      : el('div', 'experiment-validation-progress', [
          el('div', 'experiment-summary-strip', [
            metric('状态', validationStatusText(session.status)),
            metric('交易日', days.filter((day) => day.status === 'complete').length),
            metric('PIT vintage', pct(validation.vintageCoverageRatio)),
            metric('run', validation.runIds?.length ?? 0),
          ]),
          el(
            'p',
            'mono muted',
            `${session.id} · ${experimentDateText(session.from)} → ${experimentDateText(session.to)} · version ${session.strategyVersionId}`,
          ),
          ...(session.error === undefined ? [] : [el('p', 'status error', session.error)]),
          days.length === 0
            ? el('p', 'placeholder', '还没有逐日快照。')
            : el('div', 'table-wrap experiment-table-wrap', [
                el('table', 'table experiment-table', [
                  el(
                    'thead',
                    null,
                    el(
                      'tr',
                      null,
                      ['日期', '状态', 'vintage', '求值', '入选', '信号', '错误'].map((label) =>
                        el('th', null, label),
                      ),
                    ),
                  ),
                  el(
                    'tbody',
                    null,
                    days.map((day) =>
                      el('tr', null, [
                        el('td', 'mono', experimentDateText(day.dataAsOf)),
                        el('td', null, validationStatusText(day.status)),
                        el('td', null, day.vintageStatus ?? '—'),
                        el('td', null, day.evaluatedCount ?? '—'),
                        el('td', null, day.selectedCount ?? '—'),
                        el('td', null, day.signalCount ?? '—'),
                        el('td', 'experiment-diff-value', day.error ?? '—'),
                      ]),
                    ),
                  ),
                ]),
              ]),
          ...(session.status === 'running'
            ? [
                experimentButton('取消独立验证', 'btn btn-danger btn-sm', async () => {
                  const confirmed = await confirmDialog({
                    title: '取消独立验证',
                    message: '已完成日期会保留为部分证据；当前 session 将不再继续。',
                    confirmLabel: '取消验证',
                    danger: true,
                  });
                  if (!confirmed) return;
                  const cancelled = await post(
                    `/api/strategies/${encodeURIComponent(strategyId)}/backtests/${encodeURIComponent(session.id)}/cancel`,
                    {},
                  );
                  if (!cancelled.ok) {
                    state.validationError = errorText(cancelled);
                    setStatus(state.validationError, true);
                    return;
                  }
                  setStatus('已请求取消独立验证；已完成日期会保留。');
                  responseCache.clear();
                  await refresh();
                }),
              ]
            : []),
        ]);
  return el('section', 'experiment-surface experiment-validation-panel', [
    el('div', 'experiment-panel-heading', [
      el('div', null, [
        el('span', 'section-kicker', 'VALIDATION / PERSISTED EVIDENCE'),
        el('h3', null, '独立验证'),
      ]),
      start,
    ]),
    el(
      'p',
      'muted',
      '验证 session 使用 candidate 的定义哈希与历史数据版本；这里只显示覆盖事实，不把它包装成表现结论。',
    ),
    el('div', 'experiment-field-grid experiment-date-grid', [
      experimentControl('开始日期', from),
      experimentControl('结束日期', to),
    ]),
    experimentControl(
      '训练 session（可选）',
      trainingSession,
      '只作为现有 adaptive personality add-on 的输入；不替代通用晋级门禁。',
    ),
    el('div', 'row-actions', [validate]),
    ...(state.validationError === undefined
      ? []
      : [el('p', 'status error', `最近失败：${state.validationError}`)]),
    progress,
    el(
      'p',
      'muted',
      `当前评审计数：完整观察 ${summary.completeObservationCount ?? 0} · benchmark coverage ${pct(summary.benchmarkCoverageRatio)}。`,
    ),
  ]);
};

const pollExperimentValidation = async (state, strategyId, setStatus, refresh) => {
  if (state.validationPolling === true || typeof state.validationSessionId !== 'string') return;
  state.validationPolling = true;
  const snapshotPath = `/api/strategies/${encodeURIComponent(strategyId)}/backtests/${encodeURIComponent(state.validationSessionId)}`;
  let terminalStatus = 'running';
  for (let attempt = 0; attempt < 360; attempt += 1) {
    responseCache.delete(snapshotPath);
    const snapshot = await cachedGet(snapshotPath);
    if (!snapshot.ok) {
      state.validationError = errorText(snapshot);
      setStatus(state.validationError, true);
      terminalStatus = 'failed';
      break;
    }
    const data = snapshot.data;
    const summary = data?.summary ?? {};
    setStatus(`独立验证进度：${summary.completedDays ?? 0}/${summary.tradingDays ?? 0} 个交易日`);
    if (data?.status !== 'running' && data?.session?.status !== 'running') {
      terminalStatus = data?.status ?? data?.session?.status ?? 'failed';
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  state.validationRunning = false;
  state.validationPolling = false;
  responseCache.clear();
  if (terminalStatus === 'failed') {
    state.validationError ??= '独立验证失败；可以修复数据或权限后重新启动。';
    setStatus(state.validationError, true);
  } else if (terminalStatus === 'partial') {
    setStatus('独立验证部分完成；已完成日期保留为受限证据。', true);
  } else if (terminalStatus === 'complete') {
    setStatus('独立验证已完成；请查看覆盖事实与晋级门禁。');
  }
  await refresh();
};

const renderExperimentStarterTemplate = (context, state, setStatus, refresh) => {
  const template = context?.starterTemplate;
  if (template === undefined) return null;
  const load = experimentButton('载入到本地编辑器', 'btn btn-outline btn-sm', async () => {
    state.definition = cloneDefinition(template.definition);
    state.dirty = true;
    state.seedVersionId = undefined;
    state.proposedDraft = undefined;
    state.trial = undefined;
    state.trialError = undefined;
    state.jsonError = undefined;
    setStatus(`${template.id} 已载入页面编辑器；尚未创建 StrategyVersion。`);
    await refresh();
  });
  return el('section', 'experiment-surface experiment-starter-panel', [
    el('div', 'experiment-panel-heading', [
      el('div', null, [
        el('span', 'section-kicker', 'STARTER / X4 ENTRY'),
        el('h3', null, 'EARLY_BREAKOUT_V2_DRAFT'),
      ]),
      load,
    ]),
    el('p', 'muted', template.description),
    el('div', 'experiment-starter-facts', [
      el('span', 'mono', `template ${template.id}`),
      el('span', 'mono', `revision ${template.revision}`),
      el('span', 'mono', `definition ${compactHash(template.definitionHash)}`),
    ]),
    el(
      'p',
      'status warning',
      '这是可复制的研究入口，不是默认模板目录中的已发布策略；载入只修改当前页面内存。',
    ),
  ]);
};

const renderExperimentReview = (context, strategyId, state, setStatus, refresh) => {
  const promotion = context?.promotion;
  const candidate = context?.candidateVersion;
  const canPublish =
    candidate !== undefined &&
    context?.versionState?.candidateValid === true &&
    context?.versionState?.candidatePublished !== true;
  const publish = experimentButton(
    canPublish
      ? promotion?.status === 'eligible-for-human-review'
        ? '人工确认发布'
        : '仍然发布有效版本'
      : '发布需有效候选',
    'btn btn-primary btn-sm',
    async () => {
      if (!canPublish) return;
      const confirmed = await confirmDialog({
        title: '发布 StrategyVersion',
        message:
          promotion?.status === 'eligible-for-human-review'
            ? `证据门禁已允许人工评审。发布仍是独立的写入动作；候选 definition hash ${compactHash(candidate?.definitionHash)}，请确认切换当前版本。`
            : `当前证据门禁仍受阻；只有你明确确认，才会发布这个已通过静态校验的版本。候选 definition hash ${compactHash(candidate?.definitionHash)}。`,
        confirmLabel: '确认发布',
        danger: promotion?.status !== 'eligible-for-human-review',
      });
      if (!confirmed) return;
      publish.disabled = true;
      state.publishRunning = true;
      const result = await post(`/api/strategies/${encodeURIComponent(strategyId)}/publish`, {
        versionId: candidate.id,
      });
      state.publishRunning = false;
      publish.disabled = false;
      if (!result.ok) {
        setStatus(errorText(result), true);
        return;
      }
      experimentStateByStrategy.delete(strategyId);
      responseCache.clear();
      setStatus(`v${result.data.version.version} 已发布；请重新建立下一次实验。`);
      await refresh();
    },
  );
  if (state.publishRunning || !canPublish) publish.disabled = true;
  const metrics = promotion?.metrics ?? {};
  const validation = context?.validation;
  const validationDays = validation?.days ?? [];
  const evaluatorStatus = validation?.evaluatorIdentityStatus ?? 'unavailable';
  const strictBacktests = context?.strictBacktests ?? [];
  const evaluatorIdentityText =
    (validation?.evaluatorIdentities ?? []).length === 0
      ? '未提供 evaluator identity；不能把缺失身份解释成一致。'
      : (validation.evaluatorIdentities ?? [])
          .map(
            (identity) =>
              `${identity.version}${identity.codeHash === undefined ? '' : ` · ${compactHash(identity.codeHash)}`} · runs ${identity.runIds.join(', ')}`,
          )
          .join('\n');
  const strictEvaluatorIdentities = [
    ...new Map(
      strictBacktests.map((run) => [
        `${run.evaluator?.version ?? ''}\0${run.evaluator?.codeHash ?? ''}`,
        run.evaluator,
      ]),
    ).values(),
  ];
  const evaluatorIdentityWithStrictText = [
    evaluatorIdentityText,
    ...(strictEvaluatorIdentities.length === 0
      ? []
      : [
          `strict backtest: ${strictEvaluatorIdentities
            .map((identity) => `${identity.version} · ${compactHash(identity.codeHash)}`)
            .join(', ')}`,
        ]),
  ].join('\n');
  const adaptive = context?.adaptivePersonality;
  const reviewSnapshot = el('div', 'experiment-review-snapshot', [
    el('div', 'experiment-section-heading', [
      el('div', null, [
        el('span', 'section-kicker', 'PUBLISH PREFLIGHT / FACTS'),
        el('h4', null, '发布前事实快照'),
      ]),
      el('span', 'muted', '只读 · 不自动发布'),
    ]),
    el('div', 'experiment-review-fact-grid', [
      el('article', 'experiment-review-fact', [
        el('span', 'section-kicker', 'DEFINITION HASH'),
        el('strong', null, `baseline ${compactHash(context?.baseVersion?.definitionHash)}`),
        el('strong', null, `candidate ${compactHash(candidate?.definitionHash)}`),
      ]),
      el('article', 'experiment-review-fact', [
        el('span', 'section-kicker', 'VALIDATION INTERVAL / DATA COVERAGE'),
        el(
          'strong',
          null,
          validation?.session === undefined
            ? '未配置 validation session'
            : `${experimentDateText(validation.session.from)} → ${experimentDateText(validation.session.to)}`,
        ),
        el(
          'span',
          'muted',
          `complete days ${validationDays.filter((day) => day.status === 'complete').length}/${validationDays.length} · PIT vintage ${pct(validation?.vintageCoverageRatio)} · run IDs ${validation?.runIds?.length ?? 0}`,
        ),
      ]),
      el('article', 'experiment-review-fact', [
        el('span', 'section-kicker', 'EVALUATOR IDENTITY'),
        el('strong', null, evaluatorStatus),
        el('pre', null, evaluatorIdentityWithStrictText),
      ]),
      el('article', 'experiment-review-fact', [
        el('span', 'section-kicker', 'STRICT BACKTEST FACTS'),
        el(
          'strong',
          null,
          strictBacktests.length === 0 ? '未开始' : `${strictBacktests.length} 个运行`,
        ),
        el(
          'span',
          'muted',
          strictBacktests.length === 0
            ? '没有严格回测结果；不影响通用门禁，但不能声称已完成。'
            : strictBacktests
                .map((run) => `${run.id}: ${run.gateAudit?.status ?? run.resultAvailability}`)
                .join(' · '),
        ),
      ]),
      el('article', 'experiment-review-fact', [
        el('span', 'section-kicker', 'ADAPTIVE PERSONALITY / ADD-ON'),
        ...(adaptive === undefined
          ? [el('strong', null, '未配置 training session')]
          : [
              experimentStatusBadge(
                adaptive.status === 'eligible-for-human-review' ? 'eligible' : 'unavailable',
              ),
              el(
                'span',
                'muted',
                `training ${adaptive.trainingSessionId} · validation ${adaptive.validationSessionId}`,
              ),
              ...(adaptive.reasons ?? []).map((reason) => el('span', 'muted', reason)),
            ]),
        el('span', 'muted', '这是现有自适应人格门禁的附加读模型，不替代通用晋级门禁。'),
      ]),
    ]),
  ]);
  return el('section', 'experiment-surface experiment-review-panel', [
    el('div', 'experiment-panel-heading', [
      el('div', null, [
        el('span', 'section-kicker', 'HUMAN REVIEW GATE'),
        el('h3', null, '晋级评审'),
      ]),
      experimentStatusBadge(
        promotion?.status === 'eligible-for-human-review' ? 'eligible' : 'blocked',
      ),
    ]),
    el(
      'p',
      'muted',
      promotion?.status === 'eligible-for-human-review'
        ? '证据质量达到预设门禁，可交给人审；这不是自动发布信号。'
        : '门禁还未全部通过；原因透明展示，并不阻止你继续修复或重新验证。',
    ),
    el('div', 'experiment-summary-strip', [
      metric('验证交易日', metrics.validationTradingDays ?? 0, '要求 20'),
      metric('PIT vintage', pct(metrics.vintageCoverageRatio), '要求 100%'),
      metric('完整观察', metrics.completeObservationCount ?? 0, '要求 30'),
      metric('benchmark', pct(metrics.benchmarkCoverageRatio), '要求 90%'),
    ]),
    el('div', 'experiment-review-columns', [
      el('div', null, [
        el('h4', null, '未满足项'),
        ...(promotion?.reasons?.length === 0
          ? [el('p', 'status success', '暂无阻断原因。')]
          : (promotion?.reasons ?? []).map((reason) =>
              el('p', 'experiment-reason', [
                badge(['阻断', 'badge-important'], ''),
                EXPERIMENT_REASON_LABELS[reason] ?? reason,
              ]),
            )),
      ]),
      el('div', null, [
        el('h4', null, '限制与边界'),
        ...(promotion?.limitations ?? context?.limitations ?? []).map((item) =>
          el('p', 'muted', item),
        ),
      ]),
    ]),
    reviewSnapshot,
    ...(promotion?.factReferences?.length
      ? [
          el('details', 'experiment-facts', [
            el('summary', null, `查看 ${promotion.factReferences.length} 条 fact reference`),
            el('pre', null, promotion.factReferences.join('\n')),
          ]),
        ]
      : []),
    publish,
  ]);
};

const renderExperimentEditorActions = (context, state, strategyId, setStatus, refresh) => {
  const output = el('div', 'experiment-action-output');
  const propose = experimentButton('生成未持久化草案', 'btn btn-outline btn-sm', async () => {
    if (context?.baseVersion === undefined) {
      output.replaceChildren(el('p', 'status error', '没有 baseline，无法生成草案。'));
      return;
    }
    const confirmed = await confirmDialog({
      title: '生成未持久化草案',
      message:
        '将把当前定义与已核验事实交给外部 proposal tool。不会创建 StrategyVersion，也不会发布。',
      confirmLabel: '生成草案',
    });
    if (!confirmed) return;
    propose.disabled = true;
    state.proposalRunning = true;
    setStatus('正在生成未持久化草案…');
    const facts = await cachedGet(
      `/api/strategies/${encodeURIComponent(strategyId)}/insights?scope=operational&windowDays=30`,
    );
    if (!facts.ok) {
      state.proposalRunning = false;
      propose.disabled = false;
      state.proposalError = errorText(facts);
      output.replaceChildren(el('p', 'status error', state.proposalError));
      setStatus(state.proposalError, true);
      return;
    }
    const factReferences = [
      ...new Set(
        (facts.data?.facts ?? []).flatMap((fact) => [fact.id, ...(fact.evidenceIds ?? [])]),
      ),
    ].slice(0, 50);
    if (factReferences.length === 0) {
      state.proposalRunning = false;
      propose.disabled = false;
      state.proposalError = '当前没有可引用的已核验事实；不会伪造 fact reference。';
      output.replaceChildren(el('p', 'status error', state.proposalError));
      setStatus(state.proposalError, true);
      return;
    }
    const result = await post(`/api/strategies/${encodeURIComponent(strategyId)}/draft`, {
      baseVersionId: context.baseVersion.id,
      definition: state.definition,
      changeSummary: state.changeSummary.trim() || 'Web 实验室 proposal 草案',
      factReferences,
      windowDays: 30,
    });
    state.proposalRunning = false;
    propose.disabled = false;
    if (!result.ok) {
      state.proposalError = errorText(result);
      output.replaceChildren(el('p', 'status error', `草案生成失败：${state.proposalError}`));
      setStatus(state.proposalError, true);
      return;
    }
    state.proposedDraft = result.data;
    state.definition = cloneDefinition(result.data.draft.definition);
    state.dirty = true;
    state.jsonError = undefined;
    output.replaceChildren(
      el('p', 'status success', '未持久化草案已生成；请先审阅 Diff，再决定是否保存。'),
      el(
        'p',
        'muted',
        `draft ${result.data.draft.id} · audit persisted=false · facts ${result.data.audit.factReferences.length}`,
      ),
    );
    setStatus('未持久化草案已生成');
    await refresh();
  });
  const create = experimentButton('保存为持久化草案', 'btn btn-primary btn-sm', async () => {
    if (context?.baseVersion === undefined) {
      output.replaceChildren(el('p', 'status error', '没有 baseline，无法创建候选版本。'));
      return;
    }
    const confirmed = await confirmDialog({
      title: '保存为持久化草案',
      message: '将创建新的不可变 StrategyVersion 草案。下一步仍需显式校验、独立验证与人工发布。',
      confirmLabel: '保存草案',
    });
    if (!confirmed) return;
    create.disabled = true;
    state.createRunning = true;
    const result = await post(`/api/strategies/${encodeURIComponent(strategyId)}/versions`, {
      definition: state.definition,
      changeSummary: state.changeSummary.trim() || 'Web 实验室保存草案',
      parentVersionId: context.baseVersion.id,
      ...(state.proposedDraft?.audit?.factReferences === undefined
        ? {}
        : { factReferences: state.proposedDraft.audit.factReferences }),
    });
    state.createRunning = false;
    create.disabled = false;
    if (!result.ok) {
      output.replaceChildren(el('p', 'status error', `保存失败：${errorText(result)}`));
      setStatus(errorText(result), true);
      return;
    }
    state.dirty = false;
    state.seedVersionId = result.data.version.id;
    state.proposedDraft = undefined;
    responseCache.clear();
    output.replaceChildren(
      el('p', 'status success', `v${result.data.version.version} 草案已保存；请继续静态校验。`),
    );
    setStatus(`v${result.data.version.version} 草案已保存`);
    await refresh();
  });
  if (state.proposalRunning) propose.disabled = true;
  if (state.createRunning) create.disabled = true;
  return el('div', 'experiment-editor-actions', [
    el('div', 'row-actions', [propose, create]),
    output,
    ...(state.proposalError === undefined ? [] : [el('p', 'status error', state.proposalError)]),
  ]);
};

const renderExperiment = async (strategyId, setStatus, refresh) => {
  const initialState = experimentStateByStrategy.get(strategyId);
  const horizon = initialState?.horizon ?? 't5';
  const contextPath = `/api/strategies/${encodeURIComponent(strategyId)}/experiment?observationHorizon=${encodeURIComponent(horizon)}${initialState?.trainingSessionId === undefined ? '' : `&trainingSessionId=${encodeURIComponent(initialState.trainingSessionId)}`}${initialState?.validationSessionId === undefined ? '' : `&validationSessionId=${encodeURIComponent(initialState.validationSessionId)}`}`;
  const [catalogResult, contextResult] = await Promise.all([
    cachedGet('/api/strategy/dsl-catalog'),
    cachedGet(contextPath),
  ]);
  if (!catalogResult.ok) return el('p', 'status error', `字段目录：${errorText(catalogResult)}`);
  if (!contextResult.ok) return el('p', 'status error', `实验上下文：${errorText(contextResult)}`);
  const catalog = catalogResult.data;
  const context = contextResult.data;
  const state = experimentStateFor(strategyId, context, catalog);
  const horizonSelect = selectOptions(
    EXPERIMENT_HORIZONS.map((item) => ({ value: item, label: item.toUpperCase() })),
    state.horizon,
  );
  horizonSelect.addEventListener('change', async () => {
    state.horizon = horizonSelect.value;
    responseCache.delete(contextPath);
    await refresh();
  });
  const editor = renderExperimentDefinitionEditor(state, catalog);
  const actions = renderExperimentEditorActions(context, state, strategyId, setStatus, refresh);
  const starter = renderExperimentStarterTemplate(context, state, setStatus, refresh);
  return el('div', 'experiment-lab', [
    el('section', 'experiment-hero', [
      el('div', null, [
        el('span', 'section-kicker', 'STRATEGY EXPERIMENT LAB / X4'),
        el('h3', null, '基线 → 草案 → Diff → Trial → 独立验证 → 人工评审'),
        el('p', 'muted', '规则先被看见，再被保存；样本试算、历史验证与发布彼此分离。'),
      ]),
      el('div', 'experiment-hero-controls', [
        experimentControl('观察周期', horizonSelect, '观察事实按该 horizon 聚合。'),
        el('div', 'experiment-hero-state', [
          el('span', 'muted', 'promotion gate'),
          experimentStatusBadge(
            context.promotion?.status === 'eligible-for-human-review' ? 'eligible' : 'blocked',
          ),
        ]),
      ]),
    ]),
    renderExperimentStepRail(context, state),
    renderExperimentEvidenceLayers(context, state),
    renderExperimentVersionFacts(context),
    el('div', 'experiment-main-grid', [
      el('div', 'experiment-main-column', [
        ...(starter === null ? [] : [starter]),
        editor,
        actions,
      ]),
      renderExperimentCatalog(catalog),
    ]),
    renderExperimentDiff(context, state),
    el('div', 'experiment-evidence-grid', [
      renderExperimentTrial(state, context, strategyId, setStatus),
      renderExperimentValidation(state, context, strategyId, setStatus, refresh),
    ]),
    renderExperimentObservations(context),
    renderExperimentStrictBacktests(context, state, setStatus, refresh),
    renderExperimentReview(context, strategyId, state, setStatus, refresh),
    ...(context.limitations?.length
      ? [el('p', 'muted experiment-footer-note', context.limitations.join('；'))]
      : []),
  ]);
};

export const renderStrategyExperiment = renderExperiment;

const openVersionEditor = (strategy, latest, setStatus, refresh) => {
  const input = el('textarea', 'strategy-def-input');
  input.rows = 22;
  input.wrap = 'off';
  input.value = JSON.stringify(latest?.definition ?? {}, null, 2);
  const summary = el('input');
  summary.placeholder = '说明本次规则变化';
  const submit = el('button', 'btn btn-primary', '创建草案');
  submit.type = 'button';
  submit.addEventListener('click', async () => {
    let definition;
    try {
      definition = JSON.parse(input.value);
    } catch {
      setStatus('策略定义不是合法 JSON', true);
      return;
    }
    submit.disabled = true;
    const result = await post(`/api/strategies/${encodeURIComponent(strategy.id)}/versions`, {
      definition,
      changeSummary: summary.value.trim() || 'Web 创建版本草案',
    });
    submit.disabled = false;
    if (!result.ok) {
      setStatus(errorText(result), true);
      return;
    }
    closeModal();
    responseCache.clear();
    setStatus(`v${result.data.version.version} 草案已创建`);
    await refresh();
  });
  openModal(
    `新版本草案 · ${strategy.name}`,
    el('div', 'modal-form', [
      el('p', 'hint', '发布版本不可原地修改；保存会创建新的不可变版本草案。'),
      summary,
      input,
      el('div', 'modal-actions', [submit]),
    ]),
  );
};

const renderPreflightHistory = (history) => {
  const runs = Array.isArray(history?.runs) ? history.runs : [];
  const reasonCounts = Array.isArray(history?.reasonCounts) ? history.reasonCounts : [];
  const limitations = Array.isArray(history?.limitations) ? history.limitations : [];
  const latest = runs[0];
  const limitationText = limitations.join(' ');
  const emptyKind = limitationText.includes('损坏')
    ? 'corrupt'
    : limitationText.includes('旧运行')
      ? 'legacy'
      : 'empty';
  const emptyTitle =
    emptyKind === 'corrupt'
      ? '历史快照损坏'
      : emptyKind === 'legacy'
        ? '只有旧历史'
        : '暂无预检历史';
  const emptyMessage =
    emptyKind === 'corrupt'
      ? '发现的 preflight 快照未通过校验，已保守忽略；这不代表候选全部通过。'
      : emptyKind === 'legacy'
        ? '历史运行没有可读取的 preflight 快照，未用默认值补齐。'
        : '尚未读取到已结束的账户预检运行；未运行不等于全部通过。';

  const reasonRows = reasonCounts.map((item) => {
    const code = String(item.code ?? 'unknown');
    return el('li', 'strategy-preflight-reason-row', [
      el('span', null, PREFLIGHT_REASON_LABELS[code] ?? '未知原因'),
      el('code', 'mono muted', code),
      el('strong', 'mono', String(item.count ?? 0)),
    ]);
  });
  const runRows = runs.map((run, index) =>
    el('li', 'strategy-preflight-run-row', [
      el('span', 'mono muted', `#${index + 1} · ${fmtDateTime(run.finishedAt)}`),
      badge(
        run.workflowStatus === 'succeeded'
          ? ['完成', 'badge-active']
          : run.workflowStatus === 'partial'
            ? ['部分完成', 'badge-important']
            : ['失败', 'badge-pos'],
        run.workflowStatus,
      ),
      el('span', null, `可分析 ${run.eligible} · 跳过 ${run.skipped} · 不可用 ${run.unavailable}`),
    ]),
  );

  const latestContent =
    latest === undefined
      ? el('div', `strategy-preflight-empty strategy-preflight-empty-${emptyKind}`, [
          el('strong', null, emptyTitle),
          el('p', 'muted', emptyMessage),
        ])
      : el('div', 'strategy-preflight-latest', [
          el('div', 'strategy-preflight-latest-head', [
            el('div', null, [
              el('span', 'eyebrow', '最近一次预检'),
              el('strong', null, fmtDateTime(latest.finishedAt)),
            ]),
            el('span', 'mono muted', `运行开始 ${fmtDateTime(latest.startedAt)}`),
          ]),
          el('div', 'strategy-preflight-summary-grid', [
            metric('可进入 Advice 分析', latest.eligible, 'eligible'),
            metric('已跳过', latest.skipped, 'skipped'),
            metric('事实不可用', latest.unavailable, 'unavailable'),
            metric('候选总数', latest.total),
          ]),
          el('div', 'strategy-preflight-detail-grid', [
            el('section', 'strategy-preflight-subpanel', [
              el('div', 'strategy-preflight-subhead', [
                el('h4', null, `最近 ${runs.length} 次原因分布`),
                el('span', 'mono muted', `${reasonRows.length} 类 · ${runs.length} 次`),
              ]),
              ...(reasonRows.length === 0
                ? [el('p', 'placeholder', '本次没有记录阻断原因。')]
                : [el('ul', 'strategy-preflight-reason-list', reasonRows)]),
            ]),
            el('section', 'strategy-preflight-subpanel', [
              el('div', 'strategy-preflight-subhead', [
                el('h4', null, '候选事实'),
                el('span', 'mono muted', `${latest.candidates?.length ?? 0} 行`),
              ]),
              ...(latest.candidates?.length
                ? [
                    el('div', 'strategy-preflight-table-wrap', [
                      el('table', 'strategy-preflight-table', [
                        el('thead', null, [
                          el('tr', null, [
                            el('th', null, '股票'),
                            el('th', null, '资格状态'),
                            el('th', null, '原因 / 审计 code'),
                            el('th', null, '事实数'),
                          ]),
                        ]),
                        el(
                          'tbody',
                          null,
                          latest.candidates.map((candidate) =>
                            el('tr', null, [
                              el('td', null, [
                                el('strong', 'mono', candidate.stockId),
                                el('small', 'muted', fmtDateTime(candidate.evaluatedAt)),
                              ]),
                              el('td', null, [
                                badge(PREFLIGHT_STATUS[candidate.status], candidate.status),
                              ]),
                              el(
                                'td',
                                null,
                                (candidate.reasonCodes ?? []).length === 0
                                  ? el('span', 'muted', '—')
                                  : (candidate.reasonCodes ?? []).map((code) =>
                                      el('span', 'strategy-preflight-reason-chip', [
                                        el(
                                          'span',
                                          null,
                                          PREFLIGHT_REASON_LABELS[code] ?? '未知原因',
                                        ),
                                        el('code', 'mono muted', code),
                                      ]),
                                    ),
                              ),
                              el('td', 'mono', `事实 ${candidate.factCount ?? 0}`),
                            ]),
                          ),
                        ),
                      ]),
                    ]),
                  ]
                : [el('p', 'placeholder', '本次没有候选明细；不补齐默认候选。')]),
            ]),
          ]),
        ]);

  return el('section', 'strategy-schedule-panel strategy-preflight-history', [
    el('div', 'strategy-tab-heading', [
      el('div', null, [
        el('h3', null, '最近预检摘要'),
        el(
          'p',
          'muted',
          '只读取已结束 strategy-daily-cycle 快照；不会重跑预检、请求行情或调用 AI。',
        ),
      ]),
      el('span', 'mono muted', `${runs.length} 次可读取运行`),
    ]),
    latestContent,
    ...(runRows.length > 1
      ? [
          el('details', 'strategy-preflight-run-history', [
            el('summary', null, '查看更早的已读取运行'),
            el('ol', null, runRows.slice(1)),
          ]),
        ]
      : []),
    ...(limitations.length > 0
      ? [
          el('div', 'strategy-preflight-limitations', [
            el('strong', null, '读取限制'),
            el(
              'ul',
              null,
              limitations.map((limitation) => el('li', null, limitation)),
            ),
          ]),
        ]
      : []),
  ]);
};

const optionalNumberValue = (input) => {
  const raw = input.value.trim();
  if (raw.length === 0) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
};

const renderScheduleSettings = (strategy, schedule, setStatus, refresh) => {
  const existingPolicy = schedule?.recommendationPolicy;
  const initialV2 = existingPolicy?.schemaVersion === 2;
  let policyVersion = initialV2 ? 'v2' : 'v1';
  let v2Values = {
    ...RECOMMENDATION_POLICY_V2_DEFAULTS,
    ...(initialV2 ? existingPolicy.portfolioPreflight : {}),
  };
  const cron = el('input');
  cron.id = 'strategy-schedule-cron';
  cron.value = schedule?.cron ?? '0 18 * * 1-5';
  cron.placeholder = '0 18 * * 1-5';
  const timezone = el('input');
  timezone.id = 'strategy-schedule-timezone';
  timezone.value = schedule?.timezone ?? 'Asia/Shanghai';
  const enabled = el('input');
  enabled.id = 'strategy-schedule-enabled';
  enabled.type = 'checkbox';
  enabled.checked = schedule?.enabled ?? true;
  const recommendationEnabled = el('input');
  recommendationEnabled.id = 'strategy-recommendation-enabled';
  recommendationEnabled.type = 'checkbox';
  recommendationEnabled.checked = existingPolicy?.enabled ?? false;
  const configuredHorizons = Array.isArray(existingPolicy?.observationHorizons)
    ? existingPolicy.observationHorizons
    : ['t3', 't5'];
  const observationHorizons = ['t1', 't3', 't5'].map((horizon) => {
    const input = el('input');
    input.type = 'checkbox';
    input.value = horizon;
    input.checked = configuredHorizons.includes(horizon);
    return { horizon, input };
  });
  const minScore = el('input');
  minScore.type = 'number';
  minScore.min = '0';
  minScore.max = '100';
  minScore.value = String(existingPolicy?.minScore ?? 70);
  const maxRank = el('input');
  maxRank.type = 'number';
  maxRank.min = '1';
  maxRank.max = '200';
  maxRank.value = String(existingPolicy?.maxRank ?? 10);
  const maxPerRun = el('input');
  maxPerRun.type = 'number';
  maxPerRun.min = '1';
  maxPerRun.max = '20';
  maxPerRun.value = String(existingPolicy?.maxPerRun ?? 3);
  const cooldownHours = el('input');
  cooldownHours.type = 'number';
  cooldownHours.min = '1';
  cooldownHours.max = '720';
  cooldownHours.value = String(existingPolicy?.cooldownHours ?? 72);
  const notify = el('input');
  notify.type = 'checkbox';
  notify.checked = existingPolicy?.notify ?? true;
  const channel = el('select');
  for (const [value, label] of [
    ['log', '站内日志'],
    ['feishu', '飞书'],
  ]) {
    const option = el('option', null, label);
    option.value = value;
    channel.append(option);
  }
  channel.value = existingPolicy?.channel ?? 'log';

  const policyBadge = el('span', 'badge badge-neutral', 'Legacy V1');
  const policyNote = el('span', 'muted', '无 schemaVersion 的存量 policy 按 V1 语义保存。');
  const versionAction = el('button', 'btn btn-outline btn-sm', '启用账户预检 V2');
  versionAction.type = 'button';
  const preflightParameters = el('div', 'strategy-preflight-parameters');
  let preflightControls;

  const checkboxControl = (id, checked) => {
    const input = el('input');
    input.id = id;
    input.type = 'checkbox';
    input.checked = checked === true;
    return input;
  };
  const numberControl = (id, value, { min = '0', max = '100', step = '0.1' } = {}) => {
    const input = el('input');
    input.id = id;
    input.type = 'number';
    input.min = min;
    input.max = max;
    input.step = step;
    input.placeholder = '留空表示不启用';
    input.value = value === undefined ? '' : String(value);
    return input;
  };
  const checkboxLabel = (input, label, note) => {
    const node = el('label', 'strategy-preflight-toggle');
    node.htmlFor = input.id;
    node.append(input, el('span', null, label));
    if (note !== undefined) node.append(el('small', 'muted', note));
    return node;
  };
  const numberLabel = (input, label, note) => {
    const node = el('label', 'strategy-preflight-number');
    node.htmlFor = input.id;
    node.append(el('span', null, label), input);
    if (note !== undefined) node.append(el('small', 'muted', note));
    return node;
  };
  const preflightGroup = (title, key, controls) =>
    el('fieldset', 'strategy-preflight-group', [
      el('legend', null, title),
      el('p', 'muted', key),
      ...controls,
    ]);
  const readPreflightValues = () => {
    if (preflightControls === undefined) return v2Values;
    return {
      maxSinglePositionExposurePct: optionalNumberValue(
        preflightControls.maxSinglePositionExposurePct,
      ),
      maxIndustryExposurePct: optionalNumberValue(preflightControls.maxIndustryExposurePct),
      skipExistingHolding: preflightControls.skipExistingHolding.checked,
      requireLiquidityFacts: preflightControls.requireLiquidityFacts.checked,
      maxDataAgeTradingDays: Number(preflightControls.maxDataAgeTradingDays.value),
      rejectOnExitSignal: preflightControls.rejectOnExitSignal.checked,
      rejectOnRiskSignal: preflightControls.rejectOnRiskSignal.checked,
    };
  };
  const showLockedPreflight = () => {
    preflightControls = undefined;
    preflightParameters.replaceChildren(
      el('div', 'strategy-preflight-locked', [
        el('strong', null, '账户级预检未启用'),
        el(
          'p',
          'muted',
          'Legacy V1 不读取账户门禁；点击上方动作并确认后，才会显示并保存 V2 参数。',
        ),
      ]),
    );
  };
  const ensurePreflightControls = () => {
    if (preflightControls !== undefined) return;
    const skipExistingHolding = checkboxControl(
      'strategy-preflight-skip-existing-holding',
      v2Values.skipExistingHolding,
    );
    const requireLiquidityFacts = checkboxControl(
      'strategy-preflight-require-liquidity-facts',
      v2Values.requireLiquidityFacts,
    );
    const maxDataAgeTradingDays = numberControl(
      'strategy-preflight-max-data-age',
      v2Values.maxDataAgeTradingDays,
      { min: '0', max: '30', step: '1' },
    );
    maxDataAgeTradingDays.placeholder = '必填：0–30 的整数';
    const rejectOnExitSignal = checkboxControl(
      'strategy-preflight-reject-exit',
      v2Values.rejectOnExitSignal,
    );
    const rejectOnRiskSignal = checkboxControl(
      'strategy-preflight-reject-risk',
      v2Values.rejectOnRiskSignal,
    );
    const maxSinglePositionExposurePct = numberControl(
      'strategy-preflight-max-single-exposure',
      v2Values.maxSinglePositionExposurePct,
    );
    const maxIndustryExposurePct = numberControl(
      'strategy-preflight-max-industry-exposure',
      v2Values.maxIndustryExposurePct,
    );
    preflightControls = {
      maxSinglePositionExposurePct,
      maxIndustryExposurePct,
      skipExistingHolding,
      requireLiquidityFacts,
      maxDataAgeTradingDays,
      rejectOnExitSignal,
      rejectOnRiskSignal,
    };
    preflightParameters.replaceChildren(
      el(
        'p',
        'strategy-preflight-intro',
        'V2 在 Advice 分析前增加确定性账户门禁；缺失事实会保持不可用，不会猜测为安全。',
      ),
      el('div', 'strategy-preflight-grid', [
        preflightGroup('候选资格', '按持仓事实决定是否跳过候选。', [
          checkboxLabel(skipExistingHolding, '跳过已有持仓', '默认开启'),
        ]),
        preflightGroup('账户暴露', '空阈值不启用检查，保存时不会写入 0。', [
          numberLabel(maxSinglePositionExposurePct, '单仓暴露上限 (%)', '可选 · 0–100'),
          numberLabel(maxIndustryExposurePct, '行业暴露上限 (%)', '可选 · 0–100'),
        ]),
        preflightGroup('信号冲突', '遇到明确的退出或风险信号时阻断进入分析。', [
          checkboxLabel(rejectOnExitSignal, '拒绝退出信号', '默认开启'),
          checkboxLabel(rejectOnRiskSignal, '拒绝风险信号', '默认开启'),
        ]),
        preflightGroup('数据质量', '只接受指定新鲜度和流动性事实。', [
          checkboxLabel(requireLiquidityFacts, '要求流动性事实', '默认开启'),
          numberLabel(maxDataAgeTradingDays, '最大数据年龄（交易日）', '必填 · 0–30 的整数'),
        ]),
      ]),
    );
  };

  const updatePolicyVersionUi = () => {
    const v2 = policyVersion === 'v2';
    policyBadge.className = `badge ${v2 ? 'badge-active' : 'badge-neutral'}`;
    policyBadge.textContent = v2 ? 'Account-gated V2' : 'Legacy V1';
    policyNote.textContent = v2
      ? '保存会写入完整 schemaVersion=2 与 portfolioPreflight。'
      : '无 schemaVersion 的存量 policy 按 V1 语义保存，不会静默升级。';
    versionAction.textContent = v2 ? '切回 Legacy V1' : '启用账户预检 V2';
    if (v2) ensurePreflightControls();
    else showLockedPreflight();
  };
  updatePolicyVersionUi();
  versionAction.addEventListener('click', async () => {
    const target = policyVersion === 'v2' ? 'v1' : 'v2';
    const confirmed = await confirmDialog({
      title: target === 'v2' ? '启用账户预检 V2' : '切回 Legacy V1',
      message:
        target === 'v2'
          ? '确认选择 Account-gated V2？保存后将在 Advice 分析前读取账户、暴露、信号和数据质量事实；不会自动交易。'
          : '切回 Legacy V1 会丢弃本次保存的账户预检配置，只保留原有推荐字段。确认继续？',
      confirmLabel: target === 'v2' ? '选择 V2' : '切回 V1',
      danger: target === 'v1',
    });
    if (!confirmed) return;
    if (policyVersion === 'v2') v2Values = readPreflightValues();
    policyVersion = target;
    updatePolicyVersionUi();
    setStatus(
      target === 'v2'
        ? '已选择 Account-gated V2；保存前还会再次确认授权边界。'
        : '已选择 Legacy V1；保存将移除账户预检配置。',
    );
  });

  const buildRecommendationPolicy = () => {
    const base = {
      enabled: recommendationEnabled.checked,
      minScore: Number(minScore.value),
      maxRank: Number(maxRank.value),
      maxPerRun: Number(maxPerRun.value),
      cooldownHours: Number(cooldownHours.value),
      notify: notify.checked,
      channel: channel.value,
      observationHorizons: observationHorizons
        .filter(({ input }) => input.checked)
        .map(({ horizon }) => horizon),
    };
    if (policyVersion !== 'v2') return base;
    const values = readPreflightValues();
    return {
      ...base,
      schemaVersion: 2,
      portfolioPreflight: {
        ...(values.maxIndustryExposurePct === undefined
          ? {}
          : { maxIndustryExposurePct: values.maxIndustryExposurePct }),
        ...(values.maxSinglePositionExposurePct === undefined
          ? {}
          : { maxSinglePositionExposurePct: values.maxSinglePositionExposurePct }),
        skipExistingHolding: values.skipExistingHolding,
        requireLiquidityFacts: values.requireLiquidityFacts,
        maxDataAgeTradingDays: values.maxDataAgeTradingDays,
        rejectOnExitSignal: values.rejectOnExitSignal,
        rejectOnRiskSignal: values.rejectOnRiskSignal,
      },
    };
  };

  const save = el('button', 'btn btn-primary btn-sm', '保存调度');
  save.type = 'button';
  save.disabled = strategy.status !== 'active' || strategy.currentVersionId === undefined;
  const validateRequiredPreflightValues = () => {
    if (policyVersion !== 'v2') return true;
    const input = preflightControls?.maxDataAgeTradingDays;
    const raw = input?.value.trim() ?? '';
    const value = Number(raw);
    if (raw.length === 0 || !Number.isInteger(value) || value < 0 || value > 30) {
      setStatus('最大数据年龄（交易日）必须填写 0–30 之间的整数。', true);
      input?.focus();
      return false;
    }
    return true;
  };
  save.addEventListener('click', async () => {
    if (!validateRequiredPreflightValues()) return;
    if (policyVersion === 'v2') {
      const confirmed = await confirmDialog({
        title: '保存 Account-gated V2',
        message:
          '确认保存完整 V2 账户预检配置？它只决定候选是否进入 Advice 分析，不会发布、下单或自动交易。',
        confirmLabel: '确认保存 V2',
      });
      if (!confirmed) return;
    }
    save.disabled = true;
    const result = await post(`/api/strategies/${encodeURIComponent(strategy.id)}/schedule`, {
      cron: cron.value.trim(),
      timezone: timezone.value.trim(),
      enabled: enabled.checked,
      recommendationPolicy: buildRecommendationPolicy(),
    });
    save.disabled = false;
    if (!result.ok) {
      setStatus(errorText(result), true);
      return;
    }
    responseCache.clear();
    setStatus(`调度已保存，下次运行 ${fmtDateTime(result.data.schedule.nextRunAt)}`);
    await refresh();
  });
  return el('section', 'strategy-schedule-panel', [
    el('div', 'strategy-tab-heading', [
      el('div', null, [
        el('h3', null, '自动调度'),
        el('p', 'muted', '标准 5 段 cron；luoome 运行时每分钟自动检查到期策略。'),
      ]),
      save,
    ]),
    el('div', 'strategy-policy-status', [
      el('div', 'strategy-policy-status-copy', [
        el('span', 'eyebrow', '推荐 policy'),
        policyBadge,
        policyNote,
      ]),
      versionAction,
    ]),
    el('div', 'strategy-schedule-form', [
      el('label', null, ['Cron 表达式', cron]),
      el('label', null, ['时区', timezone]),
      el('label', 'strategy-schedule-toggle', [enabled, '启用']),
      el('label', 'strategy-schedule-toggle', [recommendationEnabled, '自动生成并保存 AI Advice']),
      el('fieldset', 'strategy-recommendation-horizons', [
        el('legend', null, '生成 Advice 的阶段观察'),
        ...observationHorizons.map(({ horizon, input }) =>
          el('label', 'strategy-schedule-toggle', [input, horizon.toUpperCase()]),
        ),
      ]),
      el('label', null, ['最低评分', minScore]),
      el('label', null, ['最高排名', maxRank]),
      el('label', null, ['每轮最多推荐', maxPerRun]),
      el('label', null, ['冷却小时', cooldownHours]),
      el('label', 'strategy-schedule-toggle', [notify, '生成后发送通知（与 Advice 开关独立）']),
      el('label', null, ['通知渠道', channel]),
    ]),
    preflightParameters,
    el('div', 'strategy-recommendation-notice', [
      el('strong', null, '推荐策略授权边界'),
      el('p', null, '仅对 accepted + published operational run 生效。'),
      el('p', null, '勾选的 T+n 观察完成后，系统才会再次生成并保存阶段 Advice。'),
      el('p', null, '不会自动交易；通知开关与 Advice 生成开关相互独立。'),
    ]),
    el(
      'p',
      'mono muted',
      schedule?.nextRunAt
        ? `下次计划 ${fmtDateTime(schedule.nextRunAt)}`
        : '保存后计算下次运行时间；策略暂停时调度会跳过并推进。',
    ),
    ...(save.disabled ? [el('p', 'status warning', '只有已发布且运行中的策略可以启用调度。')] : []),
  ]);
};

const renderStrategyWatchlistSubscriptions = async (strategy, setStatus, refresh) => {
  const [subscriptionsResult, watchlistsResult] = await Promise.all([
    cachedGet(`/api/strategies/${encodeURIComponent(strategy.id)}/watchlists`),
    cachedGet('/api/watchlists'),
  ]);
  if (!subscriptionsResult.ok) {
    return el('section', 'strategy-schedule-panel', [
      el('h3', null, 'Strategy → Watchlist 订阅'),
      el('p', 'status error', errorText(subscriptionsResult)),
    ]);
  }
  if (!watchlistsResult.ok) {
    return el('section', 'strategy-schedule-panel', [
      el('h3', null, 'Strategy → Watchlist 订阅'),
      el('p', 'status error', errorText(watchlistsResult)),
    ]);
  }
  const subscriptions = subscriptionsResult.data.subscriptions ?? [];
  const targets = (watchlistsResult.data.items ?? []).filter(
    ({ watchlist }) => watchlist.enabled && watchlist.kind !== 'system',
  );
  const select = el('select');
  for (const { watchlist } of targets) {
    const option = el('option', null, `${watchlist.name} · ${watchlist.id}`);
    option.value = watchlist.id;
    select.append(option);
  }
  const subscribe = el('button', 'btn btn-primary btn-sm', '订阅目标 Watchlist');
  subscribe.type = 'button';
  subscribe.disabled = targets.length === 0;
  subscribe.addEventListener('click', async () => {
    if (select.value.length === 0) return;
    const target = targets.find(({ watchlist }) => watchlist.id === select.value)?.watchlist;
    const confirmed = await confirmDialog({
      title: '订阅 Strategy 输出',
      message: `确认将 ${strategy.name} 的后续 published operational run 同步到“${target?.name ?? select.value}”？部分数据只会标 stale，试跑/评估/未发布运行不会改变 Watchlist。`,
      confirmLabel: '确认订阅',
    });
    if (!confirmed) return;
    subscribe.disabled = true;
    const result = await post(`/api/strategies/${encodeURIComponent(strategy.id)}/watchlists`, {
      watchlistId: select.value,
    });
    subscribe.disabled = targets.length === 0;
    if (!result.ok) {
      setStatus(errorText(result), true);
      return;
    }
    responseCache.clear();
    setStatus(result.data.idempotent ? '订阅已存在' : 'Strategy→Watchlist 订阅已创建');
    await refresh();
  });
  const activeRows = subscriptions.map((subscription) => {
    const target = targets.find(({ watchlist }) => watchlist.id === subscription.watchlistId);
    const cancel = el('button', 'btn btn-outline btn-sm', '取消订阅');
    cancel.type = 'button';
    cancel.addEventListener('click', async () => {
      const confirmed = await confirmDialog({
        title: '取消 Strategy 订阅',
        message: `确认停止将 ${strategy.name} 的后续 published operational run 同步到“${target?.name ?? subscription.watchlistId}”？已有 Watchlist 成员和同步历史不会被删除。`,
        confirmLabel: '取消订阅',
      });
      if (!confirmed) return;
      cancel.disabled = true;
      const result = await callApi(
        `/api/strategies/${encodeURIComponent(strategy.id)}/watchlists/${encodeURIComponent(subscription.watchlistId)}`,
        { method: 'DELETE', body: '{}' },
      );
      if (!result.ok) {
        cancel.disabled = false;
        setStatus(errorText(result), true);
        return;
      }
      responseCache.clear();
      setStatus('Strategy→Watchlist 订阅已取消');
      await refresh();
    });
    return el('article', 'entity-item', [
      el('div', 'flex gap-2', [
        el('strong', null, target?.name ?? subscription.watchlistId),
        el('span', 'badge badge-active', '同步中'),
      ]),
      el(
        'p',
        'muted',
        `source ${subscription.sourceKey} · 创建于 ${fmtDateTime(subscription.createdAt)}`,
      ),
      cancel,
    ]);
  });
  return el('section', 'strategy-schedule-panel', [
    el('div', 'strategy-tab-heading', [
      el('div', null, [
        el('h3', null, 'Strategy → Watchlist 订阅'),
        el(
          'p',
          'muted',
          '必须显式选择目标。只有 published operational run 才会同步；partial 只标 stale，不根据缺失集合退出来源。',
        ),
      ]),
      el('div', 'row-actions', [select, subscribe]),
    ]),
    ...(targets.length === 0 ? [el('p', 'status warning', '没有可订阅的启用 Watchlist。')] : []),
    ...(activeRows.length === 0
      ? [el('p', 'placeholder', '当前没有 active Strategy→Watchlist 订阅。')]
      : [el('div', 'entity-list', activeRows)]),
  ]);
};

export const renderSettings = async (strategyId, setStatus, refresh) => {
  const [result, scheduleResult, preflightHistoryResult] = await Promise.all([
    cachedGet(`/api/strategies/${encodeURIComponent(strategyId)}`),
    cachedGet(`/api/strategies/${encodeURIComponent(strategyId)}/schedule`),
    cachedGet(
      `/api/strategies/${encodeURIComponent(strategyId)}/recommendation-preflights?limit=10`,
    ),
  ]);
  if (!result.ok) return el('p', 'status error', errorText(result));
  if (!scheduleResult.ok) return el('p', 'status error', errorText(scheduleResult));
  const { strategy, versions } = result.data;
  const subscriptionPanel = await renderStrategyWatchlistSubscriptions(
    strategy,
    setStatus,
    refresh,
  );
  const preflightHistory = preflightHistoryResult.ok
    ? preflightHistoryResult.data
    : {
        runs: [],
        reasonCounts: [],
        limitations: ['预检历史暂时不可读；当前设置仍可保存。'],
      };
  const latest = versions.at(-1);
  const actions = el('div', 'row-actions');
  const create = el('button', 'btn btn-outline btn-sm', '创建新版本');
  create.type = 'button';
  create.addEventListener('click', () => openVersionEditor(strategy, latest, setStatus, refresh));
  actions.append(create);
  if (latest !== undefined && latest.publishedAt === undefined) {
    const validate = el('button', 'btn btn-outline btn-sm', '静态校验');
    validate.type = 'button';
    validate.addEventListener('click', async () => {
      validate.disabled = true;
      const checked = await post(`/api/strategies/${encodeURIComponent(strategy.id)}/validate`, {
        versionId: latest.id,
      });
      validate.disabled = false;
      responseCache.clear();
      setStatus(checked.ok ? '版本校验完成' : errorText(checked), !checked.ok);
      if (checked.ok) await refresh();
    });
    actions.append(validate);
    if (latest.validationStatus === 'valid') {
      const publish = el('button', 'btn btn-primary btn-sm', '发布版本');
      publish.type = 'button';
      publish.addEventListener('click', async () => {
        const confirmed = await confirmDialog({
          title: '发布策略版本',
          message: `确认发布 v${latest.version} 并将其设为当前有效版本？`,
          confirmLabel: '发布',
        });
        if (!confirmed) return;
        publish.disabled = true;
        const published = await post(`/api/strategies/${encodeURIComponent(strategy.id)}/publish`, {
          versionId: latest.id,
        });
        publish.disabled = false;
        responseCache.clear();
        setStatus(published.ok ? '策略版本已发布' : errorText(published), !published.ok);
        if (published.ok) await refresh();
      });
      actions.append(publish);
    }
  }
  if (strategy.status === 'active' || strategy.status === 'paused') {
    const next = strategy.status === 'active' ? 'pause' : 'resume';
    const toggle = el(
      'button',
      'btn btn-outline btn-sm',
      next === 'pause' ? '暂停策略' : '恢复策略',
    );
    toggle.type = 'button';
    toggle.addEventListener('click', async () => {
      const changed = await post(`/api/strategies/${encodeURIComponent(strategy.id)}/${next}`, {});
      responseCache.clear();
      setStatus(
        changed.ok ? (next === 'pause' ? '策略已暂停' : '策略已恢复') : errorText(changed),
        !changed.ok,
      );
      if (changed.ok) await refresh();
    });
    actions.append(toggle);
  }
  const remove = el('button', 'btn btn-danger btn-sm', '删除策略');
  remove.type = 'button';
  remove.addEventListener('click', async () => {
    const confirmed = await confirmDialog({
      title: '删除策略',
      message: `确认删除“${strategy.name}”？版本、调度、运行结果、信号和观察数据都会一并删除，且无法撤销。`,
      confirmLabel: '删除',
      danger: true,
    });
    if (!confirmed) return;
    remove.disabled = true;
    const deleted = await callApi(`/api/strategies/${encodeURIComponent(strategy.id)}`, {
      method: 'DELETE',
      body: '{}',
    });
    if (!deleted.ok) {
      remove.disabled = false;
      setStatus(errorText(deleted), true);
      return;
    }
    responseCache.clear();
    setStatus('策略已删除');
    window.location.hash = '#strategies';
  });
  actions.append(remove);
  const versionRows = versions.map((version) =>
    el('article', 'entity-item strategy-version-item', [
      el('div', 'flex gap-2', [
        el('strong', null, `v${version.version}`),
        badge(
          version.validationStatus === 'valid'
            ? ['有效', 'badge-active']
            : version.validationStatus === 'invalid'
              ? ['无效', 'badge-pos']
              : ['待校验', 'badge-neutral'],
          version.validationStatus,
        ),
        ...(version.publishedAt ? [el('span', 'badge badge-active', '已发布')] : []),
      ]),
      el('p', null, version.changeSummary ?? '无变更说明'),
      ...(version.validationErrors ?? []).map((message) => el('p', 'status error', message)),
      el('details', null, [
        el('summary', null, '查看 definition JSON'),
        el('pre', 'strategy-definition-json', JSON.stringify(version.definition, null, 2)),
      ]),
    ]),
  );
  return el('div', null, [
    el('div', 'strategy-tab-heading', [el('h3', null, '版本与运行设置'), actions]),
    ...(versionRows.length === 0
      ? [el('p', 'placeholder', '尚无版本，请创建第一个版本草案。')]
      : versionRows),
    subscriptionPanel,
    el('div', 'strategy-automation-grid', [
      renderScheduleSettings(strategy, scheduleResult.data.schedule, setStatus, refresh),
      renderPreflightHistory(preflightHistory),
    ]),
  ]);
};

const renderTabContent = async (workspace, state, setStatus, refresh) => {
  if (state.tab === 'overview') return renderOverview(workspace, state);
  if (state.tab === 'experiment')
    return renderExperiment(workspace.strategy.id, setStatus, refresh);
  if (state.tab === 'pool') return renderPool(workspace.strategy.id, setStatus);
  if (state.tab === 'runs') return renderRuns(workspace.strategy.id, state.scope ?? 'operational');
  if (state.tab === 'insights')
    return renderInsights(workspace.strategy.id, setStatus, state.scope ?? 'operational', state);
  if (state.tab === 'cycle') return renderDecisionCycles(workspace.strategy.id, state);
  return renderSettings(workspace.strategy.id, setStatus, refresh);
};

export const parseBacktestStockIds = (value) => {
  const stockIds = [
    ...new Set(
      String(value ?? '')
        .split(/[\s,，;；]+/)
        .map((stockId) => stockId.trim().toUpperCase())
        .filter(Boolean),
    ),
  ];
  return stockIds.length === 0 ? undefined : stockIds;
};

const BACKTEST_STATUS = {
  complete: ['完成', 'badge-active'],
  partial: ['部分完成', 'badge-important'],
  failed: ['失败', 'badge-pos'],
};

const VINTAGE_STATUS = {
  available: ['版本可用', 'badge-active'],
  unavailable: ['版本不可用', 'badge-important'],
  'not-applicable': ['不适用', 'badge-neutral'],
};

const STRICT_GATE_STATUS = {
  complete: ['完整', 'badge-active'],
  partial: ['部分可用', 'badge-important'],
  unavailable: ['不可用', 'badge-pos'],
};

export const buildStrictBacktestResultContent = (run) => {
  const gateRows = (run.gateAudit?.items ?? []).map((item) =>
    el('tr', null, [
      el('td', 'mono', item.key),
      el('td', null, badge(STRICT_GATE_STATUS[item.status], item.status)),
      el(
        'td',
        'muted',
        [item.reason ?? item.detail ?? '', ...(item.evidenceRefs ?? [])]
          .filter(Boolean)
          .join(' · '),
      ),
    ]),
  );
  const metrics = run.metrics;
  const metricNodes =
    metrics === undefined
      ? [
          el(
            'p',
            'status warning',
            '数据门禁未完整通过，净值、收益、回撤等指标暂不可用；不会输出伪造 Sharpe 或胜率。',
          ),
        ]
      : [
          el('div', 'strategy-summary-grid', [
            metric('最终净值', fmtNum(metrics.finalEquity)),
            metric('净收益', `${fmtSigned(metrics.netReturnPct)}%`),
            metric('最大回撤', `${fmtSigned(metrics.maxDrawdownPct)}%`),
            metric('基准收益', `${fmtSigned(metrics.benchmarkReturnPct)}%`),
            metric('超额收益', `${fmtSigned(metrics.excessReturnPct)}%`),
            metric('成交笔数', metrics.tradeCount),
          ]),
        ];
  return el('div', 'strategy-backtest-result', [
    el(
      'p',
      'muted',
      `严格回测 ${run.id} · ${run.status} · 输入指纹 ${String(run.inputFingerprint ?? '').slice(0, 12) || '--'}${run.inputFingerprint ? '…' : ''}`,
    ),
    ...metricNodes,
    el('h4', null, '门禁审计'),
    ...(gateRows.length === 0
      ? [el('p', 'placeholder', '暂无门禁审计。')]
      : [
          el('div', 'table-wrap', [
            el('table', 'table', [
              el(
                'thead',
                null,
                el(
                  'tr',
                  null,
                  ['门禁', '状态', '证据'].map((label) => el('th', null, label)),
                ),
              ),
              el('tbody', null, gateRows),
            ]),
          ]),
        ]),
    ...(run.error === undefined ? [] : [el('p', 'status error', run.error)]),
    el('p', 'muted', '严格回测与生产运行、历史评估隔离，不生成 Advice、Trade 或通知。'),
  ]);
};

export const runStrictStrategyBacktest = async (strategy, input, setStatus) => {
  setStatus('正在检查严格回测数据门禁…');
  const created = await post(
    `/api/strategies/${encodeURIComponent(strategy.id)}/strict-backtests`,
    input,
  );
  if (!created.ok) {
    setStatus(errorText(created), true);
    return created;
  }
  const initial = created.data?.run;
  const runId = initial?.id;
  if (typeof runId !== 'string') return created;
  let run = initial;
  for (
    let attempt = 0;
    attempt < 360 && (run.status === 'queued' || run.status === 'running');
    attempt += 1
  ) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    const snapshot = await callApi(
      `/api/strategies/${encodeURIComponent(strategy.id)}/strict-backtests/${encodeURIComponent(runId)}`,
    );
    if (!snapshot.ok) {
      setStatus(errorText(snapshot), true);
      return snapshot;
    }
    run = snapshot.data.run;
    setStatus(`严格回测：${run.status}，门禁 ${run.gateAudit?.status ?? 'unknown'}`);
  }
  openModal(`严格回测 · ${strategy.name}`, buildStrictBacktestResultContent(run));
  setStatus(
    run.metrics === undefined
      ? `严格回测${run.resultAvailability === 'unavailable' ? '不可用' : '部分完成'}：请查看门禁审计`
      : `严格回测完成：净收益 ${fmtSigned(run.metrics.netReturnPct)}%`,
    run.metrics === undefined,
  );
  return { ...created, data: { run } };
};

const openStrictBacktestDialog = async (strategy, setStatus) => {
  const values = await promptDialog({
    title: `严格回测 · ${strategy.name}`,
    fields: [
      { key: 'evaluationSessionId', label: '历史评估 session ID', value: '' },
      { key: 'initialCash', label: '初始资金', value: '1000000' },
      { key: 'commissionBps', label: '佣金（bps）', value: '3' },
      { key: 'minimumCommission', label: '最低佣金', value: '5' },
      { key: 'sellStampDutyBps', label: '卖出印花税（bps）', value: '5' },
      { key: 'buySlippageBps', label: '买入滑点（bps）', value: '2' },
      { key: 'sellSlippageBps', label: '卖出滑点（bps）', value: '2' },
    ],
    confirmLabel: '创建严格回测',
    note: '必须提供已完成的历史评估 session。任一 PIT、修订、费用、滑点、可交易性、公司行动、基准或求值器身份门禁缺失时，只返回不可用/部分结果，不生成收益指标。',
  });
  if (values === null) return;
  await runStrictStrategyBacktest(
    strategy,
    {
      evaluationSessionId: values.evaluationSessionId,
      initialCash: Number(values.initialCash),
      costs: {
        commissionBps: Number(values.commissionBps),
        minimumCommission: Number(values.minimumCommission),
        sellStampDutyBps: Number(values.sellStampDutyBps),
        buySlippageBps: Number(values.buySlippageBps),
        sellSlippageBps: Number(values.sellSlippageBps),
      },
    },
    setStatus,
  );
};

export const buildBacktestResultContent = (data, strategyId = '', sessionId) => {
  const summary = data.summary;
  const evaluationSessionId = sessionId ?? data.sessionId ?? data.session?.id;
  const evaluationButton = el('button', 'btn btn-outline btn-sm', '查看历史评估记录');
  evaluationButton.type = 'button';
  const evaluationHash = buildStrategyHash({
    strategyId,
    tab: 'runs',
    scope: 'evaluation',
  });
  evaluationButton.addEventListener('click', () => {
    window.location.hash = evaluationHash;
    closeModal();
  });
  const rows = (data.days ?? []).map((day) =>
    el('tr', null, [
      el('td', 'mono', String(day.dataAsOf).slice(0, 10)),
      el('td', null, badge(BACKTEST_STATUS[day.status], day.status)),
      el('td', null, badge(VINTAGE_STATUS[day.vintageStatus], day.vintageStatus)),
      el('td', 'num mono', day.evaluatedCount ?? '--'),
      el('td', 'num mono', day.selectedCount ?? '--'),
      el('td', 'num mono', day.signalCount ?? '--'),
      el('td', 'num mono', day.failedCount ?? '--'),
      el('td', 'muted', day.error ?? ''),
    ]),
  );
  return el('div', 'strategy-backtest-result', [
    el('div', 'strategy-summary-grid', [
      metric(
        '交易日',
        summary.tradingDays,
        `完成 ${summary.completedDays} · 失败 ${summary.failedDays}`,
      ),
      metric('累计求值', summary.evaluatedCount),
      metric('累计入选', summary.selectedCount),
      metric('累计信号', summary.signalCount),
    ]),
    ...(strategyId.length === 0 ? [] : [el('div', 'modal-actions', evaluationButton)]),
    el(
      'p',
      'status warning',
      '这是按历史时点逐日重放的策略模拟，只统计规则命中与信号；不含收益、费用、滑点和可交易性模拟，不构成投资建议。',
    ),
    ...(rows.length === 0
      ? [el('p', 'placeholder', '所选区间没有交易日。')]
      : [
          el('div', 'table-wrap', [
            el('table', 'table', [
              el(
                'thead',
                null,
                el(
                  'tr',
                  null,
                  ['日期', '状态', '历史数据', '求值', '入选', '信号', '失败', '说明'].map(
                    (label) => el('th', null, label),
                  ),
                ),
              ),
              el('tbody', null, rows),
            ]),
          ]),
        ]),
    ...(evaluationSessionId === undefined
      ? []
      : [el('p', 'mono muted', `Evaluation session ${evaluationSessionId}`)]),
  ]);
};

const buildBacktestProgressContent = (data, strategyId, sessionId, setStatus) => {
  const summary = data.summary ?? {
    tradingDays: 0,
    completedDays: 0,
    failedDays: 0,
    selectedCount: 0,
  };
  const cancel = el('button', 'btn btn-danger btn-sm', '取消历史评估');
  cancel.type = 'button';
  cancel.addEventListener('click', async () => {
    cancel.disabled = true;
    const result = await post(
      `/api/strategies/${encodeURIComponent(strategyId)}/backtests/${encodeURIComponent(sessionId)}/cancel`,
      {},
    );
    setStatus(result.ok ? '已请求取消历史评估，已完成日期会保留' : errorText(result), !result.ok);
  });
  return el('div', 'strategy-backtest-progress', [
    el(
      'p',
      null,
      `已完成 ${summary.completedDays ?? 0}/${summary.tradingDays ?? 0} 个交易日，失败 ${summary.failedDays ?? 0}，累计入选 ${summary.selectedCount ?? 0}`,
    ),
    el('p', 'muted', '任务在后台运行，页面会按日期刷新进度；历史评估不会替换当前生产股票池。'),
    el('div', 'modal-actions', [cancel]),
  ]);
};

export const runStrategyBacktest = async (strategy, input, setStatus) => {
  setStatus('正在逐交易日运行历史模拟…');
  const result = await post(`/api/strategies/${encodeURIComponent(strategy.id)}/backtests`, input);
  if (!result.ok) {
    setStatus(errorText(result), true);
    return result;
  }
  let completed = result.data?.summary === undefined ? undefined : result.data;
  const sessionId = result.data?.sessionId ?? result.data?.session?.id;
  if (completed === undefined && typeof sessionId === 'string') {
    openModal(
      `模拟回测（历史回放）· ${strategy.name}`,
      buildBacktestProgressContent(result.data, strategy.id, sessionId, setStatus),
    );
    for (let attempt = 0; attempt < 360; attempt += 1) {
      const snapshot = await callApi(
        `/api/strategies/${encodeURIComponent(strategy.id)}/backtests/${encodeURIComponent(sessionId)}`,
      );
      if (!snapshot.ok) {
        setStatus(errorText(snapshot), true);
        return snapshot;
      }
      const data = snapshot.data;
      const summary = data.summary ?? {};
      setStatus(
        `历史评估进度：${summary.completedDays ?? 0}/${summary.tradingDays ?? 0} 个交易日，已入选 ${summary.selectedCount ?? 0}`,
      );
      if (data.status !== 'running' && data.session?.status !== 'running') {
        completed = data;
        break;
      }
      openModal(
        `模拟回测（历史回放）· ${strategy.name}`,
        buildBacktestProgressContent(data, strategy.id, sessionId, setStatus),
      );
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  if (completed === undefined) {
    setStatus('历史评估仍在后台运行，可在执行记录中查看进度', false);
    return result;
  }
  responseCache.clear();
  openModal(
    `模拟回测（历史回放）· ${strategy.name}`,
    buildBacktestResultContent(completed, strategy.id, sessionId),
  );
  const completionLabel =
    completed.status === 'complete'
      ? '历史模拟完成'
      : completed.status === 'partial'
        ? '历史模拟部分完成'
        : '历史模拟失败或已取消';
  setStatus(
    `${completionLabel}：${completed.summary.completedDays}/${completed.summary.tradingDays} 个交易日，累计入选 ${completed.summary.selectedCount}，信号 ${completed.summary.signalCount}`,
    completed.status !== 'complete',
  );
  return { ...result, data: completed };
};

const localDateText = (date) => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const openBacktestDialog = async (strategy, setStatus) => {
  const to = new Date();
  const from = new Date(to);
  from.setDate(from.getDate() - 30);
  const values = await promptDialog({
    title: `模拟回测（历史回放）· ${strategy.name}`,
    fields: [
      { key: 'from', label: '开始日期（YYYY-MM-DD）', value: localDateText(from) },
      { key: 'to', label: '结束日期（YYYY-MM-DD）', value: localDateText(to) },
      {
        key: 'stockIds',
        label: '股票代码（可选，逗号或换行分隔）',
        value: '',
        multiline: true,
        rows: 4,
      },
    ],
    confirmLabel: '开始模拟',
    note: '最长 31 个自然日；留空将按历史时点全市场运行，可能耗时。结果保存为历史评估，不会替换当前股票池。',
  });
  if (values === null) return;
  const stockIds = parseBacktestStockIds(values.stockIds);
  if (stockIds !== undefined && stockIds.length > 500) {
    setStatus('模拟范围最多包含 500 只股票', true);
    return;
  }
  await runStrategyBacktest(
    strategy,
    {
      from: values.from,
      to: values.to,
      ...(stockIds === undefined ? {} : { stockIds }),
    },
    setStatus,
  );
};

const runAction = async (strategy, persist, setStatus, refresh) => {
  let stockIds;
  if (!persist) {
    const values = await promptDialog({
      title: '样本试跑',
      fields: [{ key: 'stockId', label: '样本股票代码', value: '600519.SH' }],
      confirmLabel: '试跑',
      note: '试跑读取外部行情，但不落库、不替换当前股票池。',
    });
    if (values === null || values.stockId.length === 0) return;
    stockIds = [values.stockId];
  } else {
    const confirmed = await confirmDialog({
      title: '正式运行',
      message:
        '将执行全市场扫描并原子落库。只有运行验收通过才会替换当前股票池；验收未通过或执行失败时保留上一份股票池。',
      confirmLabel: '开始运行',
    });
    if (!confirmed) return;
  }
  setStatus(persist ? '策略正式运行中…' : '策略样本试跑中…');
  const result = await post(`/api/strategies/${encodeURIComponent(strategy.id)}/run`, {
    ...(stockIds === undefined ? {} : { stockIds }),
    persist,
  });
  if (!result.ok) {
    setStatus(errorText(result), true);
    return;
  }
  responseCache.clear();
  const dataHealth =
    result.data.run.summary?.schemaVersion === 3
      ? `，数据${DATA_HEALTH[result.data.run.summary.dataHealth] ?? result.data.run.summary.dataHealth}`
      : '';
  setStatus(
    persist
      ? `运行${RUN_STATUS[result.data.run.status]?.[0] ?? result.data.run.status}${dataHealth}；结果 ${result.data.results.length}，信号 ${result.data.signals.length}`
      : `试跑${RUN_STATUS[result.data.run.status]?.[0] ?? result.data.run.status}${dataHealth}；结果 ${result.data.results.length}（未落库）`,
  );
  await refresh();
};

const renderWorkspaceDetail = async (strategyId, state, setStatus, epoch) => {
  const root = $('#strategy-detail');
  if (root === null) return;
  mount(root, el('p', 'placeholder', '加载策略工作台…'));
  const result = await cachedGet(`/api/strategies/${encodeURIComponent(strategyId)}/workspace`);
  if (epoch !== requestEpoch) return;
  if (!result.ok) {
    mount(root, el('p', 'status error', errorText(result)));
    return;
  }
  const workspace = result.data;
  const rerender = async () => {
    const nextEpoch = ++requestEpoch;
    await renderWorkspaceDetail(
      strategyId,
      parseStrategyHash(window.location.hash),
      setStatus,
      nextEpoch,
    );
  };
  const headerActions = el('div', 'row-actions');
  if (workspace.currentVersion !== undefined && workspace.strategy.status === 'active') {
    const strictBacktest = el('button', 'btn btn-outline btn-sm', '严格回测');
    strictBacktest.type = 'button';
    strictBacktest.addEventListener(
      'click',
      () => void openStrictBacktestDialog(workspace.strategy, setStatus),
    );
    const backtest = el('button', 'btn btn-outline btn-sm', '模拟回测');
    backtest.type = 'button';
    backtest.addEventListener(
      'click',
      () => void openBacktestDialog(workspace.strategy, setStatus),
    );
    const sample = el('button', 'btn btn-outline btn-sm', '样本试跑');
    sample.type = 'button';
    sample.addEventListener(
      'click',
      () => void runAction(workspace.strategy, false, setStatus, rerender),
    );
    const formal = el('button', 'btn btn-primary btn-sm', '正式运行');
    formal.type = 'button';
    formal.addEventListener(
      'click',
      () => void runAction(workspace.strategy, true, setStatus, rerender),
    );
    headerActions.append(strictBacktest, backtest, sample, formal);
  }
  const tabs = el('div', 'strategy-tabs');
  tabs.setAttribute('role', 'tablist');
  const tabButtons = Object.entries(TAB_LABELS).map(([key, label]) => {
    const button = el('button', state.tab === key ? 'active' : '', label);
    button.type = 'button';
    button.setAttribute('role', 'tab');
    button.setAttribute('aria-selected', String(state.tab === key));
    button.tabIndex = state.tab === key ? 0 : -1;
    button.addEventListener('click', () => navigate(state, { tab: key }));
    tabs.append(button);
    return button;
  });
  tabs.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const current = tabButtons.indexOf(document.activeElement);
    const delta = event.key === 'ArrowRight' ? 1 : -1;
    const next = (Math.max(0, current) + delta + tabButtons.length) % tabButtons.length;
    tabButtons[next]?.focus();
    tabButtons[next]?.click();
  });
  const panel = el('div', 'strategy-tab-panel');
  panel.setAttribute('role', 'tabpanel');
  panel.append(el('p', 'placeholder', '加载视图…'));
  mount(root, [
    el('article', 'strategy-workspace', [
      el('header', 'strategy-workspace-head', [
        el('div', null, [
          el('div', 'flex gap-2', [
            el('h2', null, workspace.strategy.name),
            badge(STRATEGY_STATUS[workspace.strategy.status], workspace.strategy.status),
            ...(workspace.currentVersion
              ? [el('span', 'badge badge-neutral', `v${workspace.currentVersion.version}`)]
              : []),
            ...(workspace.currentRun
              ? [
                  badge(
                    PUBLICATION_STATUS[workspace.currentRun.publication?.status] ?? null,
                    workspace.currentRun.publication?.status ?? 'legacy/unknown',
                  ),
                ]
              : []),
          ]),
          el('p', 'muted', workspace.strategy.description),
          el(
            'div',
            'strategy-workspace-meta',
            workspace.currentRun
              ? `数据截止 ${fmtDateTime(workspace.currentRun.dataAsOf)} · 可用运行 ${fmtDateTime(workspace.currentRun.finishedAt ?? workspace.currentRun.startedAt)}`
              : '尚无可用运行',
          ),
        ]),
        headerActions,
      ]),
      renderHealthBanner(workspace),
      tabs,
      panel,
    ]),
  ]);
  const content = await renderTabContent(workspace, state, setStatus, rerender);
  if (epoch !== requestEpoch) return;
  mount(panel, content);
};

export const renderStrategyWorkspacePage = async ({
  setStatus,
  preferredStrategyId = '',
  onSelect = () => {},
}) => {
  const epoch = ++requestEpoch;
  const list = $('#strategies-list');
  const detail = $('#strategy-detail');
  if (list === null || detail === null) return;
  const state = parseStrategyHash(window.location.hash);
  const result = await cachedGet('/api/strategies');
  if (epoch !== requestEpoch) return;
  if (!result.ok) {
    mount(list, el('p', 'status error', errorText(result)));
    return;
  }
  const strategies = result.data.strategies ?? [];
  if (
    state.strategyId.length === 0 &&
    preferredStrategyId.length > 0 &&
    strategies.some((strategy) => strategy.id === preferredStrategyId)
  ) {
    window.location.hash = buildStrategyHash({
      ...state,
      strategyId: preferredStrategyId,
      tab: 'settings',
    });
    return;
  }
  if (
    state.strategyId.length === 0 &&
    preferredStrategyId.length > 0 &&
    !strategies.some((strategy) => strategy.id === preferredStrategyId)
  ) {
    onSelect('');
  }
  const meta = $('#strategies-meta');
  if (meta !== null) meta.textContent = `${strategies.length} 个`;
  mount(
    list,
    strategies.length === 0
      ? el('div', 'strategy-empty-state compact', [
          el('strong', null, '尚无策略'),
          el('p', 'muted', '从右上角新增策略或复制内置模板。'),
        ])
      : strategies.map((strategy) => {
          const row = el('button', 'strategy-catalog-item', [
            el('span', 'strategy-catalog-copy', [
              el('strong', null, strategy.name),
              el('small', null, strategy.description),
            ]),
            badge(STRATEGY_STATUS[strategy.status], strategy.status),
          ]);
          row.type = 'button';
          if (strategy.id === state.strategyId) row.classList.add('selected');
          row.addEventListener('click', () => {
            onSelect(strategy.id);
            navigate(state, { strategyId: strategy.id, tab: 'overview', runId: undefined });
          });
          return row;
        }),
  );
  if (state.strategyId.length === 0) {
    mount(
      detail,
      el('div', 'strategy-empty-state', [
        el('span', 'section-kicker', 'STRATEGY WORKSPACE'),
        el('h2', null, '选择策略查看工作台'),
        el('p', 'muted', '查看当前股票池、候选、运行 Diff 和不可变版本。'),
      ]),
    );
    return;
  }
  if (!strategies.some((strategy) => strategy.id === state.strategyId)) {
    mount(detail, el('p', 'status error', '所选 Strategy 不存在或已不可见。'));
    return;
  }
  onSelect(state.strategyId);
  await renderWorkspaceDetail(state.strategyId, state, setStatus, epoch);
};
