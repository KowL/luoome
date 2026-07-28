import {
  type Logger,
  type MarketCoverage,
  type StockUniverseManagerLike,
  type StockUniverseSnapshot,
  StockUniverseSnapshotSchema,
  type StockUniverseSourceLike,
} from '@luoome/core';

export interface StockUniverseManagerOptions {
  readonly sources: readonly StockUniverseSourceLike[];
  readonly logger: Logger;
}

export class StockUniverseManager implements StockUniverseManagerLike {
  readonly name = 'stock-universe';
  readonly sources: readonly string[];

  private readonly sourceAdapters: readonly StockUniverseSourceLike[];
  private readonly logger: Logger;

  constructor(options: StockUniverseManagerOptions) {
    if (options.sources.length === 0) {
      throw new Error('stock universe manager requires at least one source');
    }
    this.sourceAdapters = options.sources;
    this.sources = options.sources.map((source) => source.name);
    this.logger = options.logger;
  }

  async fetchStockUniverse(input: {
    readonly coverage: MarketCoverage;
    readonly source?: string;
  }): Promise<StockUniverseSnapshot> {
    const candidates =
      input.source === undefined
        ? this.sourceAdapters
        : this.sourceAdapters.filter((source) => source.name === input.source);
    if (candidates.length === 0) {
      throw new Error(`unsupported_capability: stock universe source ${input.source}`);
    }

    const failures: string[] = [];
    for (const source of candidates) {
      if (!source.coverage.includes(input.coverage)) {
        failures.push(`${source.name}: unsupported_market`);
        continue;
      }
      try {
        const snapshot = StockUniverseSnapshotSchema.parse(
          await source.fetchStockUniverse(input.coverage),
        );
        if (snapshot.source !== source.name || snapshot.coverage !== input.coverage) {
          throw new Error('invalid_payload: source or coverage mismatch');
        }
        return snapshot;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failures.push(`${source.name}: ${message}`);
        this.logger.warn('stockUniverse.fetch source failed', {
          source: source.name,
          coverage: input.coverage,
          error: message,
        });
      }
    }
    throw new Error(`all stock universe sources failed: ${failures.join('; ')}`);
  }
}
