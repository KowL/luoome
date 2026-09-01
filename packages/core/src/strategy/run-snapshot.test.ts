import { describe, expect, it } from 'vitest';

import { readStrategyRunSnapshot, strategyRunUsesEvaluator } from './run-snapshot.js';

describe('StrategyRunSnapshot compatibility', () => {
  it('normalizes current v3 fields and checkpoint dates', () => {
    const snapshot = readStrategyRunSnapshot({
      schemaVersion: 3,
      strategyVersionId: 'version-1',
      definitionHash: 'hash',
      evaluatorVersion: 'evaluator-v1',
      evaluatorCodeIdentity: 'code-hash',
      scope: 'evaluation',
      universeKind: 'explicit',
      stockIds: ['600519.SH'],
      requestedBy: 'replay',
      evaluationSessionId: 'session-1',
      dataCheckpoint: {
        id: 'checkpoint-1',
        dataAsOf: '2026-08-10T00:00:00.000Z',
        checksum: 'checksum',
      },
    });

    expect(snapshot).toMatchObject({
      format: 'v3',
      schemaVersion: 3,
      stockIds: ['600519.SH'],
      requestedBy: 'replay',
      evaluationSessionId: 'session-1',
      dataCheckpoint: { id: 'checkpoint-1', checksum: 'checksum' },
    });
    expect(snapshot.dataCheckpoint?.dataAsOf).toEqual(new Date('2026-08-10T00:00:00.000Z'));
    expect(
      strategyRunUsesEvaluator(snapshot, {
        version: 'evaluator-v1',
        codeIdentity: 'code-hash',
      }),
    ).toBe(true);
  });

  it('keeps useful fields from partial legacy snapshots without pretending they are current', () => {
    const snapshot = readStrategyRunSnapshot({
      evaluationSessionId: 'legacy-session',
      requestedBy: 'scheduled',
      stockIds: ['600519.SH', 42],
      dataCheckpoint: { dataAsOf: 'invalid' },
    });

    expect(snapshot).toEqual({
      format: 'legacy',
      stockIds: ['600519.SH'],
      requestedBy: 'scheduled',
      evaluationSessionId: 'legacy-session',
    });
    expect(
      strategyRunUsesEvaluator(snapshot, {
        version: 'evaluator-v1',
        codeIdentity: 'code-hash',
      }),
    ).toBe(false);
  });
});
