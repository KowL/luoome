import { describe, expect, it } from 'vitest';

import { MarketDumpRunSchema } from './market-dump.js';

const HASH = 'a'.repeat(64);

const base = {
  runId: 'run-1',
  kind: 'daily-k',
  dumpId: 'a_share_daily_k_1d_none_10d',
  source: 'fuyao',
  artifactSha256: null,
  status: 'running',
  recordedAt: null,
  requestedAt: '2026-11-03T15:00:00.000Z',
  downloadedAt: null,
  startedAt: null,
  finishedAt: null,
  nextRowOffset: 0,
  processedRows: 0,
  minDate: null,
  maxDate: null,
  artifactBytes: null,
  errorKind: null,
  errorMessage: null,
} as const;

describe('MarketDumpRunSchema', () => {
  it('接受 running 初始形态（全空审计字段）', () => {
    const run = MarketDumpRunSchema.parse(base);
    expect(run.status).toBe('running');
    expect(run.artifactSha256).toBeNull();
  });

  it('complete 必须带 artifactSha256 与 finishedAt', () => {
    expect(() =>
      MarketDumpRunSchema.parse({ ...base, status: 'complete', artifactSha256: HASH }),
    ).toThrow(/finishedAt/);
    const run = MarketDumpRunSchema.parse({
      ...base,
      status: 'complete',
      artifactSha256: HASH,
      recordedAt: '2026-11-03T15:01:00.000Z',
      downloadedAt: '2026-11-03T15:00:30.000Z',
      startedAt: '2026-11-03T15:00:31.000Z',
      finishedAt: '2026-11-03T15:05:00.000Z',
      nextRowOffset: 1000,
      processedRows: 1000,
      minDate: '2026-10-21T00:00:00.000Z',
      maxDate: '2026-11-03T00:00:00.000Z',
    });
    expect(run.artifactSha256).toBe(HASH);
  });

  it('failed 必须带 errorKind', () => {
    expect(() =>
      MarketDumpRunSchema.parse({
        ...base,
        status: 'failed',
        finishedAt: '2026-11-03T15:05:00.000Z',
      }),
    ).toThrow(/errorKind/);
    const run = MarketDumpRunSchema.parse({
      ...base,
      status: 'failed',
      finishedAt: '2026-11-03T15:05:00.000Z',
      errorKind: 'network',
      errorMessage: 'connection reset',
    });
    expect(run.errorKind).toBe('network');
  });

  it('processedRows 不能大于 nextRowOffset', () => {
    expect(() =>
      MarketDumpRunSchema.parse({ ...base, nextRowOffset: 10, processedRows: 11 }),
    ).toThrow(/processedRows/);
  });

  it('minDate 不能晚于 maxDate', () => {
    expect(() =>
      MarketDumpRunSchema.parse({
        ...base,
        minDate: '2026-11-03T00:00:00.000Z',
        maxDate: '2026-10-21T00:00:00.000Z',
      }),
    ).toThrow(/minDate/);
  });

  it('artifactSha256 必须是 sha256 hex', () => {
    expect(() => MarketDumpRunSchema.parse({ ...base, artifactSha256: 'xyz' })).toThrow();
  });

  it('拒绝未知 kind', () => {
    expect(() => MarketDumpRunSchema.parse({ ...base, kind: 'weekly-k' })).toThrow();
  });
});
