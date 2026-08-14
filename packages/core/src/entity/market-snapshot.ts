import { z } from 'zod';

import { ExchangeSchema } from './stock.js';
import { MarketCoverageSchema } from './stock-universe.js';

export const MarketSnapshotItemSchema = z.object({
  id: z.string().min(1),
  code: z.string().min(1),
  exchange: ExchangeSchema,
  name: z.string().min(1),
  close: z.number().positive().optional(),
  changePct: z.number().finite().optional(),
});
export type MarketSnapshotItem = z.infer<typeof MarketSnapshotItemSchema>;

export const MarketSnapshotCompletenessSchema = z.object({
  expectedCount: z.number().int().nonnegative(),
  receivedCount: z.number().int().nonnegative(),
  missingCount: z.number().int().nonnegative(),
  duplicateCount: z.number().int().nonnegative(),
  complete: z.boolean(),
});
export type MarketSnapshotCompleteness = z.infer<typeof MarketSnapshotCompletenessSchema>;

export const MarketSnapshotSchema = z.object({
  coverage: MarketCoverageSchema,
  source: z.string().min(1),
  fetchedAt: z.coerce.date(),
  observedAt: z.coerce.date().optional(),
  dataAsOf: z.coerce.date().optional(),
  items: z.array(MarketSnapshotItemSchema).min(1),
  completeness: MarketSnapshotCompletenessSchema,
});
export type MarketSnapshot = z.infer<typeof MarketSnapshotSchema>;

export const assertMarketSnapshotInvariants = (snapshot: MarketSnapshot): void => {
  const { completeness } = snapshot;
  if (completeness.receivedCount !== snapshot.items.length) {
    throw new Error('market snapshot receivedCount must equal unique item count');
  }
  if (completeness.expectedCount < completeness.receivedCount) {
    throw new Error('market snapshot expectedCount must be >= receivedCount');
  }
  if (completeness.missingCount !== completeness.expectedCount - completeness.receivedCount) {
    throw new Error('market snapshot missingCount must equal expectedCount - receivedCount');
  }
  const ids = new Set(snapshot.items.map((item) => item.id));
  if (ids.size !== snapshot.items.length) {
    throw new Error('market snapshot items must have unique ids');
  }
  const complete =
    completeness.expectedCount > 0 &&
    completeness.missingCount === 0 &&
    completeness.duplicateCount === 0;
  if (completeness.complete !== complete) {
    throw new Error('market snapshot complete does not match completeness counters');
  }
};
