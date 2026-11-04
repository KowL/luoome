import { ZodError, z } from 'zod';

import type { FuyaoClient } from '../fuyao/client.js';
import { invalidPayloadError, unsupportedCapabilityError } from '../source-error.js';
import type { NewsFetchResult, NewsRawItem } from './types.js';

/**
 * Fuyao 财经快讯源（`GET /api/news/flash/list`）。
 *
 * 契约（Phase 0 实测，docs/ddd/fuyao-phase0-special-evidence.md §4.1）：
 * - `data` 形状 `{ items[] }`，无分页对象、无 has_more；每页固定约 20 条
 * - 翻页协议是 `tag_id + seq`：首屏 `seq='0'`；取本页**最后一条的 seq** 作为下一页 seq
 * - `id`/`seq` 是十进制字符串（文档示例出现过 16 位，超 Number.MAX_SAFE_INTEGER），
 *   必须按字符串处理，不能转 Number
 * - `create_time_ms` 是首次发布时间（毫秒）；`update_time_ms` 只表示内容修订，不覆盖首发时间
 * - 列表无媒体来源字段，统一写 `同花顺快讯`（不落入 Eastmoney 默认哨兵）
 * - 未知 `tag_id` 返回空列表而非错误：配置错误不会被上游报错暴露
 *
 * seq/cursor 分页（设计 §9.1）：
 * - 同一源顺序浏览时保存 page → next seq 的进程内游标（不持久化、不跨来源通用）
 * - 冷启动直接请求 page>1 且没有游标时抛 unsupported_capability，让其它已启用源承担；
 *   不能把 page 数字当 seq
 * - 顺序翻页（page == lastPage+1 且有游标）即使条目全部失效也会推进游标，
 *   避免同一坏页反复请求形成活锁
 */

const FuyaoFlashItemSchema = z.object({
  id: z.string().min(1),
  seq: z.string().min(1),
  title: z.string().min(1),
  encoded_url: z.string().nullish(),
  summary: z.string().nullish(),
  create_time_ms: z.number().int().positive(),
  // update_time_ms 只表示内容修订，不映射为发布时间；schema 校验存在性即可。
  update_time_ms: z.number().int().positive().nullish(),
});

const FuyaoFlashDataSchema = z.object({
  items: z.array(FuyaoFlashItemSchema),
});

export interface FuyaoNewsSourceOptions {
  /** 栏目 id（LUOOME_FUYAO_NEWS_TAG_ID；21103 已实测为当前财经要闻混合流）。 */
  readonly tagId: string;
}

export class FuyaoNewsSource {
  readonly name = 'fuyao';

  private readonly tagId: string;
  /** 进程内翻页游标：已完成的最后一个 page → 该页末条 seq（下一页入参）。 */
  private readonly cursorByPage = new Map<number, string>();
  private lastPage = 0;

  constructor(
    private readonly client: FuyaoClient,
    options: FuyaoNewsSourceOptions,
  ) {
    this.tagId = options.tagId;
  }

  async fetchNews(page: number, pageSize: number): Promise<NewsFetchResult> {
    const seq = this.seqForPage(page);
    const { data } = await this.client.getData('/api/news/flash/list', {
      tag_id: this.tagId,
      seq,
    });
    let parsed: z.infer<typeof FuyaoFlashDataSchema>;
    try {
      parsed = FuyaoFlashDataSchema.parse(data);
    } catch (error) {
      if (error instanceof ZodError) {
        throw invalidPayloadError(`fuyao news: data 形状不符（${error.message}）`, error);
      }
      throw error;
    }

    const items: NewsRawItem[] = [];
    let lastSeq: string | undefined;
    for (const row of parsed.items) {
      lastSeq = row.seq;
      const publishedAt = new Date(row.create_time_ms);
      if (Number.isNaN(publishedAt.getTime())) continue;
      const summary = row.summary?.trim();
      const url = row.encoded_url?.trim();
      items.push({
        id: row.id,
        title: row.title,
        ...(summary === undefined || summary.length === 0 ? {} : { summary }),
        source: '同花顺快讯',
        published_at: publishedAt.toISOString(),
        ...(url === undefined || url.length === 0 ? {} : { url }),
      });
    }

    // 顺序翻页推进游标（即使本页条目全部失效也推进，避免坏页活锁）；
    // 重试同一页（page <= lastPage）不推进，保持幂等。
    if (lastSeq !== undefined && page === this.lastPage + 1) {
      this.cursorByPage.set(page, lastSeq);
      this.lastPage = page;
    }
    return { items: items.slice(0, pageSize) };
  }

  /** page=1 固定 seq='0'；page>1 需要上一页游标，冷启动抛 unsupported_capability。 */
  private seqForPage(page: number): string {
    if (page <= 1) return '0';
    const seq = this.cursorByPage.get(page - 1);
    if (seq === undefined) {
      throw unsupportedCapabilityError(
        `fuyao news: 冷启动不支持直接请求 page=${page}（seq 游标缺失，需从 page=1 顺序翻页）`,
      );
    }
    return seq;
  }
}
