import type {
  AgentRuntimeLike,
  AShareSentimentManagerLike,
  LimitUpLadderManagerLike,
  LLMAdapterLike,
  Logger,
  MarketDataAdapterLike,
  RepositoryRegistry,
  ResearchRemoteImportAdapterLike,
  ResearchVaultAdapterLike,
  StockUniverseManagerLike,
  ToolContext,
} from '@luoome/core';
import { BUILTIN_STRATEGIES, InvariantError } from '@luoome/core';

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
  readonly researchVault?: ResearchVaultAdapterLike;
  readonly researchRemote?: ResearchRemoteImportAdapterLike;
}

/** 幂等装载并协调 builtin revision；不覆盖用户同名 Strategy。 */
export const ensureBuiltinStrategies = async (
  repos: Pick<RepositoryRegistry, 'strategy'>,
): Promise<void> => {
  for (const bundle of BUILTIN_STRATEGIES) {
    const existing = await repos.strategy.findById(bundle.strategy.id);
    if (existing === null) {
      await repos.strategy.create(bundle.strategy);
      await repos.strategy.createVersion(bundle.version);
      continue;
    }
    if (existing.owner !== 'builtin') continue;

    const versions = await repos.strategy.listVersions(existing.id);
    const target = versions.find((version) => version.id === bundle.version.id);
    if (target !== undefined && target.definitionHash !== bundle.version.definitionHash) {
      throw new InvariantError(`builtin revision hash 冲突: ${bundle.version.id}`);
    }
    if (target === undefined) {
      const latest = versions.at(-1);
      if (latest !== undefined && latest.version >= bundle.version.version) {
        throw new InvariantError(`builtin revision 序号冲突: ${bundle.version.id}`);
      }
      await repos.strategy.createVersion({
        ...bundle.version,
        ...(existing.currentVersionId === undefined
          ? {}
          : { parentVersionId: existing.currentVersionId }),
      });
    }
    if (existing.currentVersionId !== bundle.version.id) {
      await repos.strategy.activateVersion(
        existing.id,
        bundle.version.id,
        bundle.strategy.updatedAt,
      );
    }
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
    ...(input.researchVault === undefined ? {} : { researchVault: input.researchVault }),
    ...(input.researchRemote === undefined ? {} : { researchRemote: input.researchRemote }),
  };
  if (input.limitUpLadder !== undefined) {
    return { ...ctx, limitUpLadder: input.limitUpLadder };
  }
  return ctx;
};
