import { describe, expect, it } from 'vitest';

import {
  isObservableStrategySignal,
  planStrategySignalEvents,
  type RuleEvaluation,
  type StrategyDslV1,
  type StrategyResult,
  type StrategySignal,
  type StrategySignalState,
} from '../index.js';

type Kind = keyof StrategyDslV1['signals'];
const START = new Date('2026-08-10T08:00:00.000Z');
const day = (offset: number): Date => new Date(START.getTime() + offset * 86_400_000);
const rule = (kind: Kind) => ({
  id: `${kind}-rule`,
  name: kind,
  when: 'true',
  score: '80',
  direction: 'neutral' as const,
  evidence: ['fact'],
  emission: { mode: 'level' as const, cooldownTradingDays: 0 },
});
const definition: StrategyDslV1 = {
  schemaVersion: 1,
  metadata: {},
  universe: { coverage: 'CN_A_SHARES_SH_SZ', excludeStockIds: [] },
  selection: { logic: 'all', rules: [] },
  signals: { entry: [rule('entry')], exit: [rule('exit')], risk: [rule('risk')] },
};
const result = (
  stockId: string,
  selected: boolean,
  statuses: Partial<Record<Kind, RuleEvaluation['status']>> = {},
  runId = 'run-1',
): StrategyResult => ({
  runId,
  stockId,
  selected,
  ruleEvaluations: Object.entries(statuses).map(([kind, status]) => ({
    ruleId: `${kind}-rule`,
    status,
    evidence: [],
  })),
  evidence: [],
  dataAsOf: START,
});
const raw = (stockId: string, kind: Kind, runId = 'run-1'): StrategySignal => ({
  id: `${runId}:${stockId}:${kind}`,
  strategyId: 'strategy',
  strategyVersionId: 'version-1',
  runId,
  stockId,
  ruleId: `${kind}-rule`,
  ts: START,
  score: 80,
  direction: 'neutral',
  evidence: ['fact'],
  evaluationSnapshot: { baseline: { price: 12 } },
});
const plan = (
  results: StrategyResult[],
  rawSignals: StrategySignal[],
  previousState?: StrategySignalState,
  offset = 0,
  dsl = definition,
) =>
  planStrategySignalEvents({
    strategyId: 'strategy',
    strategyVersionId: 'version-1',
    contextKey: 'operational',
    runId: 'run-1',
    now: day(offset),
    definition: dsl,
    results,
    rawSignals,
    ...(previousState === undefined ? {} : { previousState }),
  });

describe('planStrategySignalEvents', () => {
  it('uses final selected flags after top ranking to gate entries', () => {
    const planned = plan(
      [result('A', true, { entry: 'matched' }), result('B', false, { entry: 'matched' })],
      [raw('A', 'entry'), raw('B', 'entry')],
    );
    expect(planned.signals.map((signal) => signal.stockId)).toEqual(['A']);
    expect(planned.state.trackedStockIds).toEqual(['A']);
    expect(planned.state.rules.map((state) => state.stockId)).toEqual(['A']);
  });

  it('suppresses market-wide exit and risk signals outside tracked or selected stocks', () => {
    const planned = plan(
      [result('A', false, { exit: 'matched', risk: 'matched' })],
      [raw('A', 'exit'), raw('A', 'risk')],
    );
    expect(planned).toMatchObject({ signals: [], state: { trackedStockIds: [], rules: [] } });
  });

  it('allows exit and risk after leaving the selected pool, and retires on exit', () => {
    const first = plan([result('A', true)], []);
    const next = plan(
      [result('A', false, { entry: 'matched', exit: 'matched', risk: 'matched' })],
      [raw('A', 'entry'), raw('A', 'exit'), raw('A', 'risk')],
      first.state,
      1,
    );
    expect(next.signals.map((signal) => signal.ruleId)).toEqual(['exit-rule', 'risk-rule']);
    expect(next.state.trackedStockIds).toEqual([]);
    expect(next.state.rules).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ruleId: 'exit-rule', matched: true, lastEmittedAt: day(1) }),
      ]),
    );
    const later = plan(
      [result('A', false, { exit: 'matched' })],
      [raw('A', 'exit')],
      next.state,
      2,
    );
    expect(later.signals).toEqual([]);
  });

  it('treats level rules as edges without modifying the definition or raw signals', () => {
    const dslBefore = structuredClone(definition);
    const signal = raw('A', 'entry');
    const first = plan([result('A', true, { entry: 'matched' })], [signal]);
    const repeated = plan([result('A', true, { entry: 'matched' })], [signal], first.state, 1);
    expect(first.signals).toHaveLength(1);
    expect(repeated.signals).toEqual([]);
    expect(repeated.state.rules).toEqual([
      { stockId: 'A', ruleId: 'entry-rule', matched: true, lastEmittedAt: START },
    ]);
    expect(definition).toEqual(dslBefore);
    expect(signal.evaluationSnapshot).toEqual({ baseline: { price: 12 } });
  });

  it('re-emits after a known false evaluation returns to true', () => {
    const first = plan([result('A', true, { risk: 'matched' })], [raw('A', 'risk')]);
    const reset = plan([result('A', true, { risk: 'not-matched' })], [], first.state, 1);
    const next = plan([result('A', true, { risk: 'matched' })], [raw('A', 'risk')], reset.state, 2);
    expect(reset.state.rules[0]).toMatchObject({ matched: false, lastEmittedAt: START });
    expect(next.signals).toHaveLength(1);
  });

  it('resets entry eligibility outside selection so re-selection is a new entry', () => {
    const first = plan([result('A', true, { entry: 'matched' })], [raw('A', 'entry')]);
    const outside = plan(
      [result('A', false, { entry: 'matched' })],
      [raw('A', 'entry')],
      first.state,
      1,
    );
    const reselected = plan(
      [result('A', true, { entry: 'matched' })],
      [raw('A', 'entry')],
      outside.state,
      2,
    );
    expect(outside.signals).toEqual([]);
    expect(outside.state.rules[0]).toMatchObject({ matched: false, lastEmittedAt: START });
    expect(reselected.signals).toHaveLength(1);
  });

  it.each(['unknown', 'error'] as const)('preserves existing state on %s', (status) => {
    const first = plan([result('A', true, { entry: 'matched' })], [raw('A', 'entry')]);
    const uncertain = plan(
      [result('A', true, { entry: status, risk: status })],
      [],
      first.state,
      1,
    );
    expect(uncertain.state.rules).toEqual(first.state.rules);
    const next = plan(
      [result('A', true, { entry: 'matched' })],
      [raw('A', 'entry')],
      uncertain.state,
      2,
    );
    expect(next.signals).toEqual([]);
  });

  it.each(['all', 'any'] as const)('preserves entry state for uncertain %s selection', (logic) => {
    const dsl = {
      ...definition,
      selection: {
        logic,
        rules: [{ id: 'selection', name: '门槛', when: 'true', evidence: ['门槛'] }],
      },
    };
    const known = {
      ...result('A', true, { entry: 'matched' }),
      ruleEvaluations: [
        ...result('A', true, { entry: 'matched' }).ruleEvaluations,
        { ruleId: 'selection', status: 'matched' as const, evidence: [] },
      ],
    };
    const first = plan([known], [raw('A', 'entry')], undefined, 0, dsl);
    for (const status of ['unknown', 'error'] as const) {
      const uncertain = {
        ...known,
        selected: false,
        ruleEvaluations: known.ruleEvaluations.map((item) =>
          item.ruleId === 'selection' ? { ...item, status } : item,
        ),
      };
      const middle = plan([uncertain], [raw('A', 'entry')], first.state, 1, dsl);
      const restored = plan([known], [raw('A', 'entry')], middle.state, 2, dsl);
      expect(middle.state.rules.find((item) => item.ruleId === 'entry-rule')?.matched).toBe(true);
      expect(restored.signals).toEqual([]);
    }
  });

  it('preserves entry state when scoring is unavailable', () => {
    const dsl: StrategyDslV1 = {
      ...definition,
      scoring: {
        method: 'weighted-sum',
        top: 1,
        components: [{ ruleId: 'entry-rule', score: '50', weight: 1 }],
      },
    };
    const known = { ...result('A', true, { entry: 'matched' }), score: 50 };
    const first = plan([known], [raw('A', 'entry')], undefined, 0, dsl);
    const middle = plan(
      [result('A', false, { entry: 'matched' })],
      [raw('A', 'entry')],
      first.state,
      1,
      dsl,
    );
    const restored = plan([known], [raw('A', 'entry')], middle.state, 2, dsl);
    expect(restored.signals).toEqual([]);
  });

  it('preserves previous rules when their result or evaluation is missing', () => {
    const first = plan(
      [result('A', true, { entry: 'matched', risk: 'not-matched' })],
      [raw('A', 'entry')],
    );
    const missingStock = plan([], [], first.state, 1);
    const missingRule = plan([result('A', true)], [], missingStock.state, 2);
    expect(missingStock.state.rules).toEqual(first.state.rules);
    expect(missingRule.state.rules).toEqual(first.state.rules);
    expect(missingRule.state.trackedStockIds).toEqual(['A']);
  });

  it('keeps cooldown when forcing effective edge emission', () => {
    const dsl = structuredClone(definition);
    dsl.signals.entry = dsl.signals.entry.map((entry) => ({
      ...entry,
      emission: { mode: 'level', cooldownTradingDays: 3 },
    }));
    const first = plan(
      [result('A', true, { entry: 'matched' })],
      [raw('A', 'entry')],
      undefined,
      0,
      dsl,
    );
    const reset = plan([result('A', false, { entry: 'matched' })], [], first.state, 1, dsl);
    const blocked = plan(
      [result('A', true, { entry: 'matched' })],
      [raw('A', 'entry')],
      reset.state,
      2,
      dsl,
    );
    expect(blocked.signals).toEqual([]);
    expect(blocked.state.rules[0]).toMatchObject({ matched: true, lastEmittedAt: START });
    const stillTrue = plan(
      [result('A', true, { entry: 'matched' })],
      [raw('A', 'entry')],
      blocked.state,
      3,
      dsl,
    );
    expect(stillTrue.signals).toEqual([]);
    const anotherReset = plan(
      [result('A', true, { entry: 'not-matched' })],
      [],
      stillTrue.state,
      4,
      dsl,
    );
    const emitted = plan(
      [result('A', true, { entry: 'matched' })],
      [raw('A', 'entry')],
      anotherReset.state,
      7,
      dsl,
    );
    expect(emitted.signals).toHaveLength(1);
    expect(emitted.state.rules[0]?.lastEmittedAt).toEqual(day(7));
  });

  it('retires on a valid exit even when cooldown suppresses the event', () => {
    const dsl = structuredClone(definition);
    dsl.signals.exit = dsl.signals.exit.map((exit) => ({
      ...exit,
      emission: { mode: 'level', cooldownTradingDays: 3 },
    }));
    const prior: StrategySignalState = {
      ...plan([result('A', true)], []).state,
      rules: [{ stockId: 'A', ruleId: 'exit-rule', matched: false, lastEmittedAt: START }],
    };
    const exited = plan(
      [result('A', false, { exit: 'matched' })],
      [raw('A', 'exit')],
      prior,
      1,
      dsl,
    );
    expect(exited).toMatchObject({ signals: [], state: { trackedStockIds: [] } });
    expect(exited.state.rules).toContainEqual({
      stockId: 'A',
      ruleId: 'exit-rule',
      matched: true,
      lastEmittedAt: START,
    });
    const reentered = plan(
      [result('A', true, { entry: 'matched' })],
      [raw('A', 'entry')],
      exited.state,
      2,
      dsl,
    );
    expect(reentered.signals).toHaveLength(1);
    expect(reentered.state.trackedStockIds).toEqual(['A']);
  });

  it('retains event times when selected and exit stay true across runs', () => {
    const dsl = structuredClone(definition);
    dsl.signals.exit[0] = { ...rule('exit'), emission: { mode: 'level', cooldownTradingDays: 3 } };
    const rows = [result('A', true, { entry: 'matched', exit: 'matched' })];
    const candidates = [raw('A', 'entry'), raw('A', 'exit')];
    const first = plan(rows, candidates, undefined, 0, dsl);
    const second = plan(rows, candidates, first.state, 1, dsl);
    const third = plan(rows, candidates, second.state, 2, dsl);
    expect([first, second, third].map((item) => item.signals.length)).toEqual([2, 0, 0]);
    expect(third.state.rules.find((item) => item.ruleId === 'exit-rule')?.lastEmittedAt).toEqual(
      START,
    );
  });

  it('preserves entry cooldown through retirement and re-selection', () => {
    const dsl = structuredClone(definition);
    dsl.signals.entry[0] = {
      ...rule('entry'),
      emission: { mode: 'level', cooldownTradingDays: 3 },
    };
    const first = plan(
      [result('A', true, { entry: 'matched' })],
      [raw('A', 'entry')],
      undefined,
      0,
      dsl,
    );
    const exited = plan(
      [result('A', false, { entry: 'matched', exit: 'matched' })],
      [raw('A', 'entry'), raw('A', 'exit')],
      first.state,
      1,
      dsl,
    );
    const reselected = plan(
      [result('A', true, { entry: 'matched' })],
      [raw('A', 'entry')],
      exited.state,
      2,
      dsl,
    );
    expect(reselected.signals).toEqual([]);
    expect(
      reselected.state.rules.find((item) => item.ruleId === 'entry-rule')?.lastEmittedAt,
    ).toEqual(START);
  });

  it('does not retire from a matched exit without a valid raw signal', () => {
    const first = plan([result('A', true)], []);
    for (const signals of [[], [{ ...raw('A', 'exit'), strategyVersionId: 'other-version' }]]) {
      const next = plan([result('A', false, { exit: 'matched' })], signals, first.state, 1);
      expect(next.state.trackedStockIds).toEqual(['A']);
      expect(next.signals).toEqual([]);
    }
  });

  it.each([0, -1])('does not emit or rewind when time offset is %s', (offset) => {
    const first = plan([result('A', true)], []);
    const next = plan(
      [result('B', true, { entry: 'matched' })],
      [raw('B', 'entry')],
      first.state,
      offset,
    );
    expect(next.signals).toEqual([]);
    expect(next.state).toBe(first.state);
  });

  it.each(['strategyId', 'strategyVersionId', 'contextKey'] as const)(
    'isolates previous state by %s',
    (field) => {
      const first = plan([result('A', true, { entry: 'matched' })], [raw('A', 'entry')]);
      const foreign = { ...first.state, [field]: 'other', evaluatedAt: day(10) };
      const next = plan([result('B', true, { entry: 'matched' })], [raw('B', 'entry')], foreign, 1);
      expect(next.signals).toHaveLength(1);
      expect(next.state.trackedStockIds).toEqual(['B']);
      expect(next.state.rules.every((state) => state.stockId === 'B')).toBe(true);
    },
  );

  it('preserves missing and unknown entry state even outside selection', () => {
    const first = plan([result('A', true, { entry: 'matched' })], [raw('A', 'entry')]);
    for (const statuses of [{}, { entry: 'unknown' as const }, { entry: 'error' as const }]) {
      const next = plan([result('A', false, statuses)], [], first.state, 1);
      expect(next.state.rules).toEqual(first.state.rules);
    }
  });

  it('matches V2 evaluation scope instead of using a selection rule with the same id', () => {
    const scoped = result('A', true);
    scoped.ruleEvaluations = [
      {
        schemaVersion: 2,
        ruleId: 'entry-rule',
        scope: 'selection',
        status: 'not-matched',
        expression: 'false',
        inputs: [],
        explanation: { code: 'not-matched', message: 'selection fact' },
        evidence: [],
      },
      {
        schemaVersion: 2,
        ruleId: 'entry-rule',
        scope: 'entry',
        status: 'matched',
        expression: 'true',
        inputs: [],
        explanation: { code: 'matched', message: 'signal fact' },
        evidence: ['fact'],
      },
    ];
    expect(plan([scoped], [raw('A', 'entry')]).signals).toHaveLength(1);
  });

  it('ignores facts and raw signals from other runs or strategies', () => {
    const staleResult = result('A', true, { entry: 'matched' }, 'other-run');
    expect(plan([staleResult], [raw('A', 'entry', 'other-run')]).state.trackedStockIds).toEqual([]);
    const validResult = result('A', true, { entry: 'matched' });
    for (const signal of [
      { ...raw('A', 'entry'), strategyId: 'other-strategy' },
      { ...raw('A', 'entry'), strategyVersionId: 'other-version' },
      raw('A', 'entry', 'other-run'),
    ]) {
      expect(plan([validResult], [signal]).signals).toEqual([]);
    }
  });

  it('uses a valid raw signal as matched evidence when its evaluation is absent', () => {
    const first = plan([result('A', true)], [raw('A', 'entry')]);
    expect(first.signals).toHaveLength(1);
    const exited = plan([], [raw('A', 'exit')], first.state, 1);
    expect(exited.signals).toHaveLength(1);
    expect(exited.state.trackedStockIds).toEqual([]);
  });

  it('only creates rule state for relevant stocks, not the whole market', () => {
    const market = Array.from({ length: 5000 }, (_, index) =>
      result(`stock-${index}`, false, {
        entry: 'matched',
        exit: 'not-matched',
        risk: 'not-matched',
      }),
    );
    const planned = plan(
      [
        ...market,
        result('A', true, { entry: 'matched', exit: 'not-matched', risk: 'not-matched' }),
      ],
      [raw('A', 'entry')],
    );
    expect(planned.state.trackedStockIds).toEqual(['A']);
    expect(planned.state.rules).toHaveLength(3);
    expect(planned.state.rules.every((state) => state.stockId === 'A')).toBe(true);
  });

  it('takes marker kinds from rule groups rather than direction, preserving snapshot facts', () => {
    const planned = plan(
      [result('A', true, { entry: 'matched', risk: 'matched' })],
      [raw('A', 'entry'), raw('A', 'risk')],
    );
    expect(planned.signals.map((signal) => signal.evaluationSnapshot)).toEqual([
      { baseline: { price: 12 }, tracking: { policyVersion: 1, kind: 'entry', eligible: true } },
      { baseline: { price: 12 }, tracking: { policyVersion: 1, kind: 'risk', eligible: true } },
    ]);
    expect(planned.signals.every(isObservableStrategySignal)).toBe(true);
  });
});

describe('isObservableStrategySignal', () => {
  it.each(['entry', 'exit', 'risk'])('accepts policy v1 eligible %s signals', (kind) => {
    expect(
      isObservableStrategySignal({
        ...raw('A', 'entry'),
        evaluationSnapshot: {
          tracking: { policyVersion: 1, kind, eligible: true },
        },
      }),
    ).toBe(true);
  });

  it.each([
    undefined,
    null,
    [],
    'tracking',
    1,
    {},
    { policyVersion: 1, kind: 'entry' },
    { policyVersion: 1, kind: 'entry', eligible: false },
    { policyVersion: 1, kind: 'entry', eligible: 'true' },
    { policyVersion: 2, kind: 'entry', eligible: true },
    { policyVersion: '1', kind: 'entry', eligible: true },
    { policyVersion: 1, kind: 'selection', eligible: true },
  ])('rejects invalid or legacy tracking marker %j', (tracking) => {
    expect(
      isObservableStrategySignal({ ...raw('A', 'entry'), evaluationSnapshot: { tracking } }),
    ).toBe(false);
  });
});
