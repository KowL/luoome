import { z } from 'zod';

import { InvariantError } from '../error/index.js';
import { dateInShanghai } from '../trading-calendar.js';
import {
  assertLimitUpLadderInvariants,
  type LimitUpLadder,
  type LimitUpLadderLevel,
  LimitUpLadderLevelSchema,
  type LimitUpLadderSource,
  LimitUpLadderSourceSchema,
} from './limit-up-ladder.js';
import { marketSnapshotBatchSampledAt } from './market-snapshot-batch.js';

/**
 * 按采样时点保存的天梯事实（ticket #41）。
 *
 * 既有的 `limit_up_ladder_snapshots` 以 `(date, source)` 为主键，只保留当日最新一份，
 * 无法还原「某只股票在 10:15 封板、11:00 开板」这类时间线。本实体在每次批次发布时
 * 同时写入一份不可变天梯样本，按 `sampledAt` 对齐盘中批次间隔：
 *
 * - 同 (tradingDate, source, sampledAt) 重试幂等，保留首次写入内容；
 * - 采样时点与批次时点对齐，便于把天梯状态和同一时点的个股行情逐点对照；
 * - 供应商只给封板时间时保留 `firstTime` / `finalTime` 原字段，不做推算或补齐。
 */

const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日期必须为 YYYY-MM-DD');

export const LimitUpLadderSampleSchema = z.object({
  /** `${tradingDate}|${source}|${sampledAt ISO}`；同采样时点重试稳定派生同一 id。 */
  id: z.string().min(1),
  tradingDate: dateString,
  sampledAt: z.coerce.date(),
  source: LimitUpLadderSourceSchema,
  total: z.number().int().nonnegative(),
  maxLevel: z.number().int().nonnegative(),
  levels: z.array(LimitUpLadderLevelSchema),
  warnings: z.array(z.string()),
  /** 上游天梯的返回时间；与采样时点分开保存，缺行情时间时不冒充采样时点。 */
  asOf: z.coerce.date(),
});
export type LimitUpLadderSample = z.infer<typeof LimitUpLadderSampleSchema>;

export interface LimitUpLadderSamplePublishResult {
  readonly created: boolean;
  readonly sample: LimitUpLadderSample;
}

const SAMPLE_ID_SEPARATOR = '|';

export const limitUpLadderSampleId = (input: {
  readonly tradingDate: string;
  readonly source: LimitUpLadderSource;
  readonly sampledAt: Date;
}): string =>
  `${input.tradingDate}${SAMPLE_ID_SEPARATOR}${input.source}${SAMPLE_ID_SEPARATOR}${input.sampledAt.toISOString()}`;

/** 一份天梯快照 + 采样时点 → 一条不可变样本；纯函数，不做 IO。 */
export const buildLimitUpLadderSample = (input: {
  readonly ladder: LimitUpLadder;
  readonly sampledAt: Date;
}): LimitUpLadderSample => {
  const sampledAt = marketSnapshotBatchSampledAt(input.sampledAt);
  const tradingDate = dateInShanghai(sampledAt);
  return LimitUpLadderSampleSchema.parse({
    id: limitUpLadderSampleId({ tradingDate, source: input.ladder.source, sampledAt }),
    tradingDate,
    sampledAt,
    source: input.ladder.source,
    total: input.ladder.total,
    maxLevel: input.ladder.maxLevel,
    levels: input.ladder.levels as LimitUpLadderLevel[],
    warnings: [...input.ladder.warnings],
    asOf: input.ladder.asOf,
  });
};

/** 样本还原成既有 `LimitUpLadder` 形状，复用天梯不变量与下游查询函数。 */
export const ladderOfSample = (sample: LimitUpLadderSample): LimitUpLadder => {
  const ladder: LimitUpLadder = {
    date: sample.tradingDate,
    total: sample.total,
    maxLevel: sample.maxLevel,
    source: sample.source,
    levels: sample.levels,
    warnings: sample.warnings,
    asOf: sample.asOf,
  };
  assertLimitUpLadderInvariants(ladder, sample.tradingDate);
  return ladder;
};

export const assertLimitUpLadderSampleInvariants = (sample: LimitUpLadderSample): void => {
  const expectedId = limitUpLadderSampleId(sample);
  if (sample.id !== expectedId) {
    throw new InvariantError(
      `limit up ladder sample id (${sample.id}) 必须由 tradingDate / source / sampledAt 派生 (${expectedId})`,
    );
  }
  const aligned = marketSnapshotBatchSampledAt(sample.sampledAt);
  if (aligned.getTime() !== sample.sampledAt.getTime()) {
    throw new InvariantError('limit up ladder sample sampledAt 必须对齐批次采样间隔');
  }
  if (sample.tradingDate !== dateInShanghai(sample.sampledAt)) {
    throw new InvariantError(
      `limit up ladder sample tradingDate (${sample.tradingDate}) 与 sampledAt 不一致`,
    );
  }
  ladderOfSample(sample);
};
