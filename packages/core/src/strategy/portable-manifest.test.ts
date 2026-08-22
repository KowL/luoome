import { describe, expect, it } from 'vitest';

import {
  type StrategyDslV1,
  type StrategyVersion,
  strategyDefinitionHash,
} from '../entity/strategy.js';
import {
  buildStrategyResearchManifest,
  canonicalStrategyResearchManifestJson,
  strategyResearchManifestHash,
  validateStrategyResearchManifest,
} from './portable-manifest.js';

const definition = (): StrategyDslV1 => ({
  schemaVersion: 1,
  metadata: { style: 'momentum', horizon: 'short' },
  universe: { coverage: 'CN_A_SHARES_SH_SZ', excludeStockIds: [] },
  selection: {
    logic: 'all',
    rules: [
      {
        id: 'positive-close',
        name: '收盘价有效',
        when: 'quote.close > 0',
        evidence: ['close={{quote.close}}'],
      },
    ],
  },
  signals: { entry: [], exit: [], risk: [] },
});

const version = (): StrategyVersion => {
  const strategyDefinition = definition();
  return {
    id: 'portable-strategy-v1',
    strategyId: 'portable-strategy',
    version: 1,
    definition: strategyDefinition,
    definitionHash: strategyDefinitionHash(strategyDefinition),
    validationStatus: 'valid',
    validationErrors: [],
    createdAt: new Date('2026-08-01T00:00:00.000Z'),
  };
};

describe('portable strategy research manifest', () => {
  it('builds a canonical, dependency-complete manifest', () => {
    const manifest = buildStrategyResearchManifest(version());
    const result = validateStrategyResearchManifest(manifest);

    expect(result.status).toBe('supported');
    expect(manifest.strategy.definitionHash).toBe(version().definitionHash);
    expect(manifest.dependencies.capabilities).toEqual(['market.quote', 'universe.cn-a-shares']);
    expect(manifest.dependencies.fields).toMatchObject([
      { path: 'quote.close', dataSource: 'quote' },
    ]);
    expect(manifest.datasets).toEqual([
      {
        role: 'quote',
        id: 'quote-snapshot',
        version: 'v1',
        coverage: 'CN_A_SHARES_SH_SZ',
      },
      {
        role: 'universe',
        id: 'cn-a-shares-universe',
        version: 'v1',
        coverage: 'CN_A_SHARES_SH_SZ',
      },
    ]);
    expect(manifest.timeSlice).toMatchObject({
      kind: 'point-in-time',
      futureDataPolicy: 'available-as-of',
    });
    expect(manifest.execution).toMatchObject({
      model: 'deterministic-rule-evaluator',
      unknownPolicy: 'propagate',
    });
    expect(canonicalStrategyResearchManifestJson(manifest)).toBe(result.canonicalJson);
    expect(strategyResearchManifestHash(manifest)).toBe(result.manifestHash);
  });

  it('canonicalizes ordering without changing the manifest identity', () => {
    const manifest = buildStrategyResearchManifest(version());
    const reordered = {
      ...manifest,
      dependencies: {
        ...manifest.dependencies,
        capabilities: [...manifest.dependencies.capabilities].reverse(),
        fields: [...manifest.dependencies.fields].reverse(),
      },
      datasets: [...manifest.datasets].reverse(),
      execution: { ...manifest.execution, modes: [...manifest.execution.modes].reverse() },
    };

    expect(canonicalStrategyResearchManifestJson(reordered)).toBe(
      canonicalStrategyResearchManifestJson(manifest),
    );
    expect(strategyResearchManifestHash(reordered)).toBe(strategyResearchManifestHash(manifest));
    expect(validateStrategyResearchManifest(reordered).status).toBe('supported');
  });

  it('reports unsupported capabilities and evaluator metadata explicitly', () => {
    const manifest = buildStrategyResearchManifest(version());
    const unsupported = {
      ...manifest,
      dependencies: {
        ...manifest.dependencies,
        capabilities: [...manifest.dependencies.capabilities, 'market.vendor-proprietary'],
      },
      evaluator: { ...manifest.evaluator, id: 'vendor.evaluator', version: 'v9' },
    };

    const result = validateStrategyResearchManifest(unsupported);
    expect(result.status).toBe('unsupported');
    expect(result.unsupported.capabilities).toContain('market.vendor-proprietary');
    expect(result.unsupported.evaluator).toEqual(['vendor.evaluator@v9/schema-1']);
    expect(result.errors).toEqual([]);
  });

  it('rejects missing dependencies, changed definition hashes, and unknown DSL fields', () => {
    const manifest = buildStrategyResearchManifest(version());
    const missingDependency = {
      ...manifest,
      dependencies: {
        ...manifest.dependencies,
        capabilities: ['universe.cn-a-shares'],
      },
    };
    expect(validateStrategyResearchManifest(missingDependency)).toMatchObject({
      status: 'invalid',
      errors: expect.arrayContaining([expect.stringContaining('market.quote')]),
    });

    const changedHash = {
      ...manifest,
      strategy: { ...manifest.strategy, definitionHash: '0'.repeat(64) },
    };
    expect(validateStrategyResearchManifest(changedHash)).toMatchObject({
      status: 'invalid',
      errors: expect.arrayContaining([expect.stringContaining('definitionHash')]),
    });

    const unknownField = {
      ...manifest,
      strategy: {
        ...manifest.strategy,
        definition: { ...manifest.strategy.definition, futureDslField: true },
      },
    };
    const unknownResult = validateStrategyResearchManifest(unknownField);
    expect(unknownResult.status).toBe('invalid');
    expect(unknownResult.errors).toEqual(
      expect.arrayContaining([expect.stringContaining('futureDslField')]),
    );
  });
});
