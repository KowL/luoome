import type { Advice, Holding, TradingPlan, WatchTrigger } from '@luoome/core';
import { z } from 'zod';

/**
 * 提醒要素判定（REQ-M3-09 §5 / S4）——**唯一实现**，三条投递路径共用。
 *
 * ## 不是「一个矩阵通吃」，而是两类提醒
 *
 * PRD §5 的六要素里，「止损/目标价、有效期、卖出限制」本质上是 **plan 层概念**。
 * 要求每条提醒都有它们，就等于要求每条提醒都关联一个 `TradingPlan`——而 PRD 从来没有
 * 这条要求（`AlertPlan` 里也没有任何指向 `TradingPlan` 的字段）。所以字面读法与 PRD
 * 自己的数据模型矛盾。这里的修法是**说清适用范围**（Lead 裁定）：
 *
 * | 提醒类型 | 判定依据 | 要素 |
 * |---|---|---|
 * | `planned` 计划型 | 关联到 active `TradingPlan` | **六要素全要**；缺任一 → 不投递 |
 * | `threshold` 阈值型 | `AlertPlan` 盘中触发，无 plan | 触发条件（价位规则）+ 依据来源 + 观察时点 |
 * | `event` 事件型 | `evaluate-event-rules`，无 plan | 触发条件（**事件本身**：kind/occursAt/remindDay）|
 *
 * 阈值型/事件型里，plan 相关的五项判为 **`not-applicable`**：
 * **不适用 ≠ 缺失 ≠ 0**，它们不进 `missingElements`，但投递内容里**必须**带一句可见披露
 * （`NON_PLAN_DISCLOSURE`）——不适用必须被说出来，否则读者会以为这条提醒「什么都没写」。
 *
 * ## 三态
 *
 * 每个要素单独判 `present` / `empty` / `absent`，**都不等于「填了 0 / 填了 false」**：
 * `stopLoss: 0` 是「有值 0」，`stopLoss: undefined` 才是 `absent`。
 */

export const REMINDER_TYPES = ['planned', 'threshold', 'event'] as const;
export type ReminderType = (typeof REMINDER_TYPES)[number];

/** 计划层五项：阈值型/事件型判为不适用。 */
export const PLAN_SCOPED_ELEMENTS = [
  'stopOrTarget',
  'counterEvidence',
  'risks',
  'validity',
  'sellRestriction',
] as const;

export const REMINDER_ELEMENTS = [
  'triggerPrice',
  'stopOrTarget',
  'counterEvidence',
  'risks',
  'validity',
  'sellRestriction',
] as const;
export type ReminderElement = (typeof REMINDER_ELEMENTS)[number];

export const REMINDER_ELEMENT_LABELS: Readonly<Record<ReminderElement, string>> = {
  triggerPrice: '触发价',
  stopOrTarget: '止损或目标价',
  counterEvidence: '反证',
  risks: '风险',
  validity: '有效期',
  sellRestriction: '卖出限制',
};

export const ElementPresenceSchema = z.enum(['present', 'empty', 'absent', 'not-applicable']);
export type ElementPresence = z.infer<typeof ElementPresenceSchema>;

/** 阈值型/事件型投递内容里必须带的一句披露（原文，报告与测试都引它）。 */
export const NON_PLAN_DISCLOSURE =
  '这是价格/事件提醒，不含止损、反证、风险、有效期与卖出限制——它不是建议。';

export interface ReminderElementStatus {
  readonly element: ReminderElement;
  readonly presence: ElementPresence;
  readonly reason?: string;
}

const PANEL_ELEMENT_STATUS_SCHEMA = z
  .object({
    element: z.enum(REMINDER_ELEMENTS),
    presence: ElementPresenceSchema,
    reason: z.string().min(1).optional(),
  })
  .strict();

export const ReminderElementsSchema = z.discriminatedUnion('status', [
  z
    .object({
      status: z.literal('complete'),
      reminderType: z.enum(REMINDER_TYPES),
      elements: z.array(PANEL_ELEMENT_STATUS_SCHEMA),
    })
    .strict(),
  z
    .object({
      status: z.literal('incomplete'),
      reminderType: z.enum(REMINDER_TYPES),
      /** 缺哪几个（**不含** `not-applicable`），按 `REMINDER_ELEMENTS` 固定顺序。 */
      missingElements: z.array(z.enum(REMINDER_ELEMENTS)).min(1),
      /** 逐项原因（与 `missingElements` 一一对应）。 */
      reasons: z.array(z.string().min(1)).min(1),
      /** 判为不适用的（阈值型/事件型的计划五项）。 */
      notApplicableElements: z.array(z.enum(REMINDER_ELEMENTS)),
      elements: z.array(PANEL_ELEMENT_STATUS_SCHEMA),
    })
    .strict(),
]);
export type ReminderElements = z.infer<typeof ReminderElementsSchema>;

export interface ReminderElementInput {
  readonly trigger: WatchTrigger;
  readonly plan?: TradingPlan;
  readonly advice?: Advice;
  readonly holding?: Holding;
}

const present = (element: ReminderElement): ReminderElementStatus => ({
  element,
  presence: 'present',
});
const lacking = (
  element: ReminderElement,
  presence: 'empty' | 'absent',
  reason: string,
): ReminderElementStatus => ({ element, presence, reason });
const notApplicable = (element: ReminderElement): ReminderElementStatus => ({
  element,
  presence: 'not-applicable',
});

const nonEmptyTexts = (values: readonly string[] | undefined): 'present' | 'empty' | 'absent' =>
  values === undefined
    ? 'absent'
    : values.some((value) => value.trim().length > 0)
      ? 'present'
      : 'empty';

/**
 * 触发条件。两类判定：
 *
 * - **价格型**（`price-level` / `price-change` / `cost-threshold` / `strategy-signal`）：
 *   必须有 `WatchTrigger.quote.close`。没有行情就是 `absent`——**不许伪造一个价格**。
 * - **事件型**（`event-date`）：触发条件**就是事件本身**（`evalSnapshot` 的
 *   `eventKind` / `occursAt` / `remindDay`），本来就不该有价格。价格缺失对它不是
 *   「缺要素」，这一项对它判 `not-applicable`。
 */
const triggerConditionStatus = (trigger: WatchTrigger): ReminderElementStatus => {
  if (trigger.ruleKind === 'event-date') {
    const kind = trigger.evalSnapshot.eventKind;
    const occursAt = trigger.evalSnapshot.occursAt;
    if (typeof kind === 'string' && typeof occursAt === 'string')
      return notApplicable('triggerPrice');
    return lacking('triggerPrice', 'absent', '事件提醒缺少事件事实（eventKind / occursAt）');
  }
  if (trigger.quote === undefined)
    return lacking('triggerPrice', 'absent', '本条触发没有行情快照，拿不到触发价');
  if (!(trigger.quote.close > 0))
    return lacking('triggerPrice', 'empty', '触发价不是正数，无法作为提醒依据');
  return present('triggerPrice');
};

const stopOrTargetStatus = (plan: TradingPlan): ReminderElementStatus => {
  const { stopLoss, takeProfit } = plan.exit;
  if (stopLoss === undefined && takeProfit === undefined)
    return lacking('stopOrTarget', 'empty', '交易计划未给出止损价与目标价');
  // `0` 是「有值」而不是「没填」。
  return present('stopOrTarget');
};

const counterEvidenceStatus = (input: ReminderElementInput): ReminderElementStatus => {
  const fromPlan = nonEmptyTexts(input.plan?.explanation.counterEvidence);
  if (fromPlan === 'present') return present('counterEvidence');
  const fromAdvice = nonEmptyTexts(input.advice?.reasoning.counterEvidence);
  if (fromAdvice === 'present') return present('counterEvidence');
  if (fromPlan === 'absent' && fromAdvice === 'absent')
    return lacking('counterEvidence', 'absent', '交易计划与建议都没有反证字段');
  return lacking('counterEvidence', 'empty', '反证字段存在但内容为空');
};

const risksStatus = (input: ReminderElementInput): ReminderElementStatus => {
  const fromPlan = nonEmptyTexts(input.plan?.explanation.risks);
  if (fromPlan === 'present') return present('risks');
  const fromAdvice = nonEmptyTexts(input.advice?.risks);
  if (fromAdvice === 'present') return present('risks');
  if (fromPlan === 'absent' && fromAdvice === 'absent')
    return lacking('risks', 'absent', '交易计划与建议都没有风险字段');
  return lacking('risks', 'empty', '风险字段存在但内容为空');
};

const validityStatus = (input: ReminderElementInput): ReminderElementStatus => {
  const value = input.plan?.validUntil ?? input.advice?.validUntil;
  if (value === undefined)
    return lacking('validity', 'absent', '本条提醒没有关联计划或建议，拿不到有效期');
  if (!Number.isFinite(value.getTime())) return lacking('validity', 'empty', '有效期不是合法时间');
  return present('validity');
};

/**
 * 卖出限制：`plan.exit.canSellNow` + `exit.unavailableReason`。
 * `canSellNow === false` **本身不是缺失**——它说明「卖不了」；缺的是原因。
 */
const sellRestrictionStatus = (input: ReminderElementInput): ReminderElementStatus => {
  if (input.plan !== undefined) {
    const { canSellNow, unavailableReason } = input.plan.exit;
    if (canSellNow) return present('sellRestriction');
    if (unavailableReason !== undefined && unavailableReason.trim().length > 0)
      return present('sellRestriction');
    return lacking('sellRestriction', 'empty', '计划标注不可卖出但没有给出原因');
  }
  if (input.holding !== undefined)
    return input.holding.availableQuantity < input.holding.quantity
      ? present('sellRestriction')
      : lacking('sellRestriction', 'empty', '持仓全部可卖，没有卖出限制可披露');
  return lacking('sellRestriction', 'absent', '本条提醒没有关联计划或持仓，拿不到卖出限制');
};

/** 触发即判定类型：有 plan 走 `planned`，否则按规则种类分 `event` / `threshold`。 */
export const reminderTypeOf = (input: ReminderElementInput): ReminderType => {
  if (input.plan !== undefined) return 'planned';
  return input.trigger.ruleKind === 'event-date' ? 'event' : 'threshold';
};

/** 收集要素并给出 `complete` / `incomplete`。 */
export const collectReminderElements = (input: ReminderElementInput): ReminderElements => {
  const reminderType = reminderTypeOf(input);
  const planScoped =
    reminderType === 'planned'
      ? [
          stopOrTargetStatus(input.plan as TradingPlan),
          counterEvidenceStatus(input),
          risksStatus(input),
          validityStatus(input),
          sellRestrictionStatus(input),
        ]
      : PLAN_SCOPED_ELEMENTS.map(notApplicable);
  const elements: ReminderElementStatus[] = [triggerConditionStatus(input.trigger), ...planScoped];

  const missing = elements.filter(
    (item) => item.presence === 'empty' || item.presence === 'absent',
  );
  const notApplicableElements = elements
    .filter((item) => item.presence === 'not-applicable')
    .map((item) => item.element);

  if (missing.length === 0) return { status: 'complete', reminderType, elements };

  return {
    status: 'incomplete',
    reminderType,
    missingElements: missing.map((item) => item.element),
    reasons: missing.map(
      (item) => `${REMINDER_ELEMENT_LABELS[item.element]}：${item.reason ?? '不可用'}`,
    ),
    notApplicableElements,
    elements,
  };
};

/**
 * 落 `evalSnapshot` 的字段（附加式、不动 DB：`evalSnapshot` 本就是
 * `record<string, unknown>`，与 `quoteClose` / `threshold` 同级）。
 *
 * `missingElements` 只装**真正缺失**的；不适用写 `notApplicableElements`——
 * 两个数在面板上分开计数，否则用户会以为有 N 条提醒发不出去。
 */
export const reminderSnapshotFields = (
  elements: ReminderElements,
): {
  readonly reminderType: ReminderType;
  readonly reminderElements: 'complete' | 'incomplete';
  readonly missingElements?: readonly string[];
  readonly missingElementReasons?: readonly string[];
  readonly notApplicableElements?: readonly string[];
} =>
  elements.status === 'complete'
    ? {
        reminderType: elements.reminderType,
        reminderElements: 'complete',
        ...(elements.reminderType === 'planned'
          ? {}
          : { notApplicableElements: [...PLAN_SCOPED_ELEMENTS] }),
      }
    : {
        reminderType: elements.reminderType,
        reminderElements: 'incomplete',
        missingElements: elements.missingElements,
        missingElementReasons: elements.reasons,
        ...(elements.notApplicableElements.length === 0
          ? {}
          : { notApplicableElements: elements.notApplicableElements }),
      };
