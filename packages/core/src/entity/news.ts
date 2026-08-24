import { z } from 'zod';

import { InvariantError } from '../error/index.js';
import { type SourceId, SourceIdSchema } from '../source.js';

/**
 * 财经要闻流实体。
 *
 * 设计要点（对齐 dragon-tiger / northbound-flow 的组织风格）：
 * - 一次查询 = 可选分类 `category` + 可选关键词 `keyword` + `limit` + 不可变的 `items`
 * - 上游（东方财富要闻 API）不提供分类字段；分类由 `inferNewsCategory` 按标题关键词推断，
 *   规则与参考产品（finance-workbench News 页）逐条一致——这是启发式标注，不是上游事实
 * - 分类 / 关键词过滤在 manager 侧对单页快照执行（上游不支持搜索），与参考产品行为一致
 * - publishedAt 为 Asia/Shanghai 发布时间（上游 'YYYY-MM-DD HH:mm:ss' 显式按 +08:00 解析）
 * - 缺字段哨兵：summary 缺失回退到 title；source 缺失显示 '东方财富'
 */

// ---------- 枚举与基础类型 ----------

/**
 * 数据源标识（通用 SourceId；当前仅 eastmoney 要闻 API 注册）。
 * 兼容扩宽：docs/ddd/source-pluggability-and-observation-design.md §4.6。
 */
export type NewsSource = SourceId;

export const NewsSourceSchema = SourceIdSchema;

/** 新闻分类（标题关键词推断，规则与参考产品一致）。 */
export const NewsCategorySchema = z.enum([
  '宏观',
  '市场',
  '行业',
  '公司',
  '监管',
  '海外',
  '商品',
  '资金',
  '政策',
]);

export type NewsCategory = z.infer<typeof NewsCategorySchema>;

// ---------- 单条新闻 ----------

export const NewsItemSchema = z.object({
  /** 上游新闻 id（code 字段）。 */
  id: z.string().min(1),
  title: z.string().min(1),
  /** 摘要；缺失时回退到 title（manager 内归一化）。 */
  summary: z.string(),
  category: NewsCategorySchema,
  /** 来源媒体；缺失显示 '东方财富'。 */
  source: z.string(),
  /** 发布时间（上游 Asia/Shanghai 时刻）。 */
  publishedAt: z.coerce.date(),
  /** 原文链接（http 归一为 https）。 */
  url: z.string(),
});

export type NewsItem = z.infer<typeof NewsItemSchema>;

// ---------- 列表快照 ----------

export const NewsListSchema = z.object({
  /** 过滤后的条目数（== items.length）。 */
  total: z.number().int().nonnegative(),
  source: NewsSourceSchema,
  /** 按发布时间倒序（与上游一致）。 */
  items: z.array(NewsItemSchema),
  /** 数据异常/口径提示；非空列表也可能有警告。 */
  warnings: z.array(z.string()),
  /** manager 拉取时间。 */
  asOf: z.coerce.date(),
});

export type NewsList = z.infer<typeof NewsListSchema>;

// ---------- 查询参数 ----------

export const FetchNewsQuerySchema = z.object({
  /** 缺省 = 全部分类。 */
  category: NewsCategorySchema.optional(),
  /** 返回条数（默认 30）。 */
  limit: z.number().int().min(1).max(100).default(30),
  /** 标题 / 摘要包含过滤（上游不支持搜索，manager 侧对单页快照执行，与参考产品一致）。 */
  keyword: z.string().trim().min(1).max(50).optional(),
  /** 可选单源路由约束：未传时按配置顺序 fallback；显式传入时只尝试该源（§4.6）。 */
  source: NewsSourceSchema.optional(),
});

export type FetchNewsQuery = z.infer<typeof FetchNewsQuerySchema>;

// ---------- 分类推断 ----------

/**
 * 按标题关键词推断分类（规则与参考产品 finance-workbench 逐条一致）。
 * 上游不提供分类字段；推断顺序敏感，先命中先返回。
 */
export const inferNewsCategory = (title: string): NewsCategory => {
  if (/央行|利率|准备金|货币|M2|GDP|CPI|PPI|PMI/.test(title)) return '宏观';
  if (/证监|监管|退市|IPO|注册制|处分/.test(title)) return '监管';
  if (/北向|外资|资金|流入|流出|主力/.test(title)) return '资金';
  if (/美股|欧股|日股|海外|国际|美联储|欧央行/.test(title)) return '海外';
  if (/黄金|原油|铜|铁矿|大宗|商品/.test(title)) return '商品';
  if (/政策|会议|规划|通知|意见/.test(title)) return '政策';
  if (/公司|股份|集团|发布|业绩|财报/.test(title)) return '公司';
  if (/板块|行业|产业链|上下游/.test(title)) return '行业';
  return '市场';
};

// ---------- 不变量 ----------

/**
 * 不变量：
 * - total 为非负整数且 == items.length
 * - items 按 publishedAt DESC
 * - item：id / title 非空
 */
export const assertNewsListInvariants = (list: NewsList): void => {
  if (list.total < 0 || !Number.isInteger(list.total)) {
    throw new InvariantError(`total 必须为非负整数，实际 ${list.total}`);
  }
  if (list.total !== list.items.length) {
    throw new InvariantError(`total (${list.total}) != items.length (${list.items.length})`);
  }
  let prev = Number.POSITIVE_INFINITY;
  for (const item of list.items) {
    if (item.id.trim().length === 0) throw new InvariantError('item.id 必须非空');
    if (item.title.trim().length === 0)
      throw new InvariantError(`item.title 必须非空 [${item.id}]`);
    const ts = item.publishedAt.getTime();
    if (ts > prev) {
      throw new InvariantError(`items 必须按 publishedAt DESC [${item.id}]`);
    }
    prev = ts;
  }
};
