import type {
  ForumHotListSnapshot,
  ForumManagerLike,
  ForumManagerResult,
  ForumPopularitySnapshot,
  ForumPostsSnapshot,
  Logger,
  SourceStatus,
} from '@luoome/core';

import { type SourceHandle, type SourceRegistry, sourceLabel } from '../source-registry.js';
import type { ForumCapabilityMap } from './types.js';

/**
 * 股吧讨论 manager。
 *
 * 与 news / dragon-tiger 同一错误模型：按绑定顺序尝试，全部失败返回显式
 * `adapter_error`，绝不用空数组冒充「今天没有讨论」。三项能力各自独立降级：
 * 列表页失败不带崩人气榜，反之亦然。
 */

interface ManagerOptions {
  readonly registry: SourceRegistry<ForumCapabilityMap>;
  readonly logger: Logger;
}

const errorResult = (message: string): ForumManagerResult<never> => ({
  ok: false,
  error: { kind: 'adapter_error', adapter: 'forum', message, recoverable: true },
});

const labelOf = (handles: readonly { source: string }[]): string =>
  handles.map((handle) => sourceLabel(handle.source)).join(' → ');

export class ForumManager implements ForumManagerLike {
  readonly name = 'forum' as const;
  readonly sources: readonly string[];

  private readonly registry: SourceRegistry<ForumCapabilityMap>;
  private readonly logger: Logger;
  private readonly postHandles: readonly SourceHandle<ForumCapabilityMap, 'forum-posts'>[];
  private readonly popularityHandles: readonly SourceHandle<
    ForumCapabilityMap,
    'forum-popularity'
  >[];
  private readonly hotListHandles: readonly SourceHandle<ForumCapabilityMap, 'forum-hot-list'>[];

  constructor(opts: ManagerOptions) {
    this.registry = opts.registry;
    this.logger = opts.logger;
    this.postHandles = this.registry.sources('forum-posts');
    this.popularityHandles = this.registry.sources('forum-popularity');
    this.hotListHandles = this.registry.sources('forum-hot-list');
    this.sources = [
      ...new Set([
        ...this.postHandles.map((handle) => handle.source),
        ...this.popularityHandles.map((handle) => handle.source),
      ]),
    ];
  }

  status(): readonly SourceStatus[] {
    return this.registry.describe();
  }

  async fetchPosts(input: {
    readonly code: string;
    readonly pages?: number;
  }): Promise<ForumManagerResult<ForumPostsSnapshot>> {
    const pages = Math.min(5, Math.max(1, Math.trunc(input.pages ?? 2)));
    let lastError: unknown;
    for (const handle of this.postHandles) {
      try {
        return { ok: true, data: await handle.execute({ code: input.code, pages }) };
      } catch (error) {
        lastError = error;
        this.logger.warn('forum posts source failed', {
          source: handle.source,
          code: input.code,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return errorResult(
      `股吧列表全部数据源失败（已尝试 ${labelOf(this.postHandles) || '无'}）：${
        lastError instanceof Error ? lastError.message : String(lastError)
      }`,
    );
  }

  async fetchPopularity(code: string): Promise<ForumManagerResult<ForumPopularitySnapshot>> {
    let lastError: unknown;
    for (const handle of this.popularityHandles) {
      try {
        return { ok: true, data: await handle.execute({ code }) };
      } catch (error) {
        lastError = error;
        this.logger.warn('forum popularity source failed', {
          source: handle.source,
          code,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return errorResult(
      `人气排名数据源失败（已尝试 ${labelOf(this.popularityHandles) || '无'}）：${
        lastError instanceof Error ? lastError.message : String(lastError)
      }`,
    );
  }

  async fetchHotList(limit: number): Promise<ForumManagerResult<ForumHotListSnapshot>> {
    const bounded = Math.min(100, Math.max(1, Math.trunc(limit)));
    let lastError: unknown;
    for (const handle of this.hotListHandles) {
      try {
        return { ok: true, data: await handle.execute({ limit: bounded }) };
      } catch (error) {
        lastError = error;
        this.logger.warn('forum hot list source failed', {
          source: handle.source,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return errorResult(
      `人气榜数据源失败（已尝试 ${labelOf(this.hotListHandles) || '无'}）：${
        lastError instanceof Error ? lastError.message : String(lastError)
      }`,
    );
  }
}
