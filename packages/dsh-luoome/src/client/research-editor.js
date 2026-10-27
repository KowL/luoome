import { createElement as h, useEffect, useState } from 'react';
import { Empty, Pill } from './primitives.js';
import { strategyExpression } from './projection.js';
import {
  buildCondition,
  conditionFields,
  conditionOperators,
  draftRule,
  fieldLabel,
  parseCondition,
  replaceRules,
} from './research-model.js';

export const ResearchField = ({ label, hint, children, wide = false }) =>
  h(
    'label',
    { className: `luo-field luo-research-field${wide ? ' is-wide' : ''}` },
    h('span', null, label),
    children,
    hint ? h('span', { className: 'luo-fine' }, hint) : null,
  );

const Button = ({ children, ...props }) =>
  h('button', { type: 'button', className: 'luo-btn', ...props }, children);

const ConditionEditor = ({ expression, catalog, onChange, disabled }) => {
  const condition = parseCondition(expression, catalog);
  const [threshold, setThreshold] = useState(condition?.value ?? '');
  useEffect(() => {
    setThreshold(condition?.value ?? '');
  }, [condition?.value]);
  const fields = conditionFields(catalog);
  if (!condition)
    return h(
      ResearchField,
      {
        label: '复合条件表达式',
        wide: true,
        hint: '保留原有逻辑；修改后仍需由服务端校验。可在下方字段目录查阅可用事实。',
      },
      h('textarea', {
        value: expression,
        rows: 3,
        maxLength: 1000,
        disabled,
        spellCheck: false,
        onChange: (event) => onChange(event.target.value),
      }),
    );
  const update = (field, operator, value) => {
    const next = buildCondition(field, operator, value);
    if (next !== null) onChange(next);
  };
  return h(
    'div',
    { className: 'luo-condition-editor' },
    h(
      ResearchField,
      { label: '事实字段' },
      h(
        'select',
        {
          value: condition.field.path,
          disabled,
          onChange: (event) => {
            const field = fields.find((item) => item.path === event.target.value);
            update(field, conditionOperators(field)[0], field.type === 'boolean' ? 'true' : '0');
          },
        },
        fields.map((field) =>
          h('option', { key: field.path, value: field.path }, fieldLabel(field)),
        ),
      ),
    ),
    h(
      ResearchField,
      { label: '比较' },
      h(
        'select',
        {
          value: condition.operator,
          disabled,
          onChange: (event) => update(condition.field, event.target.value, condition.value),
        },
        conditionOperators(condition.field).map((operator) =>
          h('option', { key: operator, value: operator }, strategyExpression(operator)),
        ),
      ),
    ),
    h(
      ResearchField,
      { label: condition.field.unit ? `门槛（${condition.field.unit}）` : '门槛' },
      condition.field.type === 'boolean'
        ? h(
            'select',
            {
              value: condition.value,
              disabled,
              onChange: (event) => update(condition.field, condition.operator, event.target.value),
            },
            h('option', { value: 'true' }, '是'),
            h('option', { value: 'false' }, '否'),
          )
        : h('input', {
            type: 'number',
            step: 'any',
            value: threshold,
            disabled,
            onChange: (event) => setThreshold(event.target.value),
            onBlur: () => {
              const next = buildCondition(condition.field, condition.operator, threshold);
              if (next === null) setThreshold(condition.value);
              else onChange(next);
            },
          }),
    ),
  );
};

const ScoreEditor = ({ score, catalog, onChange, disabled }) => {
  const numericFields = (catalog?.fields ?? []).filter((field) => field.type === 'number');
  const field = numericFields.find((item) => score === `\${${item.path}}` || score === item.path);
  const isConstant = /^\d+(?:\.\d+)?$/.test(score);
  const mode = field ? 'field' : isConstant ? 'constant' : 'expression';
  return h(
    'div',
    { className: 'luo-score-editor' },
    h(
      ResearchField,
      { label: '评分方式' },
      h(
        'select',
        {
          value: mode,
          disabled,
          onChange: (event) =>
            onChange(
              event.target.value === 'field' && numericFields.length
                ? `\${${numericFields[0].path}}`
                : event.target.value === 'expression'
                  ? `(${score})`
                  : '50',
            ),
        },
        h('option', { value: 'constant' }, '固定分数'),
        h('option', { value: 'field', disabled: numericFields.length === 0 }, '数值事实'),
        h('option', { value: 'expression' }, '复合表达式'),
      ),
    ),
    h(
      ResearchField,
      { label: mode === 'field' ? '评分字段' : '评分值 / 表达式' },
      mode === 'field'
        ? h(
            'select',
            {
              value: field.path,
              disabled,
              onChange: (event) => onChange(`\${${event.target.value}}`),
            },
            numericFields.map((item) =>
              h('option', { key: item.path, value: item.path }, fieldLabel(item)),
            ),
          )
        : h('input', {
            value: score,
            disabled,
            maxLength: 1000,
            type: mode === 'constant' ? 'number' : 'text',
            ...(mode === 'constant' ? { min: 0, max: 100, step: 'any' } : {}),
            onChange: (event) => onChange(event.target.value),
          }),
    ),
  );
};

export function DefinitionEditor({ definition, catalog, onChange, disabled }) {
  if (!definition) return h(Empty, { title: '选择一个基线版本后开始编辑。' });
  const editScope = (scope, index, patch) => {
    const rules = scope === 'selection' ? definition.selection.rules : definition.signals[scope];
    onChange(
      replaceRules(
        definition,
        scope,
        rules.map((rule, i) => (i === index ? { ...rule, ...patch } : rule)),
      ),
    );
  };
  const hasCatalog = catalog?.fields.length > 0;
  return h(
    'div',
    { className: 'luo-definition-editor' },
    !hasCatalog
      ? h(
          'p',
          { className: 'luo-fine', role: 'status' },
          '字段目录尚未读到，暂时保留定义。刷新目录后可编辑。',
        )
      : null,
    h(
      'div',
      { className: 'luo-research-fields' },
      h(
        ResearchField,
        { label: '研究周期' },
        h(
          'select',
          {
            value: definition.metadata.horizon ?? '',
            disabled,
            onChange: (event) => {
              const metadata = { ...definition.metadata };
              if (event.target.value) metadata.horizon = event.target.value;
              else delete metadata.horizon;
              onChange({ ...definition, metadata });
            },
          },
          ['', 'intraday', 'short', 'medium', 'long'].map((value) =>
            h(
              'option',
              { key: value, value },
              { '': '未限定', intraday: '日内', short: '短期', medium: '中期', long: '长期' }[
                value
              ],
            ),
          ),
        ),
      ),
      h(
        ResearchField,
        { label: '筛选逻辑' },
        h(
          'select',
          {
            value: definition.selection.logic,
            disabled,
            onChange: (event) =>
              onChange({
                ...definition,
                selection: { ...definition.selection, logic: event.target.value },
              }),
          },
          h('option', { value: 'all' }, '全部条件满足'),
          h('option', { value: 'any' }, '任一条件满足'),
        ),
      ),
    ),
    [
      ['selection', '选股条件'],
      ['entry', '入场信号'],
      ['exit', '退出条件'],
      ['risk', '风险条件'],
    ].map(([scope, label]) => {
      const rules = scope === 'selection' ? definition.selection.rules : definition.signals[scope];
      return h(
        'details',
        { key: scope, className: 'luo-research-scope', open: scope === 'selection' },
        h('summary', null, label, h(Pill, null, `${rules.length} 条`)),
        rules.map((rule, index) => {
          const referenced =
            scope === 'selection' &&
            definition.scoring?.components.some((item) => item.ruleId === rule.id);
          return h(
            'fieldset',
            { key: rule.id, disabled: disabled || !hasCatalog, className: 'luo-rule-editor' },
            h('legend', null, `${index + 1}. ${rule.name}`),
            h(
              ResearchField,
              { label: '条件名称' },
              h('input', {
                value: rule.name,
                maxLength: 80,
                onChange: (event) => editScope(scope, index, { name: event.target.value }),
              }),
            ),
            h(ConditionEditor, {
              expression: rule.when,
              catalog,
              onChange: (when) => editScope(scope, index, { when }),
            }),
            scope !== 'selection'
              ? h(
                  'div',
                  { className: 'luo-research-fields' },
                  h(
                    ResearchField,
                    { label: '信号方向' },
                    h(
                      'select',
                      {
                        value: rule.direction,
                        onChange: (event) =>
                          editScope(scope, index, { direction: event.target.value }),
                      },
                      ['bullish', 'bearish', 'neutral'].map((value) =>
                        h(
                          'option',
                          { key: value, value },
                          { bullish: '看多', bearish: '看空', neutral: '中性' }[value],
                        ),
                      ),
                    ),
                  ),
                  h(ScoreEditor, {
                    score: rule.score,
                    catalog,
                    onChange: (score) => editScope(scope, index, { score }),
                  }),
                )
              : null,
            h(
              'details',
              null,
              h('summary', null, '证据模板与原始条件'),
              h('p', { className: 'luo-rule-expression' }, strategyExpression(rule.when)),
              h(
                ResearchField,
                { label: '证据模板（每行一条）', wide: true },
                h('textarea', {
                  rows: 2,
                  value: rule.evidence.join('\n'),
                  onChange: (event) =>
                    editScope(scope, index, { evidence: event.target.value.split('\n') }),
                }),
              ),
            ),
            h(
              Button,
              {
                disabled: referenced,
                title: referenced ? '先移除引用此条件的评分项' : undefined,
                onClick: () =>
                  onChange(
                    replaceRules(
                      definition,
                      scope,
                      rules.filter((_, i) => i !== index),
                    ),
                  ),
              },
              referenced ? '先移除对应评分项再删除' : '移除此条件',
            ),
          );
        }),
        h(
          Button,
          {
            disabled:
              disabled ||
              !hasCatalog ||
              (catalog.limits[scope === 'selection' ? 'selectionRules' : 'signalRulesPerScope'] !=
                null &&
                rules.length >=
                  catalog.limits[scope === 'selection' ? 'selectionRules' : 'signalRulesPerScope']),
            onClick: () => {
              const rule = draftRule(definition, scope, catalog);
              if (rule) onChange(replaceRules(definition, scope, [...rules, rule]));
            },
          },
          `添加${label}`,
        ),
      );
    }),
    h(
      'details',
      { className: 'luo-research-scope' },
      h('summary', null, '评分与排序', h(Pill, null, definition.scoring ? '加权评分' : '未设置')),
      definition.scoring
        ? h(
            'div',
            null,
            definition.scoring.components.map((component, index) =>
              h(
                'fieldset',
                {
                  key: component.ruleId,
                  disabled: disabled || !hasCatalog,
                  className: 'luo-rule-editor',
                },
                h(
                  'legend',
                  null,
                  definition.selection.rules.find((rule) => rule.id === component.ruleId)?.name ??
                    '评分项',
                ),
                h(ScoreEditor, {
                  score: component.score,
                  catalog,
                  onChange: (score) =>
                    onChange({
                      ...definition,
                      scoring: {
                        ...definition.scoring,
                        components: definition.scoring.components.map((item, i) =>
                          i === index ? { ...item, score } : item,
                        ),
                      },
                    }),
                }),
                h(
                  ResearchField,
                  { label: '权重（各项合计为 1）' },
                  h('input', {
                    type: 'number',
                    min: 0.000001,
                    max: 1,
                    step: 'any',
                    value: component.weight,
                    onChange: (event) =>
                      onChange({
                        ...definition,
                        scoring: {
                          ...definition.scoring,
                          components: definition.scoring.components.map((item, i) =>
                            i === index ? { ...item, weight: Number(event.target.value) } : item,
                          ),
                        },
                      }),
                  }),
                ),
                h(
                  Button,
                  {
                    onClick: () => {
                      const components = definition.scoring.components.filter(
                        (_, i) => i !== index,
                      );
                      const next = { ...definition };
                      if (components.length) next.scoring = { ...definition.scoring, components };
                      else delete next.scoring;
                      onChange(next);
                    },
                  },
                  '移除此评分项',
                ),
              ),
            ),
            h(
              ResearchField,
              { label: '保留前几名', hint: '留空保留全部匹配。' },
              h('input', {
                type: 'number',
                min: 1,
                max: 500,
                value: definition.scoring.top ?? '',
                disabled,
                onChange: (event) => {
                  const scoring = { ...definition.scoring };
                  if (event.target.value) scoring.top = Number(event.target.value);
                  else delete scoring.top;
                  onChange({ ...definition, scoring });
                },
              }),
            ),
          )
        : null,
      h(
        Button,
        {
          disabled:
            disabled ||
            !hasCatalog ||
            !definition.selection.rules.some(
              (rule) => !definition.scoring?.components.some((item) => item.ruleId === rule.id),
            ),
          onClick: () => {
            const rule = definition.selection.rules.find(
              (item) =>
                !definition.scoring?.components.some((component) => component.ruleId === item.id),
            );
            onChange({
              ...definition,
              scoring: {
                ...definition.scoring,
                method: 'weighted-sum',
                components: [
                  ...(definition.scoring?.components ?? []),
                  { ruleId: rule.id, score: '50', weight: 1 },
                ],
              },
            });
          },
        },
        '添加评分项',
      ),
      h(
        'p',
        { className: 'luo-fine' },
        '分数与权重仅是规则参数。服务端校验后才形成候选版本；评分不代表成功概率。',
      ),
    ),
    h(
      'details',
      { className: 'luo-research-scope' },
      h('summary', null, '可用字段目录'),
      h(
        'ul',
        { className: 'luo-catalog-fields' },
        (catalog?.fields ?? []).map((field) =>
          h(
            'li',
            { key: field.path },
            h('strong', null, fieldLabel(field)),
            h(
              'span',
              null,
              `${({ quote: '行情', 'daily-bars': '历史日线', meta: '派生事实', 'limit-up-ladder': '涨停梯队' })[field.dataSource] ?? field.dataSource} · 回看 ${field.requiredLookback ?? 0} 日`,
            ),
          ),
        ),
      ),
    ),
  );
}
