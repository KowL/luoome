import { describe, expect, it } from 'bun:test';
import { buildMarketSnapshotBatch, themeLibraryRuleThemeId } from '@luoome/core';
import { buildTestContext } from '@luoome/tools/testing';
import { createWebApp } from './server.js';

const TRADING_DATE = '2026-11-25';
const at = (time: string): Date => new Date(`${TRADING_DATE}T${time}+08:00`);

const seedConcepts = async (ctx: Awaited<ReturnType<typeof buildTestContext>>) => {
  await ctx.repos.sectorCatalog.applySync({
    syncId: 'sector-sync-1',
    source: 'fuyao',
    appliedAt: at('08:00'),
    status: 'succeeded',
    catalog: [
      { kind: 'concept', vendorCode: '885728.TI', name: '人工智能' },
      { kind: 'concept', vendorCode: '886108.TI', name: 'AI应用' },
    ],
    catalogKinds: ['concept'],
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
    ],
    stockStatuses: [],
    failures: [],
  });
};

const postJson = (
  app: ReturnType<typeof createWebApp>,
  path: string,
  body: unknown,
  headers = {},
) =>
  app.fetch(
    new Request(`http://test${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    }),
  );

describe('系统题材库 Web 路由', () => {
  it('imports from local fuyao data and serves the library + rotation read models', async () => {
    const ctx = await buildTestContext({ clock: () => at('09:00') });
    await seedConcepts(ctx);
    await ctx.repos.marketSnapshotBatch.publish(
      buildMarketSnapshotBatch({
        sampledAt: at('10:00'),
        snapshot: {
          coverage: 'CN_A_SHARES_SH_SZ',
          source: 'fixture',
          fetchedAt: at('10:00'),
          items: [
            {
              id: '600519.SH',
              code: '600519',
              exchange: 'SH',
              name: '贵州茅台',
              close: 10.5,
              changePct: 5,
              amount: 1_000_000,
            },
            {
              id: '000001.SZ',
              code: '000001',
              exchange: 'SZ',
              name: '平安银行',
              close: 10.2,
              changePct: 2,
              amount: 2_000_000,
            },
          ],
          completeness: {
            expectedCount: 2,
            receivedCount: 2,
            missingCount: 0,
            duplicateCount: 0,
            complete: true,
          },
        },
      }),
    );
    const web = createWebApp(ctx, { exposeWrite: true, exposeExternal: false });

    const imported = await postJson(web, '/api/theme-library/import', {});
    expect(imported.status).toBe(200);
    const importBody = (await imported.json()) as {
      ok: boolean;
      data?: { import: { status: string; createdThemes: number } };
    };
    expect(importBody.ok).toBe(true);
    expect(importBody.data?.import).toMatchObject({ status: 'imported', createdThemes: 1 });

    const library = await web.fetch(new Request('http://test/api/theme-library?state=all'));
    const libraryBody = (await library.json()) as {
      ok: boolean;
      data?: {
        canManage: boolean;
        initialized: boolean;
        themes: { theme: { name: string }; activeMemberCount: number }[];
      };
    };
    expect(libraryBody.data).toMatchObject({ canManage: true, initialized: true });
    expect(libraryBody.data?.themes[0]).toMatchObject({
      theme: { name: 'AI与算力' },
      activeMemberCount: 2,
    });

    const rotation = await web.fetch(new Request('http://test/api/market/room/themes?window=w15'));
    const rotationBody = (await rotation.json()) as {
      ok: boolean;
      data?: {
        rotation: {
          state: string;
          batches: { sampledAt: string; complete: boolean }[];
          themes: {
            themeId: string;
            day: { value: number };
            window15: { value: number };
            memberCount: number;
            leaders: {
              day: { stockId: string; name: string | null; value: number }[];
              window: { stockId: string; value: number }[];
            };
          }[];
        };
      };
    };
    expect(rotationBody.data?.rotation.state).toBe('ready');
    expect(rotationBody.data?.rotation.themes[0]).toMatchObject({
      themeId: 'ai-computing',
      memberCount: 2,
      day: { value: 3.5 },
    });
    // 轮动图需要的两份读模型：同一次响应里的卡内前五只 + 当日可选批次时间轴
    const row = rotationBody.data?.rotation.themes[0];
    expect(row?.leaders.day.map((leader) => [leader.stockId, leader.value])).toEqual([
      ['600519.SH', 5],
      ['000001.SZ', 2],
    ]);
    expect(row?.leaders.window).toEqual([]);
    expect(rotationBody.data?.rotation.batches).toEqual([
      { sampledAt: at('10:00').toISOString(), complete: true },
    ]);
  });

  it('requires write opt-in and same-origin Origin for every mutation', async () => {
    const ctx = await buildTestContext({ clock: () => at('09:00') });
    const guarded = createWebApp(ctx, { exposeWrite: false, exposeExternal: false });
    const denied = await postJson(guarded, '/api/theme-library/import', {});
    expect(denied.status).toBe(403);

    const read = await guarded.fetch(new Request('http://test/api/theme-library'));
    const readBody = (await read.json()) as { data: { canManage: boolean } };
    expect(readBody.data.canManage).toBe(false);

    const web = createWebApp(ctx, { exposeWrite: true, exposeExternal: false });
    const crossOrigin = await postJson(
      web,
      '/api/theme-library/update',
      { action: 'create', name: '低空经济' },
      { origin: 'http://evil.test' },
    );
    expect(crossOrigin.status).toBe(403);
  });

  it('maintains order and archive through the update route and keeps raw concepts out of the theme read model', async () => {
    const ctx = await buildTestContext({ clock: () => at('09:00') });
    await seedConcepts(ctx);
    const web = createWebApp(ctx, { exposeWrite: true, exposeExternal: false });
    const imported = await postJson(web, '/api/theme-library/import', {});
    expect(imported.status).toBe(200);

    const created = await postJson(web, '/api/theme-library/update', {
      action: 'create',
      name: '低空经济',
    });
    expect(created.status).toBe(200);
    const createdBody = (await created.json()) as { ok: boolean; data?: { themeId: string } };
    expect(createdBody.ok).toBe(true);
    const themeId = createdBody.data?.themeId;
    expect(typeof themeId).toBe('string');

    const reordered = await postJson(web, '/api/theme-library/update', {
      action: 'reorder',
      themeIds: [themeId, 'ai-computing'],
    });
    expect(reordered.status).toBe(200);

    const archived = await postJson(web, '/api/theme-library/update', {
      action: 'archive',
      themeId: 'ai-computing',
    });
    expect(archived.status).toBe(200);

    const library = await web.fetch(new Request('http://test/api/theme-library?state=all'));
    const body = (await library.json()) as {
      data: { themes: { theme: { id: string; sortOrder: number; state: string } }[] };
    };
    expect(body.data.themes.map((entry) => entry.theme)).toMatchObject([
      { id: themeId, sortOrder: 0, state: 'active' },
      { id: 'ai-computing', sortOrder: 1, state: 'archived' },
    ]);
  });
});

describe('系统题材库自动维护 Web 路由', () => {
  const snapshot = (entries: { stockId: string; name: string; reason: string | null }[]) => ({
    date: TRADING_DATE,
    source: 'fuyao' as const,
    asOf: at('15:20'),
    dataAsOf: at('15:10'),
    pool: {
      total: entries.length,
      entries: entries.map((entry) => ({
        stockId: entry.stockId,
        code: entry.stockId.slice(0, 6),
        name: entry.name,
        isSt: false,
        isNew: false,
        price: 10,
        changePct: 0.1,
        limitUpTime: '09:35',
        openTimes: 0,
        reason: entry.reason,
        continueDayText: '首板',
        continueDayCnt: 1,
        sealMoney: 1_000_000,
        maxSealMoney: 1_000_000,
      })),
    },
    statistics: {
      tradeDate: TRADING_DATE,
      sealRate: 0.6,
      openStockCount: 2,
      limitUpStockCount: entries.length,
      touchedLimitUpStockCount: entries.length + 2,
      pageBoards: [],
      exactBoards: [],
    },
    ladder: null,
    warnings: [],
  });

  const manager = (result: { ok: boolean; data?: unknown; error?: unknown }) => ({
    name: 'limit-up-market' as const,
    sources: ['fuyao'],
    status: () => [],
    fetchMarket: async () => result as never,
  });

  const ROBOTICS = themeLibraryRuleThemeId('机器人与具身智能');

  const seedRuleTheme = async (ctx: Awaited<ReturnType<typeof buildTestContext>>) => {
    await ctx.repos.themeLibrary.importSeed({
      importId: 'seed-rule-1',
      source: 'fuyao-concept',
      appliedAt: at('08:00'),
      seed: {
        themes: [
          {
            id: ROBOTICS,
            name: '机器人',
            sortOrder: 0,
            sources: [{ vendorCode: '885728.TI', sectorId: 'concept-1', name: '机器人概念' }],
            stockIds: ['000001.SZ'],
          },
        ],
        skipped: [],
      },
    });
  };

  const autoContext = async (input?: {
    entries?: { stockId: string; name: string; reason: string | null }[];
    failing?: boolean;
  }) =>
    buildTestContext({
      clock: () => at('16:05'),
      limitUpMarket: manager(
        input?.failing === true
          ? {
              ok: false,
              error: {
                kind: 'adapter_error',
                adapter: 'limit-up-market',
                message: '上游超时',
                recoverable: true,
              },
            }
          : {
              ok: true,
              data: snapshot(
                input?.entries ?? [
                  { stockId: '600519.SH', name: '贵州茅台', reason: '工业机器人+减速器' },
                  { stockId: '000002.SZ', name: '万科A', reason: '量子织布机' },
                ],
              ),
            },
      ),
    });

  it('reads the auto status with the library and toggles it through the update route', async () => {
    const ctx = await autoContext();
    await seedConcepts(ctx);
    const web = createWebApp(ctx, { exposeWrite: true, exposeExternal: true });
    await seedRuleTheme(ctx);

    const read = await web.fetch(new Request('http://test/api/theme-library'));
    const readBody = (await read.json()) as {
      data: { auto: { enabled: boolean; lastRun: unknown; pending: unknown[] } };
    };
    expect(readBody.data.auto).toMatchObject({ enabled: false, lastRun: null, pending: [] });

    const enabled = await postJson(web, '/api/theme-library/auto/settings', { enabled: true });
    expect(enabled.status).toBe(200);
    const enabledBody = (await enabled.json()) as { ok: boolean; data?: { changed: number } };
    expect(enabledBody.data?.changed).toBe(1);

    const again = await web.fetch(new Request('http://test/api/theme-library'));
    const againBody = (await again.json()) as { data: { auto: { enabled: boolean } } };
    expect(againBody.data.auto.enabled).toBe(true);

    const disabled = await postJson(web, '/api/theme-library/auto/settings', { enabled: false });
    expect(disabled.status).toBe(200);
  });

  it('runs the maintenance on demand, is idempotent for the same trading day, and exposes pending items', async () => {
    const ctx = await autoContext({
      entries: [
        { stockId: '600519.SH', name: '贵州茅台', reason: '工业机器人+减速器' },
        { stockId: '000002.SZ', name: '万科A', reason: '量子织布机' },
      ],
    });
    await seedConcepts(ctx);
    const web = createWebApp(ctx, { exposeWrite: true, exposeExternal: true });
    await seedRuleTheme(ctx);

    const first = await postJson(web, '/api/theme-library/auto/run', {});
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as {
      ok: boolean;
      data?: { status: string; tradingDay: string; createdMembers: number; pendingCount: number };
    };
    expect(firstBody.ok).toBe(true);
    expect(firstBody.data).toMatchObject({
      status: 'succeeded',
      tradingDay: TRADING_DATE,
      createdMembers: 1,
      pendingCount: 1,
    });

    const second = await postJson(web, '/api/theme-library/auto/run', {});
    const secondBody = (await second.json()) as {
      data?: { createdMembers: number; attempt: number };
    };
    expect(secondBody.data).toMatchObject({ createdMembers: 1, attempt: 1 });
    const members = await ctx.repos.themeLibrary.listMembers();
    expect(members.filter((member) => member.origin === 'auto')).toHaveLength(1);

    const library = await web.fetch(new Request('http://test/api/theme-library'));
    const libraryBody = (await library.json()) as {
      data: {
        auto: {
          lastSucceededDay: string | null;
          lastRun: { status: string; createdMembers: number } | null;
          pending: { kind: string; reason: string | null; tradingDate: string }[];
          pendingFrom: string | null;
        };
      };
    };
    expect(libraryBody.data.auto.lastSucceededDay).toBe(TRADING_DATE);
    expect(libraryBody.data.auto.lastRun).toMatchObject({ status: 'succeeded', createdMembers: 1 });
    expect(libraryBody.data.auto.pending).toHaveLength(1);
    expect(libraryBody.data.auto.pending[0]).toMatchObject({
      kind: 'unmatched',
      reason: '量子织布机',
      tradingDate: TRADING_DATE,
    });
    expect(libraryBody.data.auto.pendingFrom).toBe(TRADING_DATE);
  });

  it('requires both write and external opt-in for the on-demand run', async () => {
    const ctx = await autoContext();
    await seedConcepts(ctx);
    const writeOnly = createWebApp(ctx, { exposeWrite: true, exposeExternal: false });
    const denied = await postJson(writeOnly, '/api/theme-library/auto/run', {});
    expect(denied.status).toBe(403);
    const deniedBody = (await denied.json()) as { error: { required: string } };
    expect(deniedBody.error.required).toContain('LUOOME_EXPOSE_EXTERNAL');

    const readOnly = createWebApp(ctx, { exposeWrite: false, exposeExternal: true });
    const settingsDenied = await postJson(readOnly, '/api/theme-library/auto/settings', {
      enabled: true,
    });
    expect(settingsDenied.status).toBe(403);

    const crossOrigin = await postJson(
      writeOnly,
      '/api/theme-library/auto/settings',
      { enabled: true },
      { origin: 'http://evil.test' },
    );
    expect(crossOrigin.status).toBe(403);
  });

  it('records upstream failures instead of marking them succeeded', async () => {
    const ctx = await autoContext({ failing: true });
    await seedConcepts(ctx);
    const web = createWebApp(ctx, { exposeWrite: true, exposeExternal: true });
    await seedRuleTheme(ctx);

    const run = await postJson(web, '/api/theme-library/auto/run', {});
    const runBody = (await run.json()) as { ok: boolean; error?: { kind: string } };
    expect(runBody.ok).toBe(false);
    expect(runBody.error?.kind).toBe('adapter_error');

    const library = await web.fetch(new Request('http://test/api/theme-library'));
    const libraryBody = (await library.json()) as {
      data: {
        auto: {
          lastRun: { status: string; errorMessage: string | null } | null;
          lastSucceededDay: string | null;
        };
      };
    };
    expect(libraryBody.data.auto.lastRun).toMatchObject({ status: 'failed' });
    expect(libraryBody.data.auto.lastRun?.errorMessage).toContain('上游超时');
    expect(libraryBody.data.auto.lastSucceededDay).toBeNull();
  });

  it('shows new auto members in the live rotation without backfilling intraday replay', async () => {
    const ctx = await autoContext({
      entries: [{ stockId: '600519.SH', name: '贵州茅台', reason: '工业机器人' }],
    });
    await seedConcepts(ctx);
    const web = createWebApp(ctx, { exposeWrite: true, exposeExternal: true });
    await seedRuleTheme(ctx);
    await ctx.repos.marketSnapshotBatch.publish(
      buildMarketSnapshotBatch({
        sampledAt: at('10:00'),
        snapshot: {
          coverage: 'CN_A_SHARES_SH_SZ',
          source: 'fixture',
          fetchedAt: at('10:00'),
          items: [
            {
              id: '600519.SH',
              code: '600519',
              exchange: 'SH',
              name: '贵州茅台',
              close: 10.5,
              changePct: 5,
              amount: 1_000_000,
            },
            {
              id: '000001.SZ',
              code: '000001',
              exchange: 'SZ',
              name: '平安银行',
              close: 10.2,
              changePct: 2,
              amount: 2_000_000,
            },
          ],
          completeness: {
            expectedCount: 2,
            receivedCount: 2,
            missingCount: 0,
            duplicateCount: 0,
            complete: true,
          },
        },
      }),
    );
    await postJson(web, '/api/theme-library/auto/run', {});

    const live = await web.fetch(new Request('http://test/api/market/room/themes?window=w15'));
    const liveBody = (await live.json()) as {
      data: { rotation: { themes: { themeId: string; memberCount: number }[] } };
    };
    expect(liveBody.data.rotation.themes[0]).toMatchObject({
      themeId: ROBOTICS,
      memberCount: 2,
    });

    const replay = await web.fetch(
      new Request(`http://test/api/market/room/themes?window=w15&at=${at('10:30').toISOString()}`),
    );
    const replayBody = (await replay.json()) as {
      data: { rotation: { themes: { themeId: string; memberCount: number }[] } };
    };
    expect(replayBody.data.rotation.themes[0]?.memberCount).toBe(1);
  });
});
