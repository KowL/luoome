import { z } from 'zod';

import { InvariantError } from '../error/index.js';
import { SourceIdSchema } from '../source.js';

/**
 * 涨停市场看板实体（涨停池 + 涨停统计 + 近 30 日连板矩阵）。
 *
 * 与 `limit-up-ladder.ts` 的分工：那边是「单一交易日、逐股可落位」的连板天梯快照；
 * 这里是上游「涨停市场」三个端点的聚合读模型，为复盘看板服务：
 * - `pool`：所选交易日的涨停池逐股明细（含封单额、开板次数、涨停原因原文）
 * - `statistics`：同一交易日的封板率 / 开板家数 / 板位档位与晋级率
 * - `ladder`：**与所选日期解耦**的近 N 个交易日连板矩阵（接口固定窗口，无日期入参）
 *
 * 设计要点：
 * - 三个维度独立可达：某维上游失败时该维为 null 并进 `warnings`，不拖垮整张看板；
 *   缺数据一律 null，绝不用 0 冒充（天梯 board_caps 是展示高度，不等于真实家数）
 * - 「涨停家数」等口径取 pool 计数、「封板率」取 statistics，两个口径可能不一致（统计基数
 *   是触板家数），因此分别保留字段，由 UI 明示口径，不在 core 里互相覆盖
 * - 天梯板位固定 6 档（2/3/4/5/6/7+ 板），`boardNum` 由上游逐股给出，不按档位反推
 */

const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日期必须为 YYYY-MM-DD');
const code6 = z.string().regex(/^\d{6}$/, '代码必须为 6 位数字');
const stockIdSchema = z.string().regex(/^\d{6}\.(SH|SZ)$/, 'stockId 必须为 XXXXXX.SH|SZ');
const hhmm = z.string().regex(/^\d{2}:\d{2}$/, '时间必须为 HH:MM');

// ---------- 涨停池 ----------

export const LimitUpPoolEntrySchema = z.object({
  stockId: stockIdSchema,
  code: code6,
  name: z.string(),
  isSt: z.boolean(),
  /** 未开板新股；仅展示，不参与筛选。 */
  isNew: z.boolean(),
  /** 最新价；停牌 / 盘前缺失时为 null。 */
  price: z.number().positive().nullable(),
  /** 涨跌幅小数（0.10 = 10%）；页面须以 % 展示。 */
  changePct: z.number().min(-0.35).max(0.35).nullable(),
  /** 首次涨停时间 HH:MM；上游缺失为 null。 */
  limitUpTime: hhmm.nullable(),
  /** 开板次数；上游缺失为 null（不按 0 处理）。 */
  openTimes: z.number().int().nonnegative().nullable(),
  /** 涨停原因原文（上游可能为多概念拼接）；缺失为 null，不做改写。 */
  reason: z.string().nullable(),
  /** 上游连板文本，例如「首板」「5天4板」。 */
  continueDayText: z.string(),
  /** 连板计数（含当日）：1 = 首板。 */
  continueDayCnt: z.number().int().min(1).max(50),
  /** 当前封单额（元）。 */
  sealMoney: z.number().nonnegative(),
  /** 峰值封单额（元）；与 sealMoney 共同派生封单留存。 */
  maxSealMoney: z.number().nonnegative(),
});

export type LimitUpPoolEntry = z.infer<typeof LimitUpPoolEntrySchema>;

// ---------- 涨停统计 ----------

/** 页面板数档位；five_plus 为上游合并档位（精确家数见 exactBoards）。 */
export const LimitUpPageBoardLevelSchema = z.enum(['one', 'two', 'three', 'four', 'five_plus']);
export type LimitUpPageBoardLevel = z.infer<typeof LimitUpPageBoardLevelSchema>;

export const LimitUpPageBoardSchema = z.object({
  level: LimitUpPageBoardLevelSchema,
  stockCount: z.number().int().nonnegative(),
  /** 档位晋级率小数；one 档与无样本时为 null。 */
  promotionRate: z.number().min(0).max(1).nullable(),
});

export const LimitUpExactBoardSchema = z.object({
  /** 恰好 N 板；上游只返回实际出现的板数（N >= 2）。 */
  boardNum: z.number().int().min(2),
  stockCount: z.number().int().nonnegative(),
});

export const LimitUpMarketStatisticsSchema = z.object({
  tradeDate: dateString,
  /** 封板率小数（0.647 = 64.7%）；上游无有效值时为 null。 */
  sealRate: z.number().min(0).max(1).nullable(),
  /** 涨停打开家数。 */
  openStockCount: z.number().int().nonnegative(),
  /** 封板汇总家数（与封板率同一口径）。 */
  limitUpStockCount: z.number().int().nonnegative(),
  /** 封板率的汇总基数（触板家数）。 */
  touchedLimitUpStockCount: z.number().int().nonnegative(),
  pageBoards: z.array(LimitUpPageBoardSchema),
  exactBoards: z.array(LimitUpExactBoardSchema),
});

export type LimitUpMarketStatistics = z.infer<typeof LimitUpMarketStatisticsSchema>;

// ---------- 近 30 日连板矩阵 ----------

/** 天梯板位档：two = 2 板 … seven_plus = 7 板及以上（上游 seven_over）。 */
export const LimitUpLadderBandSchema = z.enum([
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven_plus',
]);
export type LimitUpLadderBand = z.infer<typeof LimitUpLadderBandSchema>;

/** 矩阵固定顺序（低板位在前，便于按行渲染）。 */
export const LIMIT_UP_LADDER_BANDS: readonly LimitUpLadderBand[] = [
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven_plus',
];

/** 档位 → 起始板数；seven_plus 记 7（真实板数以逐股 boardNum 为准）。 */
const BAND_LEVEL: Readonly<Record<LimitUpLadderBand, number>> = {
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven_plus: 7,
};

export const limitUpLadderBandLabel = (band: LimitUpLadderBand): string =>
  band === 'seven_plus' ? '7 板及以上' : `${BAND_LEVEL[band]} 板`;

export const LimitUpLadderMatrixStockSchema = z.object({
  stockId: stockIdSchema,
  code: code6,
  name: z.string(),
  /** 连板数（上游逐股给出；seven_plus 档可能是 7、8、11…）。 */
  boardNum: z.number().int().min(2),
  /** 次一交易日是否继续封板；最近交易日无次日参考，固定 null。 */
  sealedNextDay: z.boolean().nullable(),
});

export type LimitUpLadderMatrixStock = z.infer<typeof LimitUpLadderMatrixStockSchema>;

export const LimitUpLadderMatrixBandSchema = z.object({
  band: LimitUpLadderBandSchema,
  stocks: z.array(LimitUpLadderMatrixStockSchema),
});

export const LimitUpLadderMatrixDaySchema = z.object({
  date: dateString,
  /** 固定 6 档、顺序同 LIMIT_UP_LADDER_BANDS；上游缺失的板位补空数组。 */
  bands: z.array(LimitUpLadderMatrixBandSchema),
});

export type LimitUpLadderMatrixDay = z.infer<typeof LimitUpLadderMatrixDaySchema>;

export const LimitUpLadderWindowSchema = z.object({
  /** 窗口交易日数（上游固定 30）。 */
  length: z.number().int().positive(),
  /** 窗口内交易日，按上游返回顺序（新 → 旧）。 */
  dateList: z.array(dateString),
  /** 板位展示高度元信息；股票列表完整返回，条数可大于此值。 */
  boardCaps: z.record(LimitUpLadderBandSchema, z.number().int().nonnegative()),
  days: z.array(LimitUpLadderMatrixDaySchema),
});

export type LimitUpLadderWindow = z.infer<typeof LimitUpLadderWindowSchema>;

// ---------- 聚合快照 ----------

export const LimitUpMarketSnapshotSchema = z.object({
  /** 请求的交易日；ladder 窗口不随它变化。 */
  date: dateString,
  source: SourceIdSchema,
  /** 本地拉取完成时刻。 */
  asOf: z.coerce.date(),
  /** 上游给出的数据就绪时刻（三个端点取最大）；上游全缺时为 null。 */
  dataAsOf: z.coerce.date().nullable(),
  /** 涨停池；上游失败为 null。 */
  pool: z
    .object({
      total: z.number().int().nonnegative(),
      entries: z.array(LimitUpPoolEntrySchema),
    })
    .nullable(),
  /** 涨停统计；上游失败为 null。 */
  statistics: LimitUpMarketStatisticsSchema.nullable(),
  /** 近 N 日连板矩阵；上游失败为 null。 */
  ladder: LimitUpLadderWindowSchema.nullable(),
  /** 数据缺口与口径提示（机器可读 token）。 */
  warnings: z.array(z.string()),
});

export type LimitUpMarketSnapshot = z.infer<typeof LimitUpMarketSnapshotSchema>;

export const LimitUpMarketQuerySchema = z.object({
  /** 交易日 YYYY-MM-DD；涨停池与统计按它取数。单源 fuyao，故不开放 source 覆盖。 */
  date: dateString,
});

export type LimitUpMarketQuery = z.infer<typeof LimitUpMarketQuerySchema>;

// ---------- 派生口径 ----------

/**
 * 看板 KPI 的派生值。全部由上游字段直接聚合，不含任何推断或补值。
 *
 * `sealRate` / `openCount` 来自 statistics（基数是触板家数），
 * `poolCount` / `consecutiveCount` / `sealAmount` 来自 pool，
 * 两者口径不同，UI 必须分别标注，不能互相替代。
 */
export const LimitUpMarketMetricsSchema = z.object({
  poolCount: z.number().int().nonnegative(),
  consecutiveCount: z.number().int().nonnegative(),
  maxBoard: z.number().int().nonnegative(),
  sealAmount: z.number().nonnegative(),
  maxSealAmount: z.number().nonnegative(),
  sealRetentionRate: z.number().min(0).max(1).nullable(),
  earlySealRate: z.number().min(0).max(1).nullable(),
  sealRate: z.number().min(0).max(1).nullable(),
  openCount: z.number().int().nonnegative().nullable(),
});

export interface LimitUpMarketMetrics {
  /** 涨停池条数。 */
  readonly poolCount: number;
  /** 连板只数（continueDayCnt >= 2）。 */
  readonly consecutiveCount: number;
  /** 涨停池最大连板数；空池 = 0。 */
  readonly maxBoard: number;
  /** 封单额合计（元）。 */
  readonly sealAmount: number;
  /** 峰值封单额合计（元）。 */
  readonly maxSealAmount: number;
  /** 封单留存 = sealAmount / maxSealAmount；分母为 0 → null。 */
  readonly sealRetentionRate: number | null;
  /** 早封率 = 10:00 前（含）封板只数 / 有时间的只数；样本 0 → null。 */
  readonly earlySealRate: number | null;
  /** 封板率（statistics）；缺统计 → null。 */
  readonly sealRate: number | null;
  /** 涨停打开家数（statistics）；缺统计 → null。 */
  readonly openCount: number | null;
}

const EARLY_SEAL_CUTOFF = '10:00';

export const deriveLimitUpMarketMetrics = (
  snapshot: Pick<LimitUpMarketSnapshot, 'pool' | 'statistics'>,
): LimitUpMarketMetrics => {
  const entries = snapshot.pool?.entries ?? [];
  const timed = entries.filter((entry) => entry.limitUpTime !== null);
  const early = timed.filter((entry) => (entry.limitUpTime as string) <= EARLY_SEAL_CUTOFF);
  const sealAmount = entries.reduce((sum, entry) => sum + entry.sealMoney, 0);
  const maxSealAmount = entries.reduce((sum, entry) => sum + entry.maxSealMoney, 0);
  return {
    poolCount: entries.length,
    consecutiveCount: entries.filter((entry) => entry.continueDayCnt >= 2).length,
    maxBoard: entries.reduce((max, entry) => Math.max(max, entry.continueDayCnt), 0),
    sealAmount,
    maxSealAmount,
    sealRetentionRate: maxSealAmount > 0 ? sealAmount / maxSealAmount : null,
    earlySealRate: timed.length > 0 ? early.length / timed.length : null,
    sealRate: snapshot.statistics?.sealRate ?? null,
    openCount: snapshot.statistics?.openStockCount ?? null,
  };
};

/** 涨停原因分布桶；reason 保持上游原文，不做行业映射。 */
export const LimitUpReasonBucketSchema = z.object({
  reason: z.string(),
  count: z.number().int().positive(),
});

export interface LimitUpReasonBucket {
  readonly reason: string;
  readonly count: number;
}

export const LIMIT_UP_REASON_OTHER = '其他原因';

/**
 * 按 `reason` 原文聚合；无原因的条目归入 `unknownReason` 桶（默认「未披露」）。
 * 返回出现次数降序，超出 `limit` 的桶合并为「其他原因」并排在末尾。
 */
export const deriveReasonDistribution = (
  entries: readonly Pick<LimitUpPoolEntry, 'reason'>[],
  limit = 8,
  unknownReason = '未披露',
): readonly LimitUpReasonBucket[] => {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    const reason = entry.reason;
    const key = reason === null || reason.trim().length === 0 ? unknownReason : reason;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const sorted = [...counts.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason, 'zh-Hans-CN'));
  if (sorted.length <= limit) return sorted;
  const head = sorted.slice(0, limit);
  const rest = sorted.slice(limit).reduce((sum, bucket) => sum + bucket.count, 0);
  return [...head, { reason: LIMIT_UP_REASON_OTHER, count: rest }];
};

// ---------- 看板视图（工具输出） ----------

/**
 * 看板一次取数的完整载荷：事实快照 + 派生 KPI + 原因分布。
 *
 * 派生放在 core（而不是前端）以保证「同一口径只有一处实现」；UI 只负责排版与格式化。
 */
export const LimitUpMarketViewSchema = z.object({
  snapshot: LimitUpMarketSnapshotSchema,
  metrics: LimitUpMarketMetricsSchema,
  reasons: z.array(LimitUpReasonBucketSchema),
});

export type LimitUpMarketView = z.infer<typeof LimitUpMarketViewSchema>;

export const buildLimitUpMarketView = (
  snapshot: LimitUpMarketSnapshot,
  reasonLimit = 8,
): LimitUpMarketView => ({
  snapshot,
  metrics: deriveLimitUpMarketMetrics(snapshot),
  reasons: [...deriveReasonDistribution(snapshot.pool?.entries ?? [], reasonLimit)],
});

// ---------- 不变量 ----------

export const assertLimitUpMarketInvariants = (snapshot: LimitUpMarketSnapshot): void => {
  if (snapshot.pool !== null) {
    const { total, entries } = snapshot.pool;
    if (total < entries.length) {
      throw new InvariantError(`pool.total (${total}) < entries.length (${entries.length})`);
    }
    const seen = new Set<string>();
    for (const entry of entries) {
      if (seen.has(entry.stockId)) {
        throw new InvariantError(`pool 内 stockId 重复：${entry.stockId}`);
      }
      seen.add(entry.stockId);
      if (entry.maxSealMoney < entry.sealMoney) {
        throw new InvariantError(
          `entry.maxSealMoney (${entry.maxSealMoney}) < sealMoney (${entry.sealMoney}) [${entry.stockId}]`,
        );
      }
    }
  }
  if (snapshot.ladder !== null) {
    const { dateList, days } = snapshot.ladder;
    const listed = new Set(dateList);
    for (const day of days) {
      if (!listed.has(day.date)) {
        throw new InvariantError(`ladder.days 含窗口外日期：${day.date}`);
      }
      const present = new Set(day.bands.map((band) => band.band));
      if (present.size !== day.bands.length) {
        throw new InvariantError(`ladder day ${day.date} 板位档重复`);
      }
    }
  }
};
