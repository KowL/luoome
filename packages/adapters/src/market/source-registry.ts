import type {
  DailyBar,
  DateRange,
  IndexQuote,
  IntradayMinute,
  MarketCoverage,
  MarketSnapshot,
  MarketSnapshotItem,
  MinuteBar,
  MinuteBarInterval,
  Quote,
  StockSearchCandidate,
} from '@luoome/core';

export type MarketCapability =
  | 'quote'
  | 'daily-bars'
  | 'search'
  | 'market-snapshot'
  | 'market-snapshot-envelope'
  | 'realtime-index'
  | 'delayed-index'
  | 'intraday-minutes'
  | 'minute-bars';

interface CapabilityRequestMap {
  readonly quote: { readonly stockId: string };
  readonly 'daily-bars': { readonly stockId: string; readonly range: DateRange };
  readonly search: { readonly query: string };
  readonly 'market-snapshot': { readonly coverage: MarketCoverage };
  readonly 'market-snapshot-envelope': { readonly coverage: MarketCoverage };
  readonly 'realtime-index': { readonly coverage: MarketCoverage };
  readonly 'delayed-index': { readonly coverage: MarketCoverage; readonly asOf: Date };
  readonly 'intraday-minutes': { readonly stockId: string };
  readonly 'minute-bars': { readonly stockId: string; readonly interval: MinuteBarInterval };
}

interface CapabilityResultMap {
  readonly quote: Quote;
  readonly 'daily-bars': readonly DailyBar[];
  readonly search: readonly StockSearchCandidate[];
  readonly 'market-snapshot': readonly MarketSnapshotItem[];
  readonly 'market-snapshot-envelope': MarketSnapshot;
  readonly 'realtime-index': readonly IndexQuote[];
  readonly 'delayed-index': readonly IndexQuote[];
  readonly 'intraday-minutes': readonly IntradayMinute[];
  readonly 'minute-bars': readonly MinuteBar[];
}

export interface MarketCapabilityBinding<C extends MarketCapability = MarketCapability> {
  readonly capability: C;
  readonly source: string;
  readonly coverage: readonly MarketCoverage[];
  readonly configurationReady: boolean;
  execute(input: CapabilityRequestMap[C]): Promise<CapabilityResultMap[C]>;
  dataAsOf?(result: CapabilityResultMap[C]): Date | undefined;
}

export type AnyMarketCapabilityBinding = {
  [C in MarketCapability]: MarketCapabilityBinding<C>;
}[MarketCapability];

export interface MarketCapabilityHandle<C extends MarketCapability> {
  readonly capability: C;
  readonly source: string;
  readonly coverage: readonly MarketCoverage[];
  execute(input: CapabilityRequestMap[C]): Promise<CapabilityResultMap[C]>;
}

export interface MarketSourceStatus {
  readonly dataset: MarketCapability;
  readonly source: string;
  readonly coverage: readonly MarketCoverage[];
  readonly capabilityEnabled: true;
  readonly configurationReady: boolean;
  readonly lastAttemptAt?: Date;
  readonly lastSuccessAt?: Date;
  readonly dataAsOf?: Date;
  readonly lastErrorKind?: string;
}

interface MutableObservation {
  lastAttemptAt?: Date;
  lastSuccessAt?: Date;
  dataAsOf?: Date;
  lastErrorKind?: string;
}

export class MarketSourceRegistry {
  private readonly observations = new Map<string, MutableObservation>();

  constructor(
    private readonly bindings: readonly AnyMarketCapabilityBinding[],
    private readonly clock: () => Date,
  ) {
    const keys = new Set<string>();
    for (const binding of bindings) {
      const key = this.keyOf(binding.source, binding.capability);
      if (keys.has(key)) {
        throw new Error(`duplicate market capability binding: ${key}`);
      }
      if (!binding.configurationReady) {
        throw new Error(`market source configuration not ready: ${key}`);
      }
      keys.add(key);
    }
  }

  sources<C extends MarketCapability>(
    capability: C,
    constraint?: { readonly coverage?: MarketCoverage },
  ): readonly MarketCapabilityHandle<C>[] {
    return this.bindings.flatMap((binding) => {
      if (binding.capability !== capability) return [];
      if (constraint?.coverage !== undefined && !binding.coverage.includes(constraint.coverage)) {
        return [];
      }
      const typed = binding as MarketCapabilityBinding<C>;
      return [
        {
          capability,
          source: typed.source,
          coverage: typed.coverage,
          execute: async (input: CapabilityRequestMap[C]): Promise<CapabilityResultMap[C]> => {
            const key = this.keyOf(typed.source, capability);
            const observation = this.observations.get(key) ?? {};
            observation.lastAttemptAt = this.clock();
            this.observations.set(key, observation);
            try {
              const result = await typed.execute(input);
              observation.lastSuccessAt = this.clock();
              delete observation.lastErrorKind;
              const dataAsOf = typed.dataAsOf?.(result);
              if (dataAsOf === undefined) delete observation.dataAsOf;
              else observation.dataAsOf = dataAsOf;
              return result;
            } catch (error) {
              observation.lastErrorKind = errorKind(error);
              throw error;
            }
          },
        },
      ];
    });
  }

  describe(): readonly MarketSourceStatus[] {
    return this.bindings.map((binding) => {
      const observation = this.observations.get(this.keyOf(binding.source, binding.capability));
      return {
        dataset: binding.capability,
        source: binding.source,
        coverage: binding.coverage,
        capabilityEnabled: true,
        configurationReady: binding.configurationReady,
        ...(observation?.lastAttemptAt === undefined
          ? {}
          : { lastAttemptAt: observation.lastAttemptAt }),
        ...(observation?.lastSuccessAt === undefined
          ? {}
          : { lastSuccessAt: observation.lastSuccessAt }),
        ...(observation?.dataAsOf === undefined ? {} : { dataAsOf: observation.dataAsOf }),
        ...(observation?.lastErrorKind === undefined
          ? {}
          : { lastErrorKind: observation.lastErrorKind }),
      };
    });
  }

  private keyOf(source: string, capability: MarketCapability): string {
    return `${source}:${capability}`;
  }
}

const errorKind = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error);
  const match =
    /(?:^|\b)(network|timeout|rate_limited|permission|unsupported_market|unsupported_capability|unsupported_adjustment|no_data|partial_data|invalid_payload)(?::|\b)/.exec(
      message,
    );
  return match?.[1] ?? 'unknown';
};
