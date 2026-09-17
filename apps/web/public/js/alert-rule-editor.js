import { fieldWrap, makeInput, makeNumberInput, makeSelect, makeTextarea } from './form-kit.js';
import { el } from './ui.js';

export const ALERT_RULE_TYPES = [
  ['price-level', '到达指定价格'],
  ['price-change', '日内涨跌幅'],
  ['cost-threshold', '持仓止盈 / 止损'],
  ['strategy-signal', '策略信号'],
  ['event-date', '事件日期提醒'],
];
const EVENT_KINDS = [
  ['earnings', '财报'],
  ['unlock', '解禁'],
  ['dividend', '分红'],
  ['shareholder-meeting', '股东大会'],
  ['announcement', '公告'],
  ['manual', '手工事件'],
];
const PRIORITIES = [
  ['normal', '普通'],
  ['important', '重要'],
  ['urgent', '紧急'],
];

export const newAlertRule = (kind, id = `rule-${crypto.randomUUID()}`) => {
  const defaults = {
    'price-level': { level: 10, side: 'above' },
    'price-change': { pct: 0.05, direction: 'any' },
    'cost-threshold': { stopLossPct: 0.05 },
    'strategy-signal': { strategyId: '', minScore: 60 },
    'event-date': { daysBefore: [7, 3, 1], minImportance: 'normal' },
  };
  return { id, kind, ...defaults[kind] };
};

export const alertNumber = (
  raw,
  label,
  {
    min = 0,
    max = Number.POSITIVE_INFINITY,
    integer = false,
    optional = false,
    positive = false,
  } = {},
) => {
  if (String(raw).trim() === '') {
    if (optional) return undefined;
    throw new Error(`请填写${label}`);
  }
  const value = Number(raw);
  if (
    !Number.isFinite(value) ||
    value < min ||
    value > max ||
    (positive && value <= 0) ||
    (integer && !Number.isInteger(value))
  ) {
    throw new Error(`${label}超出范围${integer ? '，请填写整数' : ''}`);
  }
  return value;
};

export const parseAlertDays = (raw) => {
  const values = String(raw)
    .split(/[，,、\s]+/)
    .filter(Boolean);
  if (values.length > 8) throw new Error('提醒日期最多填写 8 个');
  return [
    ...new Set(values.map((value) => alertNumber(value, '提前天数', { max: 90, integer: true }))),
  ];
};

export const validateAlertRules = (rules) => {
  if (!Array.isArray(rules) || rules.length === 0) throw new Error('至少添加一条预警规则');
  const ids = new Set();
  for (const rule of rules) {
    if (!rule || !ALERT_RULE_TYPES.some(([kind]) => kind === rule.kind))
      throw new Error('不支持的预警规则类型');
    if (typeof rule.id !== 'string' || !rule.id.trim() || ids.has(rule.id))
      throw new Error('规则标识不能为空或重复');
    ids.add(rule.id);
    if (rule.kind === 'strategy-signal' && !rule.strategyId?.trim())
      throw new Error('请选择要关注的策略');
    if (
      rule.kind === 'cost-threshold' &&
      rule.stopLossPct === undefined &&
      rule.takeProfitPct === undefined
    )
      throw new Error('止损和止盈至少填写一项');
  }
  return rules;
};

export const createAlertRulesEditor = (initial, { strategies = [] } = {}) => {
  let rules = structuredClone(initial);
  let readCards = [];
  let mode = 'form';
  const root = el('div', 'alert-rule-editor');
  const host = el('div');
  const error = el('p', 'status error');
  error.setAttribute('role', 'alert');
  const json = makeTextarea(undefined, { rows: 14 });
  json.setAttribute('aria-label', '高级预警规则 JSON');
  const button = (label, action) => {
    const node = el('button', 'btn btn-outline btn-sm', label);
    node.type = 'button';
    node.addEventListener('click', () => {
      try {
        action();
        error.textContent = '';
      } catch (cause) {
        error.textContent = cause.message;
      }
    });
    return node;
  };
  const read = () =>
    mode === 'json'
      ? validateAlertRules(JSON.parse(json.value))
      : validateAlertRules(readCards.map((readCard) => readCard()));
  const render = () => {
    readCards = [];
    const cards = rules.map((original, index) => {
      const readers = [];
      const fields = el('div', 'alert-rule-fields');
      const addField = (label, control, readValue, key, hint) => {
        control.setAttribute('aria-label', label);
        fields.append(fieldWrap(label, control, hint));
        readers.push((rule) => {
          const value = readValue();
          if (value === undefined) delete rule[key];
          else rule[key] = value;
        });
      };
      const number = (key, label, options = {}, scale = 1) => {
        const control = makeNumberInput(undefined, {
          value: original[key] === undefined ? undefined : original[key] * scale,
          min: options.min ?? 0,
          max: options.max,
          step: options.integer ? 1 : 'any',
        });
        addField(
          label,
          control,
          () => {
            const value = alertNumber(control.value, label, options);
            return value === undefined ? undefined : value / scale;
          },
          key,
        );
      };
      const select = (key, label, options, optional = false) => {
        const control = makeSelect(undefined, options);
        control.value = original[key] ?? options[0][0];
        addField(
          label,
          control,
          () => (optional && control.value === '' ? undefined : control.value),
          key,
        );
      };
      if (original.kind === 'price-level') {
        select('side', '提醒条件', [
          ['above', '价格达到或高于'],
          ['below', '价格达到或低于'],
        ]);
        number('level', '价格（元）', { positive: true });
        fields.append(el('p', 'hint', '价格规则仅在进入条件时提醒。'));
      } else if (original.kind === 'price-change') {
        select('direction', '涨跌方向', [
          ['any', '上涨或下跌'],
          ['up', '上涨'],
          ['down', '下跌'],
        ]);
        number('pct', '幅度（%）', { positive: true, max: 100 }, 100);
      } else if (original.kind === 'cost-threshold') {
        number(
          'stopLossPct',
          '相对成本止损（%）',
          { positive: true, max: 100, optional: true },
          100,
        );
        number(
          'takeProfitPct',
          '相对成本止盈（%）',
          { positive: true, max: 100, optional: true },
          100,
        );
        fields.append(el('p', 'hint', '至少填写一项；5 表示 5%，只提醒，不下单。'));
      } else if (original.kind === 'strategy-signal') {
        const options = [
          ['', '请选择策略'],
          ...strategies.map((strategy) => [strategy.id, strategy.name]),
        ];
        if (
          original.strategyId &&
          !strategies.some((strategy) => strategy.id === original.strategyId)
        )
          options.push([original.strategyId, '原策略（当前不可用）']);
        select('strategyId', '关注策略', options);
        number('minScore', '最低信号分数', { max: 100 });
        select(
          'direction',
          '信号方向',
          [
            ['', '不限'],
            ['bullish', '看多'],
            ['bearish', '看空'],
            ['neutral', '中性'],
          ],
          true,
        );
        if (original.ruleId)
          fields.append(el('p', 'hint', '已保留指定信号规则过滤；如需修改，可使用高级 JSON。'));
      } else if (original.kind === 'event-date') {
        select('minImportance', '最低事件重要性', PRIORITIES);
        const days = makeInput(undefined, { value: (original.daysBefore ?? [7, 3, 1]).join('、') });
        addField(
          '提前提醒天数',
          days,
          () => parseAlertDays(days.value),
          'daysBefore',
          '用逗号分隔；0 表示事件当天，最多 8 个，范围 0～90 天。',
        );
        const checks = EVENT_KINDS.map(([kind, label]) => {
          const control = makeInput(undefined, { type: 'checkbox' });
          control.checked = original.eventKinds?.includes(kind) ?? false;
          return { kind, control, node: el('label', 'alert-event-option', [control, label]) };
        });
        fields.append(
          fieldWrap(
            '事件类型',
            el(
              'div',
              'alert-event-options',
              checks.map((item) => item.node),
            ),
            '不勾选表示全部类型。',
          ),
        );
        readers.push((rule) => {
          const selected = checks.filter((item) => item.control.checked).map((item) => item.kind);
          if (selected.length > 0) rule.eventKinds = selected;
          else if (original.eventKinds?.length === 0) rule.eventKinds = [];
          else delete rule.eventKinds;
        });
      }
      select('priority', '规则优先级', [['', '使用默认'], ...PRIORITIES], true);
      readCards.push(() => {
        const rule = structuredClone(original);
        for (const reader of readers) reader(rule);
        return rule;
      });
      const kind = makeSelect(undefined, ALERT_RULE_TYPES);
      kind.value = original.kind;
      kind.setAttribute('aria-label', `第 ${index + 1} 条规则类型`);
      kind.addEventListener('change', () => {
        try {
          rules = readCards.map((reader, i) =>
            i === index ? newAlertRule(kind.value, original.id) : reader(),
          );
          if (original.priority !== undefined) rules[index].priority = original.priority;
          render();
          error.textContent = '';
        } catch (cause) {
          kind.value = original.kind;
          error.textContent = cause.message;
        }
      });
      return el('section', 'alert-rule-card', [
        el('div', 'alert-rule-heading', [
          el('strong', null, `条件 ${index + 1}`),
          kind,
          button('删除条件', () => {
            rules = readCards.filter((_, i) => i !== index).map((reader) => reader());
            render();
          }),
        ]),
        fields,
      ]);
    });
    host.replaceChildren(
      ...cards,
      button('添加条件', () => {
        rules = [...readCards.map((reader) => reader()), newAlertRule('price-level')];
        render();
      }),
    );
  };
  const formMode = button('表单编辑', () => {
    if (mode === 'form') return;
    rules = read();
    mode = 'form';
    render();
  });
  const advanced = button('高级 JSON', () => {
    if (mode === 'json') return;
    rules = read();
    json.value = JSON.stringify(rules, null, 2);
    mode = 'json';
    host.replaceChildren(json);
  });
  root.append(el('div', 'flex gap-2', [formMode, advanced]), host, error);
  render();
  return { root, getValue: read };
};
