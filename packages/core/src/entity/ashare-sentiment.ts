import { z } from 'zod';

import { InvariantError } from '../error/index.js';
import { DataProvenanceSchema } from './provenance.js';
import { IndexQuoteSchema } from './quote.js';

export const EvidenceDimensionStatusSchema = z.enum(['complete', 'partial', 'unavailable']);
export type EvidenceDimensionStatus = z.infer<typeof EvidenceDimensionStatusSchema>;

const EvidenceDimensionBase = {
  status: EvidenceDimensionStatusSchema,
  provenance: z.array(DataProvenanceSchema).min(1),
  warnings: z.array(z.string()).default([]),
};

const ThemeCountSchema = z.object({
  name: z.string().min(1),
  count: z.number().int().positive(),
});

export const AShareSentimentSnapshotSchema = z.object({
  date: z.string().date(),
  coverage: z.literal('CN_A_SHARES_SH_SZ'),
  dataAsOf: z.coerce.date(),
  indexes: z.object({
    ...EvidenceDimensionBase,
    values: z.array(IndexQuoteSchema).optional(),
  }),
  breadth: z.object({
    ...EvidenceDimensionBase,
    value: z
      .object({
        advancing: z.number().int().nonnegative(),
        declining: z.number().int().nonnegative(),
        unchanged: z.number().int().nonnegative(),
        total: z.number().int().positive(),
      })
      .optional(),
  }),
  limitUp: z.object({
    ...EvidenceDimensionBase,
    value: z
      .object({
        sealedCount: z.number().int().nonnegative(),
        brokenCount: z.number().int().nonnegative(),
        brokenRate: z.number().min(0).max(1).nullable(),
        maxLadderLevel: z.number().int().nonnegative(),
        totalSealAmount: z.number().nonnegative().nullable(),
        boardDistribution: z.record(z.string(), z.number().int().nonnegative()),
        leaders: z.array(
          z.object({
            stockId: z.string().min(1),
            name: z.string().min(1),
            ladderLevel: z.number().int().positive(),
            sealAmount: z.number().nonnegative().nullable(),
            openCount: z.number().int().nonnegative().nullable(),
          }),
        ),
      })
      .optional(),
  }),
  themes: z.object({
    ...EvidenceDimensionBase,
    value: z
      .object({
        industries: z.array(ThemeCountSchema),
        concepts: z.array(ThemeCountSchema),
      })
      .optional(),
  }),
});

export type AShareSentimentSnapshot = z.infer<typeof AShareSentimentSnapshotSchema>;

const assertValueStatus = (
  name: string,
  dimension: { readonly status: EvidenceDimensionStatus; readonly value?: unknown },
): void => {
  if (dimension.status === 'unavailable' && dimension.value !== undefined) {
    throw new InvariantError(`unavailable ${name} dimension must not carry value`);
  }
  if (dimension.status === 'complete' && dimension.value === undefined) {
    throw new InvariantError(`complete ${name} dimension requires value`);
  }
};

export const assertAShareSentimentSnapshotInvariants = (
  snapshot: AShareSentimentSnapshot,
): void => {
  if (snapshot.indexes.status === 'unavailable' && snapshot.indexes.values !== undefined) {
    throw new InvariantError('unavailable indexes dimension must not carry values');
  }
  if (snapshot.indexes.status === 'complete' && snapshot.indexes.values === undefined) {
    throw new InvariantError('complete indexes dimension requires values');
  }
  assertValueStatus('breadth', snapshot.breadth);
  assertValueStatus('limitUp', snapshot.limitUp);
  assertValueStatus('themes', snapshot.themes);

  const breadth = snapshot.breadth.value;
  if (
    breadth !== undefined &&
    breadth.advancing + breadth.declining + breadth.unchanged !== breadth.total
  ) {
    throw new InvariantError('breadth total must equal advancing + declining + unchanged');
  }

  const limitUp = snapshot.limitUp.value;
  if (limitUp === undefined) return;
  const denominator = limitUp.sealedCount + limitUp.brokenCount;
  if (snapshot.limitUp.status !== 'complete' && limitUp.brokenRate !== null) {
    throw new InvariantError('partial limitUp dimension must not claim brokenRate');
  }
  if (snapshot.limitUp.status === 'complete') {
    const expectedRate = denominator === 0 ? null : limitUp.brokenCount / denominator;
    if (
      expectedRate === null
        ? limitUp.brokenRate !== null
        : limitUp.brokenRate === null ||
          Math.abs(limitUp.brokenRate - expectedRate) > Number.EPSILON
    ) {
      throw new InvariantError('limitUp brokenRate does not match sealed and broken counts');
    }
  }
  const distributed = Object.values(limitUp.boardDistribution).reduce(
    (total, count) => total + count,
    0,
  );
  if (distributed !== limitUp.sealedCount) {
    throw new InvariantError('limitUp boardDistribution must sum to sealedCount');
  }
  if (limitUp.leaders.some((leader) => leader.ladderLevel > limitUp.maxLadderLevel)) {
    throw new InvariantError('limitUp leader ladderLevel exceeds maxLadderLevel');
  }
};
