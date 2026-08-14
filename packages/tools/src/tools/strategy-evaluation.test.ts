import { type StrategyEvaluationSession, strategyDefinitionHash } from '@luoome/core';
import { describe, expect, it } from 'vitest';
import { buildTestContext } from '../testing/context.js';

import {
  cancelStrategyEvaluationSessionTool,
  resumeStrategyEvaluationSessionTool,
} from './strategy-evaluation.js';

const session = (
  overrides: Partial<StrategyEvaluationSession> = {},
): StrategyEvaluationSession => ({
  id: 'evaluation-session-tools',
  strategyId: 'strategy-1',
  strategyVersionId: 'strategy-1-v1',
  from: new Date('2026-08-10T00:00:00.000Z'),
  to: new Date('2026-08-11T00:00:00.000Z'),
  status: 'running',
  definitionHash: strategyDefinitionHash({
    schemaVersion: 1,
    metadata: {},
    universe: { coverage: 'CN_A_SHARES_SH_SZ', excludeStockIds: [] },
    selection: { logic: 'all', rules: [] },
    signals: { entry: [], exit: [], risk: [] },
  }),
  createdAt: new Date('2026-08-09T00:00:00.000Z'),
  ...overrides,
});

describe('strategy evaluation session lifecycle tools', () => {
  it('resumes a failed session and clears terminal fields', async () => {
    const ctx = await buildTestContext();
    await ctx.repos.strategyEvaluation.saveSession(
      session({
        status: 'partial',
        finishedAt: new Date('2026-08-12T00:00:00.000Z'),
        error: 'day_failed',
      }),
    );
    const result = await resumeStrategyEvaluationSessionTool.execute(
      { sessionId: 'evaluation-session-tools' },
      ctx,
    );
    expect(result).toMatchObject({ ok: true, data: { session: { status: 'running' } } });
    if (result.ok) {
      expect(result.data.session.finishedAt).toBeUndefined();
      expect(result.data.session.error).toBeUndefined();
    }
  });

  it('cancels a running session with a stable error code and is idempotent', async () => {
    const ctx = await buildTestContext({ clock: () => new Date('2026-08-12T12:00:00.000Z') });
    await ctx.repos.strategyEvaluation.saveSession(session());
    const cancelled = await cancelStrategyEvaluationSessionTool.execute(
      { sessionId: 'evaluation-session-tools' },
      ctx,
    );
    expect(cancelled).toMatchObject({
      ok: true,
      data: { session: { status: 'failed', error: 'evaluation_cancelled' } },
    });
    const repeated = await cancelStrategyEvaluationSessionTool.execute(
      { sessionId: 'evaluation-session-tools' },
      ctx,
    );
    expect(repeated).toMatchObject({
      ok: true,
      data: { session: { status: 'failed', error: 'evaluation_cancelled' } },
    });
  });
});
