import { createHash } from 'node:crypto';
import { z } from 'zod';

import { DataProvenanceSchema } from './provenance.js';

/**
 * External 市场事实（REQ-M3-16 / S1）。
 *
 * 为什么必须是一个**新实体**而不复用既有三个：
 * - `MarketSnapshotSchema` 没有稳定 id（`items[].id` 是标的 id），无法被 Advice 逐条引用；
 * - `NewsItemSchema.id` 是**上游** id（可空、可重复、可被上游改写），且没有 `observedAt`；
 * - `StrictBacktestMarketFactSchema` 的范式最接近（有 `contentHash`），但它只面向回测日线。
 *
 * 本实体的核心是**稳定 id**：`extfact:<kind>:<source>:<subjectKey>:<observedAt ISO>`。
 * `contentHash` **刻意不进 id**——上游更正正文时，我们要的是「同一条事实被更新」，
 * 而不是「多出一条事实」；否则一次补字就会让 Advice 的引用链断掉。
 */

export const EXTERNAL_FACT_KINDS = ['news'] as const;
export const ExternalFactKindSchema = z.enum(EXTERNAL_FACT_KINDS);
export type ExternalFactKind = z.infer<typeof ExternalFactKindSchema>;

/** 稳定 id 的前缀：L2 强制点（`checkExternalFactPersistence`）按它识别外部事实。 */
export const EXTERNAL_FACT_ID_PREFIX = 'extfact:';

export const externalFactId = (input: {
  readonly kind: ExternalFactKind;
  readonly source: string;
  readonly subjectKey: string;
  readonly observedAt: Date;
}): string =>
  `${EXTERNAL_FACT_ID_PREFIX}${input.kind}:${input.source}:${input.subjectKey}:${input.observedAt.toISOString()}`;

/** 规范化 JSON：键排序后序列化，保证同一内容得到同一哈希。 */
const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
};

/** 内容哈希：**只做变更检测**，不参与 id。 */
export const externalFactContentHash = (input: {
  readonly kind: ExternalFactKind;
  readonly source: string;
  readonly subjectKey: string;
  readonly observedAt: Date;
  readonly payload: Readonly<Record<string, unknown>>;
}): string =>
  createHash('sha256')
    .update(
      canonicalJson({
        kind: input.kind,
        source: input.source,
        subjectKey: input.subjectKey,
        observedAt: input.observedAt.toISOString(),
        payload: input.payload,
      }),
    )
    .digest('hex');

const ContentHashSchema = z.string().regex(/^[a-f0-9]{64}$/);

export const ExternalMarketFactSchema = z
  .object({
    /** 稳定 id（幂等键）；`contentHash` 不进 id。 */
    id: z.string().min(1).max(400),
    kind: ExternalFactKindSchema,
    /** 上游标识：news 用上游新闻 id。 */
    subjectKey: z.string().min(1).max(200),
    category: z.string().min(1).max(100).optional(),
    /** 数据实际对应时间（≠ 抓取时间）。**缺了就拒绝落库**，不拿 `fetchedAt` 顶替。 */
    observedAt: z.coerce.date(),
    /** 抓取时间。 */
    fetchedAt: z.coerce.date(),
    /** 数据来源标识（provider 名，与 `DataProvenance.provider` 同口径）。 */
    source: z.string().min(1).max(100),
    provenance: DataProvenanceSchema,
    /** 归一化后的外部内容原文（新闻 title + summary + url …）。 */
    payload: z.record(z.string(), z.unknown()),
    /** payload 的规范化哈希：变更检测用，**不进 id**。 */
    contentHash: ContentHashSchema,
    /** 首次落库时间；内容更正时**保持不变**。 */
    recordedAt: z.coerce.date(),
    /**
     * 内容更正时间（可选）。上游改写正文后重抓会写这个字段，
     * 让「这条事实被更正过」可审计，而 `recordedAt` 仍指向首次落库。
     */
    revisedAt: z.coerce.date().optional(),
    /** 引用该事实的 Advice / 策略 id（反查用）。 */
    referencedBy: z.array(z.string().min(1)).default([]),
  })
  .strict();
export type ExternalMarketFact = z.infer<typeof ExternalMarketFactSchema>;

/** 落库入参：id / contentHash / recordedAt 由落库方算，不信任调用方。 */
export const ExternalFactDraftSchema = z
  .object({
    kind: ExternalFactKindSchema,
    subjectKey: z.string().min(1).max(200),
    category: z.string().min(1).max(100).optional(),
    observedAt: z.coerce.date(),
    source: z.string().min(1).max(100),
    provenance: DataProvenanceSchema,
    payload: z.record(z.string(), z.unknown()),
  })
  .strict();
export type ExternalFactDraft = z.infer<typeof ExternalFactDraftSchema>;

export const assertExternalMarketFactInvariants = (fact: ExternalMarketFact): void => {
  const expected = externalFactId({
    kind: fact.kind,
    source: fact.source,
    subjectKey: fact.subjectKey,
    observedAt: fact.observedAt,
  });
  // 先查「含哈希」——否则它会被下面的 `id !== expected` 抢先报成不一致，原因就被掩盖了。
  if (fact.id.includes(fact.contentHash)) {
    throw new Error('external fact id 不得包含 contentHash（更正会让引用链断裂）');
  }
  if (fact.id !== expected) {
    throw new Error(
      `external fact id 与 (kind, source, subjectKey, observedAt) 不一致：${fact.id}`,
    );
  }
};
