// dsh-luoome 生产 composition root 的 Node/Vitest 测试（需求 §6.2，task-6 验收）。
//
// 使用临时 LUOOME_HOME + 临时 Node SQLite；不 mock 生产数据、不触碰真实个人库。
// 本文件由 Node/vitest 执行：node:sqlite 可用，bun:sqlite 不参与。
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import type { Context } from '@deepseek-ai/cordis';
import {
  type Account,
  type Advice,
  money,
  STANDARD_DISCLAIMERS,
  type Strategy,
} from '@luoome/core';
import { createNodeDrizzleRepos } from '@luoome/db/node';
import { privateResearchTools, toolRegistry } from '@luoome/tools';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_MARKET_TIMEOUT_MS } from './market-surface.js';
import {
  apply,
  createProductionHost,
  createProductionOperationPolicies,
  TRUSTED_ANALYSIS_PROVENANCE,
} from './production.js';
import {
  DEFAULT_MARKET_TOOL_ALLOWLIST,
  DEFAULT_READ_TOOL_ALLOWLIST,
  resolveProductionConfig,
  resolveProductionConfigFromEnv,
} from './production-config.js';

const T0 = new Date('2026-07-02T01:00:00.000Z');
const T1 = new Date('2026-07-02T01:05:00.000Z');
const FAR_FUTURE = new Date('2099-01-01T00:00:00.000Z');
const OWNER = Object.freeze({ userId: 'owner-1', accountId: 'owner-account' });

const roots: string[] = [];

const tempRoot = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'luoome-production-'));
  roots.push(dir);
  return dir;
};

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const signal = (): AbortSignal => new AbortController().signal;

const makeAccount = (id: string): Account => ({
  id,
  name: `账户-${id}`,
  kind: 'real',
  currency: 'CNY',
  initialCapital: money(1_000_000),
  cashBalance: money(1_000_000),
  createdAt: T0,
});

const makeAdvice = (id: string): Advice => ({
  id,
  subjectKind: 'stock',
  subjectId: '600519.SH',
  decision: 'hold',
  confidence: 65,
  horizon: 'short',
  reasoning: {
    premise: '短期处于箱体震荡，等待方向选择',
    evidence: ['日线 MA5/MA10/MA20 粘合'],
    counterEvidence: ['板块整体回暖'],
  },
  risks: ['大盘系统性下行风险'],
  disclaimers: [...STANDARD_DISCLAIMERS],
  sourceTool: 'production-fixture',
  basedOn: { dataAsOf: T1 },
  validFrom: T1,
  validUntil: FAR_FUTURE,
  createdAt: T1,
});

const makeStrategy = (id: string): Strategy => ({
  id,
  name: `策略-${id}`,
  description: 'production fixture strategy',
  owner: 'user',
  status: 'draft',
  createdAt: T0,
  updatedAt: T0,
});

const productionInput = (
  home: string,
  overrides: {
    readonly read?: unknown;
    readonly market?: unknown;
    readonly env?: Readonly<Record<string, string | undefined>>;
  } = {},
): unknown => ({
  home,
  owner: { ...OWNER },
  env: overrides.env ?? { LUOOME_MARKET_PROVIDER: 'real' },
  ...(overrides.read === undefined ? {} : { read: overrides.read }),
  ...(overrides.market === undefined ? {} : { market: overrides.market }),
});

/** 在事实库里预置 owner 账户；生产装配要求该账户已存在。 */
const seedOwnerAccount = async (home: string): Promise<void> => {
  const handle = createNodeDrizzleRepos(join(home, 'luoome.db'));
  try {
    await handle.repos.account.save(makeAccount(OWNER.accountId));
  } finally {
    handle.close();
  }
};

describe('dsh-luoome production composition root', () => {
  it('opens the real Node DB, binds the configured owner and executes real read tools as JSON', async () => {
    const home = tempRoot();
    await seedOwnerAccount(home);
    const host = await createProductionHost(productionInput(home));
    try {
      expect(host.config.home).toBe(home);
      expect(host.config.owner).toEqual(OWNER);
      expect(host.context.identity).toEqual({ mode: 'local', userId: OWNER.userId });
      expect(host.context.user).toEqual({
        id: OWNER.userId,
        defaultAccountId: OWNER.accountId,
      });
      expect(host.read.descriptors().map((tool) => tool.name)).toEqual(
        expect.arrayContaining(['list_accounts', 'get_advice', 'get_analysis_context']),
      );
      const readNames = host.read.descriptors().map((tool) => tool.name);
      const marketNames = host.market.descriptors().map((tool) => tool.name);
      expect([...marketNames].sort()).toEqual([...DEFAULT_MARKET_TOOL_ALLOWLIST].sort());
      expect(host.config.market).toEqual({
        allowlist: [...DEFAULT_MARKET_TOOL_ALLOWLIST],
        denylist: [],
        timeoutMs: DEFAULT_MARKET_TIMEOUT_MS,
        exposeResearch: false,
      });
      expect(Object.isFrozen(host.config.market)).toBe(true);
      expect(Object.isFrozen(host.config.market.allowlist)).toBe(true);
      for (const name of marketNames)
        expect(readNames, `${name} must not be a read-surface tool`).not.toContain(name);

      const advice = makeAdvice('fixture-advice');
      const strategy = makeStrategy('fixture-strategy');
      await host.context.repos.advice.save(advice);
      await host.context.repos.strategy.create(strategy);

      const accounts = await host.invoke('list_accounts', {}, signal());
      if (!accounts.ok) throw new Error(`list_accounts failed: ${JSON.stringify(accounts)}`);
      expect(accounts.data).toMatchObject({
        total: 1,
        accounts: [{ id: OWNER.accountId, currency: 'CNY' }],
      });

      const advices = await host.invoke('get_advice', {}, signal());
      if (!advices.ok) throw new Error(`get_advice failed: ${JSON.stringify(advices)}`);
      const advicePage = advices.data as {
        total: number;
        advices: { id: string; createdAt: unknown }[];
      };
      expect(advicePage.total).toBe(1);
      expect(advicePage.advices[0]?.id).toBe(advice.id);
      // DSH canonical value 是 JSON：Date 必须已经序列化成 ISO 字符串。
      expect(advicePage.advices[0]?.createdAt).toBe(T1.toISOString());

      const strategies = await host.invoke('list_strategies', {}, signal());
      if (!strategies.ok) throw new Error(`list_strategies failed: ${JSON.stringify(strategies)}`);
      expect(strategies.data).toMatchObject({ total: 1, strategies: [{ id: strategy.id }] });

      // 调度与订阅契约读面在默认 read allowlist 内，可作为真实只读工具调用。
      const schedule = await host.invoke(
        'get_strategy_schedule',
        { strategyId: strategy.id },
        signal(),
      );
      if (!schedule.ok) throw new Error(`get_strategy_schedule failed`);
      expect(schedule.data).toEqual({ schedule: null });
      const subscriptions = await host.invoke(
        'list_strategy_watchlist_subscriptions',
        { strategyId: strategy.id },
        signal(),
      );
      if (!subscriptions.ok) throw new Error(`list_strategy_watchlist_subscriptions failed`);
      expect(subscriptions.data).toMatchObject({ total: 0, subscriptions: [] });
    } finally {
      host.dispose();
    }
  });

  it('persists facts across close/reopen and denies old closures after dispose', async () => {
    const home = tempRoot();
    await seedOwnerAccount(home);

    const first = await createProductionHost(productionInput(home));
    const advice = makeAdvice('persisted-advice');
    await first.context.repos.advice.save(advice);
    expect((await first.invoke('get_advice', {}, signal())).ok).toBe(true);
    first.dispose();
    first.dispose();
    expect(await first.invoke('get_advice', {}, signal())).toMatchObject({
      ok: false,
      error: { kind: 'permission_denied' },
    });

    const second = await createProductionHost(productionInput(home));
    try {
      const reopened = await second.invoke('get_advice', {}, signal());
      if (!reopened.ok) throw new Error(`reopened get_advice failed`);
      expect((reopened.data as { advices: { id: string }[] }).advices[0]?.id).toBe(advice.id);
      expect(existsSync(join(home, 'luoome.db'))).toBe(true);
    } finally {
      second.dispose();
    }
  });

  it('applies FUYAO settings to live tools immediately and restores them after restart', async () => {
    const home = tempRoot();
    await seedOwnerAccount(home);
    let host = await createProductionHost(productionInput(home));
    const fetchMock = vi.fn(async (_url: unknown, _init?: RequestInit) =>
      Response.json({
        code: 0,
        data: {
          timestamp: Date.now(),
          item: [
            {
              thscode: '600519.SH',
              last_price: 1277.8,
              open_price: 1252.08,
              high_price: 1282,
              low_price: 1250.21,
              prev_price: 1256,
              volume: 3098875,
            },
          ],
        },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    try {
      const previous = host.context;
      host.marketSettings.save({
        sources: ['fuyao'],
        fuyao: { baseUrl: 'https://fuyao.example.test', apiKey: 'synthetic-live-key' },
      });
      expect(host.context.adapters.market).not.toBe(previous.adapters.market);
      expect(host.context.ashareSentiment).not.toBe(previous.ashareSentiment);
      expect(host.context.news).toBe(previous.news);
      const quote = await host.invokeMarket('fetch_quote', { stockId: '600519.SH' }, signal());
      expect(quote).toMatchObject({
        ok: true,
        data: { quote: { source: 'fuyao', close: 1277.8 } },
      });
      expect(fetchMock).toHaveBeenLastCalledWith(
        'https://fuyao.example.test/api/a-share/prices/snapshot?thscodes=600519.SH',
        expect.objectContaining({ headers: { 'X-api-key': 'synthetic-live-key' } }),
      );
      host.dispose();
      host = await createProductionHost(productionInput(home));
      expect(host.marketSettings.read().activeOrder).toEqual(['fuyao']);
      expect(
        await host.invokeMarket('fetch_quote', { stockId: '600519.SH' }, signal()),
      ).toMatchObject({
        ok: true,
        data: { quote: { source: 'fuyao', close: 1277.8 } },
      });
    } finally {
      host.dispose();
      vi.unstubAllGlobals();
    }
  });

  it('fails on LUOOME_EXPOSE_TRADE=true before creating any file or directory', async () => {
    const parent = tempRoot();
    const home = join(parent, 'trade-home');
    vi.stubEnv('LUOOME_EXPOSE_TRADE', 'true');
    await expect(createProductionHost(productionInput(home))).rejects.toThrow(
      'LUOOME_EXPOSE_TRADE=true',
    );
    expect(existsSync(home)).toBe(false);
    expect(existsSync(join(home, 'luoome.db'))).toBe(false);
    vi.unstubAllEnvs();

    const configHome = join(parent, 'trade-env-home');
    await expect(
      createProductionHost(productionInput(configHome, { env: { LUOOME_EXPOSE_TRADE: 'true' } })),
    ).rejects.toThrow('LUOOME_EXPOSE_TRADE=true');
    expect(existsSync(join(configHome, 'luoome.db'))).toBe(false);
  });

  it('requires an explicit owner and an existing owner account instead of falling back', async () => {
    expect(() => resolveProductionConfigFromEnv({})).toThrow(/LUOOME_OWNER_USER_ID/);
    expect(() =>
      resolveProductionConfigFromEnv({
        LUOOME_OWNER_USER_ID: 'owner-1',
        LUOOME_OWNER_ACCOUNT_ID: 'owner-account',
      }),
    ).not.toThrow();
    expect(() => resolveProductionConfig({ env: {} })).toThrow();

    const home = tempRoot();
    await expect(createProductionHost(productionInput(home))).rejects.toThrow(
      /owner account does not exist/,
    );
    // 装配失败后连接必须关闭，重开同一文件仍可用。
    const reopened = createNodeDrizzleRepos(join(home, 'luoome.db'));
    reopened.close();
  });

  it('freezes parsed config and rejects privilege-expanding options', async () => {
    const home = tempRoot();
    const config = resolveProductionConfig({
      ...(productionInput(home) as Record<string, unknown>),
      read: { allowlist: ['list_accounts'] },
    });
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.owner)).toBe(true);
    expect(Object.isFrozen(config.read)).toBe(true);
    expect(Object.isFrozen(config.read.allowlist)).toBe(true);
    expect(Object.isFrozen(config.read.denylist)).toBe(true);
    expect(Object.isFrozen(config.env)).toBe(true);
    expect(Object.isFrozen(config.market)).toBe(true);
    expect(Object.isFrozen(config.market.allowlist)).toBe(true);
    expect(Object.isFrozen(config.market.denylist)).toBe(true);
    expect(config.automationsEnabled).toBe(false);
    expect(config.read.exposeResearch).toBe(false);
    expect(config.market.exposeResearch).toBe(false);
    expect([...config.market.allowlist]).toEqual([...DEFAULT_MARKET_TOOL_ALLOWLIST]);
    expect(config.market.timeoutMs).toBe(DEFAULT_MARKET_TIMEOUT_MS);
    expect(() => (config.market.allowlist as string[]).push('send_notification')).toThrow();
    expect(() => (config.read.allowlist as string[]).push('create_account')).toThrow();

    expect(() =>
      resolveProductionConfig({ ...(config as unknown as object), extra: true }),
    ).toThrow();
    expect(() =>
      resolveProductionConfig({ owner: { ...OWNER }, automationsEnabled: true, env: {} }),
    ).toThrow();
    expect(() =>
      resolveProductionConfig({
        owner: { ...OWNER },
        read: { exposeResearch: true },
        env: {},
      }),
    ).toThrow();
    // Node 的 process.env 不是普通对象；配置解析必须先快照再校验，部署环境才能直接透传。
    const liveEnv = resolveProductionConfig({ owner: { ...OWNER }, env: process.env });
    expect(liveEnv.env).toEqual({ ...process.env });
    expect(Object.isFrozen(liveEnv.env)).toBe(true);

    expect(() =>
      resolveProductionConfig({
        owner: { ...OWNER },
        market: { timeoutMs: 0 },
        env: {},
      }),
    ).toThrow();
    expect(() =>
      resolveProductionConfig({
        owner: { ...OWNER },
        market: { exposeResearch: true },
        env: {},
      }),
    ).toThrow();

    const emptyHome = tempRoot();
    await seedOwnerAccount(emptyHome);
    const empty = await createProductionHost(
      productionInput(emptyHome, { read: { allowlist: [], exposeResearch: false } }),
    );
    try {
      expect(empty.read.descriptors()).toEqual([]);
    } finally {
      empty.dispose();
    }
  });

  it('refuses misconfigured allowlists before any IO', async () => {
    const parent = tempRoot();
    const home = join(parent, 'bad-allowlist');
    await expect(
      createProductionHost(productionInput(home, { read: { allowlist: ['create_account'] } })),
    ).rejects.toThrow('not read-only');
    expect(existsSync(home)).toBe(false);
    const unknownHome = join(parent, 'unknown-tool');
    await expect(
      createProductionHost(productionInput(unknownHome, { read: { allowlist: ['missing_tool'] } })),
    ).rejects.toThrow('Unknown configured dsh-luoome read tool');
    expect(existsSync(unknownHome)).toBe(false);
  });

  it('keeps read and market configuration independent and frozen', async () => {
    const home = tempRoot();
    await seedOwnerAccount(home);
    const host = await createProductionHost(
      productionInput(home, {
        read: { allowlist: ['list_accounts'] },
        market: { allowlist: ['fetch_quote'], timeoutMs: 1234 },
      }),
    );
    try {
      expect(host.read.descriptors().map((tool) => tool.name)).toEqual(['list_accounts']);
      expect(host.market.descriptors().map((tool) => tool.name)).toEqual(['fetch_quote']);
      expect(host.config.read.allowlist).toEqual(['list_accounts']);
      expect(host.config.market.allowlist).toEqual(['fetch_quote']);
      expect(host.config.market.timeoutMs).toBe(1234);
      expect(host.config.read.allowlist).not.toBe(host.config.market.allowlist);
    } finally {
      host.dispose();
    }
  });

  it('rejects a non-external market allowlist before any IO', async () => {
    const parent = tempRoot();
    const home = join(parent, 'bad-market');
    await expect(
      createProductionHost(productionInput(home, { market: { allowlist: ['list_accounts'] } })),
    ).rejects.toThrow('not external');
    expect(existsSync(home)).toBe(false);
    const mixedHome = join(parent, 'mixed-capability');
    await expect(
      createProductionHost(
        productionInput(mixedHome, { market: { allowlist: ['get_stock_minute_bars'] } }),
      ),
    ).rejects.toThrow('unsupported capabilities');
    expect(existsSync(mixedHome)).toBe(false);
  });

  it('keeps an explicit empty market allowlist as zero external tools', async () => {
    const home = tempRoot();
    await seedOwnerAccount(home);
    const host = await createProductionHost(productionInput(home, { market: { allowlist: [] } }));
    try {
      expect(host.market.descriptors()).toEqual([]);
      expect(host.read.descriptors().length).toBe(DEFAULT_READ_TOOL_ALLOWLIST.length);
      expect(await host.invokeMarket('fetch_quote', {}, signal())).toMatchObject({
        ok: false,
        error: { kind: 'permission_denied' },
      });
      expect((await host.invoke('list_accounts', {}, signal())).ok).toBe(true);
    } finally {
      host.dispose();
    }
  });

  it('registers and revokes real read tools through the composition handle', async () => {
    const home = tempRoot();
    await seedOwnerAccount(home);
    const host = await createProductionHost(productionInput(home));
    const registered: string[] = [];
    const removed: string[] = [];
    const runtimes = {
      register(definition: { name: string }) {
        registered.push(definition.name);
        return () => removed.push(definition.name);
      },
    } as unknown as Parameters<typeof host.register>[0];
    host.register(runtimes);
    expect(registered).toHaveLength(host.read.descriptors().length);
    host.dispose();
    expect(removed).toEqual(expect.arrayContaining(registered));
    expect(() => host.register(runtimes)).toThrow(/disposed/);
    expect(() => host.registerMarket(runtimes)).toThrow(/disposed/);
    expect(await host.invoke('list_accounts', {}, signal())).toMatchObject({
      ok: false,
      error: { kind: 'permission_denied' },
    });
    expect(await host.invokeMarket('fetch_quote', {}, signal())).toMatchObject({
      ok: false,
      error: { kind: 'permission_denied' },
    });
    // 写工具只经原生确认操作执行；read surface 的 invoke 不能成为通用写入口。
    for (const writeTool of [
      'record_advice',
      'record_analysis_result',
      'save_decision_review',
      'create_strategy',
      'create_strategy_version',
      'validate_strategy_version',
      'publish_strategy_version',
      'set_strategy_schedule',
      'pause_strategy',
      'resume_strategy',
      'subscribe_strategy_to_watchlist',
      'unsubscribe_strategy_from_watchlist',
      'record_advice_outcome',
    ])
      expect(await host.invoke(writeTool, {}, signal())).toMatchObject({
        ok: false,
        error: { kind: 'permission_denied' },
      });
  });

  it('derives the default allowlist from the real registry and keeps it read-only', () => {
    const privateResearch = new Set<string>(privateResearchTools);
    for (const name of DEFAULT_READ_TOOL_ALLOWLIST) {
      const tool = toolRegistry.get(name);
      expect(tool, `default read tool ${name} must exist in the registry`).toBeDefined();
      expect(tool?.sideEffect, `${name} must be read`).toBe('read');
      expect(tool?.requiredCapabilities, `${name} must require only read`).toEqual(['read']);
      expect(privateResearch.has(name), `${name} must not be private research`).toBe(false);
    }
    const names = new Set(DEFAULT_READ_TOOL_ALLOWLIST);
    for (const required of [
      // 四场景
      'list_strategies',
      'get_strategy_dsl_catalog',
      'get_strategy_insight_facts',
      'get_advice',
      'get_advice_stats',
      'get_confidence_calibration',
      'get_decision_review_context',
      'limit_up_ladder',
      'dragon_tiger_list',
      'northbound_flow',
      'get_market_data_status',
      // 策略调度与订阅契约读面
      'get_strategy_schedule',
      'list_strategy_watchlist_subscriptions',
      // 三面板
      'list_holdings',
      'list_watch_triggers',
      'get_strategy_run',
      'list_decision_reviews',
    ])
      expect(names.has(required), `default allowlist must cover ${required}`).toBe(true);
    expect(names.has('record_decision_trade')).toBe(false);
    expect(names.has('list_analysis_jobs')).toBe(false);
  });
});

describe('dsh-luoome production write policies', () => {
  it('wires only the exact native-confirmation policies with trusted provenance', () => {
    const policies = createProductionOperationPolicies();
    expect(policies.map((policy) => policy.tool.name)).toEqual([
      'save_decision_review',
      'record_advice',
      'record_analysis_result',
      'create_strategy',
      'create_strategy_version',
      'validate_strategy_version',
      'publish_strategy_version',
      'set_strategy_schedule',
      'pause_strategy',
      'resume_strategy',
      'subscribe_strategy_to_watchlist',
      'unsubscribe_strategy_from_watchlist',
      'record_advice_outcome',
      'start_strategy_evaluation_session',
      'resume_strategy_evaluation_session',
      'cancel_strategy_evaluation_session',
      'trial_strategy_version',
      'run_strategy_research_comparison',
      'save_strategy_research_state',
      'create_strict_strategy_backtest',
      'execute_strict_strategy_backtest',
      'update_account',
      'create_watchlist',
      'update_watchlist',
      'archive_watchlist',
      'add_watchlist_member',
      'add_watchlist_members',
      'update_watchlist_member',
      'archive_watchlist_member',
    ]);
    for (const policy of policies) expect(policy.scheduled).toBe(false);
    const byName = new Map(policies.map((policy) => [policy.tool.name, policy]));
    expect(byName.get('record_advice')?.tool.sideEffect).toBe('queue');
    expect(byName.get('record_advice')?.tool.requiredCapabilities).toEqual(['queue']);
    expect(byName.get('record_analysis_result')?.tool.sideEffect).toBe('queue');
    expect(byName.get('record_analysis_result')?.tool.requiredCapabilities).toEqual(['queue']);
    for (const strategyTool of [
      'create_strategy',
      'create_strategy_version',
      'validate_strategy_version',
      'publish_strategy_version',
      'set_strategy_schedule',
      'pause_strategy',
      'resume_strategy',
      'subscribe_strategy_to_watchlist',
      'unsubscribe_strategy_from_watchlist',
      'record_advice_outcome',
    ]) {
      expect(byName.get(strategyTool)?.tool.sideEffect, strategyTool).toBe('write');
      expect(byName.get(strategyTool)?.tool.requiredCapabilities, strategyTool).toEqual(['write']);
    }
    expect(TRUSTED_ANALYSIS_PROVENANCE).toEqual({ generatorKind: 'dsh-chat' });
    for (const forbidden of [
      'claim_analysis_jobs',
      'complete_analysis_job',
      'fail_analysis_job',
      'requeue_analysis_job',
      'cancel_analysis_job',
      'get_analysis_metrics',
      'list_analysis_jobs',
      'get_analysis_job',
      'record_decision_trade',
      'add_trade',
      'send_notification',
      // 策略生命周期里的删除/归档与调度 lease 内部桥不是确认操作
      'delete_strategy',
      'archive_strategy',
      'claim_due_strategy_schedules',
      'finish_strategy_schedule_claim',
      'renew_strategy_schedule_claim',
      'sync_strategy_watchlist_subscriptions',
      'create_strategy_observation_candidates',
    ])
      expect(byName.has(forbidden), `${forbidden} must not be a policy`).toBe(false);
  });
});

describe('dsh-luoome production apply entry', () => {
  it('declares the schedule dependency required by batch assembly', async () => {
    const { inject } = await import('./plugin.js');
    expect(inject).toContain('schedule');
  });
  it('requires the schedule service for automation opt-in before opening a database', async () => {
    const parent = tempRoot();
    const home = join(parent, 'no-schedule');
    const fake = createFakeHostContext({ omit: ['schedule'] });
    await expect(
      apply(fake.ctx, {
        ...(productionInput(home) as object),
        batchEnabled: true,
        automationsEnabled: true,
      }),
    ).rejects.toThrow('require the host schedule service');
    expect(existsSync(home)).toBe(false);
  });
  it.each(['approval', 'agents'])(
    'refuses to assemble when %s is missing, before any IO',
    async (service) => {
      const home = join(tempRoot(), 'apply-missing');
      const fake = createFakeHostContext({ omit: [service] });
      await expect(apply(fake.ctx, productionInput(home))).rejects.toThrow(service);
      expect(existsSync(home)).toBe(false);
    },
  );

  it('registers read tools, market external tools and the read-only call route', async () => {
    const home = tempRoot();
    await seedOwnerAccount(home);
    const fake = createFakeHostContext();
    const host = await apply(fake.ctx, productionInput(home));
    try {
      const readNames = new Set(host.read.descriptors().map((tool) => tool.name));
      const marketNames = new Set(host.market.descriptors().map((tool) => tool.name));
      expect(marketNames.size).toBeGreaterThan(0);
      expect(fake.registered).toEqual(expect.arrayContaining([...readNames, ...marketNames]));
      expect(fake.routes).toEqual(['/api/luoome']);
      for (const name of fake.registered) {
        if (
          [
            'luoome_confirmed_operation',
            'luoome_scheduled_operation',
            'luoome_operation_status',
            'luoome_research_status',
          ].includes(name)
        )
          continue;
        const tool = toolRegistry.get(name);
        if (marketNames.has(name)) {
          expect(tool?.sideEffect, `${name} must be external`).toBe('external');
          expect(tool?.requiredCapabilities).toEqual(['external']);
        } else {
          expect(readNames.has(name), `${name} must be a configured surface tool`).toBe(true);
          expect(tool?.sideEffect, `${name} must be read-only`).toBe('read');
        }
      }
      expect(fake.registered).toContain('luoome_confirmed_operation');
      expect(fake.registered).toContain('luoome_scheduled_operation');
      expect(fake.registered).toContain('luoome_operation_status');
      expect(fake.registered).toContain('luoome_research_status');
      for (const writeTool of [
        'record_advice',
        'record_analysis_result',
        'save_decision_review',
        'create_strategy',
        'create_strategy_version',
        'validate_strategy_version',
        'publish_strategy_version',
        'set_strategy_schedule',
        'pause_strategy',
        'resume_strategy',
        'subscribe_strategy_to_watchlist',
        'unsubscribe_strategy_from_watchlist',
        'record_advice_outcome',
        'claim_analysis_jobs',
        'complete_analysis_job',
        'fail_analysis_job',
      ])
        expect(fake.registered, `${writeTool} must not be registered directly`).not.toContain(
          writeTool,
        );
      expect(fake.active.size).toBe(fake.registered.length);
    } finally {
      for (const cleanup of fake.cleanups.splice(0).reverse()) cleanup();
    }
    expect(fake.active.size).toBe(0);
    expect(await host.invoke('list_accounts', {}, signal())).toMatchObject({
      ok: false,
      error: { kind: 'permission_denied' },
    });
    expect(await host.invokeMarket('fetch_quote', {}, signal())).toMatchObject({
      ok: false,
      error: { kind: 'permission_denied' },
    });
    // 写工具只经原生确认操作执行；read surface 的 invoke 不能成为通用写入口。
    for (const writeTool of [
      'record_advice',
      'record_analysis_result',
      'save_decision_review',
      'create_strategy',
      'create_strategy_version',
      'validate_strategy_version',
      'publish_strategy_version',
      'set_strategy_schedule',
      'pause_strategy',
      'resume_strategy',
      'subscribe_strategy_to_watchlist',
      'unsubscribe_strategy_from_watchlist',
      'record_advice_outcome',
    ])
      expect(await host.invoke(writeTool, {}, signal())).toMatchObject({
        ok: false,
        error: { kind: 'permission_denied' },
      });
  });

  it('rolls back read/market registrations and closes the DB when market registration fails', async () => {
    const home = tempRoot();
    await seedOwnerAccount(home);
    const fake = createFakeHostContext({ failNames: new Set(DEFAULT_MARKET_TOOL_ALLOWLIST) });
    await expect(apply(fake.ctx, productionInput(home))).rejects.toThrow('runtime refused');
    expect(fake.active.size).toBe(0);
    expect(fake.activeRoutes).toEqual([]);
    // 装配失败后 DB 连接必须已关闭，重开同一文件仍可用。
    const reopened = createNodeDrizzleRepos(join(home, 'luoome.db'));
    reopened.close();
  });
});

describe('dsh-luoome production dependency graph', () => {
  it('never reaches bun:sqlite, MCP, CLI or Web modules from the production root', () => {
    const entry = fileURLToPath(new URL('./production.ts', import.meta.url));
    const specifiers = collectModuleGraph(entry);
    const forbidden = [
      'bun:sqlite',
      '@luoome/mcp',
      '@luoome/cli',
      '@luoome/web',
      '@luoome/dsh-bridge',
    ];
    for (const packageName of forbidden)
      expect(specifiers.has(packageName), `production graph must not import ${packageName}`).toBe(
        false,
      );
    expect(specifiers.has('@luoome/db/node')).toBe(true);
    expect(specifiers.has('@luoome/db')).toBe(false);
    expect(specifiers.has('./market-surface.js')).toBe(true);
    expect(specifiers.has('./analysis-operations.js')).toBe(true);
    expect(specifiers.has('./strategy-operations.js')).toBe(true);
    expect([...specifiers].some((specifier) => specifier.includes('/apps/web/'))).toBe(false);
  });
});

// ---------- helpers ----------

interface FakeHostContext {
  readonly ctx: Context;
  readonly registered: string[];
  readonly routes: string[];
  readonly cleanups: (() => void)[];
  readonly active: Set<string>;
  readonly activeRoutes: string[];
}

const createFakeHostContext = (
  options: { readonly omit?: readonly string[]; readonly failNames?: ReadonlySet<string> } = {},
): FakeHostContext => {
  const omit = options.omit ?? [];
  const registered: string[] = [];
  const routes: string[] = [];
  const cleanups: (() => void)[] = [];
  const active = new Set<string>();
  const activeRoutes: string[] = [];
  const tools = {
    register(definition: { name: string }) {
      if (options.failNames?.has(definition.name)) throw new Error('runtime refused');
      registered.push(definition.name);
      active.add(definition.name);
      return () => active.delete(definition.name);
    },
    guard() {
      return () => {};
    },
  };
  const services: Record<string, unknown> = {};
  if (!omit.includes('connection')) services.connection = {};
  if (!omit.includes('webServer'))
    services.webServer = {
      protocol: 'http:',
      register(route: { path: string }) {
        routes.push(route.path);
        activeRoutes.push(route.path);
        return () => {
          const index = activeRoutes.indexOf(route.path);
          if (index >= 0) activeRoutes.splice(index, 1);
        };
      },
    };
  if (!omit.includes('sessionController')) services.sessionController = {};
  if (!omit.includes('approval')) services.approval = {};
  if (!omit.includes('agents')) services.agents = { get: () => undefined };
  services.tools = tools;
  const ctx = {
    get: (name: string) => services[name],
    on: () => () => {},
    effect: (factory: () => unknown) => {
      const cleanup = factory();
      if (typeof cleanup === 'function') cleanups.push(cleanup as () => void);
      return () => {};
    },
    tools,
    agents: services.agents,
    schedule: { catalog: async () => [] },
    webServer: services.webServer,
    connection: services.connection,
  } as unknown as Context;
  return { ctx, registered, routes, cleanups, active, activeRoutes };
};

/** 从入口文件递归收集相对导入闭包里的全部 import specifier。 */
const collectModuleGraph = (entry: string): Set<string> => {
  const specifiers = new Set<string>();
  const visited = new Set<string>();
  const visit = (file: string): void => {
    if (visited.has(file)) return;
    visited.add(file);
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)) {
      const specifier = match[1];
      if (specifier === undefined) continue;
      specifiers.add(specifier);
      if (!specifier.startsWith('.')) continue;
      const resolved = fileURLToPath(
        new URL(`${specifier.slice(0, -'.js'.length)}.ts`, pathToFileURL(file)),
      );
      visit(resolved);
    }
  };
  visit(entry);
  return specifiers;
};
