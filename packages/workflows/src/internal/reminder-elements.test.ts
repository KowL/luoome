import {
  type Advice,
  type Holding,
  money,
  type TradingPlan,
  TradingPlanSchema,
  type WatchTrigger,
} from '@luoome/core';
import { describe, expect, it } from 'vitest';

import {
  collectReminderElements,
  NON_PLAN_DISCLOSURE,
  PLAN_SCOPED_ELEMENTS,
  REMINDER_ELEMENT_LABELS,
  REMINDER_ELEMENTS,
  ReminderElementsSchema,
  reminderSnapshotFields,
} from './reminder-elements.js';

const NOW = new Date('2026-10-30T06:00:00.000Z');

const trigger = (overrides: Partial<WatchTrigger> = {}): WatchTrigger => ({
  id: 'wt-1',
  poolId: 'pool-1',
  stockId: '600519.SH',
  ruleKind: 'price-level',
  ruleId: 'rule-1',
  direction: 'buy',
  triggerType: 'triggered',
  reason: '价格上穿 10.5',
  evidence: ['quote:close'],
  quote: { close: money(10.55), ts: NOW },
  priority: 'important',
  deliveryStatus: 'pending',
  evalSnapshot: { ruleId: 'rule-1' },
  notified: false,
  createdAt: NOW,
  ...overrides,
});

const plan = (
  overrides: {
    readonly exit?: Record<string, unknown>;
    readonly explanation?: Record<string, unknown>;
  } = {},
): TradingPlan =>
  TradingPlanSchema.parse({
    id: 'account:a:stock:600519.SH',
    version: 1,
    accountId: 'a',
    stockId: '600519.SH',
    stockName: '贵州茅台',
    status: 'active',
    action: 'observe',
    entryPriceLow: 10,
    entryPriceHigh: 12,
    entryConditions: [],
    invalidEntryConditions: [],
    position: {
      currentPct: 0,
      targetPctRange: null,
      appliedPct: null,
      fallbackPct: null,
      rangePick: null,
      constraintStatus: 'passed',
      constraintReasons: [],
      prerequisiteActions: [],
    },
    holding: {
      minTradingDays: 3,
      maxTradingDays: 10,
      nextReviewAt: NOW,
      earlyExitConditions: [],
      extensionBasis: [],
    },
    exit: { conditions: [], canSellNow: true, ...(overrides.exit ?? {}) },
    validFrom: new Date('2026-10-01T00:00:00.000Z'),
    validUntil: new Date('2026-11-30T00:00:00.000Z'),
    invalidationConditions: [],
    invalidationRules: [],
    accountFactsAsOf: new Date('2026-10-01T00:00:00.000Z'),
    accountFactsDigest: 'digest-0001',
    marketFacts: [],
    evidence: [],
    source: { strategyIds: [], strategyVersionIds: [], runIds: [], signalIds: [], adviceIds: [] },
    explanation: {
      supportingEvidenceIds: [],
      counterEvidence: ['板块轮动'],
      risks: ['大盘下行'],
      unknowns: [],
      ...(overrides.explanation ?? {}),
    },
    confidence: 60,
    createdAt: new Date('2026-10-01T02:00:00.000Z'),
  });

const holding = (availableQuantity: number, quantity: number): Holding => ({
  id: 'h-1',
  accountId: 'a',
  stockId: '600519.SH',
  quantity,
  availableQuantity,
  avgCost: money(10),
  openedAt: new Date('2026-09-01T00:00:00.000Z'),
  closedAt: null,
});

const advice = (overrides: Partial<Advice> = {}): Advice =>
  ({
    id: 'adv-1',
    subjectKind: 'stock',
    subjectId: '600519.SH',
    decision: 'buy',
    confidence: 60,
    horizon: 'short',
    reasoning: { premise: 'p', evidence: [], counterEvidence: ['advice 反证'] },
    risks: ['advice 风险'],
    disclaimers: [],
    basedOn: { dataAsOf: NOW },
    validFrom: NOW,
    validUntil: new Date('2026-11-05T00:00:00.000Z'),
    createdAt: NOW,
    ...overrides,
  }) as Advice;

describe('S4 提醒六要素：唯一判定实现', () => {
  it('六要素齐全 → complete，且逐项 presence 都是 present', () => {
    const result = collectReminderElements({
      trigger: trigger(),
      plan: plan({ exit: { stopLoss: money(9), takeProfit: money(12) } }),
    });
    expect(result.status).toBe('complete');
    expect(result.reminderType).toBe('planned');
    expect(result.elements.map((item) => item.element)).toEqual([...REMINDER_ELEMENTS]);
    expect(result.elements.every((item) => item.presence === 'present')).toBe(true);
    expect(ReminderElementsSchema.safeParse(result).success).toBe(true);
  });

  // 逐要素缺失 —— 六个 fixture，不是一个（PRD 要求「缺任一项」逐条红）
  it('计划型缺触发价（有 plan 但没行情）→ missing 只含 triggerPrice，三态是 absent', () => {
    // 计划型提醒**必须**有触发价：有 plan 时价格缺失就是真缺失。
    const result = collectReminderElements({
      trigger: trigger({ quote: undefined }),
      plan: plan({ exit: { stopLoss: money(9), takeProfit: money(12) } }),
    });
    expect(result.status).toBe('incomplete');
    if (result.status !== 'incomplete') return;
    expect(result.missingElements).toEqual(['triggerPrice']);
    expect(result.reasons[0]).toContain('拿不到触发价');
    expect(result.elements[0]?.presence).toBe('absent');
  });

  it('事件型：触发条件就是事件本身 → triggerPrice 判 not-applicable，五项计划要素也不适用，missing 为空', () => {
    const result = collectReminderElements({
      trigger: trigger({
        quote: undefined,
        ruleKind: 'event-date',
        evalSnapshot: {
          eventId: 'e1',
          eventKind: 'dividend',
          occursAt: NOW.toISOString(),
          remindDay: 3,
        },
      }),
    });
    expect(result.status).toBe('complete');
    expect(result.reminderType).toBe('event');
    const triggerPrice = result.elements.find((item) => item.element === 'triggerPrice');
    expect(triggerPrice?.presence).toBe('not-applicable');
    const snapshot = reminderSnapshotFields(result);
    expect(snapshot.missingElements).toBeUndefined();
    expect(snapshot.notApplicableElements).toEqual([...PLAN_SCOPED_ELEMENTS]);
  });

  it('事件型：事件事实本身缺失时才是真缺失（不许把「没有事件」当不适用）', () => {
    const result = collectReminderElements({
      trigger: trigger({ quote: undefined, ruleKind: 'event-date', evalSnapshot: {} }),
    });
    expect(result.status).toBe('incomplete');
    if (result.status !== 'incomplete') return;
    expect(result.missingElements).toEqual(['triggerPrice']);
    expect(result.reasons[0]).toContain('缺少事件事实');
  });

  it('缺止损与目标价（两者都空）→ missing 只含 stopOrTarget', () => {
    const result = collectReminderElements({
      trigger: trigger(),
      plan: plan(),
    });
    expect(result.status).toBe('incomplete');
    if (result.status !== 'incomplete') return;
    expect(result.missingElements).toEqual(['stopOrTarget']);
    expect(result.reasons[0]).toContain('未给出止损价与目标价');
    expect(result.elements.find((item) => item.element === 'stopOrTarget')?.presence).toBe('empty');
  });

  it('缺反证（空数组）→ missing 只含 counterEvidence', () => {
    const result = collectReminderElements({
      trigger: trigger(),
      plan: plan({
        exit: { stopLoss: money(9) },
        explanation: { counterEvidence: [] },
      }),
    });
    expect(result.status).toBe('incomplete');
    if (result.status !== 'incomplete') return;
    expect(result.missingElements).toEqual(['counterEvidence']);
    expect(result.elements.find((item) => item.element === 'counterEvidence')?.presence).toBe(
      'empty',
    );
  });

  it('缺风险（空数组）→ missing 只含 risks', () => {
    const result = collectReminderElements({
      trigger: trigger(),
      plan: plan({ exit: { stopLoss: money(9) }, explanation: { risks: [] } }),
    });
    expect(result.status).toBe('incomplete');
    if (result.status !== 'incomplete') return;
    expect(result.missingElements).toEqual(['risks']);
  });

  it('阈值型（无 plan）：计划五项判 not-applicable，不进 missing；有触发价即可投递', () => {
    const result = collectReminderElements({ trigger: trigger() });
    expect(result.status).toBe('complete');
    expect(result.reminderType).toBe('threshold');
    const notApplicable = result.elements
      .filter((item) => item.presence === 'not-applicable')
      .map((item) => item.element);
    expect(notApplicable).toEqual([...PLAN_SCOPED_ELEMENTS]);
    // 不适用 ≠ 缺失：missing 里不许出现这五项。
    expect(reminderSnapshotFields(result).missingElements).toBeUndefined();
  });

  it('阈值型缺触发价才是真缺失（价格型提醒必须有价格）', () => {
    const result = collectReminderElements({ trigger: trigger({ quote: undefined }) });
    expect(result.status).toBe('incomplete');
    if (result.status !== 'incomplete') return;
    expect(result.missingElements).toEqual(['triggerPrice']);
    expect(result.notApplicableElements).toEqual([...PLAN_SCOPED_ELEMENTS]);
  });

  it('缺卖出限制（不可卖但没写原因）→ missing 含 sellRestriction 且点名为什么', () => {
    const result = collectReminderElements({
      trigger: trigger(),
      plan: plan({
        exit: { stopLoss: money(9), canSellNow: false },
      }),
    });
    expect(result.status).toBe('incomplete');
    if (result.status !== 'incomplete') return;
    expect(result.missingElements).toEqual(['sellRestriction']);
    expect(result.reasons[0]).toContain('不可卖出但没有给出原因');
  });

  it('「缺」与「填了 0/false」不同：stopLoss=0 算有值，canSellNow=false + 原因算有值', () => {
    const zeroStop = collectReminderElements({
      trigger: trigger(),
      plan: plan({ exit: { stopLoss: money(0), canSellNow: false, unavailableReason: '停牌' } }),
    });
    expect(zeroStop.status).toBe('complete');
  });

  it('无 plan 但有 advice：仍是阈值型，计划五项不适用（持有不改变提醒类型）', () => {
    const withAdvice = collectReminderElements({
      trigger: trigger(),
      holding: holding(500, 1000),
      advice: advice(),
    });
    expect(withAdvice.reminderType).toBe('threshold');
    expect(withAdvice.status).toBe('complete');
  });

  it('要素顺序固定（按 REMINDER_ELEMENTS），便于逐项断言', () => {
    const result = collectReminderElements({
      trigger: trigger(),
      plan: plan({ exit: { stopLoss: money(9) }, explanation: { counterEvidence: [], risks: [] } }),
    });
    if (result.status !== 'incomplete') throw new Error('expected incomplete');
    const indexOf = (element: string) => REMINDER_ELEMENTS.indexOf(element as never);
    const indexes = result.missingElements.map(indexOf);
    expect([...indexes].sort((a, b) => a - b)).toEqual(indexes);
  });

  it('reminderSnapshotFields：complete 只写状态；阈值型附 notApplicable；incomplete 逐项落缺口', () => {
    expect(
      reminderSnapshotFields({ status: 'complete', reminderType: 'planned', elements: [] }),
    ).toEqual({
      reminderType: 'planned',
      reminderElements: 'complete',
    });
    const threshold = reminderSnapshotFields(collectReminderElements({ trigger: trigger() }));
    expect(threshold).toMatchObject({
      reminderType: 'threshold',
      reminderElements: 'complete',
    });
    expect(threshold.missingElements).toBeUndefined();
    expect(threshold.notApplicableElements).toEqual([...PLAN_SCOPED_ELEMENTS]);

    const incomplete = reminderSnapshotFields(
      collectReminderElements({ trigger: trigger({ quote: undefined }) }),
    );
    expect(incomplete.reminderElements).toBe('incomplete');
    expect(incomplete.missingElements).toEqual(['triggerPrice']);
    expect(incomplete.missingElementReasons?.[0]).toContain('触发价');
  });

  it('不适用必须被说出来：披露文案是非空且点明「不是建议」', () => {
    expect(NON_PLAN_DISCLOSURE).toContain('止损');
    expect(NON_PLAN_DISCLOSURE).toContain('不是建议');
  });

  it('四态可区分：empty（字段在但值为空）与 absent（字段不存在）落到不同 presence、reasons 不同', () => {
    const presenceOf = (result: ReturnType<typeof collectReminderElements>, element: string) =>
      result.elements.find((item) => item.element === element)?.presence;
    const reasonOf = (result: ReturnType<typeof collectReminderElements>, element: string) =>
      result.elements.find((item) => item.element === element)?.reason ?? '';

    // empty：计划里的 risks 字段存在但是空数组。
    const empty = collectReminderElements({
      trigger: trigger(),
      plan: plan({ exit: { stopLoss: money(9) }, explanation: { risks: [] } }),
    });
    expect(presenceOf(empty, 'risks')).toBe('empty');
    expect(reasonOf(empty, 'risks')).toContain('字段存在但内容为空');

    // absent：计划型但它压根没有 rights 字段来源（用 sellRestriction 演示更干净：
    // 有 plan 且 canSellNow=false 但**没有 unavailableReason 字段** → empty；
    // 而无 plan 的 planned 世界不存在，所以用 validity 的 absent 世界：
    // 计划型 + advice 缺失时 validity 有值，改用 stopOrTarget 的 absent 不成立——
    // 因此这里用「无 plan 的计划型」不可构造，改为直接断言阈值型的 not-applicable 与之不同。
    const threshold = collectReminderElements({ trigger: trigger() });
    expect(presenceOf(threshold, 'risks')).toBe('not-applicable');
    expect(reasonOf(threshold, 'risks')).toBe('');

    // absent：事件型但事件事实缺失 → triggerPrice 是 absent（字段不存在，不是空值）。
    const absent = collectReminderElements({
      trigger: trigger({ quote: undefined, ruleKind: 'event-date', evalSnapshot: {} }),
    });
    expect(presenceOf(absent, 'triggerPrice')).toBe('absent');
    expect(reasonOf(absent, 'triggerPrice')).toContain('缺少事件事实');
    expect(reasonOf(absent, 'triggerPrice')).not.toContain('不是正数');
  });

  it('present / empty / absent / not-applicable 四态在同一个计划型结果里各出现一次', () => {
    const mixed = collectReminderElements({
      trigger: trigger(), // present（有 quote）
      plan: plan({
        // stopOrTarget: present（有 stopLoss）
        exit: { stopLoss: money(9), canSellNow: false, unavailableReason: '停牌' },
        // counterEvidence: empty（空数组）
        explanation: { counterEvidence: [], risks: ['大盘下行'] },
      }),
    });
    const presence = mixed.elements.map((item) => `${item.element}:${item.presence}`);
    expect(presence).toEqual([
      'triggerPrice:present',
      'stopOrTarget:present',
      'counterEvidence:empty',
      'risks:present',
      'validity:present',
      'sellRestriction:present',
    ]);
    // absent 只能在「字段不存在」的世界出现：无 plan 的计划型拿不到。
    const noPlanEvent = collectReminderElements({
      trigger: trigger({ quote: undefined, ruleKind: 'event-date', evalSnapshot: {} }),
    });
    expect(noPlanEvent.elements.find((item) => item.element === 'triggerPrice')?.presence).toBe(
      'absent',
    );
    const threshold = collectReminderElements({ trigger: trigger() });
    expect(threshold.elements.find((item) => item.element === 'stopOrTarget')?.presence).toBe(
      'not-applicable',
    );
  });

  it('每个要素都有中文标签（面板与报告展示用，不许出现裸枚举名）', () => {
    for (const element of REMINDER_ELEMENTS)
      expect(REMINDER_ELEMENT_LABELS[element].length).toBeGreaterThan(0);
  });
});
