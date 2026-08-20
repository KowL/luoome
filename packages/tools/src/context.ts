import type {
  AgentRuntimeLike,
  AShareSentimentManagerLike,
  LimitUpLadderManagerLike,
  LLMAdapterLike,
  Logger,
  MarketDataAdapterLike,
  NotificationManagerLike,
  RepositoryRegistry,
  ResearchEmbeddingAdapterLike,
  ResearchRemoteImportAdapterLike,
  ResearchVaultAdapterLike,
  StockUniverseManagerLike,
  ToolContext,
} from '@luoome/core';

export interface BuildContextInput {
  readonly repos: RepositoryRegistry;
  readonly adapters: {
    readonly market: MarketDataAdapterLike;
    readonly stockUniverse?: StockUniverseManagerLike;
    readonly llm: LLMAdapterLike;
  };
  readonly agent?: AgentRuntimeLike;
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
  readonly ashareSentiment?: AShareSentimentManagerLike;
  readonly researchVault?: ResearchVaultAdapterLike;
  readonly researchRemote?: ResearchRemoteImportAdapterLike;
  readonly researchEmbedding?: ResearchEmbeddingAdapterLike;
  readonly notification?: NotificationManagerLike;
  readonly portfolioBenchmark?: ToolContext['portfolioBenchmark'];
}

/** Production composition root used by CLI, TUI, Web, and MCP surfaces. */
export const buildContext = (input: BuildContextInput): ToolContext => {
  const ctx: ToolContext = {
    repos: input.repos,
    adapters: input.adapters,
    user: input.user ?? { id: 'local-user', defaultAccountId: '' },
    clock: input.clock ?? (() => new Date()),
    logger: input.logger ?? console,
    ...(input.auditLog === undefined ? {} : { auditLog: input.auditLog }),
    ...(input.auditCaller === undefined ? {} : { auditCaller: input.auditCaller }),
    ...(input.agent !== undefined ? { agent: input.agent } : {}),
    ...(input.ashareSentiment === undefined ? {} : { ashareSentiment: input.ashareSentiment }),
    ...(input.researchVault === undefined ? {} : { researchVault: input.researchVault }),
    ...(input.researchRemote === undefined ? {} : { researchRemote: input.researchRemote }),
    ...(input.researchEmbedding === undefined
      ? {}
      : { researchEmbedding: input.researchEmbedding }),
    ...(input.notification === undefined ? {} : { notification: input.notification }),
    ...(input.portfolioBenchmark === undefined
      ? {}
      : { portfolioBenchmark: input.portfolioBenchmark }),
  };
  if (input.limitUpLadder !== undefined) {
    return { ...ctx, limitUpLadder: input.limitUpLadder };
  }
  return ctx;
};
