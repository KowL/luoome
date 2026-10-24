import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ToolCallId } from '@deepseek-ai/dsh-llm';
import { SessionId } from '@deepseek-ai/dsh-session';
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval';
import { money, type PluginAutomationGrant } from '@luoome/core';
import { createDrizzleRepos } from '@luoome/db';
import { enqueueAnalysisJobTool, getDecisionReviewContextTool } from '@luoome/tools';
import { type Call, createDshTestHost } from '../testing/dsh-host.js';
import { MANUAL_OPERATION_TOOL, SCHEDULED_OPERATION_TOOL } from './dsh-authority.js';
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

describe('DSH approval and schedule integration with durable facts', () => {
  it('preflights persisted SQLite queue facts without a model request or claim', async () => {
    const fixture = await start(await rootDir());
    try {
      const context = () => fixture.domain;
      const signal = new AbortController().signal;
      expect(await runQueuePreflight({ context, signal })).toEqual({ state: 'empty', exitCode: 1 });
      const now = fixture.domain.clock();
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
        fixture.domain,
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
  it('confirms a real grant through the actual Agent loop and ApprovalService', async () => {
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
      ).toEqual(['allowed-once']);
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
      expect(fixture.approvals).toEqual(['allowed-once']);
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

  it('refuses rejected, unavailable, never-policy and overridden approval gates', async () => {
    for (const options of [
      {},
      { policy: 'never' as const },
      { withoutApproval: true },
      { bypassPre: true },
      { noAnswerer: true },
    ]) {
      const fixture = await start(await rootDir(), options);
      try {
        if (!options.withoutApproval && !options.noAnswerer)
          fixture.answer(options.policy === 'never' ? 'allowed-once' : 'rejected');
        const task = await fixture.ctx.schedule.create(fixture.handle.agent.id, {
          prompt: 'fixture',
          title: 'approval negative',
          after_seconds: 3600,
        });
        const grant = fixture.grant(task, {
          accountId: fixture.principal.accountId,
          label: 'denied',
        });
        const result = await fixture.run({
          name: MANUAL_OPERATION_TOOL,
          input: {
            id: randomUUID(),
            tool: 'configure_plugin_automation',
            input: { grant, expectedVersion: null },
          },
        });
        expect(result?.isError).toBe(true);
        expect(
          await fixture.db.repos.pluginAuthority.findGrant(grant.id, fixture.principal.userId),
        ).toBe(null);
      } finally {
        await fixture.close();
      }
    }
  });

  it('discards late approval after cancellation and binds approved parameters to the frozen operation', async () => {
    const fixture = await start(await rootDir());
    try {
      let reply: ((answer: ApprovalOutcome) => void) | undefined;
      fixture.ctx.on(
        'approval/request',
        () =>
          new Promise<ApprovalOutcome>((resolve) => {
            reply = resolve;
          }),
      );
      const [advice] = await fixture.domain.repos.advice.query({ includeExpired: true, limit: 1 });
      if (!advice) throw new Error('Missing advice fixture');
      const subject = { kind: 'advice', id: advice.id };
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
              note: 'original',
            },
          },
        },
      };
      const pending = fixture.run(call);
      await eventually(() => reply !== undefined);
      call.input.input.content.note = 'changed after prompt';
      fixture.handle.agent.cancel({ kind: 'user' });
      reply?.('allowed-once');
      await pending;
      expect(
        await fixture.domain.repos.decisionReview.findBySubject({
          accountId: fixture.principal.accountId,
          subject: { kind: 'advice', id: advice.id },
        }),
      ).toBe(null);
      const op = await fixture.db.repos.pluginAuthority.findOperation({ ...fixture.principal, id });
      expect(op?.inputJson).toContain('original');
      expect(op?.state).toBe('cancelled');
      expect(
        fixture.handle.agent.session
          .ownEvents()
          .filter((e) => e.type === 'approval/decided')
          .map((e) => e.data.outcome),
      ).toEqual(['cancelled']);
    } finally {
      await fixture.close();
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
});
