import { type ScheduleCatalogEntry, ScheduleId } from '@deepseek-ai/dsh-schedule';
import { SessionId } from '@deepseek-ai/dsh-session';
import {
  buildStrategySchedule,
  type PluginAutomationGrant,
  type PluginOperation,
  type StrategyDslV1,
  type StrategyRun,
  strategyDefinitionHash,
  type ToolContext,
} from '@luoome/core';
import { pluginInputHash, pluginInputJson, toolRegistry } from '@luoome/tools';
import { buildTestContext } from '@luoome/tools/testing';
import { describe, expect, it, vi } from 'vitest';
import { dshScheduleHash } from './dsh-identity.js';
import { createMarketSurface } from './market-surface.js';
import { createReadSurface } from './read-surface.js';
import { createResearchReadHandler } from './research.js';
import { createResearchContinuityReader, scheduledResearchOperationId } from './research-status.js';

const now = new Date('2026-10-27T09:00:00Z');
type ResearchBody = {
  data: {
    accountId: string;
    context: { ok: boolean; data: { realObservations: { horizons: { horizon: string }[] } } };
    manifest: {
      ok: boolean;
      data: { manifestHash: string; canonicalJson: string; manifest: unknown };
    };
    comparison: unknown;
    continuity: { status: string; factCutoff: string | null };
    account: { ok: boolean };
    steps: unknown[];
  };
};
const definition: StrategyDslV1 = {
  schemaVersion: 1,
  metadata: { horizon: 'short' },
  universe: { coverage: 'CN_A_SHARES_SH_SZ', excludeStockIds: [] },
  selection: {
    logic: 'all',
    rules: [{ id: 'positive', name: '正价格', when: 'quote.close > 0', evidence: ['收盘价'] }],
  },
  signals: { entry: [], exit: [], risk: [] },
};

export const seedResearchReadStrategy = async (ctx: ToolContext, strategyId = 'research-a') => {
  await ctx.repos.strategy.create({
    id: strategyId,
    name: '合成研究策略',
    description: '研究读取边界测试',
    owner: 'user',
    status: 'active',
    currentVersionId: `${strategyId}-v1`,
    createdAt: now,
    updatedAt: now,
  });
  for (const version of [1, 2])
    await ctx.repos.strategy.createVersion({
      id: `${strategyId}-v${version}`,
      strategyId,
      version,
      definition,
      definitionHash: strategyDefinitionHash(definition),
      validationStatus: 'valid',
      validationErrors: [],
      createdAt: now,
      ...(version === 1 ? { publishedAt: now } : { parentVersionId: `${strategyId}-v1` }),
    });
};

const setup = async (admit: () => Response | null = () => null) => {
  const ctx = await buildTestContext({ clock: () => now });
  await seedResearchReadStrategy(ctx);
  const principal = { userId: ctx.user.id, accountId: ctx.user.defaultAccountId };
  const read = createReadSurface({
    config: {
      allowlist: toolRegistry
        .all()
        .filter((tool) => tool.sideEffect === 'read')
        .map((tool) => tool.name),
    },
    tools: toolRegistry.all(),
    context: () => ctx,
  });
  const market = createMarketSurface({
    config: { allowlist: ['list_strategy_result_views'] },
    tools: toolRegistry.all(),
    context: () => ctx,
  });
  const continuity = createResearchContinuityReader({
    read,
    repository: ctx.repos.pluginAuthority,
    profile: 'research-test',
    policyVersion: 1,
    automationsEnabled: false,
    dailyCycleEnabled: false,
    principalForSession: () => principal,
    now: () => now.getTime(),
  });
  const handle = createResearchReadHandler({
    read,
    principal: () => principal,
    admit,
    continuity,
    now: () => now.getTime(),
  });
  return { ctx, principal, read, market, handle };
};

const request = (query: string) => new Request(`https://dsh.example/api/luoome/research?${query}`);

describe('fixed research read routes', () => {
  it('binds immutable versions and returns the real experiment context and active horizons', async () => {
    const { handle, principal } = await setup();
    const response = await handle(
      request(
        'view=context&strategyId=research-a&baseVersionId=research-a-v1&candidateVersionId=research-a-v2',
      ),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = (await response.json()) as ResearchBody;
    expect(body).toMatchObject({
      ok: true,
      data: {
        accountId: principal.accountId,
        context: {
          ok: true,
          data: { baseVersion: { id: 'research-a-v1' }, candidateVersion: { id: 'research-a-v2' } },
        },
      },
    });
    expect(
      body.data.context.data.realObservations.horizons.map(
        (item: { horizon: string }) => item.horizon,
      ),
    ).toEqual(['t1', 't3', 't5']);
  });

  it('rejects duplicate, arbitrary, oversized or cross-account scope before tool calls', async () => {
    const { handle, read, market } = await setup();
    const invoke = vi.spyOn(read, 'invoke');
    const external = vi.spyOn(market, 'invoke');
    for (const query of [
      'view=context&strategyId=research-a&tool=delete_strategy',
      'view=context&strategyId=research-a&strategyId=research-b',
      'view=diagnostics&strategyId=research-a&versionId=research-a-v1&runId=run&kind=selected&limit=201',
      'view=preflight&strategyId=research-a&versionId=research-a-v1&from=bad&to=2026-10-27',
      'view=context&strategyId=research-a&accountId=another-account',
    ]) {
      const response = await handle(request(query));
      expect([400, 403]).toContain(response.status);
    }
    expect(invoke).not.toHaveBeenCalled();
    expect(external).not.toHaveBeenCalled();
  });

  it('rejects a foreign version and foreign evaluation session without reading its days', async () => {
    const { ctx, handle, read } = await setup();
    await seedResearchReadStrategy(ctx, 'research-b');
    await ctx.repos.strategyEvaluation.saveSession({
      id: 'foreign-session',
      strategyId: 'research-b',
      strategyVersionId: 'research-b-v1',
      definitionHash: strategyDefinitionHash(definition),
      from: now,
      to: now,
      status: 'running',
      createdAt: now,
    });
    const invoke = vi.spyOn(read, 'invoke');
    const version = await handle(
      request('view=manifest&strategyId=research-a&versionId=research-b-v1'),
    );
    expect(version.status).toBe(400);
    const session = await handle(
      request('view=validation&strategyId=research-a&sessionId=foreign-session'),
    );
    expect(session.status).toBe(404);
    expect(invoke.mock.calls.map(([name]) => name)).not.toContain('list_strategy_evaluation_days');
    expect(invoke.mock.calls.map(([name]) => name)).not.toContain('export_strategy_manifest');
  });

  it('exports a real canonical manifest without modifying the strategy', async () => {
    const { handle, ctx } = await setup();
    const before = await ctx.repos.strategy.findById('research-a');
    const response = await handle(
      request('view=manifest&strategyId=research-a&versionId=research-a-v2'),
    );
    const body = (await response.json()) as ResearchBody;
    expect(body.data.manifest.ok).toBe(true);
    expect(body.data.manifest.data.manifestHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.parse(body.data.manifest.data.canonicalJson)).toEqual(
      body.data.manifest.data.manifest,
    );
    expect(await ctx.repos.strategy.findById('research-a')).toEqual(before);
  });

  it('projects missing observations and comparisons as unavailable facts without enabling tasks', async () => {
    const { handle, ctx } = await setup();
    const body = (await (
      await handle(request('view=updates&strategyId=research-a&versionId=research-a-v2'))
    ).json()) as ResearchBody;
    expect(body.data.context.ok).toBe(true);
    expect(body.data.comparison).toMatchObject({ ok: false, error: { kind: 'not_found' } });
    expect(body.data.continuity.status).toBe('not-configured');
    expect(body.data.continuity.factCutoff).toBeNull();
    expect(await ctx.repos.strategySchedule.findByStrategyId('research-a')).toBeNull();
  });

  it('does not create investment assets or alter the owner during onboarding', async () => {
    const { handle, ctx, principal } = await setup();
    const before = await ctx.repos.account.list();
    const body = (await (await handle(request('view=onboarding'))).json()) as ResearchBody;
    expect(body.data.accountId).toBe(principal.accountId);
    expect(body.data.account.ok).toBe(true);
    expect(body.data.steps).toHaveLength(5);
    expect(await ctx.repos.account.list()).toEqual(before);
  });

  it('uses admission and accepts GET only', async () => {
    const rejection = new Response(null, { status: 401 });
    const { handle, read } = await setup(() => rejection);
    const invoke = vi.spyOn(read, 'invoke');
    expect(await handle(request('view=onboarding'))).toBe(rejection);
    expect(invoke).not.toHaveBeenCalled();
    const post = await handle(
      new Request('https://dsh.example/api/luoome/research', { method: 'POST' }),
    );
    expect(post.status).toBe(405);
    expect(post.headers.get('allow')).toBe('GET');
  });
});

describe('continuous research status', () => {
  const configured = async (
    options: {
      automationsEnabled?: boolean;
      grant?: boolean;
      receipt?: 'executing' | 'unknown' | 'succeeded';
      outcome?: string;
      changed?: boolean;
      audit?: boolean;
    } = {},
  ) => {
    const { ctx, read, principal } = await setup();
    const run: StrategyRun = {
      id: 'research-operational-run',
      strategyId: 'research-a',
      strategyVersionId: 'research-a-v1',
      scope: 'operational',
      mode: 'scheduled',
      coverage: 'CN_A_SHARES_SH_SZ',
      status: 'complete',
      startedAt: new Date(now.getTime() - 120_000),
      finishedAt: new Date(now.getTime() - 60_000),
      dataAsOf: new Date(now.getTime() - 300_000),
      inputSnapshot: { stockIds: ['600519.SH'], universeKind: 'explicit' },
      providerStatuses: [],
      publication: {
        status: 'published',
        reasons: [],
        decidedAt: new Date(now.getTime() - 60_000),
      },
    };
    await ctx.repos.strategyRun.commitRun({ run, results: [], signals: [] });
    await ctx.repos.strategySchedule.save({
      ...buildStrategySchedule({
        strategyId: 'research-a',
        cron: '30 16 * * 1-5',
        timezone: 'Asia/Shanghai',
        enabled: true,
        now,
      }),
      lastRunId: run.id,
    });
    const task: ScheduleCatalogEntry = {
      id: ScheduleId('task-research'),
      sessionId: SessionId('session-research'),
      title: '合成持续观察任务',
      prompt: '精确执行已授权日循环',
      kind: 'cron',
      expression: '30 16 * * 1-5',
      timeZone: 'Asia/Shanghai',
      status: 'active',
      scheduledAt: '2026-10-28T08:30:00.000Z',
      lastDelivery: {
        scheduledAt: '2026-10-27T08:30:00.000Z',
        deliveredAt: '2026-10-27T08:30:01.000Z',
        messageId: 'message-research' as never,
      },
    };
    const grant: PluginAutomationGrant = {
      id: `batch:${task.id}:${principal.accountId}`,
      identity: {
        userId: principal.userId,
        profile: 'research-test',
        sessionId: task.sessionId,
        taskId: task.id,
      },
      scheduleHash: dshScheduleHash(task),
      version: 1,
      policyVersion: 1,
      enabled: true,
      createdAt: now.getTime() - 86_400_000,
      updatedAt: now.getTime() - 86_400_000,
      expiresAt: now.getTime() + 86_400_000,
      allowedCalls: [
        {
          tool: 'run_strategy_daily_cycle',
          accountId: principal.accountId,
          inputJson: pluginInputJson({ accountId: principal.accountId }),
          inputHash: pluginInputHash({ accountId: principal.accountId }),
          capabilities: ['write', 'external'],
        },
      ],
    };
    if (options.grant !== false) await ctx.repos.pluginAuthority.saveGrant(grant, null);
    if (options.receipt) {
      const operation = {
        id: scheduledResearchOperationId(
          grant.identity,
          task.lastDelivery?.scheduledAt as string,
          principal.accountId,
        ),
        ...principal,
        tool: 'run_strategy_daily_cycle',
        inputJson: pluginInputJson({ accountId: principal.accountId }),
        inputHash: pluginInputHash({ accountId: principal.accountId }),
        policyVersion: 1,
        requiredCapabilities: ['write', 'external'],
        authorization: { kind: 'schedule', grantId: grant.id, grantVersion: 1 },
        state: options.receipt,
        claimToken: 'claim-research',
        resultJson: JSON.stringify({
          ok: true,
          data: { outcome: options.outcome ?? 'due', reason: '合成回执' },
        }),
        createdAt: now.getTime() - 180_000,
        updatedAt: now.getTime() - 30_000,
        expiresAt: now.getTime() + 540_000,
      } as PluginOperation;
      expect(
        await ctx.repos.pluginAuthority.insertOperation({
          ...operation,
          state: 'pending',
          claimToken: null,
          resultJson: null,
        }),
      ).toBe(true);
      expect(
        await ctx.repos.pluginAuthority.claimOperation({
          ...principal,
          id: operation.id,
          now: now.getTime() - 170_000,
          policyVersion: 1,
          authorization: { kind: 'schedule', identity: grant.identity },
          claimToken: 'claim-research',
        }),
      ).not.toBeNull();
      if (options.receipt !== 'executing')
        expect(
          await ctx.repos.pluginAuthority.settleOperation({
            ...principal,
            id: operation.id,
            claimToken: 'claim-research',
            state: options.receipt,
            resultJson: operation.resultJson,
            now: operation.updatedAt,
          }),
        ).toBe(true);
    }
    if (options.audit !== false)
      await ctx.repos.workflowRun.save({
        id: 'workflow-research-cycle',
        workflowName: 'strategy-daily-cycle',
        mode: 'scheduled',
        status: 'succeeded',
        startedAt: new Date(now.getTime() - 150_000),
        finishedAt: new Date(now.getTime() - 45_000),
        providerStatuses: [],
        inputSummary: {
          schemaVersion: 1,
          strategyId: 'research-a',
          scheduleId: 'strategy-schedule:research-a',
          requestedBy: 'scheduled',
          dataAsOf: run.dataAsOf,
        },
        outputSummary: {
          schemaVersion: 1,
          status: 'complete',
          phase: 'finish',
          runId: run.id,
          publication: 'published',
          leaseRenewals: 1,
          phaseTimings: [],
        },
      });
    const tasks = [options.changed ? { ...task, prompt: '修改后的任务定义' } : task];
    const reader = createResearchContinuityReader({
      read,
      repository: ctx.repos.pluginAuthority,
      profile: 'research-test',
      policyVersion: 1,
      automationsEnabled: options.automationsEnabled ?? true,
      dailyCycleEnabled: true,
      tasks: async () => tasks,
      principalForSession: (sessionId) => (sessionId === task.sessionId ? principal : null),
      now: () => now.getTime(),
    });
    return {
      ctx,
      read: () => reader(principal, 'research-a', new AbortController().signal),
      task,
      grant,
    };
  };

  it('never treats enabled strategy schedule as proof of a running backend', async () => {
    const disabled = await configured({ automationsEnabled: false, receipt: 'succeeded' });
    expect((await disabled.read()).status).toBe('disabled');
    const missing = await configured({ grant: false });
    expect((await missing.read()).status).toBe('blocked');
    const changed = await configured({ changed: true, receipt: 'succeeded' });
    expect((await changed.read()).tasks[0]?.grantStatus).toBe('changed');
    expect((await changed.read()).status).toBe('blocked');
  });

  it('distinguishes delivered reminders, executing operations and unknown business results', async () => {
    expect((await (await configured()).read()).status).toBe('waiting');
    expect((await (await configured({ receipt: 'executing' })).read()).status).toBe('running');
    expect((await (await configured({ receipt: 'unknown' })).read()).status).toBe('unknown');
    expect(
      (await (await configured({ receipt: 'succeeded', outcome: 'failed' })).read()).status,
    ).toBe('partial');
    expect(
      (await (await configured({ receipt: 'succeeded', outcome: 'skipped' })).read()).status,
    ).toBe('waiting');
    expect((await (await configured({ receipt: 'succeeded', audit: false })).read()).status).toBe(
      'unknown',
    );
  });

  it('requires real receipts and a matching strategy run, and never claims notification delivery', async () => {
    const fixture = await configured({ receipt: 'succeeded' });
    const status = await fixture.read();
    expect(status.status).toBe('healthy');
    expect(status.factCutoff).toBe('2026-10-27T08:55:00.000Z');
    expect(status.notificationStatus).toBe('not-verified');
    const schedule = await fixture.ctx.repos.strategySchedule.findByStrategyId('research-a');
    if (!schedule) throw new Error('Missing schedule');
    await fixture.ctx.repos.strategySchedule.save({ ...schedule, lastRunId: 'other-run' });
    expect((await fixture.read()).status).toBe('stale');
  });
});
