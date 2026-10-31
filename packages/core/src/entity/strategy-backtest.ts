import { createHash } from 'node:crypto';

import { z } from 'zod';

import { InvariantError } from '../error/index.js';
import { computeEvaluatorCodeHash } from '../strategy/evaluator-code-identity.js';

export const STRICT_BACKTEST_MODEL_VERSION = 'strict-backtest-v1';
export const STRATEGY_EVALUATOR_VERSION = 'strategy-evaluator-v2';

/**
 * REQ-M3-12：code identity 是 evaluator 真实文件内容的 SHA-256（不是手写版本号/路径）。
 * 范围与 dist 回退语义见 `strategy/evaluator-code-identity.ts`。
 */
export const STRATEGY_EVALUATOR_CODE_HASH = computeEvaluatorCodeHash();

export const StrategyEvaluatorIdentitySchema = z.object({
  version: z.literal(STRATEGY_EVALUATOR_VERSION),
  codeHash: z.literal(STRATEGY_EVALUATOR_CODE_HASH),
});
export type StrategyEvaluatorIdentity = z.infer<typeof StrategyEvaluatorIdentitySchema>;

export const CURRENT_STRATEGY_EVALUATOR_IDENTITY: StrategyEvaluatorIdentity = {
  version: STRATEGY_EVALUATOR_VERSION,
  codeHash: STRATEGY_EVALUATOR_CODE_HASH,
};

/** 涨跌停幅度表版本；口径变化必须换版本，回测事实的 source 里记录它。 */
export const TRADABILITY_RULE_VERSION = 'tradability-rule-v1';

export type TradabilityBoard = 'main_board' | 'chinext' | 'star' | 'bse';

/** 板块由 stockId 的代码前缀确定性判定（不信外部标签）。 */
export const tradabilityBoard = (stockId: string): TradabilityBoard | null => {
  const index = stockId.lastIndexOf('.');
  const code = index > 0 ? stockId.slice(0, index) : stockId;
  const exchange = index > 0 ? stockId.slice(index + 1) : '';
  if (exchange === 'BJ' || /^[84]/.test(code)) return 'bse';
  if (exchange === 'SH')
    return code.startsWith('68') ? 'star' : code.startsWith('60') ? 'main_board' : null;
  if (exchange === 'SZ')
    return /^30[01]/.test(code) ? 'chinext' : code.startsWith('00') ? 'main_board' : null;
  return null;
};

/**
 * 涨跌停幅度（比例，0.05 = 5%）。规则表 v1：
 * - 北交所 30%；科创板/创业板 20%；
 * - 主板非 ST 10%，主板 ST 5%；
 * - ST 状态 unknown 时无法判定（返回 null）——不得猜。
 */
export const tradabilityLimitPct = (input: {
  readonly stockId: string;
  readonly stStatus: 'st' | 'non-st' | 'unknown';
}): number | null => {
  const board = tradabilityBoard(input.stockId);
  if (board === null) return null;
  if (board === 'bse') return 0.3;
  if (board === 'star' || board === 'chinext') return 0.2;
  if (input.stStatus === 'unknown') return null;
  return input.stStatus === 'st' ? 0.05 : 0.1;
};

const roundPrice = (value: number): number => Math.round((value + Number.EPSILON) * 100) / 100;

/** 由前收盘价 × 幅度确定性计算涨停/跌停价（两位小数，四舍五入）。 */
export const tradabilityLimitPrices = (
  prevClose: number,
  pct: number,
): { readonly up: number; readonly down: number } => ({
  up: roundPrice(prevClose * (1 + pct)),
  down: roundPrice(prevClose * (1 - pct)),
});

export const StrictBacktestGateKeySchema = z.enum([
  'pit-universe',
  'daily-bar-revisions',
  'fees',
  'slippage',
  'tradability',
  'corporate-actions',
  'benchmark',
  'evaluator-code',
]);
export type StrictBacktestGateKey = z.infer<typeof StrictBacktestGateKeySchema>;

export const StrictBacktestAvailabilitySchema = z.enum(['complete', 'partial', 'unavailable']);
export type StrictBacktestAvailability = z.infer<typeof StrictBacktestAvailabilitySchema>;

export const StrictBacktestGateItemSchema = z.object({
  key: StrictBacktestGateKeySchema,
  status: StrictBacktestAvailabilitySchema,
  reason: z.string().min(1).max(500),
  evidenceRefs: z.array(z.string().min(1).max(300)).max(200),
});
export type StrictBacktestGateItem = z.infer<typeof StrictBacktestGateItemSchema>;

const STRICT_BACKTEST_GATE_KEYS = StrictBacktestGateKeySchema.options;

export const StrictBacktestGateAuditSchema = z
  .object({
    status: StrictBacktestAvailabilitySchema,
    items: z.array(StrictBacktestGateItemSchema),
    assessedAt: z.coerce.date(),
  })
  .superRefine((audit, ctx) => {
    const keys = audit.items.map((item) => item.key);
    if (new Set(keys).size !== keys.length) {
      ctx.addIssue({ code: 'custom', path: ['items'], message: 'backtest gate key 必须唯一' });
    }
    for (const key of STRICT_BACKTEST_GATE_KEYS) {
      if (!keys.includes(key)) {
        ctx.addIssue({ code: 'custom', path: ['items'], message: `缺少 backtest gate: ${key}` });
      }
    }
    const expected = audit.items.every((item) => item.status === 'complete')
      ? 'complete'
      : audit.items.every((item) => item.status === 'unavailable')
        ? 'unavailable'
        : 'partial';
    if (audit.status !== expected) {
      ctx.addIssue({
        code: 'custom',
        path: ['status'],
        message: `gate audit status 应为 ${expected}`,
      });
    }
  });
export type StrictBacktestGateAudit = z.infer<typeof StrictBacktestGateAuditSchema>;

export const StrictBacktestSpecSchema = z
  .object({
    schemaVersion: z.literal(1),
    strategyId: z.string().min(1),
    strategyVersionId: z.string().min(1),
    evaluationSessionId: z.string().min(1),
    from: z.coerce.date(),
    to: z.coerce.date(),
    initialCash: z.number().positive().finite(),
    benchmark: z.object({
      stockId: z.string().min(1),
      datasetVersion: z.string().min(1),
    }),
    execution: z.object({
      model: z.literal('next-open-full-rebalance-equal-weight-v1'),
      lotSize: z.number().int().positive().default(100),
      maxPositions: z.number().int().min(1).max(100).default(20),
    }),
    fees: z.object({
      model: z.literal('ashare-fees-v1'),
      commissionBps: z.number().nonnegative().max(100),
      minimumCommission: z.number().nonnegative().finite(),
      sellStampDutyBps: z.number().nonnegative().max(100),
    }),
    slippage: z.object({
      model: z.literal('fixed-bps-at-open-v1'),
      buyBps: z.number().nonnegative().max(500),
      sellBps: z.number().nonnegative().max(500),
    }),
  })
  .superRefine((spec, ctx) => {
    if (spec.from > spec.to) {
      ctx.addIssue({ code: 'custom', path: ['from'], message: 'backtest from 不能晚于 to' });
    }
  });
export type StrictBacktestSpec = z.infer<typeof StrictBacktestSpecSchema>;

export const StrictBacktestCorporateActionSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('split'),
    ratio: z.number().positive().finite(),
    sourceId: z.string().min(1),
  }),
  z.object({
    kind: z.literal('cash-dividend'),
    cashPerShare: z.number().nonnegative().finite(),
    sourceId: z.string().min(1),
  }),
]);
export type StrictBacktestCorporateAction = z.infer<typeof StrictBacktestCorporateActionSchema>;

export const StrictBacktestMarketFactSchema = z
  .object({
    stockId: z.string().min(1),
    date: z.coerce.date(),
    rawOpen: z.number().positive().finite(),
    rawHigh: z.number().positive().finite(),
    rawLow: z.number().positive().finite(),
    rawClose: z.number().positive().finite(),
    sessionStatus: z.enum(['open', 'suspended', 'delisted']),
    buyAllowed: z.boolean(),
    sellAllowed: z.boolean(),
    buyRestriction: z.enum(['none', 'limit-up', 'suspended', 'delisted']),
    sellRestriction: z.enum(['none', 'limit-down', 'suspended', 'delisted']),
    corporateActionsStatus: z.enum(['complete', 'unavailable']),
    corporateActions: z.array(StrictBacktestCorporateActionSchema),
    source: z.string().min(1),
    recordedAt: z.coerce.date(),
    contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .superRefine((fact, ctx) => {
    if (fact.rawLow > fact.rawHigh) {
      ctx.addIssue({ code: 'custom', path: ['rawLow'], message: 'rawLow 不能大于 rawHigh' });
    }
    if (
      fact.rawOpen < fact.rawLow ||
      fact.rawOpen > fact.rawHigh ||
      fact.rawClose < fact.rawLow ||
      fact.rawClose > fact.rawHigh
    ) {
      ctx.addIssue({ code: 'custom', path: ['rawOpen'], message: 'OHLC 必须位于 high/low 区间' });
    }
    if (fact.sessionStatus !== 'open' && (fact.buyAllowed || fact.sellAllowed)) {
      ctx.addIssue({
        code: 'custom',
        path: ['sessionStatus'],
        message: '非开市状态不得标记可买卖',
      });
    }
    if (fact.buyAllowed !== (fact.buyRestriction === 'none')) {
      ctx.addIssue({ code: 'custom', path: ['buyAllowed'], message: 'buy restriction 不一致' });
    }
    if (fact.sellAllowed !== (fact.sellRestriction === 'none')) {
      ctx.addIssue({ code: 'custom', path: ['sellAllowed'], message: 'sell restriction 不一致' });
    }
    if (fact.corporateActionsStatus === 'unavailable' && fact.corporateActions.length > 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['corporateActions'],
        message: '公司行动不可用时不得携带部分推断 action',
      });
    }
  });
export type StrictBacktestMarketFact = z.infer<typeof StrictBacktestMarketFactSchema>;

export const StrictBacktestTradeSchema = z.object({
  date: z.coerce.date(),
  stockId: z.string().min(1),
  side: z.enum(['buy', 'sell']),
  quantity: z.number().int().positive(),
  executionPrice: z.number().positive().finite(),
  notional: z.number().positive().finite(),
  fees: z.number().nonnegative().finite(),
});
export type StrictBacktestTrade = z.infer<typeof StrictBacktestTradeSchema>;

export const StrictBacktestMetricsSchema = z.object({
  modelVersion: z.literal(STRICT_BACKTEST_MODEL_VERSION),
  initialEquity: z.number().positive().finite(),
  finalEquity: z.number().nonnegative().finite(),
  netReturnPct: z.number().finite(),
  maxDrawdownPct: z.number().nonnegative().finite(),
  benchmarkReturnPct: z.number().finite(),
  excessReturnPct: z.number().finite(),
  turnoverPct: z.number().nonnegative().finite(),
  tradeCount: z.number().int().nonnegative(),
  equityCurve: z.array(
    z.object({
      date: z.coerce.date(),
      equity: z.number().nonnegative().finite(),
      cash: z.number().finite(),
    }),
  ),
  trades: z.array(StrictBacktestTradeSchema),
});
export type StrictBacktestMetrics = z.infer<typeof StrictBacktestMetricsSchema>;

export const StrictBacktestRunSchema = z
  .object({
    id: z.string().min(1),
    status: z.enum(['queued', 'running', 'complete', 'failed']),
    resultAvailability: StrictBacktestAvailabilitySchema,
    spec: StrictBacktestSpecSchema,
    specHash: z.string().regex(/^[a-f0-9]{64}$/),
    inputFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    evaluator: StrategyEvaluatorIdentitySchema,
    gateAudit: StrictBacktestGateAuditSchema,
    metrics: StrictBacktestMetricsSchema.optional(),
    /** 结果旁边必须能看到的已知缺口（分红送转、ST 派生依据等）。 */
    limitations: z.array(z.string().min(1)).optional(),
    error: z.string().min(1).optional(),
    createdAt: z.coerce.date(),
    startedAt: z.coerce.date().optional(),
    finishedAt: z.coerce.date().optional(),
  })
  .superRefine((run, ctx) => {
    if (run.specHash !== strictBacktestSpecHash(run.spec)) {
      ctx.addIssue({ code: 'custom', path: ['specHash'], message: 'specHash 不匹配' });
    }
    if (run.resultAvailability !== run.gateAudit.status && run.metrics === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['resultAvailability'],
        message: '无 metrics 时 resultAvailability 必须等于 gate audit',
      });
    }
    if (run.metrics !== undefined && run.resultAvailability !== 'complete') {
      ctx.addIssue({
        code: 'custom',
        path: ['metrics'],
        message: '只有 complete 才能保存 metrics',
      });
    }
    if (
      run.status === 'complete' &&
      run.resultAvailability === 'complete' &&
      run.metrics === undefined
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['metrics'],
        message: 'complete backtest 必须有 metrics',
      });
    }
    if (run.status === 'failed' && run.error === undefined) {
      ctx.addIssue({ code: 'custom', path: ['error'], message: 'failed backtest 必须有 error' });
    }
    if ((run.status === 'complete' || run.status === 'failed') !== (run.finishedAt !== undefined)) {
      ctx.addIssue({ code: 'custom', path: ['finishedAt'], message: '终态与 finishedAt 不一致' });
    }
  });
export type StrictBacktestRun = z.infer<typeof StrictBacktestRunSchema>;

const canonicalize = (value: unknown): unknown => {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value;
};

export const strictBacktestHash = (value: unknown): string =>
  createHash('sha256')
    .update(JSON.stringify(canonicalize(value)))
    .digest('hex');

export const strictBacktestSpecHash = (spec: StrictBacktestSpec): string =>
  strictBacktestHash(StrictBacktestSpecSchema.parse(spec));

export const assertStrictBacktestRunInvariants = (run: StrictBacktestRun): void => {
  const parsed = StrictBacktestRunSchema.safeParse(run);
  if (!parsed.success) throw new InvariantError(parsed.error.issues[0]?.message ?? 'backtest 无效');
};
