/**
 * 账户事实摘要：现金来自账户字段、市值来自行情、更新时间来自 facts.asOf；
 * 再附一条对账差额——差额就是漏记的成交或资金流水，不需要人工找。
 */
export const accountFactsSummary = ({ factsResult, reconcileResult }) => {
  if (factsResult === undefined || !factsResult.ok) {
    return el('div', 'plan-guidance', [
      el('strong', null, '账户事实不可用'),
      el('p', 'hint', `读取失败：${toolErrorText(factsResult?.error)}`),
    ]);
  }
  const facts = factsResult.data.facts;
  const lines = [
    `现金 ${fmtNum(facts.cashBalance, 2)}`,
    facts.stockMarketValue === null
      ? '持仓市值 不可用'
      : `持仓市值 ${fmtNum(facts.stockMarketValue, 2)}`,
    facts.totalAssets === null ? '总资产 不可用' : `总资产 ${fmtNum(facts.totalAssets, 2)}`,
    `更新于 ${fmtDateTime(facts.asOf)}`,
  ];
  const reconcile = reconcileResult?.ok ? reconcileResult.data : undefined;
  const reconcileLine =
    reconcile === undefined
      ? null
      : reconcile.reconciled
        ? '账本对账：现金余额与账本一致'
        : `账本对账：相差 ${fmtNum(reconcile.difference, 2)}（可能有未登记的成交或资金流水）`;
  const incomplete = facts.status !== 'complete';
  const notes = facts.notes ?? [];
  const lines2 = [...lines, ...(reconcileLine === null ? [] : [reconcileLine])];
  if (!incomplete && (reconcile === undefined || reconcile.reconciled) && notes.length === 0) {
    return el('p', 'muted plan-facts', lines2.join(' · '));
  }
  if (!incomplete && (reconcile === undefined || reconcile.reconciled)) {
    return el('div', 'plan-guidance', [
      el('strong', null, '账户事实可用（有限制）'),
      el('p', 'hint', notes.join('；')),
      el('p', 'muted plan-facts', lines2.join(' · ')),
    ]);
  }
  return el('div', 'plan-guidance', [
    el('strong', null, incomplete ? '账户事实不可用' : '账户现金与账本不一致'),
    el(
      'p',
      'hint',
      incomplete ? facts.reasons.join('；') || '缺少现金或合格行情' : (reconcileLine ?? ''),
    ),
    el('p', 'muted plan-facts', lines2.join(' · ')),
  ]);
};

/* apps/web/public/js/trading-plan-panel.js —— 「预警」页的交易计划分区。
 *
 * 只读取 list_trading_plans / get_account_facts / reconcile_account_cash 的结果做渲染：计划是研究结论与条件，
 * 不是成交、也不会自动下单。按服务端监控资格说明阻塞原因与下一步。
 */

import { callApi } from './api.js';
import { makeSelect } from './form-kit.js';
import { openModal } from './modal.js';
import { stockIdentityLink } from './stock-link.js';
import { $, el, fmtDateTime, fmtNum, mount, toolErrorText } from './ui.js';

const ACTION_LABELS = {
  observe: '观察',
  enter: '建仓',
  add: '加仓',
  hold: '持有',
  reduce: '减仓',
  exit: '退出',
  avoid: '回避',
};

/** 卡片展示顺序：先当前有效，再草案，最后历史状态。 */
const STATUS_ORDER = { active: 0, draft: 1, superseded: 2, revoked: 3, expired: 4 };

const STATUS_LABELS = {
  active: '生效',
  draft: '草案',
  superseded: '已替代',
  revoked: '已撤销',
  expired: '已过期',
};

const CONDITION_PHASE_LABELS = {
  entry: '入场',
  hold: '持有',
  exit: '退出',
  risk: '风险',
  market: '市场',
};

export const planActionLabel = (action) => ACTION_LABELS[action] ?? action ?? '--';

export const planStatusLabel = (status) => STATUS_LABELS[status] ?? status ?? '--';

export const planStatusBadgeClass = (status) => {
  if (status === 'active') return 'badge-active';
  if (status === 'draft') return 'badge-draft';
  return 'badge-neutral';
};

const fmtPrice = (value) =>
  typeof value === 'number' && Number.isFinite(value) ? fmtNum(value, 2) : null;

const fmtPct = (value) =>
  typeof value === 'number' && Number.isFinite(value) ? `${fmtNum(value, 2)}%` : null;

/** 没有建仓动作的计划不存在入场区间，不该显示成「未提供」让人以为是漏数据。 */
const NO_ENTRY_ACTIONS = new Set(['hold', 'reduce', 'exit', 'avoid']);

export const planEntryText = (plan) => {
  const low = fmtPrice(plan.entryPriceLow);
  const high = fmtPrice(plan.entryPriceHigh);
  if (low !== null && high !== null) return `${low} - ${high}`;
  if (NO_ENTRY_ACTIONS.has(plan.action)) return '不适用（无建仓动作）';
  if (plan.action === 'observe') return '等待条件（未给出价位）';
  return '未提供入场区间';
};

export const planTargetText = (plan) => {
  const text = fmtPct(plan.position?.targetPct);
  if (text === null) return '目标仓位不可用';
  if (plan.position.targetPct === 0 && plan.action === 'observe') return '等待条件（未设置仓位）';
  return text;
};

/** 卡片与详情共用的入场条件口径：不适用 / 等待条件 / 未设置，不把缺价位说成漏数据。 */
export const entryConditionText = (plan) => {
  const summary = conditionSummary(plan.entryConditions);
  if ((plan.entryConditions ?? []).length === 0) {
    if (NO_ENTRY_ACTIONS.has(plan.action)) return '不适用（无建仓动作）';
    return plan.action === 'observe' ? '等待条件（未给出具体条件）' : '未设置入场条件';
  }
  // 观察计划的价位是「等条件」而不是「现在就买」，说清楚语义，避免读成待执行建仓。
  return plan.action === 'observe' ? `等待条件（满足前不建仓）：${summary}` : summary;
};

export const planMetaText = (plan) =>
  [
    `v${plan.version}`,
    planActionLabel(plan.action),
    `入场 ${planEntryText(plan)}`,
    `目标 ${planTargetText(plan)}`,
    `有效期至 ${fmtDateTime(plan.validUntil)}`,
  ].join(' · ');

/** 草案不能执行的原因：约束未通过时优先展示约束原因，否则展示未知项。 */
export const planDraftNote = (plan) => {
  if (plan.status !== 'draft') return null;
  const reasons = [
    ...new Set(
      [...(plan.position?.constraintReasons ?? []), ...(plan.explanation?.unknowns ?? [])].filter(
        (item) => typeof item === 'string' && item.trim().length > 0,
      ),
    ),
  ];
  if (reasons.length > 0) return `草案原因：${reasons.join('；')}`;
  return plan.position?.constraintStatus === 'passed' ? null : '草案：约束校验未通过，暂不可执行';
};

/** 每个计划只展示最高版本；同版本冲突时取较新创建的一条。 */
export const latestPlanVersions = (plans) => {
  const latest = new Map();
  for (const plan of plans ?? []) {
    const current = latest.get(plan.id);
    if (
      current === undefined ||
      plan.version > current.version ||
      (plan.version === current.version && new Date(plan.createdAt) > new Date(current.createdAt))
    ) {
      latest.set(plan.id, plan);
    }
  }
  return [...latest.values()].sort(
    (left, right) =>
      (STATUS_ORDER[left.status] ?? 9) - (STATUS_ORDER[right.status] ?? 9) ||
      String(left.stockId).localeCompare(String(right.stockId)) ||
      right.version - left.version,
  );
};

export const planVersionsOf = (plans, planId) =>
  (plans ?? [])
    .filter((plan) => plan.id === planId)
    .sort((left, right) => right.version - left.version);

export const planVersionId = (plan) => `${plan.id}:v${plan.version}`;

const conditionSummary = (conditions) => {
  const lines = (conditions ?? []).map(planConditionText);
  return lines.length === 0 ? '无' : lines.join('；');
};

const listText = (items) => {
  const lines = (items ?? []).filter((line) => typeof line === 'string' && line.trim().length > 0);
  return lines.length === 0 ? '无' : lines.join('；');
};

const priceText = (value) => fmtPrice(value) ?? '未设置';

const holdingText = (plan) =>
  `${plan.holding?.minTradingDays ?? '--'} - ${plan.holding?.maxTradingDays ?? '--'}`;

/** 版本差异：只列出真正变化的字段，不把“没变”渲染成变化。 */
export const planDiff = (previous, current) => {
  if (previous === undefined || current === undefined) return [];
  const rows = [];
  const push = (label, before, after) => {
    if (before !== after) rows.push({ label, before, after });
  };
  push('状态', planStatusLabel(previous.status), planStatusLabel(current.status));
  push('动作', planActionLabel(previous.action), planActionLabel(current.action));
  push('入场区间', planEntryText(previous), planEntryText(current));
  push(
    '入场条件',
    conditionSummary(previous.entryConditions),
    conditionSummary(current.entryConditions),
  );
  push('目标仓位', planTargetText(previous), planTargetText(current));
  push('止损', priceText(previous.exit?.stopLoss), priceText(current.exit?.stopLoss));
  push('止盈', priceText(previous.exit?.takeProfit), priceText(current.exit?.takeProfit));
  push('预计持有交易日', holdingText(previous), holdingText(current));
  push(
    '下次复核',
    fmtDateTime(previous.holding?.nextReviewAt),
    fmtDateTime(current.holding?.nextReviewAt),
  );
  push('有效期至', fmtDateTime(previous.validUntil), fmtDateTime(current.validUntil));
  push(
    '反证',
    listText(previous.explanation?.counterEvidence),
    listText(current.explanation?.counterEvidence),
  );
  push('风险', listText(previous.explanation?.risks), listText(current.explanation?.risks));
  push('未知', listText(previous.explanation?.unknowns), listText(current.explanation?.unknowns));
  return rows;
};

/** 上一版：优先用 supersedesVersionId 精确匹配，否则回退到同计划 version-1。 */
export const previousVersionOf = (plan, versions) => {
  const list = versions ?? [];
  if (plan.supersedesVersionId !== undefined) {
    const explicit = list.find((item) => planVersionId(item) === plan.supersedesVersionId);
    if (explicit !== undefined) return explicit;
  }
  return list.find((item) => item.id === plan.id && item.version === plan.version - 1);
};

const METRIC_LABELS = {
  price: '价格',
  changePct: '涨跌幅',
  marketIndexChangePct: '指数涨跌幅',
  marketBreadthPct: '市场上涨占比',
};
const COMPARATOR_LABELS = { gte: '≥', gt: '>', lte: '≤', lt: '<', eq: '=' };
const FACT_STATUS_LABELS = {
  available: '可用',
  stale: '已过时',
  unknown: '未知',
  unavailable: '不可用',
};

export const planConditionText = (condition) => {
  if (condition.kind === 'manual-confirmation') return `${condition.description}（需人工确认）`;
  if (condition.metric === undefined || condition.value === undefined) return condition.description;
  const unit = condition.metric === 'price' ? '元' : '%';
  const threshold =
    condition.comparator === 'between'
      ? `${fmtNum(condition.value, 2)} – ${fmtNum(condition.valueTo, 2)}${unit}`
      : `${COMPARATOR_LABELS[condition.comparator] ?? ''} ${fmtNum(condition.value, 2)}${unit}`;
  return `${condition.description}（${METRIC_LABELS[condition.metric] ?? condition.metric} ${threshold}）`;
};

const conditionLines = (conditions) =>
  (conditions ?? []).map(
    (condition) =>
      `${CONDITION_PHASE_LABELS[condition.phase] ?? condition.phase}：${planConditionText(condition)}`,
  );

export const planKeyMetrics = (plan) => {
  const quote = (plan.marketFacts ?? [])
    .filter(
      (fact) =>
        fact.metric === 'price' && (fact.stockId === undefined || fact.stockId === plan.stockId),
    )
    .sort((a, b) => new Date(b.observedAt) - new Date(a.observedAt))[0];
  return [
    {
      label: '生成时参考价',
      value:
        quote === undefined
          ? '未提供'
          : `${fmtNum(quote.value, 2)} ${quote.unit === 'CNY' ? '元' : quote.unit}`,
      note:
        quote === undefined
          ? '缺少价格事实'
          : `${FACT_STATUS_LABELS[quote.status]} · ${fmtDateTime(quote.observedAt)} · ${quote.source}`,
    },
    { label: '入场区间', value: planEntryText(plan), note: '元 / 股' },
    {
      label: '止损 / 止盈',
      value: `${priceText(plan.exit?.stopLoss)} / ${priceText(plan.exit?.takeProfit)}`,
      note: '元 / 股',
    },
    {
      label: '当前 → 目标仓位',
      value: `${fmtPct(plan.position?.currentPct) ?? '不可用'} → ${planTargetText(plan)}`,
      note: `调整 ${plan.position?.deltaPct == null ? '不可用' : `${fmtNum(plan.position.deltaPct, 2)} 个百分点`} · 占账户总资产`,
    },
  ];
};

const metricsNode = (plan) =>
  el(
    'dl',
    'plan-metrics',
    planKeyMetrics(plan).map((metric) =>
      el('div', 'plan-metric', [
        el('dt', null, metric.label),
        el('dd', null, metric.value),
        el('p', 'muted', metric.note),
      ]),
    ),
  );

const exitLines = (plan) => {
  const exit = plan.exit ?? {};
  const lines = [];
  if (fmtPrice(exit.stopLoss) !== null) lines.push(`止损：${fmtPrice(exit.stopLoss)}`);
  if (fmtPrice(exit.takeProfit) !== null) lines.push(`止盈：${fmtPrice(exit.takeProfit)}`);
  lines.push(...conditionLines(exit.triggerConditions));
  lines.push(...(exit.conditions ?? []).map((item) => `退出条件：${item}`));
  lines.push(
    exit.canSellNow === true
      ? '当前可卖数量足够，可在条件满足时执行'
      : `当前不可直接执行${exit.unavailableReason === undefined ? '' : `（${exit.unavailableReason}）`}`,
  );
  return lines;
};

const factLines = (plan) =>
  (plan.marketFacts ?? []).map((fact) => {
    const status = FACT_STATUS_LABELS[fact.status] ?? fact.status;
    return `${METRIC_LABELS[fact.metric] ?? fact.metric} ${fmtNum(fact.value, 2)}${fact.unit ?? ''} · ${status} · 数据时间 ${fmtDateTime(fact.observedAt)} · 来源 ${fact.source}`;
  });

/** 计划详情分区（纯数据，便于单测与复用）。 */
export const planDetailSections = (plan) => {
  const position = plan.position ?? {};
  const holding = plan.holding ?? {};
  const explanation = plan.explanation ?? {};
  return [
    {
      title: '身份与有效性',
      lines: [
        `计划版本：v${plan.version}`,
        `状态：${planStatusLabel(plan.status)} · 动作：${planActionLabel(plan.action)}`,
        `生效：${fmtDateTime(plan.validFrom)} · 有效期至：${fmtDateTime(plan.validUntil)}`,
        ...(plan.invalidationConditions ?? []).map((item) => `失效条件：${item}`),
      ],
    },
    {
      title: '入场',
      lines: [
        `价格区间：${planEntryText(plan)}`,
        ...(plan.action === 'observe' && conditionLines(plan.entryConditions).length > 0
          ? ['等待条件（满足前不建仓）']
          : []),
        ...(conditionLines(plan.entryConditions).length === 0
          ? [entryConditionText(plan)]
          : conditionLines(plan.entryConditions)),
        ...(plan.invalidEntryConditions ?? []).map((item) => `不可入场：${item}`),
      ],
    },
    {
      title: '仓位',
      lines: [
        `当前：${fmtPct(position.currentPct) ?? '不可用'} · 目标：${fmtPct(position.targetPct) ?? '不可用'} · 差额：${fmtPct(position.deltaPct) ?? '不可用'}`,
        `约束校验：${({ passed: '通过', blocked: '未通过', unavailable: '数据不可用' })[position.constraintStatus] ?? '--'}${
          (position.constraintReasons ?? []).length === 0
            ? ''
            : `（${(position.constraintReasons ?? []).join('；')}）`
        }`,
        ...(position.prerequisiteActions ?? []).map((item) => `前置动作：${item}`),
      ],
    },
    {
      title: '持有',
      lines: [
        `预计持有交易日：${holding.minTradingDays ?? '--'} - ${holding.maxTradingDays ?? '--'}`,
        `下次复核：${fmtDateTime(holding.nextReviewAt)}`,
        ...(holding.earlyExitConditions ?? []).map((item) => `提前退出：${item}`),
        ...(holding.extensionBasis ?? []).map((item) => `允许延长的依据：${item}`),
      ],
    },
    { title: '退出', lines: exitLines(plan) },
    {
      title: '依据、反证与未知',
      lines: [
        ...(plan.evidence ?? []).map(
          (item) =>
            `支持证据：${item.summary}（${item.source}${item.observedAt === undefined ? '' : ` · ${fmtDateTime(item.observedAt)}`}）`,
        ),
        ...(explanation.counterEvidence ?? []).map((item) => `反证：${item}`),
        ...(explanation.risks ?? []).map((item) => `风险：${item}`),
        ...(explanation.unknowns ?? []).map((item) => `未知：${item}`),
        ...(explanation.changeSummary === undefined ? [] : [`变更：${explanation.changeSummary}`]),
        `信心评分：${fmtNum(plan.confidence, 0)}（不是收益概率）`,
      ],
    },
    {
      title: '账户与来源',
      lines: [
        `账户事实更新：${fmtDateTime(plan.accountFactsAsOf)}`,
        `行业：${plan.industry ?? '未记录'}`,
        `参考策略：${plan.source?.strategyIds.length ?? 0} 个`,
        `研究运行：${plan.source?.runIds.length ?? 0} 次`,
        `参考建议：${plan.source?.adviceIds.length ?? 0} 条`,
        ...factLines(plan),
      ],
    },
  ];
};

const auditNode = (plan) =>
  el('details', 'plan-audit', [
    el('summary', null, '查看追溯信息'),
    ...[
      `计划版本：${planVersionId(plan)}`,
      `账户事实指纹：${plan.accountFactsDigest}`,
      `策略：${listText(plan.source?.strategyIds)}`,
      `运行：${listText(plan.source?.runIds)}`,
      `建议：${listText(plan.source?.adviceIds)}`,
      ...(plan.supersedesVersionId ? [`替代版本：${plan.supersedesVersionId}`] : []),
    ].map((line) => el('p', 'plan-detail-line', line)),
  ]);

const sectionNode = (section) =>
  el('section', 'plan-detail-section', [
    el('h3', null, section.title),
    ...section.lines.map((line) => el('p', 'plan-detail-line', line)),
  ]);

/**
 * 计划详情弹窗；多版本时可直接切换历史版本（走 get_trading_plan 读确切版本）。
 */
export const openTradingPlanDetail = (plan, versions = [plan]) => {
  const body = el('div', 'plan-detail');
  const versionBar = el('div', 'flex gap-2');
  const diffRoot = el('div', 'plan-diff');

  /** 上一版差异：先在本页版本列表里找，找不到再按 supersedesVersionId 读确切版本。 */
  const loadDiff = (subject) => {
    mount(diffRoot, []);
    if (subject.supersedesVersionId === undefined) return;
    const local = previousVersionOf(subject, versions);
    if (local !== undefined) {
      renderDiff(local, subject);
      return;
    }
    void (async () => {
      const result = await callApi(
        `/api/trading-plans/${encodeURIComponent(subject.supersedesVersionId)}`,
      );
      if (!result.ok) return;
      renderDiff(result.data.plan, subject);
    })();
  };

  const renderDiff = (previous, subject) => {
    const rows = planDiff(previous, subject);
    if (rows.length === 0) return;
    mount(diffRoot, [
      el('h3', null, `与上一版本（v${previous.version}）的差异`),
      ...rows.map((row) =>
        el('p', 'plan-detail-line', `${row.label}：${row.before} → ${row.after}`),
      ),
      ...(subject.explanation?.changeSummary === undefined
        ? []
        : [el('p', 'hint', `变更说明：${subject.explanation.changeSummary}`)]),
    ]);
  };

  const render = (subject) => {
    const buttons = versions.map((item) => {
      const button = el(
        'button',
        `btn btn-sm ${item.version === subject.version ? 'btn-primary' : 'btn-outline'}`,
        `v${item.version}`,
      );
      button.type = 'button';
      button.addEventListener('click', () => {
        if (item.version === subject.version) return;
        void (async () => {
          const result = await callApi(
            `/api/trading-plans/${encodeURIComponent(planVersionId(item))}`,
          );
          if (!result.ok) {
            versionBar.append(el('span', 'status error', `v${item.version} 读取失败`));
            return;
          }
          render(result.data.plan);
        })();
      });
      return button;
    });
    mount(body, [
      el('div', 'flex gap-2', [
        el(
          'span',
          `badge ${planStatusBadgeClass(subject.status)}`,
          planStatusLabel(subject.status),
        ),
        el('span', 'badge badge-neutral', planActionLabel(subject.action)),
        stockIdentityLink(subject),
        el('span', 'muted', `v${subject.version}`),
      ]),
      ...(versions.length <= 1 ? [] : [versionBar]),
      metricsNode(subject),
      diffRoot,
      ...planDetailSections(subject).map(sectionNode),
      auditNode(subject),
      el(
        'p',
        'hint',
        '计划是研究结论与条件，不等于成交，也不会自动下单；实际持仓、资金与可卖数量由你维护的账户事实决定。',
      ),
    ]);
    if (versions.length > 1) mount(versionBar, buttons);
    loadDiff(subject);
  };

  render(plan);
  openModal('交易计划详情', body);
};

/**
 * 按确切版本打开计划详情（报告页引用入口）：先读该版本，再尽量补齐同计划的历史版本，
 * 便于在弹窗里切换与查看差异。返回读版本的 ToolResult，失败由调用方提示。
 */
export const openTradingPlanDetailByVersionId = async (versionId) => {
  const result = await callApi(`/api/trading-plans/${encodeURIComponent(versionId)}`);
  if (!result.ok) return result;
  const plan = result.data.plan;
  const siblings = await callApi(
    `/api/trading-plans?activeOnly=false&stockId=${encodeURIComponent(plan.stockId)}&limit=200`,
  );
  const list = siblings.ok ? (siblings.data?.plans ?? []) : [];
  openTradingPlanDetail(plan, planVersionsOf(list, plan.id));
  return result;
};

export const PLAN_STATUS_FILTERS = [
  { id: 'all', label: '全部状态' },
  { id: 'active', label: '生效' },
  { id: 'draft', label: '草案' },
  { id: 'history', label: '历史状态' },
];

/** 动作筛选：按「该不该动手」归类，不逐个动作堆选项。 */
export const PLAN_ACTION_FILTERS = [
  { id: 'all', label: '全部动作' },
  { id: 'open', label: '建仓 / 加仓' },
  { id: 'keep', label: '持有 / 观察' },
  { id: 'risk', label: '减仓 / 退出 / 回避' },
];

const ACTION_FILTER_MATCH = {
  open: ['enter', 'add'],
  keep: ['hold', 'observe'],
  risk: ['reduce', 'exit', 'avoid'],
};

export const filterPlansByStatus = (plans, status) => {
  if (status === undefined || status === 'all') return plans ?? [];
  if (status === 'history') {
    return (plans ?? []).filter((plan) => !['active', 'draft'].includes(plan.status));
  }
  return (plans ?? []).filter((plan) => plan.status === status);
};

export const filterPlansByAction = (plans, action) => {
  if (action === undefined || action === 'all') return plans ?? [];
  const allowed = ACTION_FILTER_MATCH[action];
  return allowed === undefined
    ? (plans ?? [])
    : (plans ?? []).filter((plan) => allowed.includes(plan.action));
};

let planStatusFilter = 'all';
let planActionFilter = 'all';
let planPanelState = {
  plans: [],
  latest: [],
  monitoring: [],
  factsResult: undefined,
  reconcileResult: undefined,
};

const visiblePlans = (latest, status, action) =>
  filterPlansByAction(filterPlansByStatus(latest, status), action);

/** 只重绘列表部分，筛选栏保持在原位。 */
const renderPlanList = (root) => {
  const filterBar = root.querySelector('.plan-filters');
  const visible = visiblePlans(planPanelState.latest, planStatusFilter, planActionFilter);
  const rows =
    visible.length === 0
      ? [el('p', 'placeholder', '当前筛选条件下没有计划。')]
      : visible.map(planRow);
  mount(root, [
    ...(filterBar === null ? [] : [filterBar]),
    ...rows,
    accountFactsSummary(planPanelState),
  ]);
};

const planRow = (plan) => {
  const detail = el('button', 'btn btn-outline btn-sm', '详情');
  detail.type = 'button';
  detail.addEventListener('click', () =>
    openTradingPlanDetail(plan, planVersionsOf(planPanelState.plans, plan.id)),
  );
  const draftNote = planDraftNote(plan);
  const monitoring = planPanelState.monitoring.find(
    (item) => item.versionId === planVersionId(plan),
  );
  return el('div', 'entity-item', [
    el('div', 'flex gap-2', [
      stockIdentityLink(plan),
      el('strong', null, planActionLabel(plan.action)),
    ]),
    metricsNode(plan),
    el('p', 'plan-detail-line', `入场条件（全部满足）：${entryConditionText(plan)}`),
    el('div', 'plan-guidance', [
      el('strong', null, monitoring?.status === 'ready' ? '可监控 · 等待条件' : '未就绪'),
      el(
        'p',
        'hint',
        monitoring === undefined
          ? '监控资格未读取，请刷新后重试'
          : `${monitoring.reason}。下一步：${monitoring.nextStep}`,
      ),
    ]),
    el(
      'p',
      'muted',
      `预计持有 ${holdingText(plan)} 个交易日 · 复核 ${fmtDateTime(plan.holding?.nextReviewAt)}`,
    ),
    el('p', 'muted', `有效期至 ${fmtDateTime(plan.validUntil)} · v${plan.version}`),
    ...(draftNote === null ? [] : [el('div', 'hint', draftNote)]),
    el('div', 'flex gap-2', [
      el('span', `badge ${planStatusBadgeClass(plan.status)}`, planStatusLabel(plan.status)),
      detail,
    ]),
  ]);
};

/** 计划筛选栏：两个维度都带计数；切换后只重绘列表。 */
const planFilterBar = () => {
  const { latest } = planPanelState;
  const statusSelect = makeSelect(
    'alerts-plan-status-filter',
    PLAN_STATUS_FILTERS.map((option) => [
      option.id,
      `${option.label}（${filterPlansByStatus(latest, option.id).length}）`,
    ]),
  );
  statusSelect.value = planStatusFilter;
  const actionSelect = makeSelect(
    'alerts-plan-action-filter',
    PLAN_ACTION_FILTERS.map((option) => [
      option.id,
      `${option.label}（${filterPlansByAction(latest, option.id).length}）`,
    ]),
  );
  actionSelect.value = planActionFilter;
  const onChange = () => {
    planStatusFilter = statusSelect.value;
    planActionFilter = actionSelect.value;
    const root = $('#alerts-plans');
    if (root !== null) renderPlanList(root);
  };
  statusSelect.addEventListener('change', onChange);
  actionSelect.addEventListener('change', onChange);
  return el('div', 'flex gap-2 plan-filters', [statusSelect, actionSelect]);
};

export const renderTradingPlanPanel = ({
  root,
  meta,
  result,
  factsResult,
  reconcileResult,
  setStatus,
}) => {
  if (root === null) return;
  if (result === undefined || !result.ok) {
    if (meta !== null) meta.textContent = '加载失败';
    mount(root, el('p', 'status error', `交易计划加载失败：${toolErrorText(result?.error)}`));
    return;
  }
  const plans = result.data?.plans ?? [];
  // 快照读取失败时按“有快照”处理：不把读取故障渲染成“未登记”。
  const facts = factsResult?.ok ? factsResult.data.facts : undefined;
  const latest = latestPlanVersions(plans);
  const monitoring = result.data?.monitoring ?? [];
  const readyCount = latest.filter((plan) =>
    monitoring.some((item) => item.versionId === planVersionId(plan) && item.status === 'ready'),
  ).length;
  const incomplete = facts !== undefined && facts.status !== 'complete';
  if (meta !== null) {
    meta.textContent =
      latest.length === 0
        ? incomplete
          ? '账户事实不可用'
          : '暂无计划'
        : `${latest.length} 个 · 可监控 ${readyCount} · 待处理 ${latest.filter((plan) => ['active', 'draft'].includes(plan.status)).length - readyCount}${incomplete ? ' · 账户事实不可用' : ''}`;
  }
  if (latest.length === 0) {
    mount(root, [
      el(
        'p',
        'placeholder',
        '尚未生成交易计划。计划在盘后批次里由持仓复核与候选分析产出，未生成计划不等于没有机会。',
      ),
      accountFactsSummary({ factsResult, reconcileResult }),
    ]);
    return;
  }
  planPanelState = { plans, latest, monitoring, factsResult, reconcileResult };
  mount(root, planFilterBar());
  renderPlanList(root);
  void setStatus;
};
