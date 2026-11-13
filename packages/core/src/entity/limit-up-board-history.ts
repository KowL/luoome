import { z } from 'zod';

import { SourceIdSchema } from '../source.js';

/**
 * 炸板 / 断板历史事实（docs/ddd/limit-up-ladder-detailed-design.md §"炸板 / 断板历史语义"）。
 *
 * 语义冻结：
 * - `isBroken(D)`：当日触及涨停但收盘未封板；开板后回封不算炸板；
 * - `consecutiveBoard(D)`：D 开盘前已经成立的连续封板高度（上一交易日封板高度）；
 * - `isBoardBreak(D)`：`consecutiveBoard(D) >= 1 && !closedAtUpperLimit(D)`。
 *
 * 任何必要输入缺失时对应字段为 `null`（unknown），不得写 `false` 或 `0`。
 */

const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日期必须为 YYYY-MM-DD');

export const LimitUpBoardHistoryFactSchema = z.object({
  /** 带交易所后缀的标准代码，例如 `600000.SH`。 */
  stockId: z.string().regex(/^\d{6}\.(SH|SZ)$/),
  isBroken: z.boolean().nullable(),
  consecutiveBoard: z.number().int().min(0).max(50).nullable(),
  isBoardBreak: z.boolean().nullable(),
  /** 该股票事实缺失的必要输入，例如 `previous-sealed`。 */
  missingFields: z.array(z.string().min(1).max(40)).max(10),
});

export type LimitUpBoardHistoryFact = z.infer<typeof LimitUpBoardHistoryFactSchema>;

export const LimitUpBoardHistorySchema = z.object({
  tradeDate: dateString,
  source: SourceIdSchema,
  coverage: z.literal('CN_A_SHARES_SH_SZ'),
  status: z.enum(['complete', 'partial', 'unavailable']),
  /** 上游数据就绪时间；缺失时回退到 fetchedAt。 */
  dataAsOf: z.coerce.date(),
  publishedAt: z.coerce.date(),
  fetchedAt: z.coerce.date(),
  /** captured = 当日采集；backfill = 事后补采，不能假装成当日 PIT 证据。 */
  vintage: z.enum(['captured', 'backfill']),
  facts: z.array(LimitUpBoardHistoryFactSchema),
  missingFields: z.array(z.string().min(1).max(40)).max(20),
  warnings: z.array(z.string().min(1).max(300)).max(20),
  recordedAt: z.coerce.date(),
});

export type LimitUpBoardHistory = z.infer<typeof LimitUpBoardHistorySchema>;

/** 涨停 / 炸板池的一行；`continueDayCnt` 只对涨停池有意义（含当日）。 */
export interface LimitUpBoardPoolRow {
  readonly stockId: string;
  readonly continueDayCnt?: number | undefined;
}

export interface DeriveLimitUpBoardHistoryInput {
  readonly tradeDate: string;
  readonly source: string;
  readonly dataAsOf: Date;
  readonly publishedAt: Date;
  readonly fetchedAt: Date;
  readonly vintage: 'captured' | 'backfill';
  readonly recordedAt: Date;
  /** null = 当日涨停池拉取失败，无法判断任何股票是否封板。 */
  readonly sealed: readonly LimitUpBoardPoolRow[] | null;
  /** null = 炸板池拉取失败；空数组表示明确没有炸板。 */
  readonly broken: readonly string[] | null;
  /** null = 上一交易日涨停池缺失，`consecutiveBoard` / `isBoardBreak` 为 unknown。 */
  readonly previousSealed: readonly LimitUpBoardPoolRow[] | null;
  readonly warnings?: readonly string[];
}

const unique = (values: readonly string[]): string[] => [...new Set(values)];

/**
 * 从当日涨停池 / 炸板池 / 上一交易日涨停池派生逐股事实。
 *
 * 不使用涨跌幅阈值或 qfq 日线：封板与触板事实只来自上游池成员关系，避免不同价格口径混算。
 */
export const deriveLimitUpBoardHistory = (
  input: DeriveLimitUpBoardHistoryInput,
): LimitUpBoardHistory => {
  const warnings = [...(input.warnings ?? [])];
  if (input.sealed === null) {
    return LimitUpBoardHistorySchema.parse({
      tradeDate: input.tradeDate,
      source: input.source,
      coverage: 'CN_A_SHARES_SH_SZ',
      status: 'unavailable',
      dataAsOf: input.dataAsOf,
      publishedAt: input.publishedAt,
      fetchedAt: input.fetchedAt,
      vintage: input.vintage,
      facts: [],
      missingFields: ['limit-up-pool'],
      warnings: [...warnings, '当日涨停池不可用，无法判断封板/炸板/断板'],
      recordedAt: input.recordedAt,
    });
  }

  const sealed = new Map(input.sealed.map((row) => [row.stockId, row] as const));
  const previous =
    input.previousSealed === null
      ? null
      : new Map(input.previousSealed.map((row) => [row.stockId, row] as const));
  const broken = input.broken === null ? null : new Set(input.broken);

  const codes = unique([
    ...sealed.keys(),
    ...(broken === null ? [] : [...broken]),
    ...(previous === null ? [] : [...previous.keys()]),
  ]).sort();

  const facts: LimitUpBoardHistoryFact[] = codes.map((stockId) => {
    const closed = sealed.has(stockId);
    const missingFields: string[] = [];
    let isBroken: boolean | null;
    if (closed) {
      isBroken = false;
    } else if (broken === null) {
      isBroken = null;
      missingFields.push('limit-break-pool');
    } else {
      isBroken = broken.has(stockId);
    }

    let consecutiveBoard: number | null;
    if (previous === null) {
      consecutiveBoard = null;
      missingFields.push('previous-sealed');
    } else {
      consecutiveBoard = previous.get(stockId)?.continueDayCnt ?? 0;
    }

    const isBoardBreak =
      closed || consecutiveBoard === null ? (closed ? false : null) : consecutiveBoard >= 1;
    return { stockId, isBroken, consecutiveBoard, isBoardBreak, missingFields };
  });

  const missingFields = unique(facts.flatMap((fact) => fact.missingFields));
  const status = missingFields.length === 0 ? 'complete' : 'partial';

  return LimitUpBoardHistorySchema.parse({
    tradeDate: input.tradeDate,
    source: input.source,
    coverage: 'CN_A_SHARES_SH_SZ',
    status,
    dataAsOf: input.dataAsOf,
    publishedAt: input.publishedAt,
    fetchedAt: input.fetchedAt,
    vintage: input.vintage,
    facts,
    missingFields,
    warnings,
    recordedAt: input.recordedAt,
  });
};

/** 读取单个股票的当日事实；不存在返回 null。 */
export const findBoardHistoryFact = (
  history: LimitUpBoardHistory,
  stockId: string,
): LimitUpBoardHistoryFact | null => history.facts.find((fact) => fact.stockId === stockId) ?? null;
