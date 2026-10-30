import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm';
import { SessionId } from '@deepseek-ai/dsh-session';
import { money, type PluginAutomationGrant } from '@luoome/core';
import { createDrizzleRepos } from '@luoome/db';
import { enqueueAnalysisJobTool, getDecisionReviewContextTool } from '@luoome/tools';
import { type Call, createDshTestHost } from '../testing/dsh-host.js';
import { AUTOMATION_CATALOG_TOOL } from './automation-catalog.js';
import { createBatchOperationPolicies } from './batch-operations.js';
import {
  MANUAL_OPERATION_TOOL,
  OPERATION_STATUS_TOOL,
  SCHEDULED_OPERATION_TOOL,
} from './dsh-authority.js';
import { dshScheduleHash } from './dsh-identity.js';
import { runQueuePreflight } from './preflight.js';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const rootDir = async () => {
  const root = await mkdtemp(join(tmpdir(), 'luoome-dsh-e2e-'));
  roots.push(root);
  return root;
};
const eventually = async (predicate: () => boolean | Promise<boolean>) => {
  for (let i = 0; i < 500; i++) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('DSH integration did not settle');
};

const start = (root: string, options: Parameters<typeof createDshTestHost>[2] = {}) =>
  createDshTestHost(root, createDrizzleRepos(join(root, 'facts.db')), options);

const fixtureClock = () => {
  let now = Date.now();
  const spy = spyOn(Date, 'now').mockImplementation(() => now);
  return {
    advance(ms: number) {
      now += ms;
    },
    restore: () => spy.mockRestore(),
  };
};
const drive = async (fixture: Awaited<ReturnType<typeof start>>) => {
  const wake = await fixture.ctx.schedule.create(fixture.handle.agent.id, {
    prompt: 'timer recomputation',
    title: 'fixture clock drive',
    after_seconds: 3600,
  });
  await fixture.ctx.schedule.delete({ sessionId: fixture.handle.agent.id, id: wake.id });
};
const authorize = async (
  fixture: Awaited<ReturnType<typeof start>>,
  grant: PluginAutomationGrant,
  expectedVersion: number | null = null,
) => {
  const result = await fixture.run({
    name: MANUAL_OPERATION_TOOL,
    input: {
      id: randomUUID(),
      tool: 'configure_plugin_automation',
      input: { grant, expectedVersion },
    },
  });
  expect(result?.value).toMatchObject({ ok: true, data: { state: 'succeeded' } });
};
const scheduledCall = (grant: PluginAutomationGrant, input: unknown): Call => {
  const [call] = grant.allowedCalls;
  if (!call) throw new Error('Missing grant fixture call');
  return {
    name: SCHEDULED_OPERATION_TOOL,
    input: {
      grantId: grant.id,
      grantVersion: grant.version,
      tool: call.tool,
      accountId: call.accountId,
      input,
    },
  };
};

describe('DSH personal execution and schedule integration with durable facts', () => {
  it('reads original operation status without replaying writes or reconstructing approval credentials', async () => {
    const fixture = await start(await rootDir());
    try {
      const operationId = randomUUID();
      const prepared = await fixture.host.service.prepare(fixture.principal, {
        id: operationId,
        tool: 'fixture_scheduled_write',
        input: { accountId: fixture.principal.accountId, label: 'status-only' },
      });
      expect(prepared.ok).toBe(true);
      const result = await fixture.run({
        name: OPERATION_STATUS_TOOL,
        input: { operationId, reconcile: true },
      });
      expect(result?.value).toMatchObject({ ok: true, data: { operationId, state: 'pending' } });
      expect(JSON.stringify(result?.value)).not.toContain('confirmationToken');
      expect(fixture.approvals).toHaveLength(0);
      expect(
        (await fixture.domain.repos.account.findById(fixture.principal.accountId))?.name,
      ).not.toContain('status-only');
      const unscoped = await fixture.ctx.tools.execute({
        name: OPERATION_STATUS_TOOL,
        callId: ToolCallId(randomUUID()),
        arguments: { operationId },
        signal: new AbortController().signal,
      });
      expect(unscoped).toMatchObject({
        value: { ok: false, error: { kind: 'permission_denied' } },
      });
    } finally {
      await fixture.close();
    }
  });
  it.each([false, true])(
    'executes every requested write without approval across steps=%s',
    async (acrossSteps) => {
      const fixture = await start(await rootDir());
      try {
        const call = (label: string): Call => ({
          name: MANUAL_OPERATION_TOOL,
          input: {
            id: randomUUID(),
            tool: 'fixture_scheduled_write',
            input: { accountId: fixture.principal.accountId, label },
          },
        });
        const removeRejection = fixture.answer('rejected');
        const before = fixture.results.length;
        const advice = (
          await fixture.domain.repos.advice.query({ includeExpired: true, limit: 1 })
        )[0];
        if (!advice) throw new Error('Missing advice fixture');
        const subject = { kind: 'advice' as const, id: advice.id };
        const preview = await getDecisionReviewContextTool.execute({ subject }, fixture.domain);
        if (!preview.ok || !preview.data.context) throw new Error('Missing context');
        const plan: Call[] = [
          call('first'),
          call('second'),
          {
            name: MANUAL_OPERATION_TOOL,
            input: {
              id: randomUUID(),
              tool: 'save_decision_review',
              input: {
                subject,
                contextHash: preview.data.context.contextHash,
                expectedRevision: 0,
                content: { note: '同一请求直接执行' },
              },
            },
          },
        ];
        fixture.model.calls.push(...(acrossSteps ? plan.map((item) => [item]) : [plan]), []);
        fixture.handle.agent.followup(
          createUserMessage({
            content: [{ type: 'text', text: 'one write plan' }],
            source: { kind: 'user' },
          }),
        );
        await fixture.handle.agent.whenIdle();
        expect(fixture.approvals).toHaveLength(0);
        expect(fixture.results.slice(before).every((result) => !result.isError)).toBe(true);
        const account = await fixture.domain.repos.account.findById(fixture.principal.accountId);
        expect(account?.name).toContain('|first|second');
        expect(
          await fixture.domain.repos.decisionReview.findBySubject({
            accountId: fixture.principal.accountId,
            subject,
          }),
        ).not.toBeNull();
        removeRejection();
      } finally {
        await fixture.close();
      }
    },
  );
  it('runs the real weekly batch only for its approved account and delivered occurrence', async () => {
    const clock = fixtureClock();
    const fixture = await start(await rootDir(), {
      automationsEnabled: true,
      policies: createBatchOperationPolicies(),
      clock: () => new Date('2026-10-25T02:00:00Z'),
    });
    try {
      const { ctx, handle, principal, model, results, domain } = fixture;
      const task = await ctx.schedule.create(handle.agent.id, {
        prompt: '执行已授权的策略周报',
        title: '原生批处理验收',
        every_seconds: 60,
      });
      const catalog = await fixture.run({ name: AUTOMATION_CATALOG_TOOL, input: {} });
      const value = catalog?.value as {
        ok: boolean;
        data: { allowedCalls: PluginAutomationGrant['allowedCalls'] };
      };
      expect(value.ok).toBe(true);
      const callTemplate = value.data.allowedCalls.find(
        (call) => call.tool === 'run_strategy_autonomy_weekly',
      );
      if (!callTemplate) throw new Error('Missing weekly call template');
      const input = JSON.parse(callTemplate.inputJson);
      const grant = { ...fixture.grant(task, input), allowedCalls: [callTemplate] };
      fixture.answer('allowed-once');
      await authorize(fixture, grant);
      const before = results.length;
      const call = scheduledCall(grant, input);
      model.calls.push([call, call], []);
      clock.advance(65_000);
      await drive(fixture);
      await eventually(() => results.length >= before + 2);
      await handle.agent.whenIdle();
      expect(results.slice(before).map((result) => result.value)).toMatchObject([
        { ok: true, data: { state: 'succeeded' } },
        { ok: true, data: { state: 'succeeded' } },
      ]);
      const reports = await domain.repos.report.list({ kind: 'weekly' });
      expect(reports).toHaveLength(1);
      expect(reports[0]?.scope).toEqual({ kind: 'account', accountId: principal.accountId });
      expect(
        await domain.repos.workflowRun.findById(
          `strategy-autonomy-weekly:2026-10-25:${principal.accountId}`,
        ),
      ).not.toBeNull();
      expect(fixture.approvals).toHaveLength(0);
      expect((await fixture.run(call))?.isError).toBe(true);
      expect(await domain.repos.report.list({ kind: 'weekly' })).toHaveLength(1);
    } finally {
      await fixture.close();
      clock.restore();
    }
  });
  it('executes a delivered occurrence in the host without any model tool call', async () => {
    const clock = fixtureClock();
    const fixture = await start(await rootDir(), { automationsEnabled: true });
    try {
      const { handle, model, results, domain, principal } = fixture;
      const task = await fixture.ctx.schedule.create(handle.agent.id, {
        prompt: '宿主已处理，无需调用工具',
        title: '宿主回调验收',
        every_seconds: 60,
      });
      const input = { accountId: principal.accountId, label: 'host-only' };
      const grant = {
        ...fixture.grant(task, input, `batch:${task.id}:${principal.accountId}`),
      };
      fixture.answer('allowed-once');
      await authorize(fixture, grant);
      const beforeResults = results.length;
      const beforeRequests = model.requests;
      model.calls.push([]);
      clock.advance(65_000);
      await drive(fixture);
      await eventually(async () =>
        Boolean(
          (await domain.repos.account.findById(principal.accountId))?.name.endsWith('|host-only'),
        ),
      );
      await handle.agent.whenIdle();
      expect(model.requests).toBe(beforeRequests + 1);
      expect(results).toHaveLength(beforeResults);
      expect((await domain.repos.account.findById(principal.accountId))?.name).toEndWith(
        '|host-only',
      );
    } finally {
      await fixture.close();
      clock.restore();
    }
  });
  it('preflights persisted SQLite queue facts without a model request or claim', async () => {
    const fixture = await start(await rootDir());
    try {
      const context = () => fixture.domain;
      const signal = new AbortController().signal;
      expect(await runQueuePreflight({ context, signal })).toEqual({ state: 'empty', exitCode: 1 });
      // advice_stock 的写回窗口是 min(now+30min, 当日 15:00)。用固定交易日 10:00 种队列，
      // 否则本测试在收盘后/周末运行会因 context_expired 失败；preflight 只读指标，
      // 仍用真实时钟的 fixture.domain。
      const seedDomain = {
        ...fixture.domain,
        clock: () => new Date('2026-10-22T02:00:00.000Z'),
      };
      const now = seedDomain.clock();
      await fixture.db.repos.quote.save({
        stockId: '600519.SH',
        ts: now,
        observedAt: now,
        fetchedAt: now,
        timestampSource: 'upstream',
        open: money(100),
        high: money(101),
        low: money(99),
        close: money(100),
        volume: 1000,
        source: 'preflight-fixture',
      });
      const queued = await enqueueAnalysisJobTool.execute(
        { kind: 'advice_stock', subject: { kind: 'stock', id: '600519.SH' }, source: 'schedule' },
        seedDomain,
      );
      expect(queued.ok).toBe(true);
      const before = await fixture.db.repos.analysis.listJobs({
        accountId: fixture.principal.accountId,
      });
      expect(await runQueuePreflight({ context, signal })).toEqual({ state: 'ready', exitCode: 0 });
      expect(
        await fixture.db.repos.analysis.listJobs({ accountId: fixture.principal.accountId }),
      ).toEqual(before);
      expect(fixture.model.requests).toBe(0);
    } finally {
      await fixture.close();
    }
  });
  it('configures a real grant through the actual Agent loop without ApprovalService', async () => {
    const fixture = await start(await rootDir());
    try {
      const { ctx, handle, answer, grant, principal, run, db } = fixture;
      const task = await ctx.schedule.create(handle.agent.id, {
        prompt: 'fixture reminder',
        title: 'fixture',
        after_seconds: 3600,
      });
      const allowed = grant(task, { accountId: principal.accountId, label: 'once' });
      const catalog = (await ctx.schedule.catalog()).find((t) => t.id === task.id);
      if (!catalog) throw new Error('Missing catalog task');
      expect(dshScheduleHash(catalog)).toBe(allowed.scheduleHash);
      answer('allowed-once');
      const result = await run({
        name: MANUAL_OPERATION_TOOL,
        input: {
          id: randomUUID(),
          tool: 'configure_plugin_automation',
          input: { grant: allowed, expectedVersion: null },
        },
      });
      expect(result?.isError).toBe(false);
      expect(result?.value).toMatchObject({ ok: true, data: { state: 'succeeded' } });
      expect(
        (await db.repos.pluginAuthority.findGrant(allowed.id, principal.userId))?.enabled,
      ).toBe(true);
      expect(
        handle.agent.session
          .ownEvents()
          .filter((e) => e.type === 'approval/decided')
          .map((e) => e.data.outcome),
      ).toEqual([]);
    } finally {
      await fixture.close();
    }
  });

  it('runs only the delivered occurrence, deduplicates it, and rejects a later human replay', async () => {
    const clock = fixtureClock();
    const fixture = await start(await rootDir(), { automationsEnabled: true });
    try {
      const { ctx, handle, principal, grant, answer, model, results, domain, run } = fixture;
      const task = await ctx.schedule.create(handle.agent.id, {
        prompt: 'run the approved batch',
        title: 'fixture recurring',
        every_seconds: 60,
      });
      const input = { accountId: principal.accountId, label: 'once' };
      const allowed = grant(task, input);
      answer('allowed-once');
      await authorize(fixture, allowed);
      const before = results.length;
      const call = scheduledCall(allowed, input);
      model.calls.push([call, call], []);
      clock.advance(65_000);
      await drive(fixture);
      await eventually(() => results.length >= before + 2);
      await handle.agent.whenIdle();
      await ctx.sessions.flush(handle.agent.session);
      expect(results.slice(before).map((r) => r.value)).toMatchObject([
        { ok: true, data: { state: 'succeeded' } },
        { ok: true, data: { state: 'succeeded' } },
      ]);
      expect(
        (await domain.repos.account.findById(principal.accountId))?.name.match(/\|once/g),
      ).toHaveLength(1);
      const history = await ctx.schedule.history({
        sessionId: handle.agent.id,
        id: task.id,
        limit: 10,
      });
      expect('records' in history && history.records.length).toBe(1);
      expect((await run(call))?.isError).toBe(true);
      expect(
        (await domain.repos.account.findById(principal.accountId))?.name.match(/\|once/g),
      ).toHaveLength(1);
      expect(fixture.approvals).toHaveLength(0);
    } finally {
      await fixture.close();
      clock.restore();
    }
  });

  it('keeps automated execution disabled by default even after approval and actual reminder delivery', async () => {
    const clock = fixtureClock();
    const fixture = await start(await rootDir());
    try {
      const task = await fixture.ctx.schedule.create(fixture.handle.agent.id, {
        prompt: 'fixture',
        title: 'disabled by default',
        after_seconds: 1,
      });
      const input = { accountId: fixture.principal.accountId, label: 'forbidden' };
      const grant = fixture.grant(task, input);
      fixture.answer('allowed-once');
      await authorize(fixture, grant);
      const before = fixture.results.length;
      fixture.model.calls.push([scheduledCall(grant, input)], []);
      clock.advance(1001);
      await drive(fixture);
      await eventually(() => fixture.results.length > before);
      await fixture.handle.agent.whenIdle();
      expect(fixture.results.at(-1)?.isError).toBe(true);
      expect(
        (await fixture.domain.repos.account.findById(fixture.principal.accountId))?.name,
      ).not.toContain('|forbidden');
    } finally {
      await fixture.close();
      clock.restore();
    }
  });

  it('executes personal operations under every host approval policy without approval requests', async () => {
    for (const options of [
      {},
      { policy: 'never' as const },
      { withoutApproval: true },
      { noAnswerer: true },
    ]) {
      const fixture = await start(await rootDir(), options);
      try {
        if (!options.withoutApproval && !options.noAnswerer)
          fixture.answer(options.policy === 'never' ? 'allowed-once' : 'rejected');
        const task = await fixture.ctx.schedule.create(fixture.handle.agent.id, {
          prompt: 'fixture',
          title: 'personal direct execution',
          after_seconds: 3600,
        });
        const grant = fixture.grant(task, {
          accountId: fixture.principal.accountId,
          label: 'direct',
        });
        const result = await fixture.run({
          name: MANUAL_OPERATION_TOOL,
          input: {
            id: randomUUID(),
            tool: 'configure_plugin_automation',
            input: { grant, expectedVersion: null },
          },
        });
        expect(result?.isError, JSON.stringify({ options, result })).toBe(false);
        expect(result?.value).toMatchObject({ ok: true, data: { state: 'succeeded' } });
        expect(
          await fixture.db.repos.pluginAuthority.findGrant(grant.id, fixture.principal.userId),
        ).not.toBe(null);
        expect(fixture.approvals).toHaveLength(0);
      } finally {
        await fixture.close();
      }
    }
  });

  it('rejects revoked grants, changed task definitions and forged schedule identity', async () => {
    const clock = fixtureClock();
    const fixture = await start(await rootDir(), { automationsEnabled: true });
    try {
      fixture.answer('allowed-once');
      const input = { accountId: fixture.principal.accountId, label: 'denied' };
      const first = await fixture.ctx.schedule.create(fixture.handle.agent.id, {
        prompt: 'first',
        title: 'revoked',
        every_seconds: 60,
      });
      const second = await fixture.ctx.schedule.create(fixture.handle.agent.id, {
        prompt: 'second',
        title: 'edited',
        every_seconds: 60,
      });
      const a = fixture.grant(first, input, 'revoked');
      const b = fixture.grant(second, input, 'edited');
      await authorize(fixture, a);
      await authorize(fixture, b);
      await authorize(fixture, { ...a, version: 2, enabled: false }, 1);
      const updated = await fixture.ctx.schedule.update({
        sessionId: fixture.handle.agent.id,
        id: second.id,
        expected: second,
        prompt: 'different instructions',
      });
      expect('updated' in updated && updated.updated).toBe(true);
      const before = fixture.results.length;
      const forged = {
        name: SCHEDULED_OPERATION_TOOL,
        input: {
          ...(scheduledCall(b, input).input as Record<string, unknown>),
          taskId: first.id,
          occurrenceId: 'pretend',
        },
      };
      fixture.model.calls.push([scheduledCall(a, input), scheduledCall(b, input), forged], []);
      clock.advance(65_000);
      await drive(fixture);
      await eventually(() => fixture.results.length >= before + 3);
      await fixture.handle.agent.whenIdle();
      expect(fixture.results.slice(before).map((r) => r.isError)).toEqual([true, true, true]);
      expect(
        (await fixture.domain.repos.account.findById(fixture.principal.accountId))?.name,
      ).not.toContain('|denied');
    } finally {
      await fixture.close();
      clock.restore();
    }
  });

  it('resolves two tasks sharing one real reminder message without conflating their occurrences', async () => {
    const clock = fixtureClock();
    const fixture = await start(await rootDir(), { automationsEnabled: true });
    try {
      fixture.answer('allowed-once');
      const tasks = [];
      const calls = [];
      for (const label of ['A', 'B']) {
        const task = await fixture.ctx.schedule.create(fixture.handle.agent.id, {
          prompt: label,
          title: label,
          every_seconds: 60,
        });
        tasks.push(task);
        const input = { accountId: fixture.principal.accountId, label };
        const grant = fixture.grant(task, input, label);
        await authorize(fixture, grant);
        calls.push(scheduledCall(grant, input));
      }
      const before = fixture.results.length;
      fixture.model.calls.push(calls, []);
      clock.advance(65_000);
      await drive(fixture);
      await eventually(() => fixture.results.length >= before + 2);
      await fixture.handle.agent.whenIdle();
      const history = await Promise.all(
        tasks.map((t) =>
          fixture.ctx.schedule.history({ sessionId: fixture.handle.agent.id, id: t.id, limit: 10 }),
        ),
      );
      const messages = history.map((h) => ('records' in h ? h.records[0]?.messageId : null));
      expect(messages[0]).toBeString();
      expect(messages[0]).toBe(messages[1]);
      expect(
        (await fixture.domain.repos.account.findById(fixture.principal.accountId))?.name,
      ).toEndWith('|A|B');
    } finally {
      await fixture.close();
      clock.restore();
    }
  });

  it('waits for the real schedule delivery acknowledgment before granting execution', async () => {
    const clock = fixtureClock();
    const fixture = await start(await rootDir(), { automationsEnabled: true });
    let release = () => {};
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    let paused = false;
    let driving: Promise<void> | undefined;
    try {
      fixture.answer('allowed-once');
      const task = await fixture.ctx.schedule.create(fixture.handle.agent.id, {
        prompt: 'wait for durable delivery',
        title: 'flush barrier',
        every_seconds: 60,
      });
      const input = { accountId: fixture.principal.accountId, label: 'acknowledged' };
      const grant = fixture.grant(task, input);
      await authorize(fixture, grant);
      fixture.ctx.on('session/flush', async (session) => {
        if (
          session
            .ownEvents()
            .some(
              (event) =>
                event.type === 'agent/inbox/spliced' &&
                event.data.inserted.some((message) => message.source.kind === 'schedule'),
            )
        ) {
          paused = true;
          await barrier;
        }
      });
      const before = fixture.results.length;
      fixture.model.calls.push([scheduledCall(grant, input)], []);
      clock.advance(65_000);
      driving = drive(fixture);
      await eventually(() => paused);
      const history = await fixture.ctx.schedule.history({
        sessionId: fixture.handle.agent.id,
        id: task.id,
        limit: 10,
      });
      expect('records' in history && history.records.length).toBe(0);
      expect(
        (await fixture.domain.repos.account.findById(fixture.principal.accountId))?.name,
      ).not.toContain('|acknowledged');
      release();
      await driving;
      await eventually(() => fixture.results.length > before);
      await fixture.handle.agent.whenIdle();
      expect(
        (await fixture.domain.repos.account.findById(fixture.principal.accountId))?.name,
      ).toEndWith('|acknowledged');
    } finally {
      release();
      await driving;
      await fixture.close();
      clock.restore();
    }
  });

  it('preserves grants, schedule history and occurrence deduplication across real service and database restart', async () => {
    const clock = fixtureClock();
    const root = await rootDir();
    let fixture = await start(root, { automationsEnabled: true });
    try {
      fixture.answer('allowed-once');
      const task = await fixture.ctx.schedule.create(fixture.handle.agent.id, {
        prompt: 'resume',
        title: 'resume',
        every_seconds: 60,
      });
      const input = { accountId: fixture.principal.accountId, label: 'resume' };
      const grant = fixture.grant(task, input);
      await authorize(fixture, grant);
      fixture.model.calls.push([scheduledCall(grant, input)], []);
      const before = fixture.results.length;
      clock.advance(65_000);
      await drive(fixture);
      await eventually(() => fixture.results.length > before);
      await fixture.handle.agent.whenIdle();
      await fixture.ctx.sessions.flush(fixture.handle.agent.session);
      await fixture.close();
      fixture = await start(root, { automationsEnabled: true, resume: true });
      expect(
        (await fixture.db.repos.pluginAuthority.findGrant(grant.id, fixture.principal.userId))
          ?.enabled,
      ).toBe(true);
      expect(fixture.model.requests).toBe(0);
      fixture.model.calls.push([scheduledCall(grant, input), scheduledCall(grant, input)], []);
      clock.advance(60_000);
      await drive(fixture);
      await eventually(() => fixture.results.length >= 2);
      await fixture.handle.agent.whenIdle();
      expect(
        (await fixture.domain.repos.account.findById(fixture.principal.accountId))?.name.match(
          /\|resume/g,
        ),
      ).toHaveLength(2);
      const history = await fixture.ctx.schedule.history({
        sessionId: fixture.handle.agent.id,
        id: task.id,
        limit: 10,
      });
      expect('records' in history && history.records.length).toBe(2);
      expect(fixture.approvals).toHaveLength(0);
    } finally {
      await fixture.close();
      clock.restore();
    }
  });

  it('recovers a real decision-review receipt after response loss and restart without another business write', async () => {
    const root = await rootDir();
    let fixture = await start(root);
    try {
      fixture.answer('allowed-once');
      const [advice] = await fixture.domain.repos.advice.query({ includeExpired: true, limit: 1 });
      if (!advice) throw new Error('Missing advice fixture');
      const subject = { kind: 'advice' as const, id: advice.id };
      const preview = await getDecisionReviewContextTool.execute({ subject }, fixture.domain);
      if (!preview.ok || !preview.data.context) throw new Error('Missing review fixture');
      const id = randomUUID();
      const call = {
        name: MANUAL_OPERATION_TOOL,
        input: {
          id,
          tool: 'save_decision_review',
          input: {
            subject,
            contextHash: preview.data.context.contextHash,
            expectedRevision: 0,
            content: {
              tradeIds: [],
              adviceFeedback: null,
              triggerFeedback: null,
              note: 'committed once',
            },
          },
        },
      };
      const settle = spyOn(
        fixture.db.repos.pluginAuthority,
        'settleOperation',
      ).mockRejectedValueOnce(new Error('lost response'));
      expect((await fixture.run(call))?.value).toMatchObject({
        ok: false,
        error: { kind: 'internal' },
      });
      settle.mockRestore();
      await fixture.close();
      fixture = await start(root, { resume: true });
      expect(await fixture.host.service.reconcile(fixture.principal, id)).toMatchObject({
        ok: true,
        data: { state: 'succeeded' },
      });
      expect((await fixture.run(call))?.value).toMatchObject({
        ok: true,
        data: { state: 'succeeded' },
      });
      const review = await fixture.domain.repos.decisionReview.findBySubject({
        accountId: fixture.principal.accountId,
        subject,
      });
      expect(review?.review.currentRevision).toBe(1);
      expect(fixture.approvals).toHaveLength(0);
    } finally {
      await fixture.close();
    }
  });

  it('refuses delegated children, cross-session scheduled calls and calls with no Agent', async () => {
    const clock = fixtureClock();
    const fixture = await start(await rootDir(), { automationsEnabled: true });
    const child = await fixture.ctx.agents.create({
      sessionId: SessionId('child-fixture'),
      parentAgent: fixture.handle.agent,
      meta: { origin: 'subagent', delegationDepth: 1 },
      agentOptions: { provider: 'fixture', model: 'scripted' },
    });
    try {
      const request = { id: randomUUID(), tool: 'save_decision_review', input: {} };
      expect(fixture.host.identity.principal(child.agent)).toBe(null);
      const noAgent = await fixture.ctx.tools.execute({
        name: MANUAL_OPERATION_TOOL,
        callId: ToolCallId('headless'),
        arguments: request,
        signal: new AbortController().signal,
      });
      expect(noAgent.isError).toBe(true);
      const childCall = await fixture.ctx.tools.execute({
        name: MANUAL_OPERATION_TOOL,
        callId: ToolCallId('child'),
        arguments: request,
        agent: child.agent,
        signal: new AbortController().signal,
      });
      expect(childCall.isError).toBe(true);
      expect(fixture.approvals).toHaveLength(0);
      fixture.answer('allowed-once');
      const task = await fixture.ctx.schedule.create(fixture.handle.agent.id, {
        prompt: 'root',
        title: 'root',
        after_seconds: 3600,
      });
      const input = { accountId: fixture.principal.accountId, label: 'other-session' };
      const grant = fixture.grant(task, input);
      await authorize(fixture, grant);
      const other = await fixture.ctx.agents.create({
        sessionId: SessionId('other-fixture'),
        agentOptions: { provider: 'fixture', model: 'scripted' },
      });
      try {
        await fixture.ctx.schedule.create(other.agent.id, {
          prompt: 'other',
          title: 'other',
          after_seconds: 1,
        });
        const before = fixture.results.length;
        fixture.model.calls.push([scheduledCall(grant, input)], []);
        clock.advance(1001);
        await drive(fixture);
        await eventually(() => fixture.results.length > before);
        await other.agent.whenIdle();
        expect(fixture.results.at(-1)?.isError).toBe(true);
        expect(
          (await fixture.domain.repos.account.findById(fixture.principal.accountId))?.name,
        ).not.toContain('|other-session');
      } finally {
        await other.dispose();
      }
    } finally {
      await child.dispose();
      await fixture.close();
      clock.restore();
    }
  });

  // T24-b / H5=B 层③：**可见 ≠ 权威**。
  //
  // 要分开两件长得很像的事（骨架 T2/T3）：
  //   - 工具**不存在**（不可见）→ isError:true + error.code === 'UNKNOWN_TOOL'（ToolNotFoundError）；
  //   - 工具**存在但被权威层拒绝** → isError:true + error 只有 message、**无 code**。
  // 现有 `expect(childCall.isError).toBe(true)` 两者都满足，分不出来；这里必须断 message 与 code。
  //
  // 陷阱 T4：**不要**用 `ctx.tools.get(name, child.agent.ctx)` 做静态可见集断言——
  // scope 是 dsh-scope 的私有 symbol，传 agent.ctx 会静默退化成全局视图 → 「子 agent 看不到 X」会假绿。
  // 因此本用例只做行为等价断言。
  it('T24-b 层③：子 agent 用不了父写工具 —— 拒绝来自执行期权威，不是「工具不存在」', async () => {
    const fixture = await start(await rootDir(), { automationsEnabled: true });
    const child = await fixture.ctx.agents.create({
      sessionId: SessionId('reconciliation-child'),
      parentAgent: fixture.handle.agent,
      meta: { origin: 'subagent', delegationDepth: 1 },
      agentOptions: { provider: 'fixture', model: 'scripted' },
    });
    try {
      const childCall = await fixture.ctx.tools.execute({
        name: MANUAL_OPERATION_TOOL,
        callId: ToolCallId('reconciliation-child-call'),
        arguments: { id: randomUUID(), tool: 'save_decision_review', input: {} },
        agent: child.agent,
        signal: new AbortController().signal,
      });

      // (a) 被拒。
      expect(childCall.isError).toBe(true);

      // (b) 拒绝原因是**执行期权威**，不是「工具不存在」——这是「看不到」与「用不了」的分水岭。
      expect(childCall.error?.message).toContain(
        'A live, top-level authorized session is required',
      );

      // (c) 明确排除「不可见」：不可见会报 UNKNOWN_TOOL（dsh-tools ToolNotFoundError）。
      // 实测形状（dsh 0.2.1-rc.2）：`error.info.code === 'UNKNOWN_TOOL'`，**不在 error.code 上**；
      // 权威拒绝则连 `info` 都没有。骨架写的 `error?.code` 会取到 undefined → 断言恒真 → 假绿。
      const childFailure = childCall.error as
        | { readonly message?: string; readonly info?: { readonly code?: string } }
        | undefined;
      expect(childFailure?.info?.code).not.toBe('UNKNOWN_TOOL');
      // 更硬的一条：权威拒绝**根本没有 info**，而 ToolNotFoundError 一定有。
      expect(childFailure?.info).toBeUndefined();

      // (c-anchor) 正向对照：用一个**确实不存在**的工具名，把 code 通路钉住。
      // 若 DSH 哪天改了 ToolNotFoundError 的形状，这里会响亮地红，而不是让 (c) 静默退化成恒真。
      const unknownCall = await fixture.ctx.tools.execute({
        name: 'luoome_tool_that_does_not_exist',
        callId: ToolCallId('reconciliation-unknown'),
        arguments: {},
        agent: child.agent,
        signal: new AbortController().signal,
      });
      expect(unknownCall.isError).toBe(true);
      const unknownFailure = unknownCall.error as
        | { readonly message?: string; readonly info?: { readonly code?: string } }
        | undefined;
      expect(unknownFailure?.info?.code).toBe('UNKNOWN_TOOL');
      expect(unknownFailure?.message).toContain('unknown tool');

      // (d) 权威层从未授权：没有任何 approval 发生。
      expect(fixture.approvals).toHaveLength(0);
    } finally {
      await fixture.close();
    }
  });

  // 将来若 DSH 提供 spawn 期的稳定 per-agent 收窄（切 A 路径），把上面 (b)(c) 翻成：
  //   expect(childCall.error?.code).toBe('UNKNOWN_TOOL');
  //   expect(childCall.error?.message).not.toContain('top-level authorized session');
  // 翻转条件（三条同时满足）：DSH 发 GA；提供 spawn 前收窄钩子；允许直接依赖 @deepseek-ai/dsh-scope。
});
