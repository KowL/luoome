import { money, type SignalObservation } from '@luoome/core';
import { describe, expect, it } from 'vitest';

import { buildTestContext } from '../testing/context.js';
import {
  completeStrategyObservationsTool,
  getSignalObservationStatsTool,
  listPendingStrategyObservationsTool,
} from './signal-observation.js';

const BASELINE = new Date('2026-08-03T08:00:00.000Z');
const NOW = new Date('2026-08-10T08:00:00.000Z');

const pending = (horizon: SignalObservation['horizon']): SignalObservation => ({
  id: `signal-observation:strategy-signal:s1:${horizon}`,
  sourceKind: 'strategy-signal',
  sourceId: 's1',
  stockId: '600519.SH',
  baselinePrice: 10,
  baselineAt: BASELINE,
  horizon,
  vintage: 'pit',
  benchmarkStatus: 'unavailable',
  status: 'pending',
  provenance: {
    provider: 'quote',
    observedAt: BASELINE,
    fetchedAt: BASELINE,
    freshness: 'unknown',
  },
});

const observed = (id: string, overrides: Partial<SignalObservation> = {}): SignalObservation => ({
  id,
  sourceKind: 'strategy-signal',
  sourceId: `source-${id}`,
  stockId: '600519.SH',
  baselinePrice: 10,
  baselineAt: BASELINE,
  horizon: 't1',
  vintage: 'pit',
  closePrice: 11,
  returnPct: 0.1,
  maxFavorableExcursionPct: 0.2,
  maxAdverseExcursionPct: -0.05,
  benchmarkReturnPct: 0.02,
  benchmarkStatus: 'complete',
  status: 'complete',
  provenance: {
    provider: 'fixture',
    observedAt: new Date('2026-08-04T08:00:00.000Z'),
    fetchedAt: new Date('2026-08-04T09:00:00.000Z'),
    freshness: 'fresh',
  },
  observedAt: new Date('2026-08-04T08:00:00.000Z'),
  ...overrides,
});

describe('strategy signal observation tools', () => {
  it('列出 pending 并仅完成日线样本已足够的 horizon', async () => {
    const ctx = await buildTestContext({ clock: () => NOW });
    await ctx.repos.signalObservation.save(pending('t3'));
    await ctx.repos.signalObservation.save(pending('t5'));
    await ctx.repos.signalObservation.save(pending('t20'));
    const dates = ['2026-08-04', '2026-08-05', '2026-08-06'];
    await ctx.repos.dailyBar.saveMany(
      dates.map((date, index) => ({
        stockId: '600519.SH',
        date: new Date(`${date}T00:00:00Z`),
        open: money(10),
        high: money(11 + index),
        low: money(9),
        close: money(10.5 + index),
        volume: 100,
        adjustment: 'qfq' as const,
        source: 'fixture',
      })),
    );
    const listed = await listPendingStrategyObservationsTool.execute({}, ctx);
    expect(listed).toMatchObject({
      ok: true,
      data: {
        stockIds: ['600519.SH'],
        observations: [{ status: 'pending' }, { status: 'pending' }],
      },
    });
    expect(
      await completeStrategyObservationsTool.execute({ runIds: ['missing-run'] }, ctx),
    ).toMatchObject({
      ok: true,
      data: { scanned: 0, completed: 0 },
    });
    expect(await ctx.repos.signalObservation.findById(pending('t3').id)).toMatchObject({
      status: 'pending',
    });
    const result = await completeStrategyObservationsTool.execute({}, ctx);
    expect(result).toMatchObject({
      ok: true,
      data: {
        scanned: 2,
        completed: 1,
        pending: 1,
        byHorizon: {
          t3: { scanned: 1, completed: 1, pending: 0 },
          t5: { scanned: 1, completed: 0, pending: 1 },
        },
      },
    });
    expect(await ctx.repos.signalObservation.findById(pending('t3').id)).toMatchObject({
      status: 'complete',
      observedAt: new Date('2026-08-06T00:00:00.000Z'),
    });
    expect(await ctx.repos.signalObservation.findById(pending('t5').id)).toMatchObject({
      status: 'pending',
    });
    expect(await ctx.repos.signalObservation.findById(pending('t20').id)).toMatchObject({
      status: 'pending',
    });
    if (!result.ok) return;
    expect(result.data.byHorizon).not.toHaveProperty('t20');
  });

  it('按 stock-day-horizon 去重并返回描述性统计与缺失限制', async () => {
    const ctx = await buildTestContext({ clock: () => NOW });
    await ctx.repos.signalObservation.save(observed('complete-1'));
    await ctx.repos.signalObservation.save(
      observed('pending-duplicate', {
        status: 'pending',
        closePrice: undefined,
        returnPct: undefined,
      }),
    );
    await ctx.repos.signalObservation.save(
      observed('pending-2', {
        stockId: '002594.SZ',
        baselineAt: new Date('2026-08-04T08:00:00.000Z'),
        status: 'pending',
        closePrice: undefined,
        returnPct: undefined,
      }),
    );
    await ctx.repos.signalObservation.save(
      observed('watch-trigger-outside-filter', {
        sourceKind: 'watch-trigger',
        horizon: 't3',
        baselineAt: new Date('2026-08-06T08:00:00.000Z'),
      }),
    );

    const result = await getSignalObservationStatsTool.execute(
      {
        since: '2026-08-03T00:00:00.000Z',
        until: '2026-08-05T23:59:59.000Z',
        sourceKind: 'strategy-signal',
        horizons: ['t1'],
        limit: 20,
      },
      ctx,
    );

    expect(result).toMatchObject({
      ok: true,
      data: {
        sampleUnit: 'stock-day-horizon',
        total: 2,
        complete: 1,
        missingRate: 0.5,
        observedAsOf: new Date('2026-08-04T08:00:00.000Z'),
        stats: [
          expect.objectContaining({
            horizon: 't1',
            sampleUnit: 'stock-day-horizon',
            total: 2,
            complete: 1,
            pending: 1,
            unavailable: 0,
            uniqueStocks: 2,
            missingRate: 0.5,
            averageReturnPct: 0.1,
            benchmarkStatus: 'complete',
          }),
        ],
      },
    });
    if (!result.ok) return;
    expect(result.data.stats[0]?.observationIds).toEqual(['complete-1', 'pending-2']);
    expect(result.data.limitations.join(' ')).toContain('描述性统计');
    expect(result.data.limitations.join(' ')).toContain('胜率承诺');
    expect(result.data.limitations.join(' ')).toContain('missingRate');
  });

  it('拒绝反向时间范围，且不把其他 horizon/source 混入统计', async () => {
    const ctx = await buildTestContext({ clock: () => NOW });
    await ctx.repos.signalObservation.save(observed('strategy-t1'));
    await ctx.repos.signalObservation.save(
      observed('strategy-t3', { horizon: 't3', baselineAt: new Date('2026-08-04T08:00:00.000Z') }),
    );
    await ctx.repos.signalObservation.save(
      observed('watch-t1', {
        sourceKind: 'watch-trigger',
        baselineAt: new Date('2026-08-04T08:00:00.000Z'),
      }),
    );

    const filtered = await getSignalObservationStatsTool.execute(
      {
        since: '2026-08-03T00:00:00.000Z',
        until: '2026-08-03T23:59:59.000Z',
        sourceKind: 'strategy-signal',
        horizons: ['t1'],
      },
      ctx,
    );
    expect(filtered).toMatchObject({
      ok: true,
      data: { total: 1, stats: [expect.objectContaining({ horizon: 't1', total: 1 })] },
    });

    const invalid = await getSignalObservationStatsTool.execute(
      { since: '2026-08-05T00:00:00.000Z', until: '2026-08-03T00:00:00.000Z' },
      ctx,
    );
    expect(invalid).toMatchObject({ ok: false, error: { kind: 'invalid_input' } });
  });
});

describe('signal observation vintage 口径', () => {
  const seedThreeVintages = async (ctx: Awaited<ReturnType<typeof buildTestContext>>) => {
    await ctx.repos.signalObservation.save(observed('pit-1', { vintage: 'pit' }));
    await ctx.repos.signalObservation.save(
      observed('restated-1', {
        vintage: 'restated',
        stockId: '000001.SZ',
        baselineAt: new Date('2026-08-04T08:00:00.000Z'),
      }),
    );
    await ctx.repos.signalObservation.save(
      observed('legacy-1', {
        vintage: 'legacy',
        stockId: '600000.SH',
        horizon: 't3',
        baselineAt: new Date('2026-08-05T08:00:00.000Z'),
      }),
    );
  };

  it('三组样本：默认只统计 pit，并在 limitations 里明示被排除的 restated/legacy 数量', async () => {
    const ctx = await buildTestContext({ clock: () => NOW });
    await seedThreeVintages(ctx);

    const result = await getSignalObservationStatsTool.execute(
      { sourceKind: 'strategy-signal' },
      ctx,
    );
    expect(result).toMatchObject({
      ok: true,
      data: {
        vintage: 'pit',
        vintageCounts: { pit: 1, restated: 1, legacy: 1 },
        mixedVintages: false,
        total: 1,
      },
    });
    if (!result.ok) return;
    const observationIds = result.data.stats.flatMap((item) => item.observationIds);
    expect(observationIds).toEqual(['pit-1']);
    const text = result.data.limitations.join(' ');
    expect(text).toContain('默认只统计 vintage=pit');
    expect(text).toContain('另有 1 条 restated、1 条 legacy 未计入');
  });

  it('混算守卫：单一口径结果内不出现第二种 vintage', async () => {
    const ctx = await buildTestContext({ clock: () => NOW });
    await seedThreeVintages(ctx);
    const vintageById = new Map([
      ['pit-1', 'pit'],
      ['restated-1', 'restated'],
      ['legacy-1', 'legacy'],
    ]);

    for (const vintage of ['pit', 'restated', 'legacy'] as const) {
      const result = await getSignalObservationStatsTool.execute(
        { sourceKind: 'strategy-signal', vintage },
        ctx,
      );
      expect(result).toMatchObject({ ok: true, data: { vintage, mixedVintages: false } });
      if (!result.ok) return;
      const seen = new Set(
        result.data.stats
          .flatMap((item) => item.observationIds)
          .map((id) => vintageById.get(id) ?? 'unknown'),
      );
      expect([...seen]).toEqual([vintage]);
    }
  });

  it('混算负例：显式请求全量时输出混算提示与分组计数', async () => {
    const ctx = await buildTestContext({ clock: () => NOW });
    await seedThreeVintages(ctx);

    const result = await getSignalObservationStatsTool.execute(
      { sourceKind: 'strategy-signal', includeAllVintages: true },
      ctx,
    );
    expect(result).toMatchObject({
      ok: true,
      data: {
        vintage: 'all',
        vintageCounts: { pit: 1, restated: 1, legacy: 1 },
        mixedVintages: true,
        total: 3,
      },
    });
    if (!result.ok) return;
    const text = result.data.limitations.join(' ');
    expect(text).toContain('显式全量请求');
    expect(text).toContain('混合了 pit 1 条 / restated 1 条 / legacy 1 条');
    expect(text).toContain('不得用于策略历史命中');
    expect(result.data.limitations.join(' ')).not.toContain('另有 1 条 restated');
  });

  it('restated 单口径只进统计层，并提示不得冒充 pit', async () => {
    const ctx = await buildTestContext({ clock: () => NOW });
    await seedThreeVintages(ctx);

    const result = await getSignalObservationStatsTool.execute(
      { sourceKind: 'strategy-signal', vintage: 'restated' },
      ctx,
    );
    expect(result).toMatchObject({ ok: true, data: { vintage: 'restated', total: 1 } });
    if (!result.ok) return;
    expect(result.data.stats.flatMap((item) => item.observationIds)).toEqual(['restated-1']);
    expect(result.data.limitations.join(' ')).toContain('restated 只允许用于统计层');
  });

  it('vintage 与 includeAllVintages 互斥', async () => {
    const ctx = await buildTestContext({ clock: () => NOW });
    await seedThreeVintages(ctx);
    const result = await getSignalObservationStatsTool.execute(
      { sourceKind: 'strategy-signal', vintage: 'pit', includeAllVintages: true },
      ctx,
    );
    expect(result).toMatchObject({ ok: false, error: { kind: 'invalid_input' } });
  });
});
