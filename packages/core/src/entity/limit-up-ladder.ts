import { z } from 'zod';

import { InvariantError } from '../error/index.js';
import { type SourceId, SourceIdSchema } from '../source.js';

/**
 * 连板天梯实体（Phase 1，docs/ddd/limit-up-ladder-detailed-design.md §1）。
 *
 * 设计要点：
 * - 一次天梯快照 = 单一日期 `date` + 单一数据源 `source` + 不可变的 `levels`
 * - `LimitUpLadderEntry` 落位唯一：同一股票在同一日只出现一次（以最深 level 为准，由 adapters 层 `filterAndDedupe` 保证）
 * - 收盘价修正：暴露 `price`（修正后）+ `rawClose`（原始）+ `corrected`（bool 标记）三个独立字段，绝不静默改写
 * - `board` 由 code 前缀派生（与策略预警 §5.2 一致）：主板 / 创业板 / 科创板 / 北交所；科创板与北交所默认被过滤
 * - `uncategorized` 区分两种来源缺失：数据源未给 `level` 字段 / 跨日 reorg 后无法判定
 *
 * manager 的实时返回仍是当前查询入口；生产 scan/scheduled 会把同一份真实结果写入
 * `LimitUpLadderSnapshotRepository`，供历史 replay 按交易日读取。快照不由 replay 现场抓取，
 * 也不把当前快照推断成历史事实。
 */

// ---------- 枚举与基础类型 ----------

/** 板块归属；按 code 前缀派生。 */
export type LimitUpBoard = 'main_board' | 'chinext' | 'star' | 'bse';

export const LimitUpBoardSchema = z.enum(['main_board', 'chinext', 'star', 'bse']);

/**
 * 数据源标识（通用 SourceId；当前仅 eastmoney 公开涨停池注册）。
 * 兼容扩宽：docs/ddd/source-pluggability-and-observation-design.md §4.6。
 */
export type LimitUpLadderSource = SourceId;

export const LimitUpLadderSourceSchema = SourceIdSchema;

/** HH:MM:SS 字符串或 null（null 表示缺数据，不臆造）。 */
const timeStringOrNull = z
  .union([z.string().regex(/^\d{2}:\d{2}:\d{2}$/, '时间必须为 HH:MM:SS'), z.null()])
  .describe('封板时间 HH:MM:SS 或 null');

const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日期必须为 YYYY-MM-DD');

// ---------- 单只股票的快照条目 ----------

export const LimitUpLadderEntrySchema = z.object({
  /** A 股代码 6 位（'600xxx' / '000xxx' / '300xxx'）；不带交易所后缀。 */
  code: z.string().regex(/^\d{6}$/),
  /** 中文名称；缺失时回退到 code（rule 层在 manager 内归一化）。 */
  name: z.string(),
  /** 行业（缺失显示 'unclassified'，哨兵字符串）。 */
  industry: z.string(),
  /** 连板层级 1=首板；同一股票在同一日只入最深 level。 */
  ladderLevel: z.number().int().min(1).max(20),
  /** true = level 来源无法判定（数据源缺字段 / 跨日 reorg）；保留在首板层级。 */
  uncategorized: z.boolean(),
  firstTime: timeStringOrNull,
  finalTime: timeStringOrNull,
  /** 涨停原因摘要；缺失显示 '--'。 */
  reason: z.string(),
  /** 修正后的收盘价；§6.4 触发条件命中时 ≠ rawClose。 */
  price: z.number().positive(),
  /** 数据源返回的原始 close，未经任何修正。 */
  rawClose: z.number().positive(),
  /** 是否经过 §6.4 修正；与 (rawClose, preClose) 涨幅区间匹配时 = true。 */
  corrected: z.boolean(),
  /** 相对昨收的小数（0.10 = 10%）；区间 [-0.35, 0.35] 覆盖北交所 30% + 20cm 涨停的浮点零头（实测 0.2002）。 */
  changePct: z.number().min(-0.35).max(0.35),
  /** YYYY-MM-DD；理论上 == 请求基准日 `date`，否则降级 uncategorized（runtime 校验）。 */
  limitUpDate: dateString,
  board: LimitUpBoardSchema,
});

export type LimitUpLadderEntry = z.infer<typeof LimitUpLadderEntrySchema>;

// ---------- 一层（同一 level 的所有 entry） ----------

export const LimitUpLadderLevelSchema = z.object({
  level: z.number().int().min(1).max(20),
  /** '首板' / 'N 连板'，便于 UI 直接展示。 */
  name: z.string(),
  /** 同层 entry 数（去重后）。 */
  count: z.number().int().nonnegative(),
  stocks: z.array(LimitUpLadderEntrySchema),
});

export type LimitUpLadderLevel = z.infer<typeof LimitUpLadderLevelSchema>;

// ---------- 单日快照 ----------

export const LimitUpLadderSchema = z.object({
  /** 请求方关心的基准日；Asia/Shanghai。 */
  date: dateString,
  /** entry 去重计数（与所有 level 的 stocks 跨层去重值）。 */
  total: z.number().int().nonnegative(),
  /** 所有 entry 的最深 level；空 levels 时 = 0。 */
  maxLevel: z.number().int().nonnegative(),
  source: LimitUpLadderSourceSchema,
  /** 按 level DESC 排列；同 level 内 count DESC。 */
  levels: z.array(LimitUpLadderLevelSchema),
  /** 数据异常/字段缺失提示；非空 ladder 也可能有警告。 */
  warnings: z.array(z.string()),
  /** manager 拉取时间（缓存 key 辅助）。 */
  asOf: z.coerce.date(),
});

export type LimitUpLadder = z.infer<typeof LimitUpLadderSchema>;

// ---------- 对比接口 ----------

export const LimitUpLadderDiffSchema = z.object({
  totalDelta: z.number().int(),
  maxLevelDelta: z.number().int(),
  topLevelAdded: z.array(z.string()),
  topLevelRemoved: z.array(z.string()),
  topLevelRetained: z.array(z.string()),
});

export type LimitUpLadderDiff = z.infer<typeof LimitUpLadderDiffSchema>;

// ---------- 查询参数 ----------

export const LimitUpLadderQuerySchema = z.object({
  date: dateString,
  /** 可选单源路由约束：未传时按配置顺序 fallback；显式传入时只尝试该源（§4.6）。 */
  source: LimitUpLadderSourceSchema.optional(),
  /** 样本窗口（默认 15）；预留给需要历史窗口判定 level 的数据源，eastmoney 涨停池忽略。 */
  days: z.number().int().positive().default(15),
  /** 默认 false；false 时 uncategorized=true 的 entry 不出现。 */
  includeUncategorized: z.boolean().default(false),
  /** 默认 false；true 时允许科创板 688x。 */
  includeStar: z.boolean().default(false),
  /** 默认 false；true 时允许北交所 8/4。 */
  includeBse: z.boolean().default(false),
  /** 默认 false；true 时允许 ST / *ST 股票。 */
  includeST: z.boolean().default(false),
});

export type LimitUpLadderQuery = z.infer<typeof LimitUpLadderQuerySchema>;

export const LimitUpLadderCompareInputSchema = z.object({
  date: dateString,
  prevDate: dateString,
  source: LimitUpLadderSourceSchema.optional(),
  days: z.number().int().positive().default(15),
  includeUncategorized: z.boolean().default(false),
  includeStar: z.boolean().default(false),
  includeBse: z.boolean().default(false),
  includeST: z.boolean().default(false),
});

export type LimitUpLadderCompareInput = z.infer<typeof LimitUpLadderCompareInputSchema>;

export const LimitUpLadderCompareOutputSchema = z.object({
  curr: LimitUpLadderSchema,
  prev: LimitUpLadderSchema,
  diff: LimitUpLadderDiffSchema,
});

export type LimitUpLadderCompareOutput = z.infer<typeof LimitUpLadderCompareOutputSchema>;

// ---------- 派生工具：board 判定 ----------

/**
 * 由 code 前缀派生 board。
 * 默认排除：科创板（star）与北交所（bse）—— 调用方按 query 选项决定是否纳入。
 */
export const deriveBoard = (code: string): LimitUpBoard => {
  if (!/^\d{6}$/.test(code)) return 'main_board';
  // 沪市主板 600/601/603/605；深市主板 000/001/002/003
  if (/^(600|601|603|605|000|001|002|003)/.test(code)) return 'main_board';
  // 创业板 300/301
  if (/^(300|301)/.test(code)) return 'chinext';
  // 科创板 688/689
  if (/^(688|689)/.test(code)) return 'star';
  // 北交所 8/4 开头
  if (/^[84]/.test(code)) return 'bse';
  return 'main_board';
};

/**
 * 是否 ST 股票：中文名称前缀为 "ST" 或 "*ST"。
 * 与策略预警产品文档 §5.2 一致；只判前缀，不接英文 / 异形缩写。
 */
export const isSTName = (name: string): boolean => /^(\*?ST)/.test(name);

const BOARD_SENTINEL = 'unclassified';
const TIME_MISSING = '--';
const REASON_MISSING = '--';

/** entry 缺字段哨兵：name → code；industry → 'unclassified'；time → null；reason → '--'。 */
export const normalizeEntryMissingFields = (raw: LimitUpLadderEntry): LimitUpLadderEntry => ({
  ...raw,
  name: raw.name.trim().length > 0 ? raw.name : raw.code,
  industry: raw.industry.trim().length > 0 ? raw.industry : BOARD_SENTINEL,
  reason: raw.reason.trim().length > 0 ? raw.reason : REASON_MISSING,
});

/**
 * 过滤 + 去重：按 query 选项过滤股票（科创 / 北交所 / ST），同一 code 只保留 ladderLevel 最深的 entry。
 * 接受的 entries 假设已通过 Zod 校验。
 */
export const filterAndDedupeEntries = (
  entries: readonly LimitUpLadderEntry[],
  query: Pick<LimitUpLadderQuery, 'includeStar' | 'includeBse' | 'includeST'>,
): LimitUpLadderEntry[] => {
  const filtered = entries.filter((e) => {
    if (e.board === 'star' && !query.includeStar) return false;
    if (e.board === 'bse' && !query.includeBse) return false;
    if (isSTName(e.name) && !query.includeST) return false;
    return true;
  });
  // 同 code 最深 level 优先；同 level 时 changePct 高的优先（保证稳定排序，便于缓存命中比较）。
  const byCode = new Map<string, LimitUpLadderEntry>();
  for (const e of filtered) {
    const cur = byCode.get(e.code);
    if (
      cur === undefined ||
      e.ladderLevel > cur.ladderLevel ||
      (e.ladderLevel === cur.ladderLevel && e.changePct > cur.changePct)
    ) {
      byCode.set(e.code, e);
    }
  }
  return [...byCode.values()];
};

/**
 * 把过滤去重后的 entries 按 level DESC + 同 level count DESC 组装成 LimitUpLadder。
 * 这是 manager 内部「组装最终快照」的核心步骤。
 */
export const assembleLadder = (
  date: string,
  source: LimitUpLadderSource,
  entries: readonly LimitUpLadderEntry[],
  warnings: readonly string[],
  asOf: Date,
): LimitUpLadder => {
  const sortedDescending = [...entries].sort((a, b) => {
    if (b.ladderLevel !== a.ladderLevel) return b.ladderLevel - a.ladderLevel;
    return b.changePct - a.changePct;
  });
  const buckets = new Map<number, LimitUpLadderEntry[]>();
  for (const e of sortedDescending) {
    const list = buckets.get(e.ladderLevel) ?? [];
    list.push(e);
    buckets.set(e.ladderLevel, list);
  }
  const levels: LimitUpLadderLevel[] = [...buckets.entries()]
    .sort(([la], [lb]) => lb - la)
    .map(([level, stocks]) => ({
      level,
      name: level === 1 ? '首板' : `${level} 连板`,
      count: stocks.length,
      stocks,
    }));
  const total = new Set(entries.map((e) => e.code)).size;
  const maxLevel = levels.length === 0 ? 0 : (levels[0]?.level ?? 0);
  return {
    date,
    total,
    maxLevel,
    source,
    levels,
    warnings: [...warnings],
    asOf,
  };
};

/**
 * 顶层 level（最深）成员 diff。
 * 假定 currDate 与 prevDate 各自的 LimitUpLadder 已经过 assertLimitUpLadderInvariants。
 */
export const diffTopLevel = (curr: LimitUpLadder, prev: LimitUpLadder): LimitUpLadderDiff => {
  const currTopCodes = new Set<string>();
  const prevTopCodes = new Set<string>();
  const firstCurr = curr.levels[0];
  const firstPrev = prev.levels[0];
  if (firstCurr !== undefined) for (const s of firstCurr.stocks) currTopCodes.add(s.code);
  if (firstPrev !== undefined) for (const s of firstPrev.stocks) prevTopCodes.add(s.code);
  const added: string[] = [];
  const removed: string[] = [];
  const retained: string[] = [];
  for (const code of currTopCodes) {
    if (prevTopCodes.has(code)) retained.push(code);
    else added.push(code);
  }
  for (const code of prevTopCodes) {
    if (!currTopCodes.has(code)) removed.push(code);
  }
  return {
    totalDelta: curr.total - prev.total,
    maxLevelDelta: curr.maxLevel - prev.maxLevel,
    topLevelAdded: added.sort(),
    topLevelRemoved: removed.sort(),
    topLevelRetained: retained.sort(),
  };
};

// ---------- 下游消费者便捷函数 ----------

/**
 * 把天梯快照映射成 `code → ladderLevel` 查询表（Phase 2 替换 ruo 旧 `refreshTop10` 的 `code→level` 输入）。
 *
 * 用法：未来 Watchlist / AlertPlan / strategy-alert 规则把 `ladderLevel` 作为 ranking 信号时，
 * 调一次本函数缓存 map，不再每次 `limit_up_ladder` 重新组装。
 *
 * 注意：若 ladder 为空（含 warnings=non-trading-day）→ 返回空 Map，由调用方决定 fallback 策略。
 */
export const codeToLevelMap = (ladder: LimitUpLadder): ReadonlyMap<string, number> => {
  const map = new Map<string, number>();
  for (const lv of ladder.levels) {
    for (const s of lv.stocks) {
      const cur = map.get(s.code);
      if (cur === undefined || s.ladderLevel > cur) {
        map.set(s.code, s.ladderLevel);
      }
    }
  }
  return map;
};

/**
 * 反向工具：把 `code → ladderLevel` 查询表与持仓 / 自选股票列表对齐，
 * 返回每只股票的连板层级 + 缺数据哨兵（用于 ranking / 评分输入）。
 */
export interface CodeLevelRow {
  readonly code: string;
  readonly level: number;
  readonly present: boolean;
}
export const lookupLevels = (
  codes: readonly string[],
  levels: ReadonlyMap<string, number>,
): readonly CodeLevelRow[] =>
  codes.map((code) => {
    const level = levels.get(code);
    return level === undefined
      ? { code, level: 0, present: false }
      : { code, level, present: true };
  });

// ---------- 不变量 ----------

/**
 * 设计文档 §1 不变量：
 * - 单 entry：changePct ∈ [-0.35, 0.35]（北交所 30% + 20cm 浮点零头）、price > 0、rawClose > 0、firstTime/finalTime 为 null 或 HH:MM:SS
 * - 单 entry：limitUpDate 与请求基准日 `date` 应一致；不一致时 entry 降级为 uncategorized=true（manager 侧处理）
 * - 总 total = 各 levels[].stocks[].code 去重计数
 * - maxLevel = levels[0]?.level ?? 0
 * - levels 内按 level DESC + 同 level count DESC 排列
 */
export const assertLimitUpLadderInvariants = (h: LimitUpLadder, baseDate?: string): void => {
  if (h.total < 0 || !Number.isInteger(h.total)) {
    throw new InvariantError(`total 必须为非负整数，实际 ${h.total}`);
  }
  if (h.maxLevel < 0 || !Number.isInteger(h.maxLevel)) {
    throw new InvariantError(`maxLevel 必须为非负整数，实际 ${h.maxLevel}`);
  }
  for (const lv of h.levels) {
    if (lv.count !== lv.stocks.length) {
      throw new InvariantError(
        `level ${lv.level}: count (${lv.count}) !== stocks.length (${lv.stocks.length})`,
      );
    }
    if (lv.level < 1 || !Number.isInteger(lv.level)) {
      throw new InvariantError(`level 必须为正整数，实际 ${lv.level}`);
    }
    for (const e of lv.stocks) {
      if (e.changePct < -0.35 || e.changePct > 0.35) {
        throw new InvariantError(`entry.changePct 越界 [${e.code}] = ${e.changePct}`);
      }
      if (e.price <= 0) throw new InvariantError(`entry.price 必须 > 0 [${e.code}]`);
      if (e.rawClose <= 0) throw new InvariantError(`entry.rawClose 必须 > 0 [${e.code}]`);
      if (baseDate !== undefined && e.limitUpDate !== baseDate) {
        throw new InvariantError(
          `entry.limitUpDate (${e.limitUpDate}) != date (${baseDate}) [${e.code}]`,
        );
      }
    }
  }
  // total = levels 跨层去重数（schema 内 manager 已 dedupe；这里再验证一遍）
  const uniq = new Set<string>();
  for (const lv of h.levels) for (const s of lv.stocks) uniq.add(s.code);
  if (uniq.size !== h.total) {
    throw new InvariantError(`total (${h.total}) != 去重 entry 数 (${uniq.size})`);
  }
  // maxLevel 与 levels[0]?.level 必须一致
  const expectedMax = h.levels[0]?.level ?? 0;
  if (expectedMax !== h.maxLevel) {
    throw new InvariantError(`maxLevel (${h.maxLevel}) != levels[0].level (${expectedMax})`);
  }
};

// 暴露哨兵常量给 UI 与 CLI 模块使用，避免硬编码字符串散落多处
export const LimitUpLadderSentinels = {
  BOARD_UNCLASSIFIED: BOARD_SENTINEL,
  TIME_MISSING,
  REASON_MISSING,
} as const;
