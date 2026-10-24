import { z } from 'zod';
import { type WatchTrigger, WatchTriggerSchema } from '../entity/watch-trigger.js';
import { HashSchema } from './hash.js';

export const PersonalWatchTriggerSnapshotSchema = WatchTriggerSchema.pick({
  id: true,
  alertPlanId: true,
  poolId: true,
  stockId: true,
  ruleKind: true,
  ruleId: true,
  direction: true,
  triggerType: true,
  reason: true,
  evidence: true,
  quote: true,
  priority: true,
  evalSnapshot: true,
  createdAt: true,
}).refine(
  (trigger) =>
    trigger.direction === 'watch' &&
    (trigger.ruleKind === 'price-level' || trigger.ruleKind === 'price-change'),
  { message: '个人反馈仅允许用户价格观察条件' },
);
export type PersonalWatchTriggerSnapshot = z.infer<typeof PersonalWatchTriggerSnapshotSchema>;
export const freezePersonalWatchTrigger = (
  trigger: WatchTrigger | PersonalWatchTriggerSnapshot,
): PersonalWatchTriggerSnapshot =>
  PersonalWatchTriggerSnapshotSchema.parse({
    ...trigger,
    evalSnapshot: Object.fromEntries(
      Object.entries(trigger.evalSnapshot).filter(
        ([key, value]) =>
          [
            'ruleId',
            'kind',
            'quoteClose',
            'quoteTs',
            'threshold',
            'changePct',
            'pct',
            'side',
            'priceLevel',
            'dataAsOf',
            'observedAt',
            'timestampSource',
          ].includes(key) &&
          (value === null || ['string', 'number', 'boolean'].includes(typeof value)),
      ),
    ),
  });
export const PersonalWatchFeedbackSchema = z.object({
  triggerId: z.string().min(1),
  triggerSnapshot: PersonalWatchTriggerSnapshotSchema,
  revision: z.number().int().positive(),
  rating: z.enum(['handled', 'useful', 'useless', 'ignored']),
  note: z.string().max(2000),
  recordedAt: z.coerce.date(),
  requestId: z.string().min(1),
  inputHash: HashSchema,
});
export type PersonalWatchFeedback = z.infer<typeof PersonalWatchFeedbackSchema>;

const TradingPlanTriggerSourceSchema = z.object({
  planVersionId: z.string().min(1),
  conditionId: z.string().min(1),
  accountFactsDigest: z.string().min(1),
  validUntil: z.coerce.date(),
});

/** 交易计划触发的来源解析；非交易计划触发返回 null。 */
export const tradingPlanTriggerSource = (trigger: WatchTrigger) => {
  const prefix = 'trading-plan-watch:';
  if (!trigger.poolId.startsWith(prefix)) return null;
  const accountId = trigger.poolId.slice(prefix.length);
  const parsed = TradingPlanTriggerSourceSchema.safeParse(trigger.evalSnapshot);
  if (
    accountId.length === 0 ||
    !parsed.success ||
    trigger.ruleId !== `${parsed.data.planVersionId}:${parsed.data.conditionId}`
  )
    return null;
  return { accountId, ...parsed.data };
};
