import { describe, expect, it } from 'vitest';

import { InvariantError } from '../error/index.js';
import {
  assertStrategyAutonomyActionInvariants,
  assertStrategyAutonomyActionTransition,
  STRATEGY_AUTONOMY_ACTION_TRANSITIONS,
  STRATEGY_AUTONOMY_PAUSE_SNAPSHOT_REQUIRED_KEYS,
  type StrategyAutonomyAction,
  StrategyAutonomyActionSchema,
} from './strategy-autonomy-action.js';

const T0 = new Date('2026-08-24T01:00:00.000Z');
const T1 = new Date('2026-08-31T01:00:00.000Z');

const PAUSE_SNAPSHOT = {
  sampleCount: 24,
  benchmarkCoverage: 0.95,
  avgExcessReturn: -0.01,
  medianExcessReturn: -0.008,
  thresholds: { minSampleCount: 20, minBenchmarkCoverage: 0.9, cooldownDays: 30 },
};

const makeAction = (overrides: Partial<StrategyAutonomyAction> = {}): StrategyAutonomyAction =>
  StrategyAutonomyActionSchema.parse({
    id: 'action-1',
    kind: 'propose-version',
    status: 'drafted',
    strategyId: 'strategy-1',
    trigger: 'weekly-review',
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  });

describe('StrategyAutonomyAction', () => {
  it('接受合法的 propose-version 草稿（factReferences/attempts 默认）', () => {
    const action = makeAction();
    expect(() => assertStrategyAutonomyActionInvariants(action)).not.toThrow();
    expect(action.factReferences).toEqual([]);
    expect(action.attempts).toBe(0);
  });

  it('propose-version 进入 validating/eligible/blocked/confirmed/published 必须有 strategyVersionId', () => {
    for (const status of ['validating', 'eligible', 'blocked', 'confirmed'] as const) {
      expect(() => assertStrategyAutonomyActionInvariants(makeAction({ status }))).toThrow(
        InvariantError,
      );
      expect(() =>
        assertStrategyAutonomyActionInvariants(
          makeAction({ status, strategyVersionId: 'strategy-1-v2' }),
        ),
      ).not.toThrow();
    }
    expect(() =>
      assertStrategyAutonomyActionInvariants(makeAction({ status: 'published' })),
    ).toThrow(InvariantError);
    expect(() =>
      assertStrategyAutonomyActionInvariants(
        makeAction({ status: 'published', strategyVersionId: 'strategy-1-v2', completedAt: T1 }),
      ),
    ).not.toThrow();
    // drafted/failed 允许没有 strategyVersionId（AI 提议失败落 failed，不留孤儿）
    expect(() =>
      assertStrategyAutonomyActionInvariants(
        makeAction({ status: 'failed', lastError: 'validation invalid', completedAt: T1 }),
      ),
    ).not.toThrow();
  });

  it('publish-version 与 pause 必须有 ruleSnapshot；pause 必须含完整指标与阈值', () => {
    expect(() =>
      assertStrategyAutonomyActionInvariants(
        makeAction({
          kind: 'publish-version',
          status: 'published',
          strategyVersionId: 'strategy-1-v2',
          completedAt: T1,
        }),
      ),
    ).toThrow(InvariantError);
    expect(() =>
      assertStrategyAutonomyActionInvariants(
        makeAction({
          kind: 'pause',
          status: 'executed',
          ruleSnapshot: { conclusion: 'underperform' },
          completedAt: T1,
        }),
      ),
    ).toThrow(/完整指标与阈值/);
    const pause = makeAction({
      kind: 'pause',
      status: 'executed',
      ruleSnapshot: PAUSE_SNAPSHOT,
      completedAt: T1,
    });
    expect(() => assertStrategyAutonomyActionInvariants(pause)).not.toThrow();
    for (const key of STRATEGY_AUTONOMY_PAUSE_SNAPSHOT_REQUIRED_KEYS) {
      expect(Object.hasOwn(PAUSE_SNAPSHOT, key)).toBe(true);
    }
  });

  it('publish-version 恒为 published 且必须关联版本；pause 恒为 executed', () => {
    expect(() =>
      assertStrategyAutonomyActionInvariants(
        makeAction({ kind: 'publish-version', status: 'published', ruleSnapshot: {} }),
      ),
    ).toThrow(InvariantError);
    expect(() =>
      assertStrategyAutonomyActionInvariants(
        makeAction({
          kind: 'publish-version',
          status: 'confirmed',
          strategyVersionId: 'strategy-1-v2',
          ruleSnapshot: {},
        }),
      ),
    ).toThrow(InvariantError);
    expect(() =>
      assertStrategyAutonomyActionInvariants(
        makeAction({
          kind: 'pause',
          status: 'drafted',
          ruleSnapshot: PAUSE_SNAPSHOT,
        }),
      ),
    ).toThrow(InvariantError);
  });

  it('completedAt 必须且只能在终态存在，且不早于 createdAt', () => {
    expect(() =>
      assertStrategyAutonomyActionInvariants(makeAction({ status: 'validating', completedAt: T1 })),
    ).toThrow(InvariantError);
    expect(() =>
      assertStrategyAutonomyActionInvariants(
        makeAction({
          status: 'published',
          strategyVersionId: 'strategy-1-v2',
        }),
      ),
    ).toThrow(InvariantError);
    expect(() =>
      assertStrategyAutonomyActionInvariants(
        makeAction({
          status: 'published',
          strategyVersionId: 'strategy-1-v2',
          completedAt: new Date('2026-08-01T00:00:00.000Z'),
        }),
      ),
    ).toThrow(InvariantError);
  });

  it('updatedAt 不能早于 createdAt；attempts 必须是非负整数', () => {
    expect(() =>
      assertStrategyAutonomyActionInvariants(
        makeAction({ updatedAt: new Date('2026-08-01T00:00:00.000Z') }),
      ),
    ).toThrow(InvariantError);
    expect(() => makeAction({ attempts: -1 })).toThrow();
    expect(() => makeAction({ attempts: 0.5 })).toThrow();
  });

  it('状态机：只放行 DDD §2.2 定义的边', () => {
    const legal: Array<[StrategyAutonomyAction['status'], StrategyAutonomyAction['status']]> = [
      ['drafted', 'validating'],
      ['drafted', 'failed'],
      ['validating', 'eligible'],
      ['validating', 'failed'],
      ['eligible', 'published'],
      ['eligible', 'blocked'],
      ['blocked', 'confirmed'],
      ['blocked', 'rejected'],
      ['confirmed', 'published'],
    ];
    for (const [from, to] of legal) {
      expect(() => assertStrategyAutonomyActionTransition(from, to)).not.toThrow();
    }
    const illegal: Array<[StrategyAutonomyAction['status'], StrategyAutonomyAction['status']]> = [
      ['drafted', 'published'],
      ['drafted', 'drafted'],
      ['validating', 'blocked'],
      ['eligible', 'confirmed'],
      ['confirmed', 'rejected'],
      ['blocked', 'published'],
      ['published', 'drafted'],
      ['rejected', 'blocked'],
      ['failed', 'validating'],
      ['executed', 'drafted'],
    ];
    for (const [from, to] of illegal) {
      expect(() => assertStrategyAutonomyActionTransition(from, to)).toThrow(InvariantError);
    }
    // 转移表不读 aiNarrative：只以 status 为键
    expect(Object.keys(STRATEGY_AUTONOMY_ACTION_TRANSITIONS)).toHaveLength(9);
  });
});
