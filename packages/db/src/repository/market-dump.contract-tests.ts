import type {
  CorporateActionEventRepository,
  CorporateActionEventRevision,
  MarketDumpRun,
  MarketDumpRunRepository,
  RawDailyBarRepository,
  RawDailyBarRevision,
} from '@luoome/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * Phase 2 market dump 仓储契约套件：Drizzle 与 in-memory 实现必须满足同一组行为。
 * 独立于共享 contract-tests.ts（Phase 2 交付边界不编辑该文件）；集成时可并入主套件。
 */

export interface MarketDumpContractRepos {
  readonly marketDumpRun: MarketDumpRunRepository;
  readonly rawDailyBar: RawDailyBarRepository;
  readonly corporateActionEvent: CorporateActionEventRepository;
}

export interface MarketDumpContractHandle {
  readonly repos: MarketDumpContractRepos;
  readonly close?: () => void;
}

const T0 = new Date('2026-11-03T15:00:00.000Z');
const T1 = new Date('2026-11-03T15:01:00.000Z');
const T2 = new Date('2026-11-03T15:02:00.000Z');
const D1 = new Date('2026-10-21T00:00:00.000Z');
const D2 = new Date('2026-11-03T00:00:00.000Z');
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const HASH_C = 'c'.repeat(64);

export const makeMarketDumpRun = (
  runId: string,
  overrides: Partial<MarketDumpRun> = {},
): MarketDumpRun => ({
  runId,
  kind: 'daily-k',
  dumpId: 'a_share_daily_k_1d_none_10d',
  source: 'fuyao',
  artifactSha256: null,
  status: 'running',
  recordedAt: null,
  requestedAt: T0,
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
  ...overrides,
});

export const makeRawDailyBar = (
  stockId: string,
  date: Date,
  overrides: Partial<RawDailyBarRevision> = {},
): RawDailyBarRevision => ({
  stockId,
  date,
  open: 10,
  high: 11,
  low: 9,
  close: 10.5,
  volume: 1000,
  turnover: 10_500,
  source: 'fuyao',
  dumpId: 'a_share_daily_k_1d_none_10d',
  artifactSha256: HASH_A,
  recordedAt: T1,
  contentHash: HASH_B,
  ...overrides,
});

export const makeCorporateActionEvent = (
  stockId: string,
  exDate: Date,
  overrides: Partial<CorporateActionEventRevision> = {},
): CorporateActionEventRevision => ({
  stockId,
  exDate,
  dividendPerShare: 1.5,
  perShareBonus: 0,
  allotmentRatio: null,
  allotmentPrice: null,
  currency: 'CNY',
  source: 'fuyao',
  sourceRecordId: `${stockId}:${exDate.getTime()}:dividend`,
  dumpId: 'a_share_adjustment_factors_event_none_all',
  artifactSha256: HASH_A,
  recordedAt: T1,
  contentHash: HASH_C,
  ...overrides,
});

export const registerMarketDumpContractTests = (
  label: string,
  factory: () => MarketDumpContractHandle,
): void => {
  describe(`market dump repository contract [${label}]`, () => {
    let handle: MarketDumpContractHandle;
    let repos: MarketDumpContractRepos;

    beforeEach(() => {
      handle = factory();
      repos = handle.repos;
    });

    afterEach(() => {
      handle.close?.();
    });

    describe('MarketDumpRunRepository', () => {
      it('saveStarted + findById 往返一致', async () => {
        const run = makeMarketDumpRun('run-1');
        await repos.marketDumpRun.saveStarted(run);
        expect(await repos.marketDumpRun.findById('run-1')).toEqual(run);
        expect(await repos.marketDumpRun.findById('missing')).toBeNull();
      });

      it('saveStarted 幂等重放；身份不一致拒绝', async () => {
        await repos.marketDumpRun.saveStarted(makeMarketDumpRun('run-1'));
        await expect(
          repos.marketDumpRun.saveStarted(makeMarketDumpRun('run-1')),
        ).resolves.toBeUndefined();
        await expect(
          repos.marketDumpRun.saveStarted(makeMarketDumpRun('run-1', { dumpId: 'other' })),
        ).rejects.toThrow(/身份不一致/);
      });

      it('saveStarted 拒绝非 running 状态', async () => {
        await expect(
          repos.marketDumpRun.saveStarted(
            makeMarketDumpRun('run-1', {
              status: 'failed',
              finishedAt: T2,
              errorKind: 'network',
            }),
          ),
        ).rejects.toThrow(/running/);
      });

      it('markDownloaded → advanceCheckpoint 冻结 recordedAt → finish complete', async () => {
        await repos.marketDumpRun.saveStarted(makeMarketDumpRun('run-1'));
        await repos.marketDumpRun.markDownloaded({
          runId: 'run-1',
          artifactSha256: HASH_A,
          artifactBytes: 1024,
          downloadedAt: T1,
        });
        await repos.marketDumpRun.advanceCheckpoint({
          runId: 'run-1',
          recordedAt: T1,
          nextRowOffset: 500,
          processedRows: 500,
          minDate: D1,
          maxDate: D2,
        });
        // 第二次推进沿用首次冻结的 recordedAt（checkpoint 恢复语义）。
        await repos.marketDumpRun.advanceCheckpoint({
          runId: 'run-1',
          recordedAt: T2,
          nextRowOffset: 1000,
          processedRows: 1000,
          minDate: D1,
          maxDate: D2,
        });
        const mid = await repos.marketDumpRun.findById('run-1');
        expect(mid?.recordedAt?.getTime()).toBe(T1.getTime());
        expect(mid?.startedAt?.getTime()).toBe(T1.getTime());
        expect(mid?.nextRowOffset).toBe(1000);
        await repos.marketDumpRun.finish({ runId: 'run-1', status: 'complete', finishedAt: T2 });
        const done = await repos.marketDumpRun.findById('run-1');
        expect(done?.status).toBe('complete');
        expect(done?.finishedAt?.getTime()).toBe(T2.getTime());
      });

      it('complete 前未 markDownloaded 拒绝；failed 必须带 errorKind', async () => {
        await repos.marketDumpRun.saveStarted(makeMarketDumpRun('run-1'));
        await expect(
          repos.marketDumpRun.finish({ runId: 'run-1', status: 'complete', finishedAt: T2 }),
        ).rejects.toThrow(/markDownloaded/);
        await expect(
          repos.marketDumpRun.finish({ runId: 'run-1', status: 'failed', finishedAt: T2 }),
        ).rejects.toThrow(/errorKind/);
        await repos.marketDumpRun.finish({
          runId: 'run-1',
          status: 'failed',
          finishedAt: T2,
          errorKind: 'network',
          errorMessage: 'connection reset',
        });
        const failed = await repos.marketDumpRun.findById('run-1');
        expect(failed?.status).toBe('failed');
        expect(failed?.errorKind).toBe('network');
      });

      it('终态后拒绝任何写入', async () => {
        await repos.marketDumpRun.saveStarted(makeMarketDumpRun('run-1'));
        await repos.marketDumpRun.finish({
          runId: 'run-1',
          status: 'failed',
          finishedAt: T1,
          errorKind: 'timeout',
        });
        await expect(
          repos.marketDumpRun.markDownloaded({
            runId: 'run-1',
            artifactSha256: HASH_A,
            artifactBytes: 1,
            downloadedAt: T2,
          }),
        ).rejects.toThrow(/终态/);
        await expect(
          repos.marketDumpRun.advanceCheckpoint({
            runId: 'run-1',
            recordedAt: T2,
            nextRowOffset: 1,
            processedRows: 1,
            minDate: null,
            maxDate: null,
          }),
        ).rejects.toThrow(/终态/);
      });

      it('listRecent 按 requestedAt 降序并按 kind 过滤', async () => {
        await repos.marketDumpRun.saveStarted(makeMarketDumpRun('run-old', { requestedAt: T0 }));
        await repos.marketDumpRun.saveStarted(
          makeMarketDumpRun('run-new', { requestedAt: T2, kind: 'adjustment-factors' }),
        );
        const all = await repos.marketDumpRun.listRecent({});
        expect(all.map((run) => run.runId)).toEqual(['run-new', 'run-old']);
        const dailyOnly = await repos.marketDumpRun.listRecent({ kind: 'daily-k' });
        expect(dailyOnly.map((run) => run.runId)).toEqual(['run-old']);
      });

      it('findResumable 只匹配 running 且 (kind, dumpId, artifactSha256) 一致', async () => {
        await repos.marketDumpRun.saveStarted(makeMarketDumpRun('run-1'));
        expect(
          await repos.marketDumpRun.findResumable({
            kind: 'daily-k',
            dumpId: 'a_share_daily_k_1d_none_10d',
            artifactSha256: HASH_A,
          }),
        ).toBeNull();
        await repos.marketDumpRun.markDownloaded({
          runId: 'run-1',
          artifactSha256: HASH_A,
          artifactBytes: 10,
          downloadedAt: T1,
        });
        const resumable = await repos.marketDumpRun.findResumable({
          kind: 'daily-k',
          dumpId: 'a_share_daily_k_1d_none_10d',
          artifactSha256: HASH_A,
        });
        expect(resumable?.runId).toBe('run-1');
        await repos.marketDumpRun.finish({
          runId: 'run-1',
          status: 'failed',
          finishedAt: T2,
          errorKind: 'network',
        });
        expect(
          await repos.marketDumpRun.findResumable({
            kind: 'daily-k',
            dumpId: 'a_share_daily_k_1d_none_10d',
            artifactSha256: HASH_A,
          }),
        ).toBeNull();
      });
    });

    describe('RawDailyBarRepository', () => {
      it('saveMany + listRevisions 区间与 PIT cutoff 过滤', async () => {
        await repos.rawDailyBar.saveMany([
          makeRawDailyBar('600519.SH', D1),
          makeRawDailyBar('600519.SH', D2),
          makeRawDailyBar('000001.SZ', D2),
        ]);
        const all = await repos.rawDailyBar.listRevisions({ stockId: '600519.SH' });
        expect(all.map((bar) => bar.date.getTime())).toEqual([D1.getTime(), D2.getTime()]);
        const ranged = await repos.rawDailyBar.listRevisions({
          stockId: '600519.SH',
          from: D2,
          to: D2,
        });
        expect(ranged).toHaveLength(1);
        const pit = await repos.rawDailyBar.listRevisions({
          stockId: '600519.SH',
          recordedAt: new Date(T1.getTime() - 1),
        });
        expect(pit).toEqual([]);
      });

      it('幂等重放不重复插入；同 recordedAt 不同 contentHash 并存', async () => {
        const bar = makeRawDailyBar('600519.SH', D1);
        await repos.rawDailyBar.saveMany([bar]);
        await repos.rawDailyBar.saveMany([bar]);
        expect(await repos.rawDailyBar.listRevisions({ stockId: '600519.SH' })).toHaveLength(1);
        await repos.rawDailyBar.saveMany([
          makeRawDailyBar('600519.SH', D1, { contentHash: HASH_C }),
        ]);
        expect(await repos.rawDailyBar.listRevisions({ stockId: '600519.SH' })).toHaveLength(2);
      });

      it('listRevisionsForStocks 稳定排序（stockId, date, recordedAt, contentHash）', async () => {
        await repos.rawDailyBar.saveMany([
          makeRawDailyBar('000001.SZ', D2),
          makeRawDailyBar('600519.SH', D2),
          makeRawDailyBar('600519.SH', D1),
        ]);
        const rows = await repos.rawDailyBar.listRevisionsForStocks({
          stockIds: ['600519.SH', '000001.SZ'],
        });
        expect(rows.map((row) => `${row.stockId}@${row.date.getTime()}`)).toEqual([
          `000001.SZ@${D2.getTime()}`,
          `600519.SH@${D1.getTime()}`,
          `600519.SH@${D2.getTime()}`,
        ]);
        expect(await repos.rawDailyBar.listRevisionsForStocks({ stockIds: [] })).toEqual([]);
      });

      it('summarizeArtifact 返回行数与日期范围', async () => {
        await repos.rawDailyBar.saveMany([
          makeRawDailyBar('600519.SH', D1),
          makeRawDailyBar('600519.SH', D2),
          makeRawDailyBar('000001.SZ', D2, { artifactSha256: HASH_C }),
        ]);
        const summary = await repos.rawDailyBar.summarizeArtifact({
          dumpId: 'a_share_daily_k_1d_none_10d',
          artifactSha256: HASH_A,
        });
        expect(summary.rows).toBe(2);
        expect(summary.minDate?.getTime()).toBe(D1.getTime());
        expect(summary.maxDate?.getTime()).toBe(D2.getTime());
      });
    });

    describe('CorporateActionEventRepository', () => {
      it('同日多事件分别保留（不同 sourceRecordId/contentHash）', async () => {
        const dividend = makeCorporateActionEvent('600030.SH', D1);
        const allotment = makeCorporateActionEvent('600030.SH', D1, {
          dividendPerShare: 0,
          allotmentRatio: 0.15,
          allotmentPrice: 16.62,
          sourceRecordId: '600030.SH:rights:2022-01-19',
          contentHash: HASH_B,
        });
        await repos.corporateActionEvent.saveMany([dividend, allotment]);
        const rows = await repos.corporateActionEvent.listRevisions({ stockId: '600030.SH' });
        expect(rows).toHaveLength(2);
        expect(rows.map((row) => row.sourceRecordId).sort()).toEqual(
          ['600030.SH:rights:2022-01-19', dividend.sourceRecordId].sort(),
        );
      });

      it('幂等重放不重复插入', async () => {
        const event = makeCorporateActionEvent('600519.SH', D1);
        await repos.corporateActionEvent.saveMany([event]);
        await repos.corporateActionEvent.saveMany([event]);
        expect(
          await repos.corporateActionEvent.listRevisions({ stockId: '600519.SH' }),
        ).toHaveLength(1);
      });

      it('保留零值行（配股除权日在线呈现为 0/0）', async () => {
        await repos.corporateActionEvent.saveMany([
          makeCorporateActionEvent('600030.SH', D1, {
            dividendPerShare: 0,
            perShareBonus: 0,
            dumpId: null,
            artifactSha256: null,
          }),
        ]);
        const rows = await repos.corporateActionEvent.listRevisions({ stockId: '600030.SH' });
        expect(rows).toHaveLength(1);
        expect(rows[0]?.dividendPerShare).toBe(0);
        expect(rows[0]?.dumpId).toBeNull();
      });

      it('listRevisionsForStocks 与 summarizeArtifact', async () => {
        await repos.corporateActionEvent.saveMany([
          makeCorporateActionEvent('600519.SH', D2),
          makeCorporateActionEvent('000001.SZ', D1),
        ]);
        const rows = await repos.corporateActionEvent.listRevisionsForStocks({
          stockIds: ['600519.SH', '000001.SZ'],
        });
        expect(rows.map((row) => row.stockId)).toEqual(['000001.SZ', '600519.SH']);
        const summary = await repos.corporateActionEvent.summarizeArtifact({
          dumpId: 'a_share_adjustment_factors_event_none_all',
          artifactSha256: HASH_A,
        });
        expect(summary.rows).toBe(2);
        expect(summary.minDate?.getTime()).toBe(D1.getTime());
        expect(summary.maxDate?.getTime()).toBe(D2.getTime());
      });

      it('PIT cutoff：recordedAt 过滤', async () => {
        await repos.corporateActionEvent.saveMany([makeCorporateActionEvent('600519.SH', D1)]);
        expect(
          await repos.corporateActionEvent.listRevisions({
            stockId: '600519.SH',
            recordedAt: new Date(T1.getTime() - 1),
          }),
        ).toEqual([]);
      });
    });
  });
};
