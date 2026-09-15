/* apps/web/public/js/trading-plan-panel.test.js —— 「预警」页交易计划分区纯函数测试。
 * DOM 渲染与弹窗交互由浏览器验收覆盖，不在此处断言。 */

import { describe, expect, it } from 'bun:test';

import {
  filterPlansByAction,
  filterPlansByStatus,
  latestPlanVersions,
  planActionLabel,
  planDetailSections,
  planDiff,
  planDraftNote,
  planEntryText,
  planMetaText,
  planStatusBadgeClass,
  planStatusLabel,
  planTargetText,
  planVersionId,
  planVersionsOf,
  previousVersionOf,
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
  invalidEntryConditions: ['账户快照待核对'],
  position: {
    currentPct: 0,
    targetPct: 10,
    deltaPct: 10,
    constraintStatus: 'passed',
    constraintReasons: [],
    prerequisiteActions: ['用户手动执行后更新账户快照'],
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
  invalidationConditions: ['账户快照版本改变'],
  accountSnapshotId: 'snapshot-1',
  accountSnapshotVersion: 3,
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

  it('账户与来源分区带上快照版本、来源 id 与行情事实状态', () => {
    const lines = planDetailSections(makePlan())
      .find((section) => section.title === '账户与来源')
      ?.lines.join('\n');
    expect(lines).toContain('账户快照：snapshot-1（v3）');
    expect(lines).toContain('策略：strategy-1');
    expect(lines).toContain('建议：adv1');
    expect(lines).toContain('price 102.00CNY · 可用');
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

describe('计划筛选', () => {
  const plans = [
    makePlan({ id: 'a', stockId: '600519.SH', status: 'active', action: 'enter' }),
    makePlan({ id: 'b', stockId: '000001.SZ', status: 'draft', action: 'observe' }),
    makePlan({ id: 'c', stockId: '300750.SZ', status: 'expired', action: 'exit' }),
    makePlan({ id: 'd', stockId: '600036.SH', status: 'active', action: 'reduce' }),
  ];

  it('状态筛选区分生效 / 草案 / 历史', () => {
    expect(filterPlansByStatus(plans, 'all').map((p) => p.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(filterPlansByStatus(plans, 'active').map((p) => p.id)).toEqual(['a', 'd']);
    expect(filterPlansByStatus(plans, 'draft').map((p) => p.id)).toEqual(['b']);
    expect(filterPlansByStatus(plans, 'history').map((p) => p.id)).toEqual(['c']);
  });

  it('动作筛选按「该不该动手」归类', () => {
    expect(filterPlansByAction(plans, 'all').map((p) => p.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(filterPlansByAction(plans, 'open').map((p) => p.id)).toEqual(['a']);
    expect(filterPlansByAction(plans, 'keep').map((p) => p.id)).toEqual(['b']);
    expect(filterPlansByAction(plans, 'risk').map((p) => p.id)).toEqual(['c', 'd']);
  });

  it('筛选维度可叠加，缺省与未知值不误删', () => {
    const active = filterPlansByStatus(plans, 'active');
    expect(filterPlansByAction(active, 'risk').map((p) => p.id)).toEqual(['d']);
    expect(filterPlansByStatus(undefined, 'active')).toEqual([]);
    expect(filterPlansByAction(plans, 'unknown')).toEqual(plans);
  });
});
