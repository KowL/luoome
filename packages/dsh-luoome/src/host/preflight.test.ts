import { Context } from '@deepseek-ai/cordis';
import { AgentRegistry } from '@deepseek-ai/dsh-agent';
import { AgentLoop } from '@deepseek-ai/dsh-agent-loop';
import { createUserMessage, LlmRuntime } from '@deepseek-ai/dsh-llm';
import { SessionId, SessionStore } from '@deepseek-ai/dsh-session';
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection';
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt';
import { ToolRuntime } from '@deepseek-ai/dsh-tools';
import { money } from '@luoome/core';
import { claimAnalysisJobsTool, enqueueAnalysisJobTool } from '@luoome/tools';
import { buildTestContext } from '@luoome/tools/testing';
import { describe, expect, it, vi } from 'vitest';
import { installQueueProbe, installWorkerPreflight, runQueuePreflight } from './preflight.js';

describe('in-process queue preflight', () => {
  it('distinguishes empty, not-yet-due, ready and expired leases without claiming', async () => {
    let now = new Date('2026-10-24T04:00:00Z');
    const domain = await buildTestContext({ clock: () => now });
    await domain.repos.quote.save({
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
      source: 'acceptance',
    });
    const probe = () =>
      runQueuePreflight({ context: () => domain, signal: new AbortController().signal });
    expect(await probe()).toEqual({ state: 'empty', exitCode: 1 });
    const queued = await enqueueAnalysisJobTool.execute(
      {
        kind: 'advice_stock',
        subject: { kind: 'stock', id: '600519.SH' },
        source: 'schedule',
        notBefore: new Date(now.getTime() + 60_000),
      },
      domain,
    );
    expect(queued.ok).toBe(true);
    expect(await probe()).toEqual({ state: 'empty', exitCode: 1 });
    now = new Date(now.getTime() + 61_000);
    expect(await probe()).toEqual({ state: 'ready', exitCode: 0 });
    const claims = await claimAnalysisJobsTool.execute(
      { owner: 'preflight-test', leaseSeconds: 60 },
      domain,
    );
    expect(claims.ok).toBe(true);
    expect(await probe()).toEqual({ state: 'empty', exitCode: 1 });
    now = new Date(now.getTime() + 61_000);
    const before = await domain.repos.analysis.listJobs({
      accountId: domain.user.defaultAccountId,
    });
    expect(await probe()).toEqual({ state: 'ready', exitCode: 0 });
    expect(
      await domain.repos.analysis.listJobs({ accountId: domain.user.defaultAccountId }),
    ).toEqual(before);
  });

  it('fails closed on error, timeout or cancellation', async () => {
    const signal = new AbortController().signal;
    expect(
      await runQueuePreflight({
        context: () => {
          throw new Error('private path');
        },
        signal,
      }),
    ).toEqual({ state: 'error', exitCode: 2 });
    expect(
      await runQueuePreflight({ context: () => new Promise(() => {}), signal, timeoutMs: 5 }),
    ).toEqual({ state: 'error', exitCode: 2 });
    expect(
      await runQueuePreflight({
        context: () => new Promise(() => {}),
        signal: AbortSignal.abort(),
      }),
    ).toEqual({ state: 'error', exitCode: 2 });
  });

  it.each(['empty', 'error'] as const)(
    'blocks %s at the real Agent pre-step before any model resolution',
    async (state) => {
      const ctx = new Context();
      const fibers = [];
      for (const plugin of [
        AgentRegistry,
        SessionStore,
        SessionProjectionRegistry,
        SystemPrompt,
        ToolRuntime,
        LlmRuntime,
        AgentLoop,
      ]) {
        const fiber = ctx.plugin(
          plugin,
          plugin === AgentLoop
            ? { agents: [] }
            : plugin === SystemPrompt
              ? { includeHarnessIdentity: false, includeRuntimeContext: false }
              : {},
        );
        fibers.push(fiber);
        await fiber.await();
      }
      const resolve = vi.spyOn(ctx.llm, 'prepareCall');
      const domain = await buildTestContext();
      const report = vi.fn();
      installWorkerPreflight(ctx, {
        context: () => {
          if (state === 'error') throw new Error('Unavailable');
          return domain;
        },
        ownsAgent: () => true,
        report,
      });
      // No adapter or credential exists. A bypass would fail model preparation.
      const handle = await ctx.agents.create({
        sessionId: SessionId(`preflight-${state}`),
        agentOptions: { provider: 'absent', model: 'absent' },
      });
      try {
        handle.agent.followup(
          createUserMessage({
            source: { kind: 'user' },
            content: [{ type: 'text', text: 'consume queue' }],
          }),
        );
        await handle.agent.whenIdle();
        expect(report).toHaveBeenCalledWith({ state, exitCode: state === 'empty' ? 1 : 2 });
        expect(resolve).not.toHaveBeenCalled();
      } finally {
        await handle.dispose();
        for (const fiber of fibers.reverse()) await fiber.dispose();
        await ctx.fiber.dispose();
      }
    },
  );

  it('uses appReady/appExit for probe mode and removes pending startup work on dispose', async () => {
    const ctx = new Context();
    const domain = await buildTestContext();
    let ready = () => {};
    const exit = vi.fn();
    const report = vi.fn();
    ctx.provide('appExit', exit);
    ctx.provide('appReady', {
      onReady: (callback) => {
        ready = callback;
        return () => {
          ready = () => {};
        };
      },
    });
    installQueueProbe(ctx, { context: () => domain, report });
    expect(exit).not.toHaveBeenCalled();
    ready();
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
    expect(report).toHaveBeenCalledWith({ state: 'empty', exitCode: 1 });
    await ctx.fiber.dispose();
  });
});
