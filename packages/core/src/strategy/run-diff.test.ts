import { describe, expect, it } from 'vitest';

import type { StrategyResult, StrategyRun } from '../entity/strategy.js';
import type { StrategyResultView } from './result-view.js';
import { diffStrategyRunViews } from './run-diff.js';

const run = (id: string, versionId: string): StrategyRun => ({
  id,
  strategyId: 'strategy-1',
  strategyVersionId: versionId,
  mode: 'scan',
  coverage: 'CN_A_SHARES_SH_SZ',
  dataAsOf: new Date('2026-08-01T07:00:00Z'),
  startedAt: new Date('2026-08-01T07:00:00Z'),
  finishedAt: new Date('2026-08-01T07:01:00Z'),
  status: 'complete',
  inputSnapshot: {},
  providerStatuses: [],
});

const result = (
  runId: string,
  stockId: string,
  selected: boolean,
  rank?: number,
  score?: number,
): StrategyResult => ({
  runId,
  stockId,
  selected,
  ...(rank === undefined ? {} : { rank }),
  ...(score === undefined ? {} : { score }),
  ruleEvaluations: [],
  evidence: [],
  dataAsOf: new Date('2026-08-01T07:00:00Z'),
});

const view = (item: StrategyResult, kind: StrategyResultView['kind']): StrategyResultView => ({
  kind,
  result: item,
  blockingRuleIds: [],
});

describe('Strategy run diff', () => {
  it('derives entry/exit/promotion/demotion/rank changes without persisting pool states', () => {
    const diff = diffStrategyRunViews({
      fromRun: run('run-1', 'version-1'),
      toRun: run('run-2', 'version-2'),
      fromViews: [
        view(result('run-1', '000001.SZ', false, 3, 70), 'ranking-near-miss'),
        view(result('run-1', '000002.SZ', true, 1, 90), 'selected'),
        view(result('run-1', '000003.SZ', true, 2, 80), 'selected'),
      ],
      toViews: [
        view(result('run-2', '000001.SZ', true, 1, 92), 'selected'),
        view(result('run-2', '000002.SZ', false), 'excluded'),
        view(result('run-2', '000003.SZ', true, 2, 80), 'selected'),
      ],
    });

    expect(diff.definitionChanged).toBe(true);
    expect(diff.summary).toMatchObject({
      entered: 1,
      exited: 1,
      stayed: 1,
      candidatePromoted: 1,
      selectedDemoted: 1,
      rankChanged: 1,
      scoreChanged: 1,
    });
    expect(diff.rows[0]).toMatchObject({
      stockId: '000001.SZ',
      changes: ['entered', 'candidate-promoted', 'rank-changed', 'score-changed'],
      rankDelta: -2,
      scoreDelta: 22,
    });
    expect(diff.rows[1]).toMatchObject({
      stockId: '000002.SZ',
      changes: ['exited', 'selected-demoted'],
    });
  });
});
