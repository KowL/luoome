import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  activeBlockNotice,
  appliedPctFor,
  mergePlanEdit,
  PLAN_FORM_STEPS,
  rangeHint,
  rangeWidthCap,
  revisionConflictNotice,
  UNEDITED_GROUPS,
  uneditedNotice,
} from './plan-form.js';

/**
 * 四步表单的纯逻辑（决策 3-C / 外部评审②）。
 *
 * 这个模块刻意**不 import react**，所以能被本仓测试直接加载——
 * client 里带 React 的模块在本仓无法测试（`react` 不在依赖里），
 * 把可验证的规则抽到这里，是「让规则可被测」而不是「让组件可被测」。
 */
describe('交易计划四步表单：结构与边界', () => {
  it('四步顺序与字段分组固定（Codex 定的，不许自己加）', () => {
    expect(PLAN_FORM_STEPS.map((step) => step.id)).toEqual([
      'action-entry',
      'position-pick',
      'exit-hold',
      'risk-preview',
    ]);
    // appliedPct / fallbackPct 不得成为可编辑字段——它们由 core 算。
    const allFields = PLAN_FORM_STEPS.flatMap((step) => step.fields);
    expect(allFields).not.toContain('appliedPct');
    expect(allFields).not.toContain('fallbackPct');
    // 证据链字段也不得进表单。
    expect(allFields).not.toContain('marketFacts');
    expect(allFields).not.toContain('evidence');
  });

  it('未编辑项必须在预览里显式声明（不能静默沿用）', () => {
    const notice = uneditedNotice('plan-1:v3');
    for (const group of UNEDITED_GROUPS) expect(notice).toContain(group.label);
    expect(notice).toContain('plan-1:v3');
    expect(notice).toContain('沿用');
  });
});

describe('区间上限与落点：来自服务端，client 不重算', () => {
  it('上限直接取服务端下发的 rangeWidthCap（值来自 core 的 min(分层, 0.30×max)）', () => {
    // 服务端对 max=10 给 3、max=20 给 6、max=100 给 8（core `tradingPlanRangeWidthCap`）。
    expect(rangeWidthCap({ rangeWidthCap: 3 })).toBe(3);
    expect(rangeWidthCap({ rangeWidthCap: 6 })).toBe(6);
    expect(rangeWidthCap({ rangeWidthCap: 8 })).toBe(8);
    // 没有下发就返回 null，**不猜一个默认值**。
    expect(rangeWidthCap({})).toBeNull();
    expect(rangeWidthCap({ rangeWidthCap: null })).toBeNull();
    expect(rangeWidthCap(null)).toBeNull();
  });

  it('改服务端下发的上限，表单显示跟着变（证明没有在 client 写死）', () => {
    const a = rangeHint({ min: 0, max: 100 }, { rangeWidthCap: 8 });
    const b = rangeHint({ min: 0, max: 100 }, { rangeWidthCap: 1.5 });
    expect(a?.text).toContain('8');
    expect(b?.text).toContain('1.5');
    expect(a?.text).not.toBe(b?.text);
  });

  it('没有服务端上限时不编数字，只说「上限由服务端计算」', () => {
    const hint = rangeHint({ min: 0, max: 100 }, {});
    expect(hint?.text).toContain('由服务端计算');
    // 不得凭空出现一个上限数字
    expect(hint?.text).not.toMatch(/上限\s*\d/);
  });

  it('落点：没改就沿服务端值；改了按 core 的恒等式算（否则保存必被拒）', () => {
    const plan = {
      position: {
        targetPctRange: { min: 10, max: 12 },
        rangePick: { ruleId: 'mid' },
        appliedPct: 11,
      },
    };
    // 未改 → 沿用服务端的 11
    expect(appliedPctFor(plan, {})).toBe(11);
    expect(appliedPctFor(plan, { range: { min: 10, max: 12 }, pick: { ruleId: 'mid' } })).toBe(11);
    // 改了区间（mid）→ **必须算出来**：core 要求 appliedPct 精确等于选点结果，
    // 留 null 会被 `positionRangeChecks` 拒（浏览器实测踩过：保存报 Invalid operation）。
    expect(appliedPctFor(plan, { range: { min: 5, max: 8 } })).toBe(6.5);
    // 改选点为 lower-bound → 落点 = 下限
    expect(appliedPctFor(plan, { pick: { ruleId: 'lower-bound' } })).toBe(10);
    // volatility-scaled 需要波动率参数，本表单不提供 → 不给结论
    expect(
      appliedPctFor(plan, {
        pick: {
          ruleId: 'volatility-scaled',
          volatilityMetric: 'x',
          volatilityPct: 1,
          tiers: [{ volatilityUpToPct: 2, bandFractionPct: 50 }],
        },
      }),
    ).toBeNull();
  });
});

describe('激活警告必须在保存前出现（不许让用户点完才知道）', () => {
  it('active + 沿用的 marketFacts 含 unavailable → 预警并点名', () => {
    const notice = activeBlockNotice({
      status: 'active',
      marketFacts: [
        { id: 'fact-a', status: 'unavailable' },
        { id: 'fact-b', status: 'available' },
      ],
    });
    expect(notice?.tone).toBe('warn');
    expect(notice?.text).toContain('fact-a');
    // 必须给出两条出路，而不是只说「不行」
    expect(notice?.text).toContain('刷新');
    expect(notice?.text).toContain('draft');
  });

  it('draft 或无 unavailable 项 → 无警告（不制造噪音）', () => {
    expect(
      activeBlockNotice({ status: 'draft', marketFacts: [{ id: 'a', status: 'unavailable' }] }),
    ).toBeNull();
    expect(
      activeBlockNotice({ status: 'active', marketFacts: [{ id: 'a', status: 'available' }] }),
    ).toBeNull();
    expect(activeBlockNotice({ status: 'active', marketFacts: [] })).toBeNull();
  });
});

describe('合并编辑：只碰四步覆盖的字段，证据原样保留', () => {
  const base = {
    id: 'plan-1',
    version: 3,
    action: 'observe',
    entryPriceLow: 70,
    entryPriceHigh: 72,
    entryConditions: [],
    invalidEntryConditions: [],
    position: {
      currentPct: 12,
      targetPctRange: { min: 10, max: 12 },
      appliedPct: 10,
      fallbackPct: 10,
      rangePick: { ruleId: 'lower-bound' },
      constraintStatus: 'passed',
      constraintReasons: [],
      prerequisiteActions: [],
    },
    holding: {
      minTradingDays: 1,
      maxTradingDays: 5,
      nextReviewAt: new Date(0),
      earlyExitConditions: [],
      extensionBasis: [],
    },
    exit: { conditions: [], triggerConditions: [], canSellNow: true },
    invalidationRules: [],
    invalidationConditions: [],
    // 以下两组**不编辑**，合并后必须原样
    marketFacts: [{ id: 'fact-a', metric: 'breadth', value: 42, status: 'available' }],
    evidence: [
      { id: 'ev-1', kind: 'market', source: 'fixture', factIds: ['fact-a'], summary: '证据' },
    ],
    explanation: {
      supportingEvidenceIds: ['ev-1'],
      counterEvidence: ['原反证'],
      risks: ['原风险'],
      unknowns: [],
    },
  };

  it('改仓位区间：fallbackPct 恒等于下限，appliedPct 按选点规则算出（否则保存必被拒）', () => {
    const merged = mergePlanEdit(base, {
      targetPctRange: { min: 5, max: 8 },
      rangePick: { ruleId: 'mid' },
    });
    // `fallbackPct === min` 是 core 的硬不变量（`trading-plan.ts:442`）。
    expect(merged.position.fallbackPct).toBe(5);
    // `appliedPct` 必须写回一个合法值：core 要求它**精确等于**选点结果，
    // 留 null 的话 `save_trading_plan` 被 schema 直接拒（真实浏览器验收发现）。
    expect(merged.position.appliedPct).toBe(6.5);
    expect(merged.position.targetPctRange).toEqual({ min: 5, max: 8 });
  });

  it('区间与选点都没变时，appliedPct 沿用服务端已算的值', () => {
    const merged = mergePlanEdit(base, {
      targetPctRange: { min: 10, max: 12 },
      rangePick: { ruleId: 'lower-bound' },
    });
    expect(merged.position.appliedPct).toBe(base.position.appliedPct);
  });

  it('marketFacts / evidence / supportingEvidenceIds 原样保留（证据不可被表单改写）', () => {
    const merged = mergePlanEdit(base, {
      action: 'enter',
      explanation: { counterEvidence: ['新反证'] },
    });
    expect(merged.marketFacts).toEqual(base.marketFacts);
    expect(merged.evidence).toEqual(base.evidence);
    expect(merged.explanation.supportingEvidenceIds).toEqual(
      base.explanation.supportingEvidenceIds,
    );
    // 但四步内的字段确实改了。
    expect(merged.action).toBe('enter');
    expect(merged.explanation.counterEvidence).toEqual(['新反证']);
  });
});

describe('冲突文案', () => {
  it('同时说清「你打开的是哪版」「现在是哪版」「修改未保存」', () => {
    const text = revisionConflictNotice({
      openedVersionId: 'plan-1:v3',
      actualVersionId: 'plan-1:v4',
    });
    expect(text).toContain('plan-1:v3');
    expect(text).toContain('plan-1:v4');
    expect(text).toContain('未保存');
  });
});
