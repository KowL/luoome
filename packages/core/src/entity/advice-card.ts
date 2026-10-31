import { z } from 'zod';

import { STANDARD_DISCLAIMERS } from './advice.js';

/**
 * 建议卡片的**唯一组装实现**（REQ-M3-09 §2 / S2）。
 *
 * 为什么必须在 core 且只有一份：今天仓里有**三个半成品渲染器**（通知文本、Web 建议卡、
 * 复盘来源摘要），各缺一段、且都**没有**「缺段」这个返回值——于是「五段齐全」这件事
 * 从来没有被任何代码判断过。把它做成 core 纯函数后，三条渲染路径都消费同一产物，
 * 「缺段 → blocked」也只有一个判定点。
 *
 * 五段 = 结论 / 反证 / 风险 / 有效期 / 免责。**缺任一段 → `blocked`，不产出卡片**；
 * 但调用方**必须**仍渲染一条「不可渲染：缺 X/Y」的条目——阻断的是卡片，不是条目，
 * 否则用户会以为「没有这条建议」。
 */

export const ADVICE_CARD_SEGMENTS = [
  'conclusion',
  'counterEvidence',
  'risks',
  'validity',
  'disclaimer',
] as const;
export type AdviceCardSegment = (typeof ADVICE_CARD_SEGMENTS)[number];

export const AdviceCardSegmentSchema = z.enum(ADVICE_CARD_SEGMENTS);

const AdviceCardValiditySchema = z
  .object({
    validUntil: z.coerce.date(),
    /** 过期是**事实**，不是缺失：过期但五段齐全仍然 `renderable`。 */
    expired: z.boolean(),
  })
  .strict();

export const AdviceCardSchema = z.discriminatedUnion('status', [
  z
    .object({
      status: z.literal('renderable'),
      adviceId: z.string().min(1),
      conclusion: z.string().min(1),
      counterEvidence: z.array(z.string().min(1)).min(1),
      risks: z.array(z.string().min(1)).min(1),
      validity: AdviceCardValiditySchema,
      /**
       * 免责声明。**条数不在这里钉**：`STANDARD_DISCLAIMERS.length` 是模块级常量，
       * 在 schema 构建期读取会形成 `advice ↔ advice-card` 的循环初始化。
       * 条数由 `renderAdviceCard` 保证（恒等于 `STANDARD_DISCLAIMERS.length`），并由测试钉住。
       */
      disclaimer: z.array(z.string().min(1)).min(1),
      dataAsOf: z.coerce.date(),
    })
    .strict(),
  z
    .object({
      status: z.literal('blocked'),
      adviceId: z.string().min(1),
      /** 缺段名，**固定顺序**（`ADVICE_CARD_SEGMENTS` 的顺序），便于逐条断言。 */
      missing: z.array(AdviceCardSegmentSchema).min(1),
      /** 已具备的段：可以展示为「部分」，绝不冒充完整卡片。 */
      available: z.array(AdviceCardSegmentSchema),
      /** 调用方直接渲染这句；证明「阻断卡片 ≠ 隐藏条目」。 */
      note: z.string().min(1),
    })
    .strict(),
]);
export type AdviceCard = z.infer<typeof AdviceCardSchema>;

/**
 * 组装卡片只需要这些字段。刻意**不**要求完整 `Advice`：`z.output<typeof AdviceSchema>`
 * 与 `Advice` 在 `exactOptionalPropertyTypes` 下并不互相赋值，而卡片只关心五段的内容。
 */
export interface AdviceCardSource {
  readonly id: string;
  readonly reasoning: {
    readonly premise: string;
    readonly counterEvidence: readonly string[];
  };
  readonly risks: readonly string[];
  readonly disclaimers: readonly string[];
  readonly validUntil: Date;
  readonly basedOn: { readonly dataAsOf: Date };
}

const trimmed = (value: string | undefined): string | undefined => {
  if (value === undefined) return undefined;
  const text = value.trim();
  return text.length === 0 ? undefined : text;
};

const nonEmpty = (values: readonly string[]): string[] =>
  values.map((value) => value.trim()).filter((value) => value.length > 0);

/**
 * 组装建议卡片。
 *
 * `now` 必须由调用方注入（core 零 IO）：`expired` 是相对判定，不读真实时钟。
 */
export const renderAdviceCard = (advice: AdviceCardSource, now: Date): AdviceCard => {
  const conclusion = trimmed(advice.reasoning.premise);
  const counterEvidence = nonEmpty(advice.reasoning.counterEvidence);
  const risks = nonEmpty(advice.risks);
  const validUntil = advice.validUntil;
  const validityValid = Number.isFinite(validUntil?.getTime());
  // 免责是**常量事实源**：`STANDARD_DISCLAIMERS` 是硬约束（恰好 3 条），不是编造内容。
  // 因此 `disclaimer` 段永不为空——五段里唯一「结构上不会缺」的一段，测试专门钉住这点。
  const disclaimer =
    advice.disclaimers.length > 0 ? [...advice.disclaimers] : [...STANDARD_DISCLAIMERS];

  const missing: AdviceCardSegment[] = [];
  const available: AdviceCardSegment[] = [];
  const record = (segment: AdviceCardSegment, present: boolean): void => {
    if (present) available.push(segment);
    else missing.push(segment);
  };
  record('conclusion', conclusion !== undefined);
  record('counterEvidence', counterEvidence.length > 0);
  record('risks', risks.length > 0);
  record('validity', validityValid);
  record('disclaimer', disclaimer.length > 0);

  if (missing.length > 0)
    return {
      status: 'blocked',
      adviceId: advice.id,
      missing,
      available,
      note: `不可渲染：缺${missing.map(segmentLabel).join(' / ')}`,
    };

  return {
    status: 'renderable',
    adviceId: advice.id,
    conclusion: conclusion ?? '',
    counterEvidence,
    risks,
    validity: {
      validUntil,
      expired: validUntil.getTime() <= now.getTime(),
    },
    disclaimer,
    dataAsOf: advice.basedOn.dataAsOf,
  };
};

const SEGMENT_LABELS: Readonly<Record<AdviceCardSegment, string>> = {
  conclusion: '结论',
  counterEvidence: '反证',
  risks: '风险',
  validity: '有效期',
  disclaimer: '免责声明',
};

export const segmentLabel = (segment: AdviceCardSegment): string => SEGMENT_LABELS[segment];
