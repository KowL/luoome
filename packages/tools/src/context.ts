import type {
  AShareSentimentManagerLike,
  DragonTigerManagerLike,
  FundamentalDataAdapterLike,
  LimitUpLadderManagerLike,
  LocalExecutionIdentity,
  Logger,
  MarketDataAdapterLike,
  NewsManagerLike,
  NorthboundFlowManagerLike,
  NotificationManagerLike,
  RepositoryRegistry,
  ResearchEmbeddingAdapterLike,
  ResearchRemoteImportAdapterLike,
  ResearchVaultAdapterLike,
  ResearchVaultGitSyncAdapterLike,
  SectorQuoteManagerLike,
  StockProfileManagerLike,
  StockUniverseManagerLike,
  ToolContext,
} from '@luoome/core';
import { ExecutionIdentitySchema } from '@luoome/core';

export interface BuildContextDependencies {
  readonly repos: RepositoryRegistry;
  readonly adapters: {
    readonly market: MarketDataAdapterLike;
    readonly stockUniverse?: StockUniverseManagerLike;
  };
  readonly clock?: () => Date;
  readonly logger?: Logger;
  readonly auditLog?: ToolContext['auditLog'];
  readonly auditCaller?: string;
  readonly user?: {
    readonly id: string;
    readonly defaultAccountId: string;
  };
  /** Phase 1：连板天梯 manager（docs/ddd/limit-up-ladder-detailed-design.md §5）。 */
  readonly limitUpLadder?: LimitUpLadderManagerLike;
  /** 龙虎榜 manager（只读；东方财富数据中心公开报表）。 */
  readonly dragonTiger?: DragonTigerManagerLike;
  /** 个股档案 manager（只读；东方财富数据中心公开报表）。 */
  readonly stockProfile?: StockProfileManagerLike;
  /** 北向资金历史流 manager（只读；东方财富数据中心公开报表）。 */
  readonly northboundFlow?: NorthboundFlowManagerLike;
  /** 财经要闻 manager（只读；东方财富公开新闻 API）。 */
  readonly news?: NewsManagerLike;
  /** 行业板块行情 manager（只读；东方财富 push2 板块列表公开 API）。 */
  readonly sectorQuote?: SectorQuoteManagerLike;
  readonly ashareSentiment?: AShareSentimentManagerLike;
  readonly researchVault?: ResearchVaultAdapterLike;
  readonly researchRemote?: ResearchRemoteImportAdapterLike;
  readonly researchEmbedding?: ResearchEmbeddingAdapterLike;
  readonly researchVaultGitSync?: ResearchVaultGitSyncAdapterLike;
  readonly notification?: NotificationManagerLike;
  readonly portfolioBenchmark?: ToolContext['portfolioBenchmark'];
  /** Phase 3 P3-1：只从显式基本面 adapter 读取，未注入时 sync 保持 unavailable。 */
  readonly fundamentalData?: FundamentalDataAdapterLike;
}

export type BuildContextInput = BuildContextDependencies & {
  readonly mode?: 'local';
  readonly identity?: Readonly<LocalExecutionIdentity>;
};

/** Production composition root used by CLI, TUI, Web, and MCP surfaces. */
export const buildContext = (input: BuildContextInput): ToolContext => {
  const identity = Object.freeze(
    ExecutionIdentitySchema.parse(
      input.identity ?? { mode: 'local' as const, userId: input.user?.id ?? 'local-user' },
    ),
  );
  const user = input.user ?? { id: identity.userId, defaultAccountId: '' };
  if (user.id !== identity.userId) {
    throw new Error('Tool context user does not match execution identity');
  }
  const ctx: ToolContext = {
    identity,
    repos: input.repos,
    adapters: input.adapters,
    user,
    clock: input.clock ?? (() => new Date()),
    logger: input.logger ?? console,
    ...(input.auditLog === undefined ? {} : { auditLog: input.auditLog }),
    ...(input.auditCaller === undefined ? {} : { auditCaller: input.auditCaller }),
    ...(input.ashareSentiment === undefined ? {} : { ashareSentiment: input.ashareSentiment }),
    ...(input.researchVault === undefined ? {} : { researchVault: input.researchVault }),
    ...(input.researchRemote === undefined ? {} : { researchRemote: input.researchRemote }),
    ...(input.researchEmbedding === undefined
      ? {}
      : { researchEmbedding: input.researchEmbedding }),
    ...(input.researchVaultGitSync === undefined
      ? {}
      : { researchVaultGitSync: input.researchVaultGitSync }),
    ...(input.notification === undefined ? {} : { notification: input.notification }),
    ...(input.portfolioBenchmark === undefined
      ? {}
      : { portfolioBenchmark: input.portfolioBenchmark }),
    ...(input.fundamentalData === undefined ? {} : { fundamentalData: input.fundamentalData }),
    ...(input.dragonTiger === undefined ? {} : { dragonTiger: input.dragonTiger }),
    ...(input.stockProfile === undefined ? {} : { stockProfile: input.stockProfile }),
    ...(input.northboundFlow === undefined ? {} : { northboundFlow: input.northboundFlow }),
    ...(input.news === undefined ? {} : { news: input.news }),
    ...(input.sectorQuote === undefined ? {} : { sectorQuote: input.sectorQuote }),
  };
  if (input.limitUpLadder !== undefined) {
    return { ...ctx, limitUpLadder: input.limitUpLadder };
  }
  return ctx;
};
