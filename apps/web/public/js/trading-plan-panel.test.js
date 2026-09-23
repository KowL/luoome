/* apps/web/public/js/trading-plan-panel.test.js —— 「预警」页交易计划分区纯函数测试。
 * DOM 渲染与弹窗交互由浏览器验收覆盖，不在此处断言。 */

import { describe, expect, it } from 'bun:test';

import {
  buildPlanRows,
  countPlanRows,
  currentPlanVersion,
  entryConditionText,
  filterPlanRows,
  latestPlanVersions,
  planActionLabel,
  planConditionText,
  planDetailSections,
  planDiff,
  planDraftNote,
  planEntryText,
  planKeyMetrics,
  planMetaText,
  planRowEligibility,
  planRowNote,
  planRowStatus,
  planStatusBadgeClass,
  planStatusLabel,
  planTargetText,
  planVersionId,
  planVersionsOf,
  previousVersionOf,
  supersededDraftNote,
} from './trading-plan-panel.js';

const makePlan = (overrides = {}) => ({
  id: 'account:acc1:stock:600519.SH',
  version: 1,
  accountId: 'acc1',
  stockId: '600519.SH',
  stockName: '贵州茅台',
  industry: '白酒',
  status: 'active',
  action: 'enter',
  entryPriceLow: 100,
  entryPriceHigh: 105,
  entryConditions: [
    {
      id: 'entry-1',
      kind: 'price-range',
      phase: 'entry',
      metric: 'price',
      comparator: 'between',
      value: 100,
      valueTo: 105,
      description: '价格处于入场区间 100-105',
    },
  ],
  invalidEntryConditions: ['账户事实待核对'],
  position: {
    currentPct: 0,
    targetPct: 10,
    deltaPct: 10,
    constraintStatus: 'passed',
    constraintReasons: [],
    prerequisiteActions: ['用户确认条件满足后手动执行；执行后更新持仓与资金记录'],
  },
  holding: {
    minTradingDays: 1,
    maxTradingDays: 5,
    nextReviewAt: '2026-08-12T00:00:00.000Z',
    earlyExitConditions: ['价格触及止损 95'],
    extensionBasis: ['新证据仍支持原市场前提'],
  },
  exit: {
    stopLoss: 95,
    takeProfit: 120,
    conditions: ['价格触及止损 95'],
    triggerConditions: [],
    canSellNow: false,
    unavailableReason: '当前持仓可卖数量为 0',
  },
  validFrom: '2026-08-11T00:00:00.000Z',
  validUntil: '2026-08-20T00:00:00.000Z',
  invalidationConditions: ['账户事实变化（持仓或现金变动）'],
  accountFactsAsOf: '2026-08-11T00:00:00.000Z',
  accountFactsDigest: 'account-facts-panel-test-digest',
  marketFacts: [
    {
      id: 'price:600519.SH:adv1',
      metric: 'price',
      value: 102,
      unit: 'CNY',
      source: 'sina',
      observedAt: '2026-08-11T01:00:00.000Z',
      status: 'available',
    },
  ],
  evidence: [
    {
      id: 'advice:adv1',
      kind: 'strategy',
      source: 'analyze_strategy_candidate',
      summary: '策略候选看多',
    },
  ],
  source: {
    strategyIds: ['strategy-1'],
    strategyVersionIds: ['strategy-1-v1'],
    runIds: ['run-1'],
    signalIds: [],
    adviceIds: ['adv1'],
  },
  explanation: {
    supportingEvidenceIds: ['advice:adv1'],
    counterEvidence: ['成交量不足'],
    risks: ['市场风险'],
    unknowns: ['缺少行业事实'],
  },
  confidence: 60,
  createdAt: '2026-08-11T00:00:00.000Z',
  ...overrides,
});

describe('计划文案', () => {
  it('动作与状态标签未知值原样回退', () => {
    expect(planActionLabel('enter')).toBe('建仓');
    expect(planActionLabel('unknown-action')).toBe('unknown-action');
    expect(planStatusLabel('draft')).toBe('草案');
    expect(planStatusLabel(undefined)).toBe('--');
  });

  it('状态徽标只对生效/草案做区分', () => {
    expect(planStatusBadgeClass('active')).toBe('badge-active');
    expect(planStatusBadgeClass('draft')).toBe('badge-draft');
    expect(planStatusBadgeClass('expired')).toBe('badge-neutral');
  });

  it('入场区间缺失时明确写未提供，而不是显示 0', () => {
    expect(planEntryText(makePlan())).toBe('100.00 - 105.00');
    expect(planEntryText(makePlan({ entryPriceLow: 100, entryPriceHigh: undefined }))).toBe(
      '未提供入场区间',
    );
  });

  it('目标仓位不可用时明确写不可用', () => {
    expect(planTargetText(makePlan())).toBe('10.00%');
    expect(
      planTargetText(makePlan({ position: { ...makePlan().position, targetPct: null } })),
    ).toBe('目标仓位不可用');
  });

  it('没有建仓动作的计划写不适用，观察计划写等待条件', () => {
    const hold = makePlan({
      action: 'hold',
      entryPriceLow: undefined,
      entryPriceHigh: undefined,
      entryConditions: [],
    });
    expect(planEntryText(hold)).toBe('不适用（无建仓动作）');
    expect(planDetailSections(hold)[1].lines).toContain('不适用（无建仓动作）');

    const observe = makePlan({
      action: 'observe',
      entryPriceLow: undefined,
      entryPriceHigh: undefined,
      entryConditions: [],
      position: { ...makePlan().position, currentPct: 0, targetPct: 0, deltaPct: 0 },
    });
    expect(planEntryText(observe)).toBe('等待条件（未给出价位）');
    expect(planTargetText(observe)).toBe('等待条件（未设置仓位）');
    expect(entryConditionText(observe)).toBe('等待条件（未给出具体条件）');
    expect(entryConditionText(hold)).toBe('不适用（无建仓动作）');
  });

  it('观察计划带条件性价位时照常展示区间与等待条件', () => {
    const observe = makePlan({
      action: 'observe',
      entryConditions: [
        {
          id: 'entry-1',
          kind: 'price-range',
          phase: 'entry',
          metric: 'price',
          comparator: 'between',
          value: 100,
          valueTo: 105,
          description: '价格处于入场区间 100-105',
        },
      ],
      position: { ...makePlan().position, currentPct: 0, targetPct: 6, deltaPct: 6 },
    });
    expect(planEntryText(observe)).toBe('100.00 - 105.00');
    expect(planTargetText(observe)).toBe('6.00%');
    expect(planDetailSections(observe)[1].lines).toContain('等待条件（满足前不建仓）');
    expect(planDetailSections(observe)[1].lines).toContain(
      '入场：价格处于入场区间 100-105（价格 100.00 – 105.00元）',
    );
  });

  it('卡片元信息包含版本、动作、入场、目标与有效期', () => {
    const text = planMetaText(makePlan());
    expect(text).toContain('v1');
    expect(text).toContain('建仓');
    expect(text).toContain('入场 100.00 - 105.00');
    expect(text).toContain('目标 10.00%');
    expect(text).toContain('有效期至');
  });

  it('版本 id 与存储口径一致', () => {
    expect(planVersionId(makePlan({ version: 4 }))).toBe('account:acc1:stock:600519.SH:v4');
  });
});

describe('草案原因', () => {
  it('生效计划没有草案原因', () => {
    expect(planDraftNote(makePlan())).toBeNull();
  });

  it('草案原因与监控说明同源时不再重复排一遍', () => {
    const draft = makePlan({
      status: 'draft',
      position: {
        ...makePlan().position,
        constraintStatus: 'failed',
        constraintReasons: ['AI 推理不可用'],
      },
      explanation: { ...makePlan().explanation, unknowns: ['AI 推理不可用'] },
    });
    const row = { plan: draft, kind: 'draft' };
    // 监控理由/下一步已经把同一句话说过 → 行下不再重复
    expect(
      planRowNote(row, { reason: '草案未通过生效门槛', nextStep: 'AI 推理不可用' }),
    ).toBeNull();
    expect(
      planRowNote(row, { reason: '草案未通过生效门槛', nextStep: '补齐证据后重新生成计划' }),
    ).toBe('草案原因：AI 推理不可用');
  });

  it('草案优先展示约束原因与未知项', () => {
    const note = planDraftNote(
      makePlan({
        status: 'draft',
        position: {
          ...makePlan().position,
          constraintStatus: 'unavailable',
          constraintReasons: ['AI Advice 未提供可核验的目标仓位百分比'],
        },
        explanation: { ...makePlan().explanation, unknowns: ['缺少价格区间'] },
      }),
    );
    expect(note).toContain('AI Advice 未提供可核验的目标仓位百分比');
    expect(note).toContain('缺少价格区间');
  });

  it('同一原因同时出现在约束与未知项时只保留一次', () => {
    const shared = '缺少价格区间，不能标为当前可执行建仓';
    const note = planDraftNote(
      makePlan({
        status: 'draft',
        position: {
          ...makePlan().position,
          constraintStatus: 'unavailable',
          constraintReasons: [shared],
        },
        explanation: { ...makePlan().explanation, unknowns: [shared] },
      }),
    );
    expect(note).toBe(`草案原因：${shared}`);
  });

  it('草案但约束已通过且无未知项时不编造原因', () => {
    const note = planDraftNote(
      makePlan({
        status: 'draft',
        explanation: { ...makePlan().explanation, unknowns: [] },
      }),
    );
    expect(note).toBeNull();
  });
});

describe('版本聚合', () => {
  it('同计划只保留最高版本', () => {
    const plans = [
      makePlan({ version: 1 }),
      makePlan({ version: 3 }),
      makePlan({ version: 2 }),
      makePlan({ id: 'account:acc1:stock:000001.SZ', version: 1, stockId: '000001.SZ' }),
    ];
    const latest = latestPlanVersions(plans);
    expect(latest).toHaveLength(2);
    expect(latest.find((plan) => plan.id.endsWith('600519.SH'))?.version).toBe(3);
  });

  it('同版本取较新创建的一条', () => {
    const older = makePlan({ version: 2, createdAt: '2026-08-11T00:00:00.000Z' });
    const newer = makePlan({ version: 2, createdAt: '2026-08-12T00:00:00.000Z' });
    expect(latestPlanVersions([older, newer])[0]?.createdAt).toBe('2026-08-12T00:00:00.000Z');
  });

  it('排序为生效 → 草案 → 历史状态，再按股票代码', () => {
    const plans = [
      makePlan({ id: 'b', stockId: '600519.SH', status: 'expired' }),
      makePlan({ id: 'c', stockId: '000001.SZ', status: 'draft' }),
      makePlan({ id: 'a', stockId: '300750.SZ', status: 'active' }),
    ];
    expect(latestPlanVersions(plans).map((plan) => plan.id)).toEqual(['a', 'c', 'b']);
  });

  it('历史版本按版本倒序，不混入其它计划', () => {
    const plans = [
      makePlan({ version: 1 }),
      makePlan({ version: 2 }),
      makePlan({ id: 'other', version: 9 }),
    ];
    expect(
      planVersionsOf(plans, 'account:acc1:stock:600519.SH').map((plan) => plan.version),
    ).toEqual([2, 1]);
  });

  it('当前版本取最新 active，更新的草案不顶掉仍在监控的生效版本', () => {
    const active = makePlan({ version: 9, status: 'active' });
    const draft = makePlan({ version: 10, status: 'draft', createdAt: '2026-08-13T00:00:00.000Z' });
    expect(currentPlanVersion([active, draft])).toEqual({ plan: active, kind: 'current' });
    expect(currentPlanVersion([draft, active])).toEqual({ plan: active, kind: 'current' });
  });

  it('没有 active 版本时退回最新草案；更新的退役状态按历史记录', () => {
    const draft = makePlan({ version: 2, status: 'draft' });
    expect(currentPlanVersion([makePlan({ version: 1, status: 'expired' }), draft])).toEqual({
      plan: draft,
      kind: 'draft',
    });
    const revoked = makePlan({ version: 3, status: 'revoked' });
    expect(currentPlanVersion([makePlan({ version: 1, status: 'active' }), revoked])).toEqual({
      plan: revoked,
      kind: 'history',
    });
  });
});

describe('计划详情分区', () => {
  it('覆盖入场、仓位、持有、退出、依据与账户来源', () => {
    const titles = planDetailSections(makePlan()).map((section) => section.title);
    expect(titles).toEqual([
      '身份与有效性',
      '入场',
      '仓位',
      '持有',
      '退出',
      '依据、反证与未知',
      '账户与来源',
    ]);
  });

  it('退出分区写明不可执行原因，不把计划当成可执行成交', () => {
    const exit = planDetailSections(makePlan()).find((section) => section.title === '退出');
    expect(exit?.lines.join('\n')).toContain('当前不可直接执行（当前持仓可卖数量为 0）');
  });

  it('依据分区区分支持证据、反证、风险与未知，并说明 confidence 不是收益概率', () => {
    const lines = planDetailSections(makePlan())
      .find((section) => section.title === '依据、反证与未知')
      ?.lines.join('\n');
    expect(lines).toContain('支持证据：策略候选看多');
    expect(lines).toContain('反证：成交量不足');
    expect(lines).toContain('风险：市场风险');
    expect(lines).toContain('未知：缺少行业事实');
    expect(lines).toContain('不是收益概率');
  });

  it('账户与来源展示时间与来源数量，不展示内部标识', () => {
    const lines = planDetailSections(makePlan())
      .find((section) => section.title === '账户与来源')
      ?.lines.join('\n');
    expect(lines).toContain('账户事实更新：');
    expect(JSON.stringify(planDetailSections(makePlan()))).not.toContain('account:acc1');
    expect(lines).not.toContain('account-facts-panel-test-digest');
    expect(lines).toContain('参考策略：1 个');
    expect(lines).not.toContain('strategy-1');
    expect(lines).toContain('参考建议：1 条');
    expect(lines).toContain('价格 102.00CNY · 可用');
  });
});

describe('版本差异', () => {
  const previous = makePlan({ version: 1 });
  const current = makePlan({
    version: 2,
    supersedesVersionId: 'account:acc1:stock:600519.SH:v1',
    entryPriceLow: 98,
    entryPriceHigh: 103,
    position: { ...makePlan().position, targetPct: 8, deltaPct: 8 },
    exit: { ...makePlan().exit, stopLoss: 92 },
    explanation: {
      ...makePlan().explanation,
      counterEvidence: ['成交量不足', '板块资金净流出'],
    },
  });

  it('只列出真正变化的字段', () => {
    const rows = planDiff(previous, current);
    const labels = rows.map((row) => row.label);
    expect(labels).toContain('入场区间');
    expect(labels).toContain('目标仓位');
    expect(labels).toContain('止损');
    expect(labels).toContain('反证');
    // 没变的字段不出现（避免把“没变”渲染成变化）
    expect(labels).not.toContain('动作');
    expect(labels).not.toContain('预计持有交易日');
  });

  it('差异行给出前后值', () => {
    const entry = planDiff(previous, current).find((row) => row.label === '入场区间');
    expect(entry).toEqual({
      label: '入场区间',
      before: '100.00 - 105.00',
      after: '98.00 - 103.00',
    });
  });

  it('完全相同的两版没有差异', () => {
    expect(planDiff(previous, makePlan({ version: 2 }))).toEqual([]);
  });

  it('缺少任一侧时不编造差异', () => {
    expect(planDiff(undefined, current)).toEqual([]);
    expect(planDiff(previous, undefined)).toEqual([]);
  });

  it('上一版优先按 supersedesVersionId 精确匹配', () => {
    const versions = [current, previous, makePlan({ version: 0 })];
    expect(previousVersionOf(current, versions)?.version).toBe(1);
  });

  it('没有 supersedesVersionId 时回退到同计划 version-1', () => {
    const planV3 = makePlan({ version: 3 });
    const versions = [makePlan({ version: 1 }), makePlan({ version: 2 }), planV3];
    expect(previousVersionOf(planV3, versions)?.version).toBe(2);
  });

  it('上一版不在列表里时返回 undefined（由调用方决定是否回源读取）', () => {
    const planV9 = makePlan({ version: 9 });
    expect(previousVersionOf(planV9, [planV9])).toBeUndefined();
  });
});

describe('计划行与监控资格', () => {
  const monitoring = (versionId, status) => ({
    versionId,
    status,
    reason: `${status} 原因`,
    nextStep: '下一步',
  });

  it('每个计划一行；有效期内与已过期按监控资格分组', () => {
    const readyPlan = makePlan({ id: 'a', stockId: '600519.SH' });
    const expiredPlan = makePlan({
      id: 'b',
      stockId: '000001.SZ',
      validUntil: '2026-08-01T00:00:00.000Z',
    });
    const rows = buildPlanRows(
      [readyPlan, expiredPlan, makePlan({ ...expiredPlan, version: 2 })],
      [
        monitoring(planVersionId(readyPlan), 'ready'),
        monitoring(planVersionId({ ...expiredPlan, version: 2 }), 'expired'),
      ],
    );
    expect(rows.map((row) => row.plan.stockId).sort()).toEqual(['000001.SZ', '600519.SH']);
    expect(rows.find((row) => row.plan.stockId === '600519.SH').eligibility).toBe('ready');
    // 同计划只保留当前版本（v2），资格取当前版本的监控结果
    expect(rows.find((row) => row.plan.stockId === '000001.SZ').plan.version).toBe(2);
    expect(rows.find((row) => row.plan.stockId === '000001.SZ').eligibility).toBe('expired');
  });

  it('草案不顶掉在跑的生效版本：行显示生效版本并提醒未发布的草案', () => {
    const active = makePlan({ version: 8, status: 'active' });
    const draft = makePlan({ version: 9, status: 'draft', createdAt: '2026-08-13T00:00:00.000Z' });
    const [row] = buildPlanRows([active, draft], [monitoring(planVersionId(active), 'ready')]);
    expect(row.plan.version).toBe(8);
    expect(row.eligibility).toBe('ready');
    expect(row.newerDraft?.version).toBe(9);
    expect(supersededDraftNote(row.newerDraft, row.plan)).toContain('更新的草案 v9 未发布');
  });

  it('没有当前版本的计划不生成行（工作版本已被退役）', () => {
    const rows = buildPlanRows([makePlan({ status: 'revoked' })]);
    expect(rows).toHaveLength(1);
    expect(rows[0].eligibility).toBe('history');
  });

  it('资格读不到时不假装可监控；徽标与记录状态解耦', () => {
    const row = { plan: makePlan({ status: 'active' }), kind: 'current', monitoring: undefined };
    expect(planRowEligibility(row)).toBe('pending');
    expect(planRowStatus(row)).toEqual({ label: '未就绪', cls: 'badge-warn' });
    expect(
      planRowStatus({
        ...row,
        monitoring: { versionId: 'x', status: 'expired', reason: '', nextStep: '' },
      }),
    ).toEqual({ label: '已过期', cls: 'badge-warn' });
    expect(
      planRowStatus({
        ...row,
        monitoring: { versionId: 'x', status: 'ready', reason: '', nextStep: '' },
      }),
    ).toEqual({ label: '可监控', cls: 'badge-active' });
    expect(
      planRowStatus({
        ...row,
        monitoring: { versionId: 'x', status: 'draft', reason: '', nextStep: '' },
      }),
    ).toEqual({ label: '草案', cls: 'badge-draft' });
  });
});

describe('计划筛选', () => {
  const rows = [
    {
      plan: makePlan({ id: 'a', stockId: '600519.SH', action: 'enter' }),
      kind: 'current',
      monitoring: { status: 'ready' },
    },
    {
      plan: makePlan({ id: 'b', stockId: '000001.SZ', action: 'observe' }),
      kind: 'draft',
      monitoring: { status: 'draft' },
    },
    {
      plan: makePlan({ id: 'c', stockId: '300750.SZ', action: 'exit' }),
      kind: 'current',
      monitoring: { status: 'expired' },
    },
    {
      plan: makePlan({ id: 'd', stockId: '600036.SH', action: 'reduce' }),
      kind: 'history',
      monitoring: undefined,
    },
  ].map((row) => ({ ...row, eligibility: planRowEligibility(row) }));

  it('「全部」不含已过期，其余按监控资格分组', () => {
    expect(filterPlanRows(rows, 'all', 'all').map((row) => row.plan.id)).toEqual(['a', 'b', 'd']);
    expect(filterPlanRows(rows, 'ready', 'all').map((row) => row.plan.id)).toEqual(['a']);
    expect(filterPlanRows(rows, 'pending', 'all').map((row) => row.plan.id)).toEqual(['b']);
    expect(filterPlanRows(rows, 'expired', 'all').map((row) => row.plan.id)).toEqual(['c']);
    expect(filterPlanRows(rows, 'history', 'all').map((row) => row.plan.id)).toEqual(['d']);
  });

  it('计数覆盖全部行（含默认不显示的已过期）', () => {
    expect(countPlanRows(rows)).toEqual({ total: 4, ready: 1, pending: 1, expired: 1, history: 1 });
  });

  it('动作筛选按「该不该动手」归类', () => {
    expect(filterPlanRows(rows, 'all', 'open').map((row) => row.plan.id)).toEqual(['a']);
    expect(filterPlanRows(rows, 'all', 'keep').map((row) => row.plan.id)).toEqual(['b']);
    expect(filterPlanRows(rows, 'all', 'risk').map((row) => row.plan.id)).toEqual(['d']);
  });

  it('筛选维度可叠加，缺省与未知值不误删', () => {
    expect(filterPlanRows(rows, 'history', 'risk').map((row) => row.plan.id)).toEqual(['d']);
    expect(filterPlanRows(undefined, 'ready', 'all')).toEqual([]);
    expect(filterPlanRows(rows, 'all', 'unknown').map((row) => row.plan.id)).toEqual([
      'a',
      'b',
      'd',
    ]);
    expect(filterPlanRows(rows, 'unknown', 'all')).toEqual([]);
  });
});

describe('计划关键数据', () => {
  it('卡片展示生成时价格、区间、退出价格和仓位', () => {
    const metrics = planKeyMetrics(makePlan());
    expect(metrics.map((metric) => metric.value)).toEqual([
      '102.00 元',
      '100.00 - 105.00',
      '95.00 / 120.00',
      '0.00% → 10.00%',
    ]);
    expect(metrics[0].note).toContain('sina');
  });
  it('缺失、过时及零仓位不会被伪造成实时数据', () => {
    expect(planKeyMetrics(makePlan({ marketFacts: [] }))[0].value).toBe('未提供');
    const stale = { ...makePlan().marketFacts[0], status: 'stale' };
    expect(planKeyMetrics(makePlan({ marketFacts: [stale] }))[0].note).toContain('已过时');
    expect(
      planKeyMetrics(makePlan({ position: { currentPct: 10, targetPct: 0, deltaPct: -10 } }))[3]
        .value,
    ).toBe('10.00% → 0.00%');
  });
  it('文字描述没有数值时仍展示结构化阈值，保留人工确认状态', () => {
    expect(
      planConditionText({ ...makePlan().entryConditions[0], description: '等待回调' }),
    ).toContain('价格 100.00 – 105.00元');
    expect(
      planConditionText({
        kind: 'change-pct-threshold',
        metric: 'changePct',
        comparator: 'lte',
        value: -3,
        description: '回撤',
      }),
    ).toContain('≤ -3.00%');
    expect(planConditionText({ kind: 'manual-confirmation', description: '核实公告' })).toContain(
      '需人工确认',
    );
  });
  it('退出触发条件即使缺少文本退出条件仍可见', () => {
    const plan = makePlan({
      exit: {
        ...makePlan().exit,
        conditions: [],
        triggerConditions: [
          {
            kind: 'price-threshold',
            phase: 'risk',
            metric: 'price',
            comparator: 'lte',
            value: 95,
            description: '止损触发',
          },
        ],
      },
    });
    expect(
      planDetailSections(plan)
        .find((section) => section.title === '退出')
        .lines.join(''),
    ).toContain('≤ 95.00元');
  });
});
