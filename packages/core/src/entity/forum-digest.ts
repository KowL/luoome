import { z } from 'zod';

import { InvariantError } from '../error/index.js';
import { dateInShanghai, previousTradingDate } from '../trading-calendar.js';
import { type StockBriefPhase, StockBriefPhaseSchema } from './stock-brief.js';

/**
 * 股吧讨论摘要（ForumDigest）。
 *
 * 回答「这个交易日的候选标的与市场，在公开股票论坛里被怎样讨论」。
 *
 * - 账户无关：讨论是公开事实，不属于某个投资账户，唯一键
 *   `(subjectKind, subjectId, tradingDate, phase)`；
 * - 只存有界摘要（≤5 条摘录、每条 ≤120 字）与派生指标，不建全量 ForumPost 表，
 *   也不引入第三套 CollectionRun；
 * - 关注度（attention）与多空倾向（stance）分开记录：关注度高不等于看多；
 * - 样本不足、作者过度集中或采集失败时 stance 保持 `null`，不合成 0–100 情绪指数，
 *   也不把「没数据」写成 0；
 * - 原帖是不可信外部文本：摘录只做展示与交叉验证，永不当作指令，也不能单独构成
 *   buy/sell 建议（见 docs/ARCHITECTURE.md 与 analyze_stock 判断校验）。
 */

export const FORUM_DIGEST_SUBJECT_KINDS = ['market', 'stock'] as const;
export const ForumDigestSubjectKindSchema = z.enum(FORUM_DIGEST_SUBJECT_KINDS);
export type ForumDigestSubjectKind = z.infer<typeof ForumDigestSubjectKindSchema>;

/** 市场级摘要的固定 subjectId；逐股摘要用 Stock.id。 */
export const FORUM_MARKET_SUBJECT_ID = 'market';

export const FORUM_POST_TYPES = ['user', 'news', 'media', 'other'] as const;
export const ForumPostTypeSchema = z.enum(FORUM_POST_TYPES);
export type ForumPostType = z.infer<typeof ForumPostTypeSchema>;

/** 摘录上限：单条长度与条数都是硬约束（进入提示词与 Web 的同一份数据）。 */
export const FORUM_EXCERPT_MAX_CHARS = 120;
export const FORUM_EXCERPT_LIMIT = 5;
/** 发布 stance 的最低有效样本：用户帖数与独立作者数双门禁。 */
export const FORUM_MIN_EFFECTIVE_POSTS = 8;
export const FORUM_MIN_UNIQUE_AUTHORS = 5;
/** 单一作者占比上限；超过即视为「作者集中」，不发布 stance。 */
export const FORUM_MAX_AUTHOR_SHARE = 0.4;
/** 分歧判定：两个方向都至少达到该占比且各有至少 3 帖。 */
export const FORUM_DIVERGENCE_MIN_SHARE = 0.2;
export const FORUM_DIVERGENCE_MIN_POSTS = 3;
/** 关注度自身历史分位所需的最少历史交易日数。 */
export const FORUM_HISTORY_MIN_SAMPLES = 5;

/** 数据源归一后的帖子样本（协议层 snake_case 由 adapter 负责映射）。 */
export const ForumPostSampleSchema = z.object({
  postId: z.string().trim().min(1),
  title: z.string().trim().min(1),
  /** 正文只用于清洗与倾向判定，不进入摘要（摘录只用标题）。 */
  content: z.string().optional(),
  author: z.string().trim().min(1),
  authorId: z.string().trim().min(1).optional(),
  publishedAt: z.coerce.date(),
  postType: ForumPostTypeSchema,
  clicks: z.number().int().nonnegative().optional(),
  replies: z.number().int().nonnegative().optional(),
  likes: z.number().int().nonnegative().optional(),
  url: z.string().trim().min(1).optional(),
});
export type ForumPostSample = z.infer<typeof ForumPostSampleSchema>;

export const ForumDigestWindowSchema = z
  .object({ start: z.coerce.date(), end: z.coerce.date() })
  .superRefine((window, ctx) => {
    if (window.start.getTime() >= window.end.getTime()) {
      ctx.addIssue({ code: 'custom', path: ['end'], message: 'window.end 必须晚于 start' });
    }
  });
export type ForumDigestWindow = z.infer<typeof ForumDigestWindowSchema>;

/**
 * 采集窗口（Asia/Shanghai）：
 * - post-market：当日 00:00 – 当日 17:30（盘中与盘后批次前讨论）；
 * - premarket：上一交易日 17:30 – 当日 09:15（隔夜与盘前讨论）。
 * 窗口只决定「哪些帖子算当日讨论」，不改变帖子的发布时间本身。
 */
export const forumDigestWindow = (
  tradingDate: string,
  phase: StockBriefPhase,
): ForumDigestWindow => {
  const dayStart = new Date(`${tradingDate}T00:00:00+08:00`);
  if (phase === 'premarket') {
    const prev = previousTradingDate(dayStart);
    return {
      start: new Date(`${prev}T17:30:00+08:00`),
      end: new Date(`${tradingDate}T09:15:00+08:00`),
    };
  }
  if (phase === 'intraday') {
    return {
      start: dayStart,
      end: new Date(`${tradingDate}T15:00:00+08:00`),
    };
  }
  return {
    start: dayStart,
    end: new Date(`${tradingDate}T17:30:00+08:00`),
  };
};

// ---------- 确定性清洗 ----------

/** 导流 / 广告 / 荐股话术；命中即从有效样本剔除，不参与 stance。 */
export const FORUM_PROMOTIONAL_PATTERNS: readonly RegExp[] = [
  /加(?:我|下)?(?:微信|威信|薇信|vx|VX|V信|v信|qq|QQ|扣扣|群|裙)/,
  /(?:微信|威信|vx|VX|V信|QQ|扣扣)(?:号|群)?[：:\s]*[A-Za-z0-9_-]{5,}/,
  /公众号|订阅号|视频号/,
  /私(?:聊|信|我)/,
  /免费诊股|诊股|荐股|带(?:你|大家)?(?:炒|做|赚)|老师带|跟(?:我|老师)(?:买|做)/,
  /(?:领取|获取|加送|赠送).{0,6}(?:指标|礼包|策略|资料|牛股)/,
  /进(?:群|圈)|扫码|二维码|直(?:播|播间)/,
  /(?:开户|佣金|万1|万一点|免五)/,
  /https?:\/\/|www\.[A-Za-z0-9-]+\.[A-Za-z]{2,}/,
  /(?:牛市|涨停板)?交流群/,
];

/** 帖内指令（prompt injection）特征；命中即整条摘录剔除，只计入清洗计数。 */
export const FORUM_INSTRUCTION_PATTERNS: readonly RegExp[] = [
  /忽略(?:之前|以上|前面|全部)(?:的)?(?:指令|提示|要求)/,
  /ignore\s+(?:all\s+|the\s+)?(?:previous|above|prior)\s+(?:instructions?|prompts?)/i,
  /system\s*prompt|系统提示词|系统指令/i,
  /你现在(?:是|扮演)|从现在开始你/,
  /(?:请|必须)?(?:调用|执行)(?:工具|函数|命令)/,
];

const ZERO_WIDTH = /[\u200b-\u200f\u202a-\u202e\u2060\ufeff]/g;
const HTML_TAG = /<[^>]{0,200}>/g;
const URL_IN_TEXT = /https?:\/\/\S+|www\.\S+/gi;

export const isPromotionalForumText = (text: string): boolean =>
  FORUM_PROMOTIONAL_PATTERNS.some((pattern) => pattern.test(text));

export const looksLikeForumInstruction = (text: string): boolean =>
  FORUM_INSTRUCTION_PATTERNS.some((pattern) => pattern.test(text));

/** 控制字符用码点判断（正则字面量里的控制字符会被 lint 拒绝）。 */
const stripControlChars = (text: string): string => {
  let out = '';
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    const control =
      code <= 0x08 ||
      code === 0x0b ||
      code === 0x0c ||
      (code >= 0x0e && code <= 0x1f) ||
      code === 0x7f;
    out += control ? ' ' : char;
  }
  return out;
};

/** 去控制字符 / 零宽字符 / HTML 标签 / URL，压缩空白；不改变语义。 */
export const sanitizeForumText = (text: string): string =>
  stripControlChars(text)
    .replace(ZERO_WIDTH, '')
    .replace(HTML_TAG, ' ')
    .replace(URL_IN_TEXT, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** 摘录：清洗 → 截断到 120 字（含省略号）；空文本返回 null。 */
export const sanitizeForumExcerpt = (text: string): string | null => {
  const cleaned = sanitizeForumText(text);
  if (cleaned.length === 0) return null;
  if (cleaned.length <= FORUM_EXCERPT_MAX_CHARS) return cleaned;
  return `${cleaned.slice(0, FORUM_EXCERPT_MAX_CHARS - 1)}…`;
};

/** 去重键：清洗后去掉标点与空白再取前 60 字，吸收「标题相同 + 表情不同」。 */
export const forumTitleKey = (title: string): string =>
  sanitizeForumText(title)
    .toLowerCase()
    .replace(/[^\p{Script=Han}\p{L}\p{N}]/gu, '')
    .slice(0, 60);

// ---------- 多空倾向（确定性词表，不是情绪指数） ----------

export const FORUM_BULLISH_TOKENS: readonly string[] = [
  '看多',
  '做多',
  '加仓',
  '补仓',
  '满仓',
  '买入',
  '抄底',
  '低吸',
  '上车',
  '起飞',
  '拉升',
  '突破',
  '新高',
  '涨停',
  '主升',
  '强势',
  '反弹',
  '翻倍',
  '牛市',
  '干进去',
];

export const FORUM_BEARISH_TOKENS: readonly string[] = [
  '看空',
  '做空',
  '减仓',
  '清仓',
  '卖出',
  '割肉',
  '止损',
  '跑路',
  '出货',
  '砸盘',
  '跳水',
  '暴跌',
  '跌停',
  '破位',
  '新低',
  '弱势',
  '套牢',
  '熊市',
  '崩了',
  '高位',
];

export type ForumStanceDirection = 'bullish' | 'bearish' | 'divided' | 'neutral';

const countTokens = (text: string, tokens: readonly string[]): number =>
  tokens.reduce((sum, token) => (text.includes(token) ? sum + 1 : sum), 0);

/** 单帖倾向：牛词多于熊词 → bullish，反之 bearish；两者都有或都没有 → neutral。 */
export const classifyForumStance = (text: string): 'bullish' | 'bearish' | 'neutral' => {
  const bullish = countTokens(text, FORUM_BULLISH_TOKENS);
  const bearish = countTokens(text, FORUM_BEARISH_TOKENS);
  if (bullish > bearish) return 'bullish';
  if (bearish > bullish) return 'bearish';
  return 'neutral';
};

export const ForumDigestStanceSchema = z
  .object({
    direction: z.enum(['bullish', 'bearish', 'divided', 'neutral']),
    bullish: z.number().int().nonnegative(),
    bearish: z.number().int().nonnegative(),
    neutral: z.number().int().nonnegative(),
    classified: z.number().int().nonnegative(),
    bullishShare: z.number().min(0).max(1),
    bearishShare: z.number().min(0).max(1),
    divergence: z.boolean(),
  })
  .superRefine((stance, ctx) => {
    if (stance.classified !== stance.bullish + stance.bearish + stance.neutral) {
      ctx.addIssue({
        code: 'custom',
        path: ['classified'],
        message: 'classified 必须等于三类之和',
      });
    }
    if (stance.classified === 0) {
      ctx.addIssue({ code: 'custom', path: ['classified'], message: 'classified 不能为 0' });
    }
    const expectedBullish = stance.bullish / Math.max(1, stance.classified);
    const expectedBearish = stance.bearish / Math.max(1, stance.classified);
    if (Math.abs(stance.bullishShare - expectedBullish) > 1e-9) {
      ctx.addIssue({
        code: 'custom',
        path: ['bullishShare'],
        message: 'bullishShare 与计数不一致',
      });
    }
    if (Math.abs(stance.bearishShare - expectedBearish) > 1e-9) {
      ctx.addIssue({
        code: 'custom',
        path: ['bearishShare'],
        message: 'bearishShare 与计数不一致',
      });
    }
  });
export type ForumDigestStance = z.infer<typeof ForumDigestStanceSchema>;

// ---------- 关注度 ----------

export const ForumDigestPopularitySchema = z.object({
  /** 东方财富人气榜排名（1 = 最高）。 */
  rank: z.number().int().positive(),
  /** 上游给出的排名变化（正数表示名次上升的位次，负数表示下降）。 */
  rankChange: z.number().int().optional(),
  /** 榜单覆盖的 A 股数量，用于把排名换算为分位。 */
  marketStockCount: z.number().int().positive().optional(),
  /** 1 - (rank-1)/marketStockCount；只在有 marketStockCount 时给出。 */
  percentile: z.number().min(0).max(1).optional(),
  /** 上游计算该排名的时间。 */
  calcTime: z.coerce.date().optional(),
});
export type ForumDigestPopularity = z.infer<typeof ForumDigestPopularitySchema>;

/**
 * 市场级广度事实（来自东方财富人气榜）：只有市场摘要才有。
 * 这些是榜单原值 / 计数，不是合成情绪指数；没有榜单时整段缺省并说明原因。
 */
export const ForumDigestBreadthSchema = z.object({
  /** 本次拉到的榜单条数。 */
  hotListSize: z.number().int().positive(),
  hotListExchanges: z.object({
    sh: z.number().int().nonnegative(),
    sz: z.number().int().nonnegative(),
    other: z.number().int().nonnegative(),
  }),
  /** 榜单内排名变化的中位数（上游 hisRc 口径）；没有该字段时为 null。 */
  rankChangeMedian: z.number().finite().nullable(),
  /** 榜单覆盖的 A 股总数（若上游给出）。 */
  marketStockCount: z.number().int().positive().optional(),
});
export type ForumDigestBreadth = z.infer<typeof ForumDigestBreadthSchema>;

export const ForumDigestOwnHistorySchema = z.object({
  /** 参与分位计算的历史交易日数。 */
  samples: z.number().int().nonnegative(),
  /** 当日发帖量在自身历史中的分位（0–1）；样本不足时为 null，不补 0。 */
  postsPercentile: z.number().min(0).max(1).nullable(),
  /** 历史回看窗口（自然日）。 */
  windowDays: z.number().int().positive(),
});
export type ForumDigestOwnHistory = z.infer<typeof ForumDigestOwnHistorySchema>;

export const ForumDigestAttentionSchema = z.object({
  posts: z.number().int().nonnegative(),
  authors: z.number().int().nonnegative(),
  replies: z.number().int().nonnegative(),
  clicks: z.number().int().nonnegative(),
  likes: z.number().int().nonnegative(),
  /** 单作者最大占比（0–1）；样本为 0 时为 0。 */
  topAuthorShare: z.number().min(0).max(1),
  popularity: ForumDigestPopularitySchema.optional(),
  ownHistory: ForumDigestOwnHistorySchema.optional(),
});
export type ForumDigestAttention = z.infer<typeof ForumDigestAttentionSchema>;

// ---------- 覆盖 / 质量 / 摘录 / 一致性 ----------

export const ForumDigestRemovedSchema = z.object({
  outsideWindow: z.number().int().nonnegative(),
  duplicate: z.number().int().nonnegative(),
  promotional: z.number().int().nonnegative(),
  instructionLike: z.number().int().nonnegative(),
  empty: z.number().int().nonnegative(),
  nonUser: z.number().int().nonnegative(),
});
export type ForumDigestRemoved = z.infer<typeof ForumDigestRemovedSchema>;

export const EMPTY_FORUM_REMOVED: ForumDigestRemoved = {
  outsideWindow: 0,
  duplicate: 0,
  promotional: 0,
  instructionLike: 0,
  empty: 0,
  nonUser: 0,
};

export const ForumDigestCoverageSchema = z
  .object({
    status: z.enum(['ok', 'partial', 'empty', 'unavailable']),
    fetchedPosts: z.number().int().nonnegative(),
    windowPosts: z.number().int().nonnegative(),
    effectivePosts: z.number().int().nonnegative(),
    mediaPosts: z.number().int().nonnegative(),
    removed: ForumDigestRemovedSchema,
    reasons: z.array(z.string().min(1)),
  })
  .superRefine((coverage, ctx) => {
    if (coverage.effectivePosts > coverage.windowPosts) {
      ctx.addIssue({
        code: 'custom',
        path: ['effectivePosts'],
        message: '有效样本不能超过窗口帖数',
      });
    }
    if (coverage.status === 'ok' && coverage.fetchedPosts === 0) {
      ctx.addIssue({ code: 'custom', path: ['fetchedPosts'], message: 'ok 状态必须有采集结果' });
    }
    if (coverage.status !== 'ok' && coverage.reasons.length === 0) {
      ctx.addIssue({ code: 'custom', path: ['reasons'], message: '降级状态必须说明原因' });
    }
  });
export type ForumDigestCoverage = z.infer<typeof ForumDigestCoverageSchema>;

export const FORUM_QUALITY_LEVELS = ['ok', 'insufficient', 'author-concentrated'] as const;
export const ForumDigestQualitySchema = z
  .object({
    level: z.enum(FORUM_QUALITY_LEVELS),
    reasons: z.array(z.string().min(1)),
  })
  .superRefine((quality, ctx) => {
    if (quality.level !== 'ok' && quality.reasons.length === 0) {
      ctx.addIssue({ code: 'custom', path: ['reasons'], message: '低质量必须说明原因' });
    }
  });
export type ForumDigestQuality = z.infer<typeof ForumDigestQualitySchema>;

export const ForumDigestExcerptSchema = z.object({
  postId: z.string().min(1),
  title: z.string().min(1).max(FORUM_EXCERPT_MAX_CHARS),
  url: z.string().min(1).optional(),
  publishedAt: z.coerce.date(),
  author: z.string().min(1).optional(),
  replies: z.number().int().nonnegative().optional(),
  /** 原帖是不可信外部文本；展示与提示词必须保留该标记。 */
  untrusted: z.literal(true),
});
export type ForumDigestExcerpt = z.infer<typeof ForumDigestExcerptSchema>;

export const FORUM_CONSISTENCY_STATUSES = ['aligned', 'divergent', 'mixed', 'unknown'] as const;
export const ForumDigestConsistencySchema = z
  .object({
    status: z.enum(FORUM_CONSISTENCY_STATUSES),
    /** 可复核的事实句（讨论方向 + 当日涨跌幅 / 板块涨跌幅）。 */
    basis: z.array(z.string().min(1)).max(6),
    quoteChangePct: z.number().finite().optional(),
    sectorChangePct: z.number().finite().optional(),
    reasons: z.array(z.string().min(1)),
  })
  .superRefine((consistency, ctx) => {
    if (consistency.status === 'unknown' && consistency.reasons.length === 0) {
      ctx.addIssue({ code: 'custom', path: ['reasons'], message: 'unknown 必须说明原因' });
    }
  });
export type ForumDigestConsistency = z.infer<typeof ForumDigestConsistencySchema>;

export const ForumDigestMissingSchema = z.object({
  dimension: z.enum(['posts', 'popularity', 'stance', 'consistency', 'history']),
  reason: z.string().trim().min(1),
});
export type ForumDigestMissing = z.infer<typeof ForumDigestMissingSchema>;

export const ForumDigestSchema = z
  .object({
    id: z.string().min(1),
    subjectKind: ForumDigestSubjectKindSchema,
    subjectId: z.string().min(1),
    tradingDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    phase: StockBriefPhaseSchema,
    source: z.string().trim().min(1),
    /** 采集完成时刻（真实数据时间），不是交易日占位值。 */
    dataAsOf: z.coerce.date(),
    windowStart: z.coerce.date(),
    windowEnd: z.coerce.date(),
    coverage: ForumDigestCoverageSchema,
    quality: ForumDigestQualitySchema,
    attention: ForumDigestAttentionSchema,
    /** 仅市场摘要：人气榜广度事实；逐股摘要不使用。 */
    breadth: ForumDigestBreadthSchema.optional(),
    stance: ForumDigestStanceSchema.nullable(),
    excerpts: z.array(ForumDigestExcerptSchema).max(FORUM_EXCERPT_LIMIT),
    consistency: ForumDigestConsistencySchema,
    missing: z.array(ForumDigestMissingSchema),
    createdAt: z.coerce.date(),
    updatedAt: z.coerce.date(),
  })
  .superRefine((digest, ctx) => {
    if (digest.subjectKind === 'market' && digest.subjectId !== FORUM_MARKET_SUBJECT_ID) {
      ctx.addIssue({
        code: 'custom',
        path: ['subjectId'],
        message: `market 摘要的 subjectId 必须是 ${FORUM_MARKET_SUBJECT_ID}`,
      });
    }
    if (digest.subjectKind === 'stock' && digest.subjectId === FORUM_MARKET_SUBJECT_ID) {
      ctx.addIssue({ code: 'custom', path: ['subjectId'], message: 'stock 摘要需要股票 id' });
    }
    if (digest.windowStart.getTime() >= digest.windowEnd.getTime()) {
      ctx.addIssue({
        code: 'custom',
        path: ['windowEnd'],
        message: 'windowEnd 必须晚于 windowStart',
      });
    }
    if (digest.breadth !== undefined && digest.subjectKind !== 'market') {
      ctx.addIssue({ code: 'custom', path: ['breadth'], message: 'breadth 只属于市场摘要' });
    }
    if (
      digest.subjectKind === 'market' &&
      digest.coverage.status === 'ok' &&
      digest.breadth === undefined
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['breadth'],
        message: '市场摘要缺少广度事实时不能标 ok',
      });
    }
    if (digest.coverage.status === 'unavailable' && digest.excerpts.length > 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['excerpts'],
        message: '采集不可用时不发布摘录（避免用旧帖冒充当日讨论）',
      });
    }
    if (digest.attention.posts !== digest.coverage.windowPosts) {
      ctx.addIssue({
        code: 'custom',
        path: ['attention', 'posts'],
        message: 'posts 与覆盖口径不一致',
      });
    }
    if (digest.createdAt.getTime() > digest.updatedAt.getTime()) {
      ctx.addIssue({ code: 'custom', path: ['updatedAt'], message: 'updatedAt 早于 createdAt' });
    }
  });
export type ForumDigest = z.infer<typeof ForumDigestSchema>;

/** 写库前的不变量：stance 只在质量门通过时发布，摘录只能是已清洗的有界文本。 */
export const assertForumDigestInvariants = (digest: ForumDigest): void => {
  const parsed = ForumDigestSchema.safeParse(digest);
  if (!parsed.success) {
    throw new InvariantError(
      `ForumDigest 不满足不变量: ${parsed.error.issues.map((issue) => issue.message).join('; ')}`,
    );
  }
  if (digest.stance !== null && digest.quality.level !== 'ok') {
    throw new InvariantError('ForumDigest: 质量门未通过时不得发布 stance');
  }
  if (digest.stance !== null && digest.coverage.effectivePosts < FORUM_MIN_EFFECTIVE_POSTS) {
    throw new InvariantError('ForumDigest: 有效样本不足时不得发布 stance');
  }
};

// ---------- 分析（纯函数） ----------

export interface AnalyzeForumPostsInput {
  readonly subjectKind: ForumDigestSubjectKind;
  readonly posts: readonly ForumPostSample[];
  readonly window: ForumDigestWindow;
  /** 数据源的股票代码 / 市场标识，用于拼原文链接时的诊断。 */
  readonly code?: string;
  readonly minEffectivePosts?: number;
  readonly minUniqueAuthors?: number;
  readonly maxAuthorShare?: number;
  /** 已采集失败时的原因（例如网络或上游字段缺失）。 */
  readonly unavailableReason?: string;
}

export interface ForumPostsAnalysis {
  readonly coverage: ForumDigestCoverage;
  readonly quality: ForumDigestQuality;
  readonly attention: ForumDigestAttention;
  readonly stance: ForumDigestStance | null;
  readonly excerpts: readonly ForumDigestExcerpt[];
  readonly missing: readonly ForumDigestMissing[];
}

const engagementScore = (post: ForumPostSample): number =>
  (post.replies ?? 0) * 3 + (post.likes ?? 0) * 2 + Math.floor((post.clicks ?? 0) / 100);

/**
 * 确定性分析：清洗 → 去重 → 导流过滤 → 质量门 → 关注度 / stance / 摘录。
 * 不调用 LLM，不合成 0–100 指数；样本不足时 stance 为 null 并写明原因。
 */
export const analyzeForumPosts = (input: AnalyzeForumPostsInput): ForumPostsAnalysis => {
  const minPosts = input.minEffectivePosts ?? FORUM_MIN_EFFECTIVE_POSTS;
  const minAuthors = input.minUniqueAuthors ?? FORUM_MIN_UNIQUE_AUTHORS;
  const maxShare = input.maxAuthorShare ?? FORUM_MAX_AUTHOR_SHARE;
  const start = input.window.start.getTime();
  const end = input.window.end.getTime();

  const removed = { ...EMPTY_FORUM_REMOVED };
  const seen = new Set<string>();
  const effective: ForumPostSample[] = [];
  let windowPosts = 0;
  let mediaPosts = 0;

  for (const post of input.posts) {
    const publishedAt = post.publishedAt.getTime();
    if (!Number.isFinite(publishedAt)) {
      removed.empty += 1;
      continue;
    }
    if (publishedAt < start || publishedAt >= end) {
      removed.outsideWindow += 1;
      continue;
    }
    windowPosts += 1;
    if (post.postType !== 'user') {
      mediaPosts += 1;
      removed.nonUser += 1;
      continue;
    }
    const cleanedTitle = sanitizeForumText(post.title);
    if (cleanedTitle.length === 0) {
      removed.empty += 1;
      continue;
    }
    const key = forumTitleKey(cleanedTitle);
    if (key.length === 0) {
      removed.empty += 1;
      continue;
    }
    if (seen.has(key)) {
      removed.duplicate += 1;
      continue;
    }
    seen.add(key);
    const body = `${cleanedTitle} ${sanitizeForumText(post.content ?? '')}`;
    if (isPromotionalForumText(body)) {
      removed.promotional += 1;
      continue;
    }
    if (looksLikeForumInstruction(body)) {
      removed.instructionLike += 1;
      continue;
    }
    effective.push({ ...post, title: cleanedTitle });
  }

  const authors = new Map<string, number>();
  for (const post of effective) {
    const author = (post.authorId ?? post.author).trim();
    authors.set(author, (authors.get(author) ?? 0) + 1);
  }
  const topAuthorCount = Math.max(0, ...authors.values());
  const topAuthorShare = effective.length === 0 ? 0 : topAuthorCount / effective.length;

  const attention: ForumDigestAttention = {
    posts: windowPosts,
    authors: authors.size,
    replies: effective.reduce((sum, post) => sum + (post.replies ?? 0), 0),
    clicks: effective.reduce((sum, post) => sum + (post.clicks ?? 0), 0),
    likes: effective.reduce((sum, post) => sum + (post.likes ?? 0), 0),
    topAuthorShare,
  };

  const reasons: string[] = [];
  let qualityLevel: ForumDigestQuality['level'] = 'ok';
  if (input.unavailableReason !== undefined) {
    reasons.push(input.unavailableReason);
  }
  if (effective.length < minPosts) {
    reasons.push(`有效用户帖 ${effective.length} 条，少于 ${minPosts} 条，不发布多空倾向`);
  }
  if (authors.size < minAuthors) {
    reasons.push(`独立作者 ${authors.size} 位，少于 ${minAuthors} 位，不发布多空倾向`);
  }
  if (topAuthorShare > maxShare) {
    reasons.push(
      `单一作者占 ${Math.round(topAuthorShare * 100)}%，超过 ${Math.round(maxShare * 100)}%，不发布多空倾向`,
    );
  }
  if (effective.length >= minPosts && topAuthorShare > maxShare) {
    qualityLevel = 'author-concentrated';
  } else if (effective.length < minPosts || authors.size < minAuthors) {
    qualityLevel = 'insufficient';
  }

  const coverageStatus: ForumDigestCoverage['status'] =
    input.unavailableReason !== undefined
      ? 'unavailable'
      : windowPosts === 0
        ? 'empty'
        : qualityLevel === 'ok'
          ? 'ok'
          : 'partial';
  if (coverageStatus === 'empty') reasons.push('采集窗口内没有新的股吧帖子');
  if (coverageStatus === 'unavailable' && reasons.length === 0) reasons.push('股吧数据源不可用');

  const coverage: ForumDigestCoverage = {
    status: coverageStatus,
    fetchedPosts: input.posts.length,
    windowPosts,
    effectivePosts: effective.length,
    mediaPosts,
    removed,
    reasons: [...new Set(reasons)],
  };

  const quality: ForumDigestQuality = {
    level: coverageStatus === 'unavailable' ? 'insufficient' : qualityLevel,
    reasons:
      coverageStatus === 'unavailable'
        ? [...new Set([...reasons, '股吧数据源不可用，未做讨论分析'])]
        : [...new Set(reasons)],
  };

  let stance: ForumDigestStance | null = null;
  if (
    qualityLevel === 'ok' &&
    coverageStatus === 'ok' &&
    effective.length >= minPosts &&
    authors.size >= minAuthors
  ) {
    let bullish = 0;
    let bearish = 0;
    let neutral = 0;
    for (const post of effective) {
      const direction = classifyForumStance(`${post.title} ${post.content ?? ''}`);
      if (direction === 'bullish') bullish += 1;
      else if (direction === 'bearish') bearish += 1;
      else neutral += 1;
    }
    const classified = bullish + bearish + neutral;
    const bullishShare = bullish / classified;
    const bearishShare = bearish / classified;
    const divergence =
      bullishShare >= FORUM_DIVERGENCE_MIN_SHARE &&
      bearishShare >= FORUM_DIVERGENCE_MIN_SHARE &&
      bullish >= FORUM_DIVERGENCE_MIN_POSTS &&
      bearish >= FORUM_DIVERGENCE_MIN_POSTS;
    const gap = bullishShare - bearishShare;
    // 两边都低于分歧阈值（大量中性帖）时是「没有明显方向」，不是「分歧」。
    const direction: ForumStanceDirection = divergence
      ? 'divided'
      : bullishShare < FORUM_DIVERGENCE_MIN_SHARE && bearishShare < FORUM_DIVERGENCE_MIN_SHARE
        ? 'neutral'
        : Math.abs(gap) < 0.1
          ? 'divided'
          : gap > 0
            ? 'bullish'
            : 'bearish';
    stance = {
      direction,
      bullish,
      bearish,
      neutral,
      classified,
      bullishShare,
      bearishShare,
      divergence,
    };
  }

  const excerpts: ForumDigestExcerpt[] = [];
  if (coverageStatus === 'ok' || coverageStatus === 'partial') {
    const ranked = [...effective].sort((left, right) => {
      const score = engagementScore(right) - engagementScore(left);
      if (score !== 0) return score;
      return right.publishedAt.getTime() - left.publishedAt.getTime();
    });
    for (const post of ranked) {
      if (excerpts.length >= FORUM_EXCERPT_LIMIT) break;
      const title = sanitizeForumExcerpt(post.title);
      if (title === null) continue;
      excerpts.push({
        postId: post.postId,
        title,
        ...(post.url === undefined ? {} : { url: post.url }),
        publishedAt: post.publishedAt,
        author: post.author,
        ...(post.replies === undefined ? {} : { replies: post.replies }),
        untrusted: true,
      });
    }
  }

  const missing: ForumDigestMissing[] = [];
  if (coverageStatus !== 'ok') {
    missing.push({
      dimension: 'posts',
      reason: coverage.reasons.join('；') || '股吧讨论不可用',
    });
  }
  if (stance === null) {
    missing.push({
      dimension: 'stance',
      reason: quality.reasons.join('；') || '样本不足，未发布多空倾向',
    });
  }

  return { coverage, quality, attention, stance, excerpts, missing };
};

// ---------- 盘面一致性 ----------

export interface ForumConsistencyInput {
  readonly stance: ForumDigestStance | null;
  readonly quoteChangePct?: number;
  readonly sectorChangePct?: number;
  readonly unavailableReason?: string;
}

/** |涨跌幅| 不超过该值视为平盘，不参与方向判定。 */
export const FORUM_CONSISTENCY_FLAT_PCT = 0.5;

/**
 * 论坛方向 × 当日真实量价事实的一致性。只用已存在的涨跌幅做交叉验证，
 * 不推断资金流、不引用没有语气字段的新闻情绪。
 */
export const deriveForumConsistency = (input: ForumConsistencyInput): ForumDigestConsistency => {
  const basis: string[] = [];
  const reasons: string[] = [];
  if (input.stance === null) {
    return {
      status: 'unknown',
      basis,
      ...(input.quoteChangePct === undefined ? {} : { quoteChangePct: input.quoteChangePct }),
      ...(input.sectorChangePct === undefined ? {} : { sectorChangePct: input.sectorChangePct }),
      reasons: ['没有通过质量门的多空倾向，无法与盘面交叉验证'],
    };
  }
  const share = `${Math.round(input.stance.bullishShare * 100)}% / ${Math.round(input.stance.bearishShare * 100)}%`;
  basis.push(
    input.stance.direction === 'divided'
      ? `股吧多空分歧（偏多/偏空 ${share}）`
      : input.stance.direction === 'bullish'
        ? `股吧偏多（偏多/偏空 ${share}）`
        : input.stance.direction === 'bearish'
          ? `股吧偏空（偏多/偏空 ${share}）`
          : `股吧没有明显方向（偏多/偏空 ${share}）`,
  );
  const quote = input.quoteChangePct;
  if (quote === undefined || !Number.isFinite(quote)) {
    reasons.push('缺少当日涨跌幅，无法判断讨论与盘面是否一致');
  } else {
    basis.push(`当日涨跌幅 ${quote > 0 ? '+' : ''}${quote.toFixed(2)}%`);
  }
  if (input.sectorChangePct !== undefined && Number.isFinite(input.sectorChangePct)) {
    basis.push(
      `所属板块涨跌幅 ${input.sectorChangePct > 0 ? '+' : ''}${input.sectorChangePct.toFixed(2)}%`,
    );
  }
  if (input.stance.direction === 'divided') {
    return {
      status: 'mixed',
      basis,
      ...(quote === undefined ? {} : { quoteChangePct: quote }),
      ...(input.sectorChangePct === undefined ? {} : { sectorChangePct: input.sectorChangePct }),
      reasons: ['讨论本身分歧，无法与单一盘面方向对齐'],
    };
  }
  if (input.stance.direction === 'neutral') {
    return {
      status: 'mixed',
      basis,
      ...(quote === undefined ? {} : { quoteChangePct: quote }),
      ...(input.sectorChangePct === undefined ? {} : { sectorChangePct: input.sectorChangePct }),
      reasons: ['讨论没有明确方向，不能作为盘面方向的证据'],
    };
  }
  if (quote === undefined || !Number.isFinite(quote)) {
    return {
      status: 'unknown',
      basis,
      ...(input.sectorChangePct === undefined ? {} : { sectorChangePct: input.sectorChangePct }),
      reasons,
    };
  }
  const priceDirection =
    Math.abs(quote) <= FORUM_CONSISTENCY_FLAT_PCT ? 'flat' : quote > 0 ? 'up' : 'down';
  if (priceDirection === 'flat') {
    return {
      status: 'mixed',
      basis,
      quoteChangePct: quote,
      ...(input.sectorChangePct === undefined ? {} : { sectorChangePct: input.sectorChangePct }),
      reasons: [`当日涨跌幅 ${quote.toFixed(2)}% 接近平盘，不构成方向证据`],
    };
  }
  const aligned =
    (input.stance.direction === 'bullish' && priceDirection === 'up') ||
    (input.stance.direction === 'bearish' && priceDirection === 'down');
  return {
    status: aligned ? 'aligned' : 'divergent',
    basis,
    quoteChangePct: quote,
    ...(input.sectorChangePct === undefined ? {} : { sectorChangePct: input.sectorChangePct }),
    reasons: aligned ? [] : ['讨论方向与当日涨跌方向相反'],
  };
};

// ---------- 关注度分位 ----------

/**
 * 当日发帖量在自身历史中的分位：严格小于当日的历史值占比，再按并列处理。
 * 历史样本不足时返回 null（不伪造 0 或 50）。
 */
export const deriveForumPostsPercentile = (input: {
  readonly posts: number;
  readonly historyPosts: readonly number[];
  readonly windowDays: number;
  readonly minSamples?: number;
}): ForumDigestOwnHistory => {
  const min = input.minSamples ?? FORUM_HISTORY_MIN_SAMPLES;
  const history = input.historyPosts.filter((value) => Number.isFinite(value));
  const percentile =
    history.length < min
      ? null
      : (() => {
          const below = history.filter((value) => value < input.posts).length;
          const equal = history.filter((value) => value === input.posts).length;
          return (below + equal / 2) / history.length;
        })();
  return {
    samples: history.length,
    postsPercentile: percentile,
    windowDays: input.windowDays,
  };
};

/**
 * 人气排名 → 分位（1 最好）：1 - (rank-1)/marketStockCount。
 * 缺 marketStockCount 时返回 undefined，不假设市场容量。
 */
export const derivePopularityPercentile = (
  rank: number,
  marketStockCount?: number,
): number | undefined => {
  if (
    marketStockCount === undefined ||
    !Number.isFinite(marketStockCount) ||
    marketStockCount <= 0
  ) {
    return undefined;
  }
  if (!Number.isFinite(rank) || rank <= 0) return undefined;
  const clamped = Math.min(Math.max(1, Math.trunc(rank)), Math.trunc(marketStockCount));
  return 1 - (clamped - 1) / Math.trunc(marketStockCount);
};

/** 由交易日期与采集时刻推导 dataAsOf 的展示日期（Asia/Shanghai）。 */
export const forumDigestDateOf = (digest: Pick<ForumDigest, 'dataAsOf'>): string =>
  dateInShanghai(digest.dataAsOf);

// ---------- adapter / manager 快照形状（core 只定义投影，不做 IO） ----------

/** 单只股票股吧页的一次采集结果。 */
export interface ForumPostsSnapshot {
  readonly code: string;
  readonly posts: readonly ForumPostSample[];
  /** 真实采集完成时刻（dataAsOf 的唯一来源）。 */
  readonly fetchedAt: Date;
  /** 实际拉取的列表页数。 */
  readonly pagesFetched: number;
  readonly warnings: readonly string[];
}

/** 个股人气排名的点位快照。 */
export interface ForumPopularitySnapshot {
  readonly code: string;
  readonly rank: number;
  readonly rankChange?: number;
  readonly marketStockCount?: number;
  readonly calcTime?: Date;
  readonly fetchedAt: Date;
}

/** 人气榜一页（市场广度），rows 按 rank 升序。 */
export interface ForumHotListSnapshot {
  readonly rows: readonly {
    readonly code: string;
    readonly rank: number;
    readonly rankChange?: number;
  }[];
  readonly fetchedAt: Date;
}
