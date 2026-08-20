import { z } from 'zod';

export const StockResearchProfileFactSchema = z.object({
  kind: z.enum([
    'topic',
    'document',
    'stock-event',
    'strategy-signal',
    'watch-trigger',
    'limit-up',
  ]),
  id: z.string().min(1),
  summary: z.string().min(1).max(500),
  occurredAt: z.coerce.date().optional(),
  sourceStatus: z.enum(['verified', 'unverified', 'not-applicable']),
});
export type StockResearchProfileFact = z.infer<typeof StockResearchProfileFactSchema>;

export const StockResearchProfileSchema = z.object({
  stock: z.object({
    stockId: z.string().min(1),
    stockName: z.string().min(1),
    nameStatus: z.enum(['resolved', 'unavailable']),
  }),
  status: z.enum(['complete', 'partial', 'unavailable']),
  factsAsOf: z.coerce.date().optional(),
  oldestEvidenceAt: z.coerce.date().optional(),
  coverage: z.object({
    topics: z.number().int().nonnegative(),
    documents: z.number().int().nonnegative(),
    events: z.number().int().nonnegative(),
    strategySignals: z.number().int().nonnegative(),
    watchTriggers: z.number().int().nonnegative(),
  }),
  evidence: z.array(StockResearchProfileFactSchema).max(100),
  counterEvidence: z.array(StockResearchProfileFactSchema).max(100),
  unknowns: z.array(z.string().min(1).max(500)).max(20),
  limitations: z.array(z.string().min(1).max(500)).min(1).max(20),
});
export type StockResearchProfile = z.infer<typeof StockResearchProfileSchema>;
