import { describe, expect, it } from 'bun:test';
import {
  buildThemeLibraryAutoPlan,
  THEME_LIBRARY_AUTO_SOURCE,
  type ThemeLibraryAutoPlan,
  themeLibraryRuleThemeId,
} from '@luoome/core';
import { createDrizzleRepos } from '../../client.js';

const at = (time: string): Date => new Date(`2026-11-26T${time}+08:00`);
const TRADING_DAY = '2026-11-26';
const ROBOTICS = themeLibraryRuleThemeId('机器人与具身智能');

const plan = (overrides: Partial<ThemeLibraryAutoPlan> = {}): ThemeLibraryAutoPlan => ({
  tradingDate: TRADING_DAY,
  source: THEME_LIBRARY_AUTO_SOURCE,
  ruleVersion: 'theme-library-auto@test',
  poolCount: 2,
  classifiedCount: 2,
  alreadyMemberCount: 0,
  suppressedCount: 0,
  additions: [
    {
      themeId: ROBOTICS,
      themeName: '机器人',
      stocks: [
        { stockId: '300001.SZ', name: '甲', reason: '机器人', token: '机器人' },
        { stockId: '300002.SZ', name: '乙', reason: '机器人+减速器', token: '机器人' },
      ],
    },
  ],
  newThemes: [],
  pending: [
    {
      kind: 'unmatched',
      tradingDate: TRADING_DAY,
      label: '量子织布机',
      stockId: '600001.SH',
      stockName: '丙',
      reason: '量子织布机',
      source: THEME_LIBRARY_AUTO_SOURCE,
      note: '本地精选概念里没有对应事实，只计入待核对',
    },
  ],
  warnings: [],
  ...overrides,
});

const withSeed = async () => {
  const handle = createDrizzleRepos(':memory:');
  await handle.repos.themeLibrary.importSeed({
    importId: 'seed-1',
    source: 'fuyao-concept',
    appliedAt: at('08:00'),
    seed: {
      themes: [
        {
          id: ROBOTICS,
          name: '机器人',
          sortOrder: 0,
          sources: [{ vendorCode: '885728.TI', sectorId: 'concept-1', name: '机器人概念' }],
          stockIds: ['600519.SH'],
        },
      ],
      skipped: [],
    },
  });
  return handle;
};

describe('题材库自动维护仓储', () => {
  it('自动维护开关默认关闭，写入后可读回', async () => {
    const { repos } = createDrizzleRepos(':memory:');
    expect(await repos.themeLibrary.getAutoSettings()).toEqual({ enabled: false, updatedAt: null });
    await repos.themeLibrary.saveAutoSettings({ enabled: true, at: at('15:30') });
    expect(await repos.themeLibrary.getAutoSettings()).toEqual({
      enabled: true,
      updatedAt: at('15:30'),
    });
    await repos.themeLibrary.saveAutoSettings({ enabled: false, at: at('16:00') });
    expect((await repos.themeLibrary.getAutoSettings()).enabled).toBe(false);
  });

  it('应用计划后成分生效时间与执行审计都落库，同日重复应用不重复写', async () => {
    const handle = await withSeed();
    const { repos } = handle;
    const claim = await repos.themeLibrary.claimAutoRun({
      tradingDay: TRADING_DAY,
      source: THEME_LIBRARY_AUTO_SOURCE,
      now: at('15:05'),
      staleBefore: at('14:35'),
    });
    expect(claim.claimed).toBe(true);
    expect(claim.run.status).toBe('running');
    expect(claim.run.attempt).toBe(1);

    const applied = await repos.themeLibrary.applyAutoPlan({
      tradingDay: TRADING_DAY,
      source: THEME_LIBRARY_AUTO_SOURCE,
      attempt: claim.run.attempt,
      plan: plan(),
      effectiveFrom: at('15:00'),
      appliedAt: at('15:05'),
    });
    expect(applied.status).toBe('succeeded');
    expect(applied.createdMembers).toBe(2);
    expect(applied.pendingCount).toBe(1);
    expect(applied.effectiveFrom).toEqual(at('15:00'));
    expect(applied.appliedAt).toEqual(at('15:05'));

    const members = await repos.themeLibrary.listMembers({ themeIds: [ROBOTICS] });
    const auto = members.filter((member) => member.origin === 'auto');
    expect(auto.map((member) => member.stockId).sort()).toEqual(['300001.SZ', '300002.SZ']);
    expect(auto.every((member) => member.effectiveFrom.getTime() === at('15:00').getTime())).toBe(
      true,
    );

    // 同日再次领取：已成功是终态，不重复写
    const again = await repos.themeLibrary.claimAutoRun({
      tradingDay: TRADING_DAY,
      source: THEME_LIBRARY_AUTO_SOURCE,
      now: at('15:10'),
      staleBefore: at('14:40'),
    });
    expect(again.claimed).toBe(false);
    expect(again.run.status).toBe('succeeded');
    const replay = await repos.themeLibrary.applyAutoPlan({
      tradingDay: TRADING_DAY,
      source: THEME_LIBRARY_AUTO_SOURCE,
      attempt: again.run.attempt,
      plan: plan(),
      effectiveFrom: at('15:00'),
      appliedAt: at('15:10'),
    });
    expect(replay.createdMembers).toBe(2);
    expect(await repos.themeLibrary.listMembers({ themeIds: [ROBOTICS] })).toHaveLength(3);
  });

  it('并发领取只有一个成功，另一半不写库', async () => {
    const handle = await withSeed();
    const { repos } = handle;
    const [first, second] = await Promise.all([
      repos.themeLibrary.claimAutoRun({
        tradingDay: TRADING_DAY,
        source: THEME_LIBRARY_AUTO_SOURCE,
        now: at('15:05'),
        staleBefore: at('14:35'),
      }),
      repos.themeLibrary.claimAutoRun({
        tradingDay: TRADING_DAY,
        source: THEME_LIBRARY_AUTO_SOURCE,
        now: at('15:05'),
        staleBefore: at('14:35'),
      }),
    ]);
    expect([first.claimed, second.claimed].filter(Boolean)).toHaveLength(1);
    const owner = first.claimed ? first : second;
    const loser = first.claimed ? second : first;
    expect(loser.run.status).toBe('running');
    expect(loser.run.attempt).toBe(owner.run.attempt);
  });

  it('失败与跳过后允许重试，重试会递增 attempt 并清空上一轮结果', async () => {
    const handle = await withSeed();
    const { repos } = handle;
    const first = await repos.themeLibrary.claimAutoRun({
      tradingDay: TRADING_DAY,
      source: THEME_LIBRARY_AUTO_SOURCE,
      now: at('15:05'),
      staleBefore: at('14:35'),
    });
    const failed = await repos.themeLibrary.finishAutoRun({
      tradingDay: TRADING_DAY,
      source: THEME_LIBRARY_AUTO_SOURCE,
      attempt: first.run.attempt,
      status: 'failed',
      finishedAt: at('15:06'),
      errorKind: 'adapter_error',
      errorMessage: '上游超时',
    });
    expect(failed.status).toBe('failed');
    expect(failed.errorMessage).toBe('上游超时');

    const retry = await repos.themeLibrary.claimAutoRun({
      tradingDay: TRADING_DAY,
      source: THEME_LIBRARY_AUTO_SOURCE,
      now: at('15:10'),
      staleBefore: at('14:40'),
    });
    expect(retry.claimed).toBe(true);
    expect(retry.run.attempt).toBe(2);
    expect(retry.run.errorMessage).toBeNull();
    expect(retry.run.status).toBe('running');

    const applied = await repos.themeLibrary.applyAutoPlan({
      tradingDay: TRADING_DAY,
      source: THEME_LIBRARY_AUTO_SOURCE,
      attempt: retry.run.attempt,
      plan: plan(),
      effectiveFrom: at('15:00'),
      appliedAt: at('15:10'),
    });
    expect(applied.status).toBe('succeeded');
    expect(applied.createdMembers).toBe(2);
  });

  it('超时未完成的 running 可被接管，未超时则不可', async () => {
    const handle = await withSeed();
    const { repos } = handle;
    await repos.themeLibrary.claimAutoRun({
      tradingDay: TRADING_DAY,
      source: THEME_LIBRARY_AUTO_SOURCE,
      now: at('15:05'),
      staleBefore: at('14:35'),
    });
    const fresh = await repos.themeLibrary.claimAutoRun({
      tradingDay: TRADING_DAY,
      source: THEME_LIBRARY_AUTO_SOURCE,
      now: at('15:10'),
      staleBefore: at('14:40'),
    });
    expect(fresh.claimed).toBe(false);
    const takeover = await repos.themeLibrary.claimAutoRun({
      tradingDay: TRADING_DAY,
      source: THEME_LIBRARY_AUTO_SOURCE,
      now: at('16:00'),
      staleBefore: at('15:05'),
    });
    expect(takeover.claimed).toBe(true);
    expect(takeover.run.attempt).toBe(2);
  });

  it('人工删除过的关系不再被自动任务加回', async () => {
    const handle = await withSeed();
    const { repos } = handle;
    const claim = await repos.themeLibrary.claimAutoRun({
      tradingDay: TRADING_DAY,
      source: THEME_LIBRARY_AUTO_SOURCE,
      now: at('15:05'),
      staleBefore: at('14:35'),
    });
    await repos.themeLibrary.applyAutoPlan({
      tradingDay: TRADING_DAY,
      source: THEME_LIBRARY_AUTO_SOURCE,
      attempt: claim.run.attempt,
      plan: plan(),
      effectiveFrom: at('15:00'),
      appliedAt: at('15:05'),
    });
    expect(
      await repos.themeLibrary.removeMember({
        themeId: ROBOTICS,
        stockId: '300001.SZ',
        at: at('16:00'),
      }),
    ).toBe(true);

    const nextDay = '2026-11-27';
    const nextClaim = await repos.themeLibrary.claimAutoRun({
      tradingDay: nextDay,
      source: THEME_LIBRARY_AUTO_SOURCE,
      now: at('15:05'),
      staleBefore: at('14:35'),
    });
    const nextPlan = plan({
      tradingDate: nextDay,
      poolCount: 1,
      classifiedCount: 1,
      suppressedCount: 1,
      additions: [
        {
          themeId: ROBOTICS,
          themeName: '机器人',
          stocks: [{ stockId: '300001.SZ', name: '甲', reason: '机器人', token: '机器人' }],
        },
      ],
      pending: [],
    });
    const applied = await repos.themeLibrary.applyAutoPlan({
      tradingDay: nextDay,
      source: THEME_LIBRARY_AUTO_SOURCE,
      attempt: nextClaim.run.attempt,
      plan: nextPlan,
      effectiveFrom: new Date('2026-11-27T15:00:00+08:00'),
      appliedAt: new Date('2026-11-27T15:05:00+08:00'),
    });
    // 计划里带着这条关系，但仓储按历史区间拒绝加回
    expect(applied.createdMembers).toBe(0);
    const members = await repos.themeLibrary.listMembers({ themeIds: [ROBOTICS] });
    const removed = members.find((member) => member.stockId === '300001.SZ');
    expect(removed?.effectiveTo).not.toBeNull();
  });

  it('新方向建库写题材与来源映射，并可按最近执行读取状态', async () => {
    const { repos } = createDrizzleRepos(':memory:');
    const claim = await repos.themeLibrary.claimAutoRun({
      tradingDay: TRADING_DAY,
      source: THEME_LIBRARY_AUTO_SOURCE,
      now: at('15:05'),
      staleBefore: at('14:35'),
    });
    const applied = await repos.themeLibrary.applyAutoPlan({
      tradingDay: TRADING_DAY,
      source: THEME_LIBRARY_AUTO_SOURCE,
      attempt: claim.run.attempt,
      plan: plan({
        additions: [],
        newThemes: [
          {
            themeId: 'auto-test-1',
            name: '钙钛矿',
            sourceConcept: { sectorId: 'concept-9', vendorCode: '886001.TI', name: '钙钛矿' },
            stocks: [
              { stockId: '300011.SZ', name: '甲', reason: '钙钛矿', token: '钙钛矿' },
              { stockId: '300012.SZ', name: '乙', reason: '钙钛矿', token: '钙钛矿' },
            ],
          },
        ],
      }),
      effectiveFrom: at('15:00'),
      appliedAt: at('15:05'),
    });
    expect(applied.createdThemes).toBe(1);
    expect(applied.createdMembers).toBe(2);
    const themes = await repos.themeLibrary.listThemes({ state: 'active' });
    expect(themes.map((theme) => theme.name)).toEqual(['钙钛矿']);
    const sources = await repos.themeLibrary.listSources(['auto-test-1']);
    expect(sources.map((source) => source.vendorCode)).toEqual(['886001.TI']);
    const runs = await repos.themeLibrary.listAutoRuns({ limit: 5 });
    expect(runs).toHaveLength(1);
    expect(runs[0]?.pending).toHaveLength(1);
    expect(runs[0]?.plan?.ruleVersion).toBe('theme-library-auto@test');
  });

  it('自动计划不覆盖人工改名与归档', async () => {
    const handle = await withSeed();
    const { repos } = handle;
    await repos.themeLibrary.renameTheme({
      themeId: ROBOTICS,
      name: '机器人方向',
      at: at('09:00'),
    });
    const claim = await repos.themeLibrary.claimAutoRun({
      tradingDay: TRADING_DAY,
      source: THEME_LIBRARY_AUTO_SOURCE,
      now: at('15:05'),
      staleBefore: at('14:35'),
    });
    await repos.themeLibrary.applyAutoPlan({
      tradingDay: TRADING_DAY,
      source: THEME_LIBRARY_AUTO_SOURCE,
      attempt: claim.run.attempt,
      plan: plan(),
      effectiveFrom: at('15:00'),
      appliedAt: at('15:05'),
    });
    const theme = await repos.themeLibrary.findTheme(ROBOTICS);
    expect(theme?.name).toBe('机器人方向');
  });
});

describe('题材库自动维护计划（仓储输入口径）', () => {
  it('空池不产生计划', async () => {
    const { repos } = createDrizzleRepos(':memory:');
    const built = buildThemeLibraryAutoPlan({
      tradingDate: TRADING_DAY,
      source: THEME_LIBRARY_AUTO_SOURCE,
      pool: [],
      themes: await repos.themeLibrary.listThemes({ state: 'all' }),
      members: await repos.themeLibrary.listMembers(),
      concepts: [],
    });
    expect(built.additions).toEqual([]);
    expect(built.newThemes).toEqual([]);
    expect(built.pending).toEqual([]);
  });
});
