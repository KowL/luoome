import { describe, expect, it } from 'vitest';
import { AnalysisContextSchema, analysisContextWriteError } from './analysis-context.js';
import {
  type AnalysisJob,
  AnalysisJobSchema,
  hasAnalysisLease,
  releaseAnalysisJob,
} from './analysis-job.js';

const now = new Date('2026-10-22T04:00:00Z');
const claimed: AnalysisJob = {
  id: 'job',
  kind: 'advice_stock',
  source: 'schedule',
  accountId: 'account',
  subject: { kind: 'stock', id: '600519.SH' },
  priority: 50,
  dedupeKey: 'key',
  payload: {},
  dataAsOf: now,
  notBefore: now,
  status: 'claimed',
  attempts: 1,
  maxAttempts: 3,
  claimToken: 'token',
  claimedBy: 'worker:test',
  leaseUntil: new Date(now.getTime() + 1000),
  contextId: 'context',
  result: null,
  error: null,
  createdAt: now,
  updatedAt: now,
  finishedAt: null,
};

describe('analysis job invariants and fencing', () => {
  it('accepts a valid claim and rejects mismatched subjects and claim state', () => {
    expect(AnalysisJobSchema.safeParse(claimed).success).toBe(true);
    for (const patch of [
      { kind: 'advice_market' },
      { claimToken: null },
      { contextId: null },
      { status: 'pending' },
      { attempts: 0 },
      { attempts: 4 },
      { finishedAt: now },
      { result: { resultRef: 'a', resultHash: 'h', completedClaimToken: 't' } },
    ])
      expect(AnalysisJobSchema.safeParse({ ...claimed, ...patch }).success).toBe(false);
  });

  it('rejects old tokens and a lease exactly at expiry', () => {
    expect(hasAnalysisLease(claimed, 'token', now)).toBe(true);
    expect(hasAnalysisLease(claimed, 'old', now)).toBe(false);
    expect(hasAnalysisLease(claimed, 'token', new Date(now.getTime() + 1000))).toBe(false);
  });

  it('retries below the limit and dead-letters exhausted or permanent failures', () => {
    const error = { code: 'provider_unavailable', message: 'Unavailable', retryable: true };
    const retry = releaseAnalysisJob(claimed, now, error, new Date(now.getTime() + 5000));
    expect(retry.status).toBe('pending');
    expect(retry.claimToken).toBeNull();
    expect(retry.contextId).toBeNull();
    expect(retry.notBefore.getTime()).toBe(now.getTime() + 5000);
    expect(releaseAnalysisJob({ ...claimed, attempts: 3 }, now, error).status).toBe('dead_letter');
    expect(releaseAnalysisJob(claimed, now, { ...error, retryable: false }).status).toBe(
      'dead_letter',
    );
    expect(claimed.status).toBe('claimed');
  });
});

describe('analysis context audit lifetime', () => {
  const context = {
    id: 'context',
    jobId: null,
    kind: 'advice_stock',
    accountId: 'account',
    subject: claimed.subject,
    dataAsOf: now,
    facts: [{ id: 'quote', label: '行情', value: 100, evidenceIds: [] }],
    factIds: ['quote'],
    limitations: ['无实时盘口'],
    contextHash: 'a'.repeat(64),
    writeUntil: new Date(now.getTime() + 1800000),
    expiresAt: new Date(now.getTime() + 180 * 86400000),
    createdAt: now,
  };
  it('keeps the snapshot valid for audit after the write deadline', () => {
    const parsed = AnalysisContextSchema.parse(context);
    expect(analysisContextWriteError(parsed, parsed.writeUntil, ['quote'])).toBe('context_expired');
    expect(parsed.expiresAt > parsed.writeUntil).toBe(true);
    expect(analysisContextWriteError(parsed, now, ['quote'])).toBeUndefined();
    expect(analysisContextWriteError(parsed, now, ['invented'])).toBe('unknown_fact_reference');
  });
  it('rejects duplicate or missing fact identities and future facts', () => {
    for (const patch of [
      { factIds: ['quote', 'quote'] },
      { factIds: [] },
      { dataAsOf: new Date(now.getTime() + 1) },
      { expiresAt: now },
    ]) {
      expect(AnalysisContextSchema.safeParse({ ...context, ...patch }).success).toBe(false);
    }
  });
});
