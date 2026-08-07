import { describe, expect, it } from 'vitest';

import { InvariantError } from '../error/index.js';
import {
  assertStrategyInvariants,
  assertStrategyRunInvariants,
  assertStrategyVersionInvariants,
  canonicalStrategyDefinitionJson,
  getStrategyRunDataHealth,
  isUsableStrategyRun,
  type StrategyDslV1,
  type StrategyRun,
  type StrategyVersion,
  strategyDefinitionHash,
} from './strategy.js';

const definition = (): StrategyDslV1 => ({
  schemaVersion: 1,
  metadata: { style: 'momentum' },
  universe: { coverage: 'CN_A_SHARES_SH_SZ', excludeStockIds: [] },
  selection: {
    logic: 'all',
    rules: [{ id: 'rule-1', name: 'Rule', when: 'true', evidence: ['matched'] }],
  },
  signals: { entry: [], exit: [], risk: [] },
});

describe('Strategy entity', () => {
  it('canonical JSON 不受对象 key 顺序影响，hash 稳定', () => {
    const left = definition();
    const right = {
      signals: { risk: [], exit: [], entry: [] },
      selection: left.selection,
      universe: left.universe,
      metadata: left.metadata,
      schemaVersion: 1,
    } satisfies StrategyDslV1;
    expect(canonicalStrategyDefinitionJson(left)).toBe(canonicalStrategyDefinitionJson(right));
    expect(strategyDefinitionHash(left)).toMatch(/^[a-f0-9]{64}$/);
    expect(strategyDefinitionHash(left)).toBe(strategyDefinitionHash(right));
  });

  it('active Strategy 需要 currentVersionId', () => {
    expect(() =>
      assertStrategyInvariants({
        id: 'strategy-1',
        name: 'Strategy',
        description: 'description',
        owner: 'user',
        status: 'active',
        createdAt: new Date(0),
        updatedAt: new Date(0),
      }),
    ).toThrow(InvariantError);
  });

  it('用户 version 不能零 selection，builtin/migration 来源可以', () => {
    const emptySelection: StrategyDslV1 = {
      ...definition(),
      selection: { logic: 'all', rules: [] },
    };
    const version: StrategyVersion = {
      id: 'strategy-1-v1',
      strategyId: 'strategy-1',
      version: 1,
      definition: emptySelection,
      definitionHash: strategyDefinitionHash(emptySelection),
      validationStatus: 'pending',
      validationErrors: [],
      createdAt: new Date(0),
    };
    expect(() => assertStrategyVersionInvariants(version, 'builtin')).not.toThrow();
    expect(() => assertStrategyVersionInvariants(version, 'migration')).not.toThrow();
    expect(() => assertStrategyVersionInvariants(version, 'user')).toThrow(/至少需要一条/);
  });

  it('终态 run 必须 finished，failed 必须 error', () => {
    expect(() =>
      assertStrategyRunInvariants({
        id: 'run-1',
        strategyId: 'strategy-1',
        strategyVersionId: 'strategy-1-v1',
        mode: 'scan',
        coverage: 'CN_A_SHARES_SH_SZ',
        dataAsOf: new Date(0),
        startedAt: new Date(0),
        status: 'failed',
        inputSnapshot: {},
        providerStatuses: [],
      }),
    ).toThrow(InvariantError);
  });

  it('separates terminal execution status from data health and normalizes legacy partial runs', () => {
    const base: StrategyRun = {
      id: 'run-1',
      strategyId: 'strategy-1',
      strategyVersionId: 'strategy-1-v1',
      mode: 'scan',
      coverage: 'CN_A_SHARES_SH_SZ',
      dataAsOf: new Date(0),
      startedAt: new Date(0),
      finishedAt: new Date(0),
      status: 'complete',
      inputSnapshot: {},
      providerStatuses: [],
      summary: {
        schemaVersion: 3,
        dataHealth: 'partial',
        universeCount: 2,
        evaluatedCount: 1,
        selectedCount: 1,
        signalCount: 1,
        incompleteCount: 0,
        failedCount: 1,
        failureSamples: [{ stockId: '000002.SZ', error: 'quote unavailable' }],
      },
    };
    expect(getStrategyRunDataHealth(base)).toBe('partial');
    expect(isUsableStrategyRun(base)).toBe(true);

    const legacyPartial: StrategyRun = {
      ...base,
      status: 'partial',
      summary: {
        schemaVersion: 2,
        universeCount: 2,
        evaluatedCount: 1,
        selectedCount: 1,
        signalCount: 1,
        partialCount: 0,
        failedCount: 1,
        failureSamples: [],
      },
    };
    expect(getStrategyRunDataHealth(legacyPartial)).toBe('partial');
    expect(isUsableStrategyRun(legacyPartial)).toBe(true);
  });
});
