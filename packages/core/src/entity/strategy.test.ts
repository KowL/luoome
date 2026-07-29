import { describe, expect, it } from 'vitest';

import { InvariantError } from '../error/index.js';
import { mapLegacyTacticToStrategy } from '../strategy/legacy-mapper.js';
import {
  assertStrategyInvariants,
  assertStrategyRunInvariants,
  assertStrategyVersionInvariants,
  canonicalStrategyDefinitionJson,
  type StrategyDslV1,
  strategyDefinitionHash,
} from './strategy.js';
import type { Tactic } from './tactic.js';

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

  it('用户 version 不能零 selection，migration 可以', () => {
    const tactic: Tactic = {
      id: 'legacy-tactic',
      name: 'Legacy',
      tag: 'momentum',
      description: 'legacy tactic',
      triggerWhen: 'true',
      scoreExpression: '80',
      direction: 'bullish',
      evidenceTemplate: ['evidence'],
      source: 'builtin',
      definedAt: new Date('2026-07-01T00:00:00.000Z'),
    };
    const bundle = mapLegacyTacticToStrategy(tactic);
    expect(bundle.version.definition.selection.rules).toEqual([]);
    expect(() => assertStrategyVersionInvariants(bundle.version, 'migration')).not.toThrow();
    expect(() => assertStrategyVersionInvariants(bundle.version, 'user')).toThrow(/至少需要一条/);
    expect(bundle.version.definition.signals.entry[0]?.id).toBe('legacy-signal');
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
});
