import { asString } from '../eastmoney/coercion.js';
import { upstreamError } from '../source-error.js';
import type { NewsRawItem } from './types.js';

/**
 * Eastmoney 财经要闻协议层（主源）。
 *
 * 最终选用端点（真实请求冒烟验证 2026-08-22）：
 *   https://np-listapi.eastmoney.com/comm/web/getNewsByColumns
 *   ?client=web&biz=web_news_col&column=350&order=1&needInteract=0
 *   &page_index=1&page_size=N&req_trace=<毫秒时间戳>
 * - column=350 为财经要闻滚动栏目（参考产品同源；345-353 其它栏目虽有数据，
 *   但栏目语义无公开文档可考，不臆造枚举，仅注册已验证的 350）
 * - req_trace 为必填参数（缺省返回参数错误）
 * - 响应 code 为字符串 "1" 表示成功；data.list 行字段：
 *   code 新闻 id / title 标题 / summary 摘要 / showTime 发布时间（'YYYY-MM-DD HH:mm:ss'，
 *   Asia/Shanghai）/ uniqueUrl、url 原文链接 / mediaName 来源媒体
 * - 上游不提供分类字段，也不支持关键词搜索；分类推断与过滤在 manager / core 完成
 *   （规则与参考产品 finance-workbench News 页一致）
 *
 * 本模块只保留 URL 模板与字段映射纯函数；HTTP 由 eastmoney/client.ts 承担，
 * 方法归属在 eastmoney/source.ts（docs/ddd/source-pluggability-and-observation-design.md §4.2）。
 */

const BASE_URL = 'https://np-listapi.eastmoney.com/comm/web/getNewsByColumns';
const COLUMN_HEADLINES = '350';

/** 要闻列表 URL；reqTrace 为必填的毫秒时间戳参数。 */
export const newsListUrl = (pageSize: number, reqTrace: number): string =>
  `${BASE_URL}?client=web&biz=web_news_col&column=${COLUMN_HEADLINES}&order=1&needInteract=0` +
  `&page_index=1&page_size=${pageSize}&req_trace=${reqTrace}`;

/** 'YYYY-MM-DD HH:mm:ss'（Asia/Shanghai）→ ISO（显式 +08:00，避免依赖运行环境时区）。 */
const parseShowTime = (v: unknown): string | undefined => {
  if (typeof v !== 'string') return undefined;
  const m = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/.exec(v.trim());
  if (m === null) return undefined;
  return `${m[1]}T${m[2]}+08:00`;
};

/** url 优先 uniqueUrl，其次 url；http 归一为 https。 */
const normalizeUrl = (obj: Record<string, unknown>): string | undefined => {
  const raw = asString(obj.uniqueUrl) ?? asString(obj.url);
  if (raw === undefined) return undefined;
  return raw.startsWith('http://') ? raw.replace('http://', 'https://') : raw;
};

/**
 * 要闻响应 → 原始条目。code != "1" 为上游业务错误（抛 upstream_error）；
 * data=null → 空列表；缺标题 / showTime 格式非法的条目剔除，code 缺失时合成 id。
 */
export const parseNewsList = (raw: unknown): NewsRawItem[] => {
  const body = raw as Record<string, unknown>;
  if (body.code !== '1') {
    throw upstreamError(`eastmoney news 上游错误: ${String(body.message)}`);
  }
  const data = body.data as Record<string, unknown> | null | undefined;
  const rows = Array.isArray(data?.list) ? (data.list as unknown[]) : [];

  const items: NewsRawItem[] = [];
  for (const item of rows) {
    const obj = item as Record<string, unknown>;
    const title = asString(obj.title);
    if (title === undefined) continue;
    const publishedAt = parseShowTime(obj.showTime);
    if (publishedAt === undefined) continue;
    const summary = asString(obj.summary);
    const source = asString(obj.mediaName);
    const url = normalizeUrl(obj);
    items.push({
      id: asString(obj.code) ?? `${publishedAt}:${title.slice(0, 20)}`,
      title,
      ...(summary === undefined ? {} : { summary }),
      ...(source === undefined ? {} : { source }),
      published_at: publishedAt,
      ...(url === undefined ? {} : { url }),
    });
  }
  return items;
};
