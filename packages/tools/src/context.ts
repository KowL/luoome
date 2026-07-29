import type {
  AgentRuntimeLike,
  AShareSentimentManagerLike,
  LimitUpLadderManagerLike,
  LLMAdapterLike,
  Logger,
  MarketDataAdapterLike,
  RepositoryRegistry,
  StockUniverseManagerLike,
  ToolContext,
} from '@luoome/core';
import { BUILTIN_TACTICS } from '@luoome/core';

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
  readonly user?: {
    readonly id: string;
    readonly defaultAccountId: string;
  };
  /** Phase 1：连板天梯 manager（docs/ddd/limit-up-ladder-detailed-design.md §5）。 */
  readonly limitUpLadder?: LimitUpLadderManagerLike;
  readonly ashareSentiment?: AShareSentimentManagerLike;
}

/** 幂等装载领域内置战法；各 surface 在开放 tool 前统一调用。 */
export const ensureBuiltinTactics = async (
  repos: Pick<RepositoryRegistry, 'tactic'>,
): Promise<void> => {
  for (const tactic of BUILTIN_TACTICS) {
    await repos.tactic.save(tactic);
  }
};

/** Production composition root used by CLI, TUI, Web, and MCP surfaces. */
export const buildContext = (input: BuildContextInput): ToolContext => {
  const ctx: ToolContext = {
    repos: input.repos,
    adapters: input.adapters,
    user: input.user ?? { id: 'local-user', defaultAccountId: '' },
    clock: input.clock ?? (() => new Date()),
    logger: input.logger ?? console,
    ...(input.agent !== undefined ? { agent: input.agent } : {}),
    ...(input.ashareSentiment === undefined ? {} : { ashareSentiment: input.ashareSentiment }),
  };
  if (input.limitUpLadder !== undefined) {
    return { ...ctx, limitUpLadder: input.limitUpLadder };
  }
  return ctx;
};
