import {
  badge,
  cloneDefinition,
  confirmDialog,
  createFeatureCache,
  DATA_HEALTH,
  el,
  errorText,
  fmtNum,
  metric,
  post,
  promptDialog,
} from './strategy-workspace-shared.js';

const featureCache = createFeatureCache();
const { cachedGet } = featureCache;
export const invalidateExperimentCache = () => {
  featureCache.clear();
  experimentStateByStrategy.clear();
};

const experimentStateByStrategy = new Map();
const pct = (value) => (value === undefined ? '--' : `${String(fmtNum(value * 100, 2))}%`);

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
    featureCache.clear();
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
    featureCache.clear();
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
    featureCache.clear();
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
    featureCache.clear();
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
                  featureCache.clear();
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
    featureCache.delete(snapshotPath);
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
  featureCache.clear();
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
      featureCache.clear();
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
    featureCache.clear();
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
    featureCache.delete(contextPath);
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
