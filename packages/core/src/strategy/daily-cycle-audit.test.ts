import { describe, expect, it } from 'vitest';

import type { WorkflowRun } from '../entity/workflow-run.js';
import {
  createStrategyDailyCycleAuditInputSummary,
  createStrategyDailyCycleAuditOutputSummary,
  decodeStrategyDailyCycleAudit,
  isHistoricalStrategyDailyCycleAudit,
} from './daily-cycle-audit.js';

const run = (overrides: Partial<WorkflowRun> = {}): WorkflowRun => ({
  id: 'audit-1',
  workflowName: 'strategy-daily-cycle',
  mode: 'scheduled',
  status: 'succeeded',
  startedAt: new Date('2026-08-10T09:00:00.000Z'),
  finishedAt: new Date('2026-08-10T09:01:00.000Z'),
  providerStatuses: [],
  ...overrides,
});

describe('StrategyDailyCycleAuditModule', () => {
  it('构建 v1 写入契约并解码归属与阶段事实', () => {
    const inputSummary = createStrategyDailyCycleAuditInputSummary({
      strategyId: 'strategy-1',
      scheduleId: 'schedule-1',
      dataAsOf: new Date('2026-08-10T00:00:00.000Z'),
      requestedBy: 'scheduled',
    });
    const outputSummary = createStrategyDailyCycleAuditOutputSummary({
      status: 'complete',
      phase: 'finish',
      publication: 'published',
      leaseRenewals: 2,
      phaseTimings: [
        {
          phase: 'run',
          startedAt: new Date('2026-08-10T09:00:10.000Z'),
          finishedAt: new Date('2026-08-10T09:00:20.000Z'),
          durationMs: 10_000,
        },
      ],
    });

    const decoded = decodeStrategyDailyCycleAudit(run({ inputSummary, outputSummary }));
    expect(decoded).toMatchObject({
      format: 'v1',
      schemaVersion: 1,
      strategyId: 'strategy-1',
      scheduleId: 'schedule-1',
      dataAsOf: new Date('2026-08-10T00:00:00.000Z'),
      cycleStatus: 'complete',
      publication: 'published',
      leaseRenewals: 2,
      phaseTimings: [{ phase: 'run', durationMs: 10_000 }],
    });
  });

  it('兼容无版本旧记录，并让单个损坏组件不遮蔽其它审计事实', () => {
    const decoded = decodeStrategyDailyCycleAudit(
      run({
        inputSummary: {
          strategyId: 'strategy-legacy',
          scheduleId: 'schedule-legacy',
          dataAsOf: '2026-08-01T00:00:00.000Z',
        },
        outputSummary: {
          status: 'partial',
          publication: 'published',
          checkpoint: { requestedCount: 'corrupt' },
          phaseTimings: [{ phase: 'run', durationMs: -1 }],
        },
      }),
    );

    expect(decoded).toMatchObject({
      format: 'legacy',
      strategyId: 'strategy-legacy',
      cycleStatus: 'partial',
      publication: 'published',
      phaseTimings: [],
      preflight: { state: 'missing' },
    });
    expect(decoded?.checkpoint).toBeUndefined();
    expect(decoded === undefined ? false : isHistoricalStrategyDailyCycleAudit(decoded)).toBe(true);
  });

  it('区分缺失和损坏的 preflight 快照', () => {
    expect(
      decodeStrategyDailyCycleAudit(run({ outputSummary: { preflight: { total: 1 } } }))?.preflight,
    ).toEqual({ state: 'corrupt' });
    expect(decodeStrategyDailyCycleAudit(run())?.preflight).toEqual({ state: 'missing' });
  });
});
