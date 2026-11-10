import { cloneDefinition, el } from './strategy-workspace-shared.js';

const _EXPERIMENT_HORIZONS = ['t1', 't3', 't5'];
const _EXPERIMENT_STATUS = {
  'not-started': ['未开始', 'experiment-status-idle'],
  ready: ['待执行', 'experiment-status-ready'],
  eligible: ['可评审', 'experiment-status-ready'],
  'memory-only': ['仅页面内存', 'experiment-status-ready'],
  running: ['进行中', 'experiment-status-running'],
  complete: ['已完成', 'experiment-status-complete'],
  blocked: ['受阻', 'experiment-status-blocked'],
  unavailable: ['不可用', 'experiment-status-unavailable'],
};
const _EXPERIMENT_REASON_LABELS = {
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
const _EXPERIMENT_CHANGE_LABELS = {
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

const FIELD_LABELS = {
  'quote.open': '开盘价',
  'quote.high': '最高价',
  'quote.low': '最低价',
  'quote.close': '最新 / 收盘价',
  'quote.prevClose': '昨日收盘价',
  'quote.volume': '成交量',
  'indicators.ma5': '5 日均线',
  'indicators.ma10': '10 日均线',
  'indicators.ma20': '20 日均线',
  'indicators.ma60': '60 日均线',
  'indicators.rsi14': '14 日相对强弱（RSI）',
  'indicators.macdDif': 'MACD 快线',
  'indicators.macdDea': 'MACD 慢线',
  'indicators.macdHist': 'MACD 柱值',
  'indicators.volMa5': '5 日均量',
  'indicators.volMa20': '20 日均量',
  'indicators.volRatio5_20': '5 / 20 日量比',
  'indicators.high20': '20 日最高价',
  'indicators.low20': '20 日最低价',
  'indicators.momentum20Pct': '20 日涨跌幅',
  'indicators.maDistance20Pct': '20 日均线偏离幅度',
  'indicators.maDistance60Pct': '60 日均线偏离幅度',
  'indicators.daysAboveMa20': '站上 20 日均线天数',
  'indicators.bollUpper20': '布林线上轨',
  'indicators.bollMiddle20': '布林线中轨',
  'indicators.bollLower20': '布林线下轨',
  'meta.recentLimitUp': '近期是否涨停',
  'meta.daysSinceLimitUp': '距上次涨停天数',
  'meta.priceUp': '价格是否上涨',
  'meta.limitUpLevel': '连板高度',
};
const experimentFieldLabel = (field) => FIELD_LABELS[field.path] ?? field.path;

const experimentFieldMeta = (field) => {
  if (field === undefined)
    return el('small', 'experiment-field-meta', '当前 catalog 没有可用字段。');
  const lookback =
    field.requiredLookback === undefined ? '' : `需 ${field.requiredLookback} 个交易日数据`;
  const source = EXPERIMENT_DATA_SOURCE_LABELS[field.dataSource] ?? field.dataSource;
  const unit =
    field.unit === undefined
      ? ''
      : `单位：${({ CNY: '元', share: '股', percent: '%', ratio: '比例', 'trading-day': '交易日', board: '板' })[field.unit] ?? field.unit}`;
  return el('small', 'experiment-field-meta', [unit, lookback, source].filter(Boolean).join(' · '));
};

const _experimentValueText = (value) => {
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
    const expression = el('textarea', 'experiment-expression-input');
    expression.rows = 3;
    expression.value = rule.when ?? '';
    expression.addEventListener('input', () => {
      rule.when = expression.value;
      changed();
    });
    return experimentControl(
      '自定义条件表达式',
      expression,
      '复杂条件保留原表达式，可直接修改；其余配置仍可使用表单。',
    );
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
      target.score = next ?? value.value;
      changed();
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
        { value: 'bullish', label: '看多' },
        { value: 'bearish', label: '看空' },
        { value: 'neutral', label: '中性' },
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
        { value: 'level', label: '条件持续满足' },
        { value: 'edge', label: '首次进入条件' },
      ],
      emission.mode ?? 'level',
    );
    emissionMode.addEventListener('change', () => {
      rule.emission = { ...rule.emission, mode: emissionMode.value };
      changed();
    });
    const cooldown = el('input');
    cooldown.type = 'number';
    cooldown.min = '0';
    cooldown.max = '60';
    cooldown.value = String(emission.cooldownTradingDays ?? 0);
    cooldown.addEventListener('input', () => {
      rule.emission = { ...rule.emission, cooldownTradingDays: Number(cooldown.value) || 0 };
      changed();
    });
    controls.push(
      el('div', 'experiment-condition-grid', [
        renderExperimentScoreEditor('信号分数', rule, catalog, changed, rebuild),
        experimentControl('方向', direction),
        experimentControl('信号生成时机', emissionMode),
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
        el('strong', null, options.signal === true ? '信号条件' : '筛选条件'),
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
      { value: 'all', label: '全部条件满足' },
      { value: 'any', label: '任一条件满足' },
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
          ? '先添加至少一条筛选规则，再启用加权评分。'
          : '可选；启用后权重由服务端 schema 校验，前端不替代领域规则。',
      ),
    ]);
  }
  const components = Array.isArray(scoring.components) ? scoring.components : [];
  const total = components.reduce((sum, component) => sum + (Number(component.weight) || 0), 0);
  const totalLabel = el('span', 'mono muted', `权重合计 ${(total * 100).toFixed(2)}%`);
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
      el('div', 'experiment-inline-actions', [totalLabel, add]),
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
              .map((rule) => ({ value: rule.id, label: rule.name })),
            component.ruleId,
          );
          ruleId.addEventListener('change', () => {
            component.ruleId = ruleId.value;
            changed();
          });
          const weight = el('input');
          weight.type = 'number';
          weight.min = '0.000001';
          weight.max = '100';
          weight.step = '0.01';
          weight.value = String((component.weight ?? 1) * 100);
          weight.addEventListener('input', () => {
            component.weight = Number(weight.value) / 100;
            totalLabel.textContent = `权重合计 ${(components.reduce((sum, item) => sum + item.weight, 0) * 100).toFixed(2)}%`;
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
            experimentControl('权重（%）', weight),
            remove,
          ]);
        })),
    el('p', 'muted', '权重合计应为 100%；每项分数按权重计入总分。'),
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
    definition.metadata = { ...definition.metadata, style: style.value || undefined };
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
    definition.metadata = { ...definition.metadata, horizon: horizon.value };
    changed();
  });
  const include = el('textarea');
  include.rows = 2;
  include.value = (universe.includeStockIds ?? []).join(', ');
  include.placeholder = '可选：600519.SH, 000001.SZ';
  include.addEventListener('input', () => {
    const ids = parseExperimentStockIds(include.value);
    definition.universe = {
      ...definition.universe,
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
    definition.universe = {
      ...definition.universe,
      excludeStockIds: parseExperimentStockIds(exclude.value),
    };
    changed();
  });
  return el('div', 'experiment-structured-editor', [
    el('section', 'experiment-builder-section experiment-metadata-section', [
      el('div', 'experiment-section-heading', [
        el('div', null, [
          el('span', 'section-kicker', '00 / METADATA'),
          el('h4', null, '策略范围'),
        ]),
        el('span', 'badge badge-neutral', '保存时校验'),
      ]),
      el('div', 'experiment-field-grid', [
        experimentControl('风格标签', style),
        experimentControl('策略周期', horizon),
        experimentControl(
          '市场范围',
          Object.assign(el('input'), {
            value: '沪深 A 股',
            readOnly: true,
          }),
          '包含股票留空时覆盖全部沪深 A 股。',
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

// 仅检查编辑器读取的结构；领域合法性仍由服务端校验。
const assertEditorDefinitionShape = (definition) => {
  if (
    definition?.schemaVersion !== 1 ||
    !definition.metadata ||
    !definition.universe ||
    !Array.isArray(definition.selection?.rules) ||
    !definition.signals ||
    !['entry', 'exit', 'risk'].every((scope) => Array.isArray(definition.signals[scope])) ||
    (definition.scoring !== undefined && !Array.isArray(definition.scoring?.components))
  ) {
    throw new Error('请提供完整的策略定义：范围、筛选规则和信号分区');
  }
  const rules = [...definition.selection.rules, ...Object.values(definition.signals).flat()];
  if (
    rules.some((rule) => rule === null || typeof rule !== 'object' || !Array.isArray(rule.evidence))
  ) {
    throw new Error('每条规则需要条件、名称和证据列表');
  }
};

export const createStrategyDefinitionEditor = (definition, catalog) => {
  const state = {
    definition: cloneDefinition(definition ?? createExperimentBlankDefinition(catalog)),
    mode: 'structured',
    changeSummary: '',
  };
  const root = el('div', 'strategy-form-editor');
  const render = () =>
    root.replaceChildren(renderExperimentDefinitionEditor(state, catalog, { standalone: true }));
  render();
  return {
    root,
    getValue: () => {
      if (state.jsonError !== undefined) throw new Error(state.jsonError);
      assertEditorDefinitionShape(state.definition);
      return cloneDefinition(state.definition);
    },
    setValue: (next) => {
      assertEditorDefinitionShape(next);
      state.definition = cloneDefinition(next);
      state.jsonError = undefined;
      state.mode = 'structured';
      render();
    },
  };
};

const renderExperimentDefinitionEditor = (state, catalog, { standalone = false } = {}) => {
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
      assertEditorDefinitionShape(parsed);
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
    if (state.jsonError !== undefined) return;
    state.mode = 'structured';
    renderBody();
  });
  const advanced = experimentButton('JSON 高级', 'btn btn-outline btn-sm', async () => {
    state.mode = 'json';
    if (state.jsonError === undefined) rebuildJsonText();
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
      standalone
        ? '按栏目配置规则，保存为草案；发布仍需单独操作。'
        : '先在本地编辑；“生成未持久化草案”只做外部分析，“保存为持久化草案”才写入版本库。',
    ),
    ...(standalone ? [] : [experimentControl('变更说明', summary)]),
    status,
    bodyHost,
  ]);
};
