import type { ForumPostSample, ForumPostType } from '@luoome/core';

import { asAmount, asString } from '../eastmoney/coercion.js';
import { upstreamError } from '../source-error.js';

/**
 * Eastmoney 股吧协议层（公开网页 / 公开榜单接口）。
 *
 * 端点（真实请求验证 2026-11-26）：
 * - 逐股列表：`https://guba.eastmoney.com/list,<code>.html`（第 1 页，按最新回复），
 *   第 N 页为 `https://guba.eastmoney.com/list,<code>,f_<N>.html`。
 *   页面内嵌 `var article_list={"re":[...],"count":...}`，每行含
 *   `post_id / post_title / post_content / post_publish_time / post_type /
 *   user_nickname / user_id / post_click_count / post_comment_count / post_like_count`。
 *   `post_publish_time` 是精确到秒的 Asia/Shanghai 时间（页面表格里的「最后更新」是
 *   12 小时制且无上下午，不能用于当日窗口判定，因此只读内嵌 JSON）。
 *   `post_type`：0 用户帖、1 个股资讯、20 财富号自媒体，其余归 other。
 * - 人气排名（单只）：POST `https://emappdata.eastmoney.com/stockrank/getCurrentLatest`
 *   body `{appId,globalId,srcSecurityCode}` → `data.{rank,rankChange,hisRankChange,
 *   marketAllCount,calcTime}`。
 * - 人气榜（市场广度）：POST `https://emappdata.eastmoney.com/stockrank/getAllCurrentList`
 *   body `{appId,globalId,marketType:"",pageNo:1,pageSize:N}` → `data:[{sc,rk,hisRc}]`。
 *
 * 不读取登录态、不绕验证码、不伪造 User-Agent 指纹；失败一律抛结构化错误。
 */

const GUBA_BASE = 'https://guba.eastmoney.com';
const RANK_BASE = 'https://emappdata.eastmoney.com/stockrank';

/** 人气榜公开网页使用的 appId / globalId（页面自身参数，不是凭证）。 */
export const FORUM_RANK_APP_ID = 'appId01';
export const FORUM_RANK_GLOBAL_ID = '786e4c21-70dc-435a-93bb-38';
const HOT_LIST_MAX = 100;

export const gubaListUrl = (code: string, page: number): string =>
  page <= 1 ? `${GUBA_BASE}/list,${code}.html` : `${GUBA_BASE}/list,${code},f_${page}.html`;

export const gubaPostUrl = (code: string, postId: string): string =>
  `${GUBA_BASE}/news,${code},${postId}.html`;

export const forumPopularityUrl = (): string => `${RANK_BASE}/getCurrentLatest`;
export const forumHotListUrl = (): string => `${RANK_BASE}/getAllCurrentList`;

/** 交易所前缀（人气榜 srcSecurityCode 的写法）。 */
export const popularitySecurityCode = (stockId: string): string => {
  const [code, exchange] = stockId.trim().toUpperCase().split('.');
  const market =
    exchange === 'SH' ? 'SH' : exchange === 'SZ' ? 'SZ' : exchange === 'BJ' ? 'BJ' : '';
  return market === '' ? (code ?? stockId) : `${market}${code}`;
};

/**
 * 从股吧列表页 HTML 中取出内嵌 `var article_list=` 的 JSON。
 * 用花括号配对（跳过字符串字面量）而不是贪心正则：正文里可能含 `};var` 片段。
 */
export const extractArticleListJson = (html: string): unknown => {
  const marker = 'var article_list=';
  const at = html.indexOf(marker);
  if (at < 0) throw upstreamError('eastmoney 股吧列表页缺少 article_list 数据');
  const start = html.indexOf('{', at + marker.length);
  if (start < 0) throw upstreamError('eastmoney 股吧列表页 article_list 不是对象');
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < html.length; index += 1) {
    const char = html[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        const text = html.slice(start, index + 1);
        try {
          return JSON.parse(text) as unknown;
        } catch (error) {
          throw upstreamError(
            `eastmoney 股吧 article_list 解析失败：${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    }
  }
  throw upstreamError('eastmoney 股吧 article_list 未闭合');
};

const asNumber = (value: unknown): number | null => asAmount(value) ?? null;

const postTypeOf = (value: unknown): ForumPostType => {
  const type = asNumber(value);
  if (type === 0) return 'user';
  if (type === 1) return 'news';
  if (type === 20) return 'media';
  return 'other';
};

/** 'YYYY-MM-DD HH:mm:ss'（Asia/Shanghai）→ Date；非法返回 null，不猜时区。 */
const parsePublishTime = (value: unknown): Date | null => {
  const raw = asString(value);
  if (raw === undefined) return null;
  const match = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})$/.exec(raw.trim());
  if (match === null) return null;
  const date = new Date(`${match[1]}T${match[2]}+08:00`);
  return Number.isNaN(date.getTime()) ? null : date;
};

/** 列表页 JSON → 归一化帖子样本；缺标题 / 发布时间 / 作者的条目剔除。 */
export const parseGubaArticleList = (payload: unknown, code: string): ForumPostSample[] => {
  const body = payload as Record<string, unknown>;
  const rows = Array.isArray(body.re) ? (body.re as unknown[]) : [];
  const posts: ForumPostSample[] = [];
  for (const row of rows) {
    const item = row as Record<string, unknown>;
    const title = asString(item.post_title);
    const author = asString(item.user_nickname);
    const publishedAt = parsePublishTime(item.post_publish_time);
    const postId = asNumber(item.post_id);
    if (title === undefined || author === undefined || publishedAt === null) continue;
    if (postId === null) continue;
    const content = asString(item.post_content);
    const authorId = asString(item.user_id);
    const clicks = asNumber(item.post_click_count);
    const replies = asNumber(item.post_comment_count);
    const likes = asNumber(item.post_like_count);
    posts.push({
      postId: String(postId),
      title,
      ...(content === undefined || content.length === 0 ? {} : { content }),
      author,
      ...(authorId === undefined ? {} : { authorId }),
      publishedAt,
      postType: postTypeOf(item.post_type),
      ...(clicks === null ? {} : { clicks: Math.max(0, Math.trunc(clicks)) }),
      ...(replies === null ? {} : { replies: Math.max(0, Math.trunc(replies)) }),
      ...(likes === null ? {} : { likes: Math.max(0, Math.trunc(likes)) }),
      url: gubaPostUrl(code, String(postId)),
    });
  }
  return posts;
};

export interface RawPopularity {
  readonly rank: number;
  readonly rankChange?: number;
  readonly marketStockCount?: number;
  readonly calcTime?: Date;
}

/** getCurrentLatest 响应 → 排名点位；status/code 非 0 或没有 data 视为上游错误。 */
export const parseForumPopularity = (payload: unknown): RawPopularity | null => {
  const body = payload as Record<string, unknown>;
  if (body.status !== undefined && asNumber(body.status) !== 0) return null;
  const data = body.data as Record<string, unknown> | null | undefined;
  if (data === null || data === undefined) return null;
  const rank = asNumber(data.rank);
  if (rank === null || rank <= 0) return null;
  const rankChange = asNumber(data.hisRankChange) ?? asNumber(data.rankChange);
  const marketAllCount = asNumber(data.marketAllCount);
  const calcTimeRaw = asString(data.calcTime);
  const calcTime =
    calcTimeRaw === undefined ? undefined : (parsePublishTime(calcTimeRaw) ?? undefined);
  return {
    rank: Math.trunc(rank),
    ...(rankChange === null ? {} : { rankChange: Math.trunc(rankChange) }),
    ...(marketAllCount === null || marketAllCount <= 0
      ? {}
      : { marketStockCount: Math.trunc(marketAllCount) }),
    ...(calcTime === undefined ? {} : { calcTime }),
  };
};

export interface RawHotRow {
  readonly code: string;
  readonly rank: number;
  readonly rankChange?: number;
}

/** getAllCurrentList 响应 → 榜单行（sc 形如 SH600519）。 */
export const parseForumHotList = (payload: unknown): RawHotRow[] => {
  const body = payload as Record<string, unknown>;
  if (body.status !== undefined && asNumber(body.status) !== 0) {
    throw upstreamError(`eastmoney 人气榜上游错误: ${String(body.message)}`);
  }
  const rows = Array.isArray(body.data) ? (body.data as unknown[]) : [];
  const out: RawHotRow[] = [];
  for (const row of rows) {
    const item = row as Record<string, unknown>;
    const security = asString(item.sc);
    const rank = asNumber(item.rk);
    if (security === undefined || rank === null || rank <= 0) continue;
    const rankChange = asNumber(item.hisRc);
    out.push({
      code: security,
      rank: Math.trunc(rank),
      ...(rankChange === null ? {} : { rankChange: Math.trunc(rankChange) }),
    });
  }
  return out.sort((left, right) => left.rank - right.rank);
};

export const FORUM_HOT_LIST_MAX = HOT_LIST_MAX;
