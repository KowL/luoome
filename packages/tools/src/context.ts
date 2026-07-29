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
import { BUILTIN_TACTICS, mapLegacyTacticToStrategy } from '@luoome/core';

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

/** 幂等装载内置 Strategy；不再向只读 legacy Tactic 表写入。 */
export const ensureBuiltinStrategies = async (
  repos: Pick<RepositoryRegistry, 'strategy'>,
): Promise<void> => {
  const strategies = await repos.strategy.list();
  const occupied = new Set(strategies.map((strategy) => strategy.id));
  const nextTargetId = (tacticId: string): string => {
    if (!occupied.has(tacticId)) return tacticId;
    const base = `legacy-tactic-${tacticId}`;
    if (!occupied.has(base)) return base;
    let suffix = 2;
    while (occupied.has(`${base}-${suffix}`)) suffix += 1;
    return `${base}-${suffix}`;
  };

  for (const tactic of BUILTIN_TACTICS) {
    const existing = strategies.find((strategy) => strategy.id === tactic.id);
    if (existing?.currentVersionId !== undefined) continue;
    const bundle = mapLegacyTacticToStrategy(tactic, nextTargetId(tactic.id));
    occupied.add(bundle.strategy.id);
    await repos.strategy.save(bundle.strategy);
    await repos.strategy.saveVersion(bundle.version);
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
