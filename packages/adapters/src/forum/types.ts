import type {
  ForumHotListSnapshot,
  ForumPopularitySnapshot,
  ForumPostsSnapshot,
} from '@luoome/core';

/**
 * 股吧讨论域 capability map（SourceRegistry 实例化，§6.2）。
 *
 * 三个能力各自是独立观测点：列表页失败不应把人气榜也标成失败，
 * 反之亦然（观测状态机按 capability 记录）。
 */
export type ForumCapabilityMap = {
  readonly 'forum-posts': {
    readonly request: { readonly code: string; readonly pages: number };
    readonly result: ForumPostsSnapshot;
  };
  readonly 'forum-popularity': {
    readonly request: { readonly code: string };
    readonly result: ForumPopularitySnapshot;
  };
  readonly 'forum-hot-list': {
    readonly request: { readonly limit: number };
    readonly result: ForumHotListSnapshot;
  };
};

/** 单个股吧数据源适配器（当前只有东方财富）。 */
export interface ForumAdapterLike {
  readonly name: string;
  fetchForumPosts(input: {
    readonly code: string;
    readonly pages: number;
  }): Promise<ForumPostsSnapshot>;
  fetchForumPopularity(code: string): Promise<ForumPopularitySnapshot>;
  fetchForumHotList(limit: number): Promise<ForumHotListSnapshot>;
}
