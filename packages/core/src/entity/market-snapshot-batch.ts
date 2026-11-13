import { z } from 'zod';

import { InvariantError } from '../error/index.js';
import { dateInShanghai } from '../trading-calendar.js';
import {
  assertMarketSnapshotInvariants,
  type MarketSnapshot,
  type MarketSnapshotCompleteness,
  MarketSnapshotCompletenessSchema,
  type MarketSnapshotItem,
  MarketSnapshotItemSchema,
} from './market-snapshot.js';
import { MarketCoverageSchema } from './stock-universe.js';

/**
 * 盘中全市场批次：一次采集发布一份不可变快照，按采样时点去重。
 *
 * - 采样时点对齐到 `MARKET_SNAPSHOT_BATCH_INTERVAL_MS`，同一批次重试复用已发布内容；
 * - `observedAt` / `dataAsOf` 跟随上游信封，上游不提供行情时间时保持缺失；
 * - `completeness` 沿用 `MarketSnapshot` 的既有完整性契约，`gaps` 只补充缺口说明；
 * - 批次不因不完整而丢弃：不完整批次照常发布并标注缺口，只有采集失败才不产生批次。
 */

export const MARKET_SNAPSHOT_BATCH_INTERVAL_MS = 5 * 60_000;

const BATCH_ID_SEPARATOR = '|';

const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日期必须为 YYYY-MM-DD');

export const MarketSnapshotBatchSchema = z.object({
  /** `${coverage}|${sampledAt ISO}`；同批次重试稳定派生同一 id。 */
  id: z.string().min(1),
  coverage: MarketCoverageSchema,
  tradingDate: dateString,
  /** 批次采样时点（对齐批次间隔）；不等于上游行情时间。 */
  sampledAt: z.coerce.date(),
  source: z.string().min(1),
  fetchedAt: z.coerce.date(),
  observedAt: z.coerce.date().optional(),
  dataAsOf: z.coerce.date().optional(),
  completeness: MarketSnapshotCompletenessSchema,
  /** 缺口说明；缺失/重复条目和缺字段分别列出，不把缺失写成 0。 */
  gaps: z.array(z.string()),
  items: z.array(MarketSnapshotItemSchema).min(1),
});

export type MarketSnapshotBatch = z.infer<typeof MarketSnapshotBatchSchema>;

export interface MarketSnapshotBatchPublishResult {
  readonly created: boolean;
  readonly batch: MarketSnapshotBatch;
}

/** 批次采样时点：向下对齐到批次间隔。 */
export const marketSnapshotBatchSampledAt = (at: Date): Date =>
  new Date(
    Math.floor(at.getTime() / MARKET_SNAPSHOT_BATCH_INTERVAL_MS) *
      MARKET_SNAPSHOT_BATCH_INTERVAL_MS,
  );

export const marketSnapshotBatchId = (input: {
  readonly coverage: MarketSnapshot['coverage'];
  readonly sampledAt: Date;
}): string => `${input.coverage}${BATCH_ID_SEPARATOR}${input.sampledAt.toISOString()}`;

const gapMessages = (input: {
  readonly completeness: MarketSnapshotCompleteness;
  readonly items: readonly MarketSnapshotItem[];
}): string[] => {
  const gaps: string[] = [];
  const { completeness, items } = input;
  if (completeness.missingCount > 0) {
    gaps.push(
      `missing_items: 期望 ${completeness.expectedCount} 只，实收 ${completeness.receivedCount} 只，缺 ${completeness.missingCount} 只`,
    );
  }
  if (completeness.duplicateCount > 0) {
    gaps.push(`duplicate_items: 丢弃重复 ${completeness.duplicateCount} 条`);
  }
  const missingAmount = items.filter((entry) => entry.amount === undefined).length;
  if (missingAmount > 0) {
    gaps.push(`missing_amount: ${missingAmount} 只缺少成交额`);
  }
  return gaps;
};

/** 一次采集 → 一个已发布批次；纯函数，不做 IO。 */
export const buildMarketSnapshotBatch = (input: {
  readonly snapshot: MarketSnapshot;
  readonly sampledAt: Date;
}): MarketSnapshotBatch => {
  const { snapshot } = input;
  const sampledAt = marketSnapshotBatchSampledAt(input.sampledAt);
  const items = [...snapshot.items];
  return {
    id: marketSnapshotBatchId({ coverage: snapshot.coverage, sampledAt }),
    coverage: snapshot.coverage,
    tradingDate: dateInShanghai(sampledAt),
    sampledAt,
    source: snapshot.source,
    fetchedAt: snapshot.fetchedAt,
    ...(snapshot.observedAt === undefined ? {} : { observedAt: snapshot.observedAt }),
    ...(snapshot.dataAsOf === undefined ? {} : { dataAsOf: snapshot.dataAsOf }),
    completeness: { ...snapshot.completeness },
    gaps: gapMessages({ completeness: snapshot.completeness, items }),
    items,
  };
};

export const assertMarketSnapshotBatchInvariants = (batch: MarketSnapshotBatch): void => {
  assertMarketSnapshotInvariants(batch);
  if (batch.items.length === 0) {
    throw new InvariantError('market snapshot batch must not be empty');
  }
  const expectedId = marketSnapshotBatchId({
    coverage: batch.coverage,
    sampledAt: batch.sampledAt,
  });
  if (batch.id !== expectedId) {
    throw new InvariantError(
      `market snapshot batch 批次 id (${batch.id}) 必须由 coverage 与 sampledAt 派生 (${expectedId})`,
    );
  }
  const aligned = marketSnapshotBatchSampledAt(batch.sampledAt);
  if (aligned.getTime() !== batch.sampledAt.getTime()) {
    throw new InvariantError('market snapshot batch sampledAt 必须对齐批次间隔');
  }
  if (batch.tradingDate !== dateInShanghai(batch.sampledAt)) {
    throw new InvariantError(
      `market snapshot batch tradingDate (${batch.tradingDate}) 与 sampledAt 不一致`,
    );
  }
  const { completeness } = batch;
  const hasGap = (prefix: string): boolean => batch.gaps.some((gap) => gap.startsWith(prefix));
  if (completeness.missingCount > 0 && !hasGap('missing_items')) {
    throw new InvariantError('market snapshot batch 缺失条目必须在 gaps 中标注 missing_items');
  }
  if (completeness.duplicateCount > 0 && !hasGap('duplicate_items')) {
    throw new InvariantError('market snapshot batch 重复条目必须在 gaps 中标注 duplicate_items');
  }
  const missingAmount = batch.items.filter((entry) => entry.amount === undefined).length;
  if (missingAmount > 0 && !hasGap('missing_amount')) {
    throw new InvariantError('market snapshot batch 缺成交额必须在 gaps 中标注 missing_amount');
  }
  if (
    completeness.missingCount === 0 &&
    completeness.duplicateCount === 0 &&
    missingAmount === 0 &&
    batch.gaps.length > 0
  ) {
    throw new InvariantError('market snapshot batch 无缺口时 gaps 必须为空');
  }
};
