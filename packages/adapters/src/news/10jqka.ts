import { SourceExecutionError } from '../source-error.js';
import type { NewsFetchResult, NewsRawItem } from './types.js';

const BASE_URL = 'https://news.10jqka.com.cn/tapp/news/push/stock/';
const DEFAULT_TIMEOUT_MS = 10_000;

export const tenjqkaNewsUrl = (page: number, pageSize: number): string =>
  `${BASE_URL}?page=${page}&tag=&track=website&pagesize=${pageSize}`;

export const parseTenjqkaNews = (raw: unknown): NewsRawItem[] => {
  const body = raw as Record<string, unknown>;
  if (body.code !== '200') {
    throw new SourceExecutionError('upstream_error', `10jqka news 上游错误: ${String(body.msg)}`);
  }
  const data = body.data as Record<string, unknown> | undefined;
  const rows = Array.isArray(data?.list) ? data.list : [];
  const items: NewsRawItem[] = [];
  for (const row of rows) {
    const item = row as Record<string, unknown>;
    const title = typeof item.title === 'string' ? item.title.trim() : '';
    const timestamp = Number(item.ctime);
    if (title.length === 0 || !Number.isFinite(timestamp) || timestamp <= 0) continue;
    const summary =
      typeof item.digest === 'string' && item.digest.trim().length > 0
        ? item.digest.trim()
        : typeof item.short === 'string'
          ? item.short.trim()
          : undefined;
    items.push({
      id: String(item.id ?? item.seq ?? `${timestamp}:${title.slice(0, 20)}`),
      title,
      ...(summary === undefined ? {} : { summary }),
      source: '同花顺快讯',
      published_at: new Date(timestamp * 1000).toISOString(),
      ...(typeof item.url === 'string' ? { url: item.url } : {}),
    });
  }
  return items;
};

export class TenjqkaNewsSource {
  readonly name = '10jqka';

  constructor(
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = DEFAULT_TIMEOUT_MS,
  ) {}

  async fetchNews(page: number, pageSize: number): Promise<NewsFetchResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(tenjqkaNewsUrl(page, pageSize), {
        signal: controller.signal,
        headers: {
          accept: 'application/json, text/plain, */*',
          referer: 'https://news.10jqka.com.cn/',
          'user-agent': 'Mozilla/5.0',
        },
      });
      if (!response.ok) {
        throw new SourceExecutionError(
          'upstream_error',
          `HTTP ${response.status} ${response.statusText}`,
        );
      }
      return { items: parseTenjqkaNews(await response.json()) };
    } catch (error) {
      if (error instanceof SourceExecutionError) throw error;
      throw new SourceExecutionError(
        error instanceof DOMException && error.name === 'AbortError' ? 'timeout' : 'network',
        `10jqka news 请求失败: ${error instanceof Error ? error.message : String(error)}`,
        error,
      );
    } finally {
      clearTimeout(timer);
    }
  }
}
