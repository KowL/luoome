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
import { BUILTIN_STRATEGIES } from '@luoome/core';

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

/** 幂等装载内置 Strategy 静态种子（同 id 已存在则跳过，不覆盖用户同名策略）。 */
export const ensureBuiltinStrategies = async (
  repos: Pick<RepositoryRegistry, 'strategy'>,
): Promise<void> => {
  const strategies = [...(await repos.strategy.list())];
  for (const bundle of BUILTIN_STRATEGIES) {
    if (strategies.some((strategy) => strategy.id === bundle.strategy.id)) continue;
    await repos.strategy.save(bundle.strategy);
    await repos.strategy.saveVersion(bundle.version);
    strategies.push(bundle.strategy);
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
