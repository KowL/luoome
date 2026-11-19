import type { ToolContext } from '@luoome/core';
import { deriveAccountFacts } from '@luoome/toolkit/tools/account-facts.js';

/**
 * 判断所需的账户/新闻/板块事实。
 *
 * 每一段都必须显式表达「有」或「为什么没有」：静默省略会让模型把缺失当默认，
 * 再把缺失写进结论（历史上 36% 的兜底建议就是这么来的）。
 */
export type ContextSection<T> =
  | { readonly status: 'ok'; readonly data: T }
  | { readonly status: 'unavailable'; readonly reason: string };

export interface AccountContext {
  readonly cashBalance: number;
  readonly totalAssets: number | null;
  readonly status: 'complete' | 'unavailable';
  readonly reasons: readonly string[];
  readonly positions: ReadonlyArray<{
    readonly stockId: string;
    readonly quantity: number;
    readonly marketValue: number;
    readonly industry?: string;
  }>;
}

export interface NewsContext {
  readonly items: ReadonlyArray<{
    readonly title: string;
    readonly summary: string;
    readonly source: string;
    readonly publishedAt: string;
  }>;
}

export interface SectorContext {
  readonly memberships: readonly unknown[];
}

export interface JudgmentContext {
  readonly account: ContextSection<AccountContext>;
  readonly news: ContextSection<NewsContext>;
  readonly sectors: ContextSection<SectorContext>;
}

const NEWS_LIMIT = 5;
const SUMMARY_MAX = 120;

const unavailable = <T>(reason: string): ContextSection<T> => ({ status: 'unavailable', reason });

const buildAccountSection = async (ctx: ToolContext): Promise<ContextSection<AccountContext>> => {
  let facts: Awaited<ReturnType<typeof deriveAccountFacts>>;
  try {
    facts = await deriveAccountFacts(ctx);
  } catch (error) {
    return unavailable(`账户事实不可用：${error instanceof Error ? error.message : '未知错误'}`);
  }
  if (facts === null) return unavailable('账户不存在');
  return {
    status: 'ok',
    data: {
      cashBalance: facts.cashBalance,
      totalAssets: facts.totalAssets ?? null,
      status: facts.status,
      reasons: facts.reasons,
      positions: facts.positions.map((position) => ({
        stockId: position.stockId,
        quantity: position.quantity,
        marketValue: position.marketValue,
        ...(position.industry === undefined ? {} : { industry: position.industry }),
      })),
    },
  };
};

const buildNewsSection = async (
  ctx: ToolContext,
  stockName: string,
): Promise<ContextSection<NewsContext>> => {
  const news = ctx.adapters.marketIntel?.news;
  if (news === undefined) return unavailable('未配置新闻数据源');
  try {
    const result = await news.fetchNews({ keyword: stockName, limit: NEWS_LIMIT, page: 1 });
    if (!result.ok || result.data === undefined) {
      return unavailable(`新闻拉取失败：${result.error?.message ?? 'unknown'}`);
    }
    return {
      status: 'ok',
      data: {
        items: result.data.items.slice(0, NEWS_LIMIT).map((item) => ({
          title: item.title,
          summary: item.summary.slice(0, SUMMARY_MAX),
          source: item.source,
          publishedAt: item.publishedAt.toISOString(),
        })),
      },
    };
  } catch (error) {
    return unavailable(`新闻拉取异常：${error instanceof Error ? error.message : '未知错误'}`);
  }
};

const buildSectorSection = async (
  ctx: ToolContext,
  stockId: string,
): Promise<ContextSection<SectorContext>> => {
  try {
    const memberships = await ctx.repos.sectorCatalog.listByStock({ stockIds: [stockId] });
    if (memberships.length === 0) return unavailable('该标的当前没有行业/概念归属记录');
    return { status: 'ok', data: { memberships } };
  } catch (error) {
    return unavailable(`板块归属查询失败：${error instanceof Error ? error.message : '未知错误'}`);
  }
};

export const buildJudgmentContext = async (
  ctx: ToolContext,
  stock: { readonly id: string; readonly name: string },
): Promise<JudgmentContext> => {
  const [account, news, sectors] = await Promise.all([
    buildAccountSection(ctx),
    buildNewsSection(ctx, stock.name),
    buildSectorSection(ctx, stock.id),
  ]);
  return { account, news, sectors };
};
