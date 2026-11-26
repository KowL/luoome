import { buildMarketSnapshotBatch, type MarketSnapshotItem, type SectorKind } from '@luoome/core';
import { getMarketRoomThemesTool } from '@luoome/toolkit/tools/market-room-themes.js';
import {
  getThemeLibraryTool,
  importThemeLibraryTool,
  updateThemeLibraryTool,
} from '@luoome/toolkit/tools/theme-library.js';
import { describe, expect, it } from 'vitest';
import { buildTestContext, seedTestStockUniverse } from '../testing/context.js';

const TRADING_DATE = '2026-11-25';
const at = (time: string): Date => new Date(`${TRADING_DATE}T${time}+08:00`);

const item = (id: string, changePct: number, close = 10): MarketSnapshotItem => ({
  id,
  code: id.split('.')[0] as string,
  exchange: 'SH',
  name: id,
  close,
  changePct,
  amount: 1_000_000,
});

const batch = (time: string, items: readonly MarketSnapshotItem[]) =>
  buildMarketSnapshotBatch({
    sampledAt: at(time),
    snapshot: {
      coverage: 'CN_A_SHARES_SH_SZ',
      source: 'fixture',
      fetchedAt: at(time),
      items: [...items],
      completeness: {
        expectedCount: items.length,
        receivedCount: items.length,
        missingCount: 0,
        duplicateCount: 0,
        complete: true,
      },
    },
  });

const seedConcepts = async (ctx: Awaited<ReturnType<typeof buildTestContext>>) => {
  const kinds: SectorKind[] = ['concept'];
  await ctx.repos.sectorCatalog.applySync({
    syncId: 'sector-sync-1',
    source: 'fuyao',
    appliedAt: at('08:00'),
    status: 'succeeded',
    catalog: [
      { kind: 'concept', vendorCode: '885728.TI', name: '人工智能' },
      { kind: 'concept', vendorCode: '886108.TI', name: 'AI应用' },
      { kind: 'concept', vendorCode: '885756.TI', name: '芯片概念' },
    ],
    catalogKinds: kinds,
    observations: [
      {
        stockId: '600519.SH',
        sectors: [
          { kind: 'concept', vendorCode: '885728.TI', name: '人工智能' },
          { kind: 'concept', vendorCode: '886108.TI', name: 'AI应用' },
        ],
      },
      {
        stockId: '000001.SZ',
        sectors: [{ kind: 'concept', vendorCode: '885728.TI', name: '人工智能' }],
      },
      {
        stockId: '300750.SZ',
        sectors: [
          { kind: 'concept', vendorCode: '886108.TI', name: 'AI应用' },
          { kind: 'concept', vendorCode: '885756.TI', name: '芯片概念' },
        ],
      },
    ],
    stockStatuses: [],
    failures: [],
  });
};

describe('theme library tools', () => {
  it('rejects import when the local fuyao source is empty', async () => {
    const ctx = await buildTestContext({ clock: () => at('09:00') });
    const result = await importThemeLibraryTool.execute({}, ctx);
    expect(result).toMatchObject({ ok: false, error: { kind: 'invalid_input' } });
    expect(await ctx.repos.themeLibrary.listThemes({ state: 'all' })).toEqual([]);
  });

  it('imports standard-theme seeds, dedupes overlap, and never overwrites manual edits on retry', async () => {
    const ctx = await buildTestContext({ clock: () => at('09:00') });
    await seedConcepts(ctx);

    const first = await importThemeLibraryTool.execute({}, ctx);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.data.import.status).toBe('imported');
    expect(first.data.import.createdThemes).toBe(2);
    expect(first.data.import.createdMembers).toBe(4);

    const library = await getThemeLibraryTool.execute({ state: 'all' }, ctx);
    expect(library.ok).toBe(true);
    if (!library.ok) return;
    expect(library.data.themes.map((entry) => entry.theme.name)).toEqual(['AI与算力', '半导体']);
    expect(library.data.themes[0]).toMatchObject({ activeMemberCount: 3, sourceCount: 2 });

    const removed = await updateThemeLibraryTool.execute(
      { action: 'remove-member', themeId: 'ai-computing', stockId: '600519.SH' },
      ctx,
    );
    expect(removed.ok).toBe(true);
    const renamed = await updateThemeLibraryTool.execute(
      { action: 'rename', themeId: 'ai-computing', name: 'AI 算力' },
      ctx,
    );
    expect(renamed.ok).toBe(true);

    const retry = await importThemeLibraryTool.execute({}, ctx);
    expect(retry.ok).toBe(true);
    if (!retry.ok) return;
    expect(retry.data.import).toMatchObject({ status: 'unchanged', createdThemes: 0 });
    const after = await getThemeLibraryTool.execute({ themeId: 'ai-computing' }, ctx);
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    expect(after.data.detail?.theme.name).toBe('AI 算力');
    expect(
      after.data.detail?.members
        .filter((view) => view.member.effectiveTo === null)
        .map((view) => view.member.stockId),
    ).toEqual(['000001.SZ', '300750.SZ']);
  });

  it('maintains order, archive, and validates stock existence before adding members', async () => {
    const ctx = await buildTestContext({ clock: () => at('09:00') });
    await seedConcepts(ctx);
    await seedTestStockUniverse(ctx);
    await importThemeLibraryTool.execute({}, ctx);

    const created = await updateThemeLibraryTool.execute(
      { action: 'create', name: '低空经济' },
      ctx,
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const themeId = created.data.themeId!;

    const invalidStock = await updateThemeLibraryTool.execute(
      { action: 'add-members', themeId, stockIds: ['999999.SH'] },
      ctx,
    );
    expect(invalidStock).toMatchObject({ ok: false, error: { kind: 'invalid_input' } });

    const added = await updateThemeLibraryTool.execute(
      { action: 'add-members', themeId, stockIds: ['600519.SH', '600519.SH'] },
      ctx,
    );
    expect(added).toMatchObject({ ok: true, data: { changed: 1 } });

    const reorder = await updateThemeLibraryTool.execute(
      { action: 'reorder', themeIds: [themeId, 'ai-computing', 'semiconductor'] },
      ctx,
    );
    expect(reorder.ok).toBe(true);
    const archived = await updateThemeLibraryTool.execute(
      { action: 'archive', themeId: 'semiconductor' },
      ctx,
    );
    expect(archived.ok).toBe(true);
    const library = await getThemeLibraryTool.execute({ state: 'all' }, ctx);
    if (!library.ok) throw new Error('library read failed');
    expect(
      library.data.themes.map((entry) => [
        entry.theme.id,
        entry.theme.sortOrder,
        entry.theme.state,
      ]),
    ).toEqual([
      [themeId, 0, 'active'],
      ['ai-computing', 1, 'active'],
      ['semiconductor', 2, 'archived'],
    ]);
  });

  it('shows a post-close import against the last quotes only in the live view', async () => {
    const ctx = await buildTestContext({ clock: () => at('15:23') });
    await ctx.repos.marketSnapshotBatch.publish(batch('14:59', [item('600519.SH', 4)]));
    await seedConcepts(ctx);
    await importThemeLibraryTool.execute({}, ctx);
    const params = { window: 'w15' as const, themeId: 'ai-computing' };
    const live = await getMarketRoomThemesTool.execute(params, ctx);
    expect(live).toMatchObject({ ok: true, data: { rotation: { state: 'ready' } } });
    if (!live.ok) return;
    expect(live.data.rotation.themes[0]).toMatchObject({
      day: { value: 4 },
      memberCount: 3,
      trend: { points: [{ value: null }] },
    });
    const replay = await getMarketRoomThemesTool.execute({ ...params, at: at('14:59') }, ctx);
    expect(replay).toMatchObject({ ok: true, data: { rotation: { emptyReason: 'no_members' } } });
  });

  it('reads rotation from the library with per-batch effective members and no future edits', async () => {
    let now = at('09:00');
    const ctx = await buildTestContext({ clock: () => now });
    await seedConcepts(ctx);
    await importThemeLibraryTool.execute({}, ctx);

    await ctx.repos.marketSnapshotBatch.publish(
      batch('09:30', [item('600519.SH', 1), item('000001.SZ', 2), item('300750.SZ', 3)]),
    );
    await ctx.repos.marketSnapshotBatch.publish(
      batch('09:45', [
        item('600519.SH', 2, 10),
        item('000001.SZ', 3, 10),
        item('300750.SZ', 4, 10),
      ]),
    );
    await ctx.repos.marketSnapshotBatch.publish(
      batch('10:00', [
        item('600519.SH', 5, 10.5),
        item('000001.SZ', 6, 10.5),
        item('300750.SZ', 7, 10.5),
      ]),
    );

    const latest = await getMarketRoomThemesTool.execute(
      { window: 'w15', themeId: 'ai-computing' },
      ctx,
    );
    expect(latest.ok).toBe(true);
    if (!latest.ok) return;
    expect(latest.data.rotation.state).toBe('ready');
    expect(latest.data.rotation.themes.map((theme) => theme.themeId)).toEqual([
      'ai-computing',
      'semiconductor',
    ]);
    const ai = latest.data.rotation.themes[0]!;
    expect(ai.memberCount).toBe(3);
    expect(ai.day.value).toBe(6);
    expect(ai.window15.value).toBe(5);
    expect(ai.trend.points.map((point) => point.value)).toEqual([2, 3, 6]);

    // 回放 09:30：之后的人工移除 / 新增都不得倒灌进历史。
    const replayAnchor = await ctx.repos.marketSnapshotBatch.findAtOrBefore({
      coverage: 'CN_A_SHARES_SH_SZ',
      tradingDate: TRADING_DATE,
      sampledAt: at('09:30'),
    });
    await ctx.repos.marketSnapshotBatch.publish(
      batch('10:30', [
        item('600519.SH', 8, 10.6),
        item('000001.SZ', 9, 10.6),
        item('300750.SZ', 10, 10.6),
      ]),
    );
    now = at('10:30');
    await updateThemeLibraryTool.execute(
      { action: 'remove-member', themeId: 'ai-computing', stockId: '600519.SH' },
      ctx,
    );
    const replay = await getMarketRoomThemesTool.execute(
      { window: 'w15', at: at('09:30'), themeId: 'ai-computing' },
      ctx,
    );
    expect(replay.ok).toBe(true);
    if (!replay.ok || replayAnchor === null) return;
    const replayAi = replay.data.rotation.themes[0]!;
    expect(replay.data.rotation.anchor?.sampledAt).toEqual(replayAnchor.sampledAt);
    expect(replayAi.memberCount).toBe(3);
    expect(replayAi.trend.points.map((point) => point.value)).toEqual([2]);

    const afterRemoval = await getMarketRoomThemesTool.execute({ window: 'w15' }, ctx);
    expect(afterRemoval.ok).toBe(true);
    if (!afterRemoval.ok) return;
    expect(afterRemoval.data.rotation.themes[0]?.memberCount).toBe(2);
  });
});
