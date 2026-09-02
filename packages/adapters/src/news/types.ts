import type { NewsList } from '@luoome/core';

/**
 * NewsManager 接口。
 *
 * 不放在 core：因为 core 不能依赖 adapters 包（ARCHITECTURE §3 依赖方向）。
 * Manager 自身实现放在 adapters/news/manager.ts；core/context.ts 只引用本接口。
 */

/** Manager 返回的完整列表快照（与 core NewsList 相同）。 */
export type NewsManagerResult = NewsList;

/** manager.fetchNews 错误（recoverable 用于决定调用方是否重试）。 */
export interface NewsError {
  readonly kind: 'adapter_error';
  readonly adapter: 'news';
  readonly message: string;
  readonly recoverable: boolean;
}

export type NewsResult =
  | { readonly ok: true; readonly data: NewsManagerResult }
  | { readonly ok: false; readonly error: NewsError };

/** adapter / source 一次要闻拉取的完整结果。 */
export interface NewsFetchResult {
  readonly items: NewsRawItem[];
}

/** 单个财经要闻数据源适配器；name 用于错误 / 日志标识。 */
export interface NewsAdapterLike {
  readonly name: string;
  /** 拉取指定页要闻（按发布时间倒序）；无数据时返回空 items，不抛错。 */
  fetchNews(page: number, pageSize: number): Promise<NewsFetchResult>;
}

/** 财经要闻域的 capability map（SourceRegistry 实例化，§6.2）。 */
export type NewsCapabilityMap = {
  readonly 'finance-news': {
    readonly request: { readonly page: number; readonly pageSize: number };
    readonly result: NewsFetchResult;
  };
};

/** 数据源 adapter 返回的原始条目（snake_case，协议层）。 */
export interface NewsRawItem {
  readonly id: string;
  readonly title: string;
  readonly summary?: string | undefined;
  readonly source?: string | undefined;
  /** ISO 时间（上游 Asia/Shanghai 时刻已显式按 +08:00 解析）。 */
  readonly published_at: string;
  readonly url?: string | undefined;
}
