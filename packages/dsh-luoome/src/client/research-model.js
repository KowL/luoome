import { strategyExpression, strategyText } from './projection.js';

const comparisons = ['>', '>=', '<', '<=', '==', '===', '!=', '!=='];
const numberLiteral = /^-?(?:\d+(?:\.\d*)?|\.\d+)$/;
const simpleCondition =
  /^\s*([\w.]+)\s*(===|!==|==|!=|<=|>=|<|>)\s*(true|false|-?(?:\d+(?:\.\d*)?|\.\d+))\s*$/;

export const fieldLabel = (field) =>
  `${strategyExpression(field.path)}${field.unit ? ` · ${field.unit}` : ''}`;

export const conditionFields = (catalog) =>
  (catalog?.fields ?? []).filter((field) => ['number', 'boolean'].includes(field.type));

export const conditionOperators = (field) =>
  comparisons.filter((operator) => field?.operators.includes(operator));

export const parseCondition = (expression, catalog) => {
  const match = expression.match(simpleCondition);
  if (!match) return null;
  const field = conditionFields(catalog).find((item) => item.path === match[1]);
  if (!field || !conditionOperators(field).includes(match[2])) return null;
  if (field.type === 'boolean' && !['true', 'false'].includes(match[3])) return null;
  if (field.type === 'number' && !numberLiteral.test(match[3])) return null;
  return { field, operator: match[2], value: match[3] };
};

export const buildCondition = (field, operator, value) => {
  const text = String(value).trim();
  if (!field || !conditionOperators(field).includes(operator)) return null;
  if (field.type === 'number' && (!numberLiteral.test(text) || !Number.isFinite(Number(text))))
    return null;
  if (field.type === 'boolean' && !['true', 'false'].includes(text)) return null;
  if (!['number', 'boolean'].includes(field.type)) return null;
  return `${field.path} ${operator} ${text}`;
};

export const nextRuleId = (definition, scope) => {
  const ids = new Set([
    ...definition.selection.rules.map((rule) => rule.id),
    ...Object.values(definition.signals)
      .flat()
      .map((rule) => rule.id),
  ]);
  let index = 1;
  while (ids.has(`${scope}-${index}`)) index++;
  return `${scope}-${index}`;
};

export const draftRule = (definition, scope, catalog) => {
  const field = conditionFields(catalog)[0];
  if (!field) return null;
  const when = buildCondition(
    field,
    conditionOperators(field)[0],
    field.type === 'boolean' ? 'true' : '0',
  );
  if (!when) return null;
  return {
    id: nextRuleId(definition, scope),
    name: '新条件',
    when,
    evidence: [`${strategyExpression(field.path)}：\${${field.path}}`],
    ...(scope === 'selection' ? {} : { score: '50', direction: 'neutral' }),
  };
};

export const replaceRules = (definition, scope, rules) =>
  scope === 'selection'
    ? { ...definition, selection: { ...definition.selection, rules } }
    : { ...definition, signals: { ...definition.signals, [scope]: rules } };

export const stockIdsFromText = (value) => [
  ...new Set(value.split(/[\s,，;；、]+/).filter(Boolean)),
];

const researchDay = (value) => (value ? String(value).slice(0, 10) : '');

export const researchFormOf = (record, versions, currentVersionId) => {
  const state = record?.state;
  return {
    question: state?.question ?? '',
    baseVersionId: state?.baseVersionId ?? currentVersionId ?? versions.at(-1)?.id ?? '',
    candidateVersionId: state?.candidateVersionId ?? '',
    stockText: state?.stockIds?.join('、') ?? '',
    from: researchDay(state?.from),
    to: researchDay(state?.to),
    benchmarkStockId: state?.benchmarkStockId ?? '',
    trainingSessionId: state?.trainingSessionId ?? '',
    validationSessionId: state?.validationSessionId ?? '',
    nextStep: state?.nextStep ?? '',
    summary: state?.conclusion?.summary ?? '',
    outcome: state?.conclusion?.outcome ?? 'inconclusive',
    limitations: state?.conclusion?.limitations?.join('\n') ?? '',
    evidenceReferences: state?.conclusion?.evidenceReferences ?? [],
    comparison: state?.comparison,
  };
};

export const researchSettingsOf = (form) => ({
  question: form.question.trim(),
  baseVersionId: form.baseVersionId,
  ...(form.candidateVersionId ? { candidateVersionId: form.candidateVersionId } : {}),
  ...(stockIdsFromText(form.stockText).length
    ? { stockIds: stockIdsFromText(form.stockText) }
    : {}),
  ...(form.from ? { from: form.from } : {}),
  ...(form.to ? { to: form.to } : {}),
  ...(form.benchmarkStockId ? { benchmarkStockId: form.benchmarkStockId } : {}),
  ...(form.trainingSessionId ? { trainingSessionId: form.trainingSessionId } : {}),
  ...(form.validationSessionId ? { validationSessionId: form.validationSessionId } : {}),
  ...(form.nextStep.trim() ? { nextStep: form.nextStep.trim() } : {}),
  ...(form.comparison ? { comparison: form.comparison } : {}),
  ...(form.summary.trim()
    ? {
        conclusion: {
          summary: form.summary.trim(),
          outcome: form.outcome,
          limitations: form.limitations
            .split('\n')
            .map((item) => item.trim())
            .filter(Boolean),
          evidenceReferences: form.evidenceReferences,
        },
      }
    : {}),
});

export const evidenceValue = (value) => {
  if (value === null || value === undefined) return '未提供';
  if (typeof value === 'boolean') return value ? '是' : '否';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '未提供';
  return strategyText(String(value));
};

export const RESEARCH_STATUS = {
  'not-started': ['未开始', 'quiet'],
  'memory-only': ['仅本次试跑', 'quiet'],
  running: ['进行中', 'accent'],
  pending: ['待执行', 'quiet'],
  queued: ['排队中', 'quiet'],
  complete: ['执行结束', 'ok'],
  succeeded: ['已完成', 'ok'],
  partial: ['部分可用', 'warn'],
  unavailable: ['数据不可用', 'warn'],
  blocked: ['存在阻塞', 'warn'],
  failed: ['失败', 'bad'],
  cancelled: ['已取消', 'quiet'],
  eligible: ['证据可评审', 'accent'],
  ready: ['可执行', 'accent'],
  'requires-live-data': ['需实际试跑核对', 'warn'],
  available: ['可用', 'ok'],
  supported: ['支持', 'ok'],
};

export const DIAGNOSIS_KIND = {
  selected: ['入选', 'ok'],
  'rule-near-miss': ['规则临界', 'accent'],
  'ranking-near-miss': ['排名临界', 'accent'],
  excluded: ['未入选', 'quiet'],
  incomplete: ['数据缺失', 'warn'],
};

export const COMPARISON_KINDS = {
  versions: {
    title: '同快照版本对照',
    note: '基线与候选使用同一股票样本、事实时间和输入快照，观察规则修改的影响。',
  },
  dates: {
    title: '跨日运行变化',
    note: '展示不同日期的入选、退出和缺失变化。市场事实也在变化，不能把差异全部归因于版本修改。',
  },
  strategies: {
    title: '跨策略研究',
    note: '跨策略比较需要相同样本、日期、基准和执行模型。当前工具仅支持同一策略的运行对照；可分别导出研究定义后核对口径。',
  },
};
