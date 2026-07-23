import type {
  LLMAdapterLike,
  Logger,
  MarketDataAdapterLike,
  RepositoryRegistry,
  ToolContext,
} from '@luoome/core';

export interface BuildContextInput {
  readonly repos: RepositoryRegistry;
  readonly adapters: {
    readonly market: MarketDataAdapterLike;
    readonly llm: LLMAdapterLike;
  };
  readonly clock?: () => Date;
  readonly logger?: Logger;
  readonly user?: {
    readonly id: string;
    readonly defaultAccountId: string;
  };
}

/** Production composition root used by CLI, TUI, Web, and MCP surfaces. */
export const buildContext = (input: BuildContextInput): ToolContext => ({
  repos: input.repos,
  adapters: input.adapters,
  user: input.user ?? { id: 'local-user', defaultAccountId: '' },
  clock: input.clock ?? (() => new Date()),
  logger: input.logger ?? console,
});
