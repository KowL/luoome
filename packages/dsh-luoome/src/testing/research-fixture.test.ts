import {
  exportStrategyManifestTool,
  getStrategyDataPreflightTool,
  getStrategyExperimentContextTool,
  getStrategyResearchStateTool,
  getStrategySelectionDiagnosticsTool,
  trialStrategyVersionTool,
} from '@luoome/tools';
import { buildTestContext } from '@luoome/tools/testing';
import { describe, expect, it } from 'vitest';
import { RESEARCH_FIXTURE, seedResearchFixture } from './research-fixture.js';

describe('isolated research acceptance facts', () => {
  it('seeds real domain diagnostics, historical gaps, observations and recoverable research state', async () => {
    const ctx = await buildTestContext({ clock: () => new Date('2026-10-27T09:00:00Z') });
    await seedResearchFixture(ctx);
    const fixture = RESEARCH_FIXTURE;
    const diagnostics = await getStrategySelectionDiagnosticsTool.execute(
      { strategyId: fixture.strategyId, runId: fixture.runId },
      ctx,
    );
    expect(diagnostics).toMatchObject({
      ok: true,
      data: {
        counts: {
          selected: 1,
          ruleNearMiss: 1,
          rankingNearMiss: 1,
          excluded: 1,
          incomplete: 1,
          missingResults: 1,
        },
        total: 6,
      },
    });
    const preflight = await getStrategyDataPreflightTool.execute(
      {
        strategyId: fixture.strategyId,
        versionId: fixture.candidateVersionId,
        from: fixture.from,
        to: fixture.to,
        stockIds: fixture.stockIds,
      },
      ctx,
    );
    expect(preflight.ok).toBe(true);
    if (preflight.ok) {
      expect(preflight.data.layers.historicalEvaluation.status).toBe('partial');
      expect(preflight.data.layers.strictBacktest.status).toBe('blocked');
    }
    const context = await getStrategyExperimentContextTool.execute(
      {
        strategyId: fixture.strategyId,
        baseVersionId: fixture.baseVersionId,
        candidateVersionId: fixture.baseVersionId,
      },
      ctx,
    );
    expect(context.ok).toBe(true);
    if (context.ok) {
      expect(context.data.realObservations.horizons.map((row) => row.horizon)).toEqual([
        't1',
        't3',
        't5',
      ]);
      expect(context.data.realObservations.status).toBe('partial');
    }
    const state = await getStrategyResearchStateTool.execute(
      { strategyId: fixture.strategyId },
      ctx,
    );
    expect(state).toMatchObject({
      ok: true,
      data: {
        state: {
          revision: 1,
          state: {
            candidateVersionId: fixture.candidateVersionId,
            conclusion: { outcome: 'inconclusive' },
          },
        },
      },
    });
    const exported = await exportStrategyManifestTool.execute(
      { versionId: fixture.candidateVersionId },
      ctx,
    );
    expect(exported).toMatchObject({
      ok: true,
      data: { reproducibility: { marketDataIncluded: false, trialSnapshotsIncluded: false } },
    });
    const trial = await trialStrategyVersionTool.execute(
      {
        strategyId: fixture.strategyId,
        baseVersionId: fixture.baseVersionId,
        draftVersionId: fixture.candidateVersionId,
        stockIds: fixture.stockIds,
        mode: 'replay',
        asOf: fixture.trialAsOf,
      },
      ctx,
    );
    expect(trial).toMatchObject({ ok: true, data: { persisted: false } });
    if (trial.ok) expect(trial.data.inputIdentity.snapshotHash).toMatch(/^[a-f0-9]{64}$/);
  });
});
