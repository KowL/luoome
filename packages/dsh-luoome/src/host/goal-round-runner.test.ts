import { randomUUID } from 'node:crypto';
import { Context } from '@deepseek-ai/cordis';
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local';
import LlmRuntime, {
  type GenerateOptions,
  LlmAdapter,
  type StreamChunk,
  type ToolCallId,
} from '@deepseek-ai/dsh-llm';
import { acceptedGoalRounds, type GoalRun, GoalRunSchema, money } from '@luoome/core';
import { createPluginOperationService, getGoalRunTool, toolRegistry } from '@luoome/tools';
import { buildTestContext } from '@luoome/tools/testing';
import { describe, expect, it, vi } from 'vitest';
import { createGoalOperationPolicies } from './goal-operations.js';
import { createDshGoalRoundRunner } from './goal-round-runner.js';
import { createDshJobRunner } from './job-runner.js';

const NOW = new Date('2026-11-02T04:00:00Z');
type Mode = 'complete' | 'revise' | 'invalid' | 'exhaust' | 'trade' | 'cancel' | 'revision-loop';
class GoalAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = [];
  entered!: () => void;
  readonly started = new Promise<void>((done) => {
    this.entered = done;
  });
  closed = false;
  constructor(readonly mode: Mode) {
    super();
  }
  async *stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(request);
    this.entered();
    const message = request.messages[0];
    if (!message || typeof message.content === 'string' || message.content[0]?.type !== 'text')
      throw new Error('fixture input missing');
    const input = JSON.parse(message.content[0].text);
    try {
      if (this.mode === 'cancel') {
        await new Promise<void>((resolve) =>
          request.signal?.addEventListener('abort', () => resolve(), { once: true }),
        );
        request.signal?.throwIfAborted();
      }
      if (this.mode === 'trade') {
        const trade = toolRegistry.get('add_trade');
        if (!trade) throw new Error('missing trade fixture');
        const payload = trade.inputSchema.parse({
          stockId: '600519.SH',
          side: 'buy',
          quantity: 100,
          price: 100,
          executedAt: NOW,
        });
        yield {
          type: 'tool-call-delta',
          index: 0,
          id: 'forbidden-trade' as ToolCallId,
          name: 'add_trade',
          argumentsDelta: JSON.stringify(payload),
        };
        return;
      }
      const output = {
        summary: `round ${input.round} research conclusion`,
        factIds: [input.factIds[0]],
        needsRevision: this.mode === 'revision-loop',
        status:
          this.mode === 'exhaust'
            ? 'continue'
            : input.round === 1 && this.mode === 'complete'
              ? 'continue'
              : 'completed',
        blockedCondition: null,
      };
      if (this.mode === 'invalid' || (this.mode === 'revise' && input.revision === 0))
        output.factIds = ['invented'];
      yield { type: 'text-delta', index: 0, text: JSON.stringify(output) };
      yield { type: 'usage', usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    } finally {
      this.closed = true;
    }
  }
}
const setup = async (mode: Mode) => {
  const host = new Context();
  const llm = host.plugin(LlmRuntime);
  const jobs = host.plugin(LocalJobRegistry, {});
  await Promise.all([llm.await(), jobs.await()]);
  const adapter = new GoalAdapter(mode);
  const unregister = host.llm.registerAdapter(['scripted'], adapter);
  const base = await buildTestContext({ clock: () => NOW, advices: [] });
  await base.repos.quote.save({
    stockId: '600519.SH',
    ts: NOW,
    observedAt: NOW,
    fetchedAt: NOW,
    timestampSource: 'upstream',
    open: money(100),
    high: money(101),
    low: money(99),
    close: money(100),
    volume: 1000,
    source: 'fixture',
  });
  const baselineTrades = await base.repos.trade.listByAccount(base.user.defaultAccountId);
  const ctx = {
    ...base,
    jobRunner: createDshJobRunner(host),
    goalRoundRunner: createDshGoalRoundRunner(host),
  };
  const principal = { userId: ctx.user.id, accountId: ctx.user.defaultAccountId };
  const service = createPluginOperationService({
    repository: ctx.repos.pluginAuthority,
    policies: createGoalOperationPolicies(),
    capabilities: ['read', 'write', 'external'],
    policyVersion: 1,
    now: () => NOW.getTime(),
    context: () => ctx,
  });
  const input = {
    confirmed: true,
    request: {
      goal: '核实量价研究条件',
      kind: 'advice_stock',
      subject: { kind: 'stock', id: '600519.SH' },
      provider: 'scripted',
      model: 'goal-model',
      maxRounds: 2,
      estimatedTokens: 100,
      estimatedDurationMs: 1000,
    },
  };
  const call = async (tool: string, data: unknown, id = randomUUID()) => {
    const prepared = await service.prepare(principal, { id, tool, input: data });
    if (!prepared.ok) throw new Error(JSON.stringify(prepared.error));
    const token = (prepared.data as { confirmationToken?: string }).confirmationToken;
    if (!token) throw new Error('missing confirmation token');
    return service.confirm(principal, { id, token }, new AbortController().signal);
  };
  const start = async (requestOverrides: Record<string, unknown> = {}) => {
    const result = await call('start_goal_run', {
      ...input,
      request: { ...input.request, ...requestOverrides },
    });
    if (!result.ok) throw new Error('operation failed');
    const outcome = result.data as {
      result: { ok: boolean; data: { goalId: string; hostJobId: string } };
    };
    if (!outcome.result.ok) throw new Error('start failed');
    return outcome.result.data;
  };
  const read = async (id: string): Promise<GoalRun> => {
    const result = await getGoalRunTool.execute({ goalId: id }, ctx);
    if (!result.ok) throw new Error('goal missing');
    return result.data;
  };
  return {
    host,
    adapter,
    ctx,
    baselineTrades,
    service,
    principal,
    input,
    call,
    start,
    read,
    wait: async (id: string, timeout: number) => {
      const job = host.jobs.list().find((item) => String(item.id) === id);
      if (!job) throw new Error('persisted goal host ID has no real job');
      return host.jobs.wait(job.id, timeout);
    },
    close: async () => {
      for (const job of host.jobs.list()) {
        host.jobs.kill(job.id);
        await host.jobs.wait(job.id, 2000);
      }
      unregister();
      await jobs.dispose();
      await llm.dispose();
    },
  };
};
describe('bounded goal execution through real host services', () => {
  it.each(['complete', 'revise', 'invalid', 'exhaust', 'revision-loop'] as const)(
    'runs only bounded, evidence-validated rounds (%s)',
    async (mode) => {
      const env = await setup(mode);
      try {
        const started = await env.start();
        const hostId = env.host.jobs.list()[0]?.id;
        if (!hostId) throw new Error('host job missing');
        await env.host.jobs.wait(hostId, 2000);
        const run = await env.read(started.goalId);
        expect(run.status).toBe(mode === 'complete' || mode === 'revise' ? 'completed' : 'blocked');
        expect(env.adapter.requests).toHaveLength(2);
        expect(run.attempts).toHaveLength(2);
        expect(run.attempts.every((attempt) => attempt.revision <= 1)).toBe(true);
        for (const round of acceptedGoalRounds(run)) {
          expect(round.output?.factIds.length).toBeGreaterThan(0);
          const context = await env.ctx.repos.analysis.findContext(run.accountId, round.contextId);
          expect(round.output?.factIds.every((id) => context?.factIds.includes(id))).toBe(true);
        }
        const payloads = env.adapter.requests.map((request) => {
          expect(request.tools).toEqual([]);
          const message = request.messages[0];
          if (
            !message ||
            typeof message.content === 'string' ||
            message.content[0]?.type !== 'text'
          )
            throw new Error('bad fixture message');
          return JSON.parse(message.content[0].text);
        });
        if (mode === 'revise' || mode === 'invalid' || mode === 'revision-loop') {
          expect(payloads.map((payload) => payload.revision)).toEqual([0, 1]);
          expect(payloads[0].contextId).toBe(payloads[1].contextId);
        }
        if (mode === 'exhaust') expect(run.blockedCondition).toContain('round_limit_reached');
        if (mode === 'invalid' || mode === 'revision-loop')
          expect(run.blockedCondition).toContain('revision_limit_reached');
        expect(await env.ctx.repos.trade.listByAccount(run.accountId)).toEqual(env.baselineTrades);
        expect(await env.ctx.repos.advice.query({ includeExpired: true })).toEqual([]);
      } finally {
        await env.close();
      }
    },
  );
  it('rejects a model tool-call chunk and leaves trade and Advice facts unchanged', async () => {
    const env = await setup('trade');
    try {
      const started = await env.start();
      const hostId = env.host.jobs.list()[0]?.id;
      if (!hostId) throw new Error('host job missing');
      expect((await env.host.jobs.wait(hostId, 2000)).status).toBe('failed');
      const run = await env.read(started.goalId);
      expect(run.status).toBe('failed');
      expect(env.adapter.requests).toHaveLength(1);
      expect(env.adapter.requests[0]?.tools).toEqual([]);
      expect(await env.ctx.repos.trade.listByAccount(run.accountId)).toEqual(env.baselineTrades);
      expect(await env.ctx.repos.advice.query({ includeExpired: true })).toEqual([]);
      const exposed = createGoalOperationPolicies().map((policy) => policy.tool);
      expect(
        exposed.every(
          (tool) => !tool.requiredCapabilities.includes('trade') && tool.name !== 'add_trade',
        ),
      ).toBe(true);
      expect(toolRegistry.get('start_goal_run')?.requiredCapabilities).toEqual([
        'write',
        'external',
      ]);
    } finally {
      await env.close();
    }
  });
  it('cancels actual provider work and persists a cancelled goal without a late conclusion', async () => {
    const env = await setup('cancel');
    try {
      const started = await env.start();
      await env.adapter.started;
      const result = await env.call('cancel_goal_run', { goalId: started.goalId });
      expect(result).toMatchObject({
        ok: true,
        data: { state: 'succeeded', result: { ok: true } },
      });
      const hostId = env.host.jobs.list()[0]?.id;
      if (!hostId) throw new Error('host job missing');
      expect((await env.host.jobs.wait(hostId, 2000)).status).toBe('killed');
      expect(env.adapter.closed).toBe(true);
      const run = await env.read(started.goalId);
      expect(run.status).toBe('cancelled');
      expect(run.attempts).toEqual([]);
    } finally {
      await env.close();
    }
  });
  it('blocks after a real usage report exceeds the budget, without a second request', async () => {
    const env = await setup('complete');
    try {
      const started = await env.start({ maxTokens: 4, estimatedTokens: 1 });
      await env.wait(started.hostJobId, 2000);
      const run = await env.read(started.goalId);
      expect(run.status).toBe('blocked');
      expect(run.blockedCondition).toContain('goal_token_budget_exceeded');
      expect(run.attempts[0]?.tokenUsed).toBe(5);
      expect(acceptedGoalRounds(run)).toEqual([]);
      expect(env.adapter.requests).toHaveLength(1);
    } finally {
      await env.close();
    }
  });
  it('aborts provider work at the duration cap and records a concrete blocked condition', async () => {
    const env = await setup('cancel');
    try {
      const started = await env.start({ maxDurationMs: 1000, estimatedDurationMs: 1000 });
      await env.wait(started.hostJobId, 3000);
      const run = await env.read(started.goalId);
      expect(run.status).toBe('blocked');
      expect(run.blockedCondition).toContain('goal_time_budget_exceeded');
      expect(env.adapter.closed).toBe(true);
      expect(run.attempts).toEqual([]);
    } finally {
      await env.close();
    }
  });
  it('blocks missing persisted subject facts before any model request', async () => {
    const env = await setup('complete');
    try {
      const started = await env.start({ subject: { kind: 'stock', id: '999999.SH' } });
      await env.wait(started.hostJobId, 2000);
      const run = await env.read(started.goalId);
      expect(run.status).toBe('blocked');
      expect(run.blockedCondition).toContain('999999.SH');
      expect(env.adapter.requests).toHaveLength(0);
    } finally {
      await env.close();
    }
  });
  it('cancels a persisted goal whose host job belonged to an earlier process', async () => {
    const env = await setup('complete');
    try {
      const accountId = env.ctx.user.defaultAccountId;
      await env.ctx.repos.goalRun.create(
        GoalRunSchema.parse({
          id: 'goal:orphan',
          accountId,
          requestId: 'orphan',
          requestHash: 'hash',
          request: env.input.request,
          status: 'pending',
          version: 0,
          hostJobId: null,
          attempts: [],
          blockedCondition: null,
          error: null,
          createdAt: NOW,
          updatedAt: NOW,
          finishedAt: null,
        }),
      );
      await env.ctx.repos.goalRun.apply({
        accountId,
        id: 'goal:orphan',
        expectedVersion: 0,
        command: { type: 'start', hostJobId: 'earlier-process-job' },
        now: NOW,
      });
      const result = await env.call('cancel_goal_run', { goalId: 'goal:orphan' });
      expect(result).toMatchObject({
        ok: true,
        data: { state: 'succeeded', result: { ok: true } },
      });
      expect((await env.read('goal:orphan')).status).toBe('cancelled');
      expect(env.host.jobs.list()).toEqual([]);
      expect(env.adapter.requests).toHaveLength(0);
    } finally {
      await env.close();
    }
  });
  it('recovers a lost operation receipt without repeating model requests', async () => {
    const env = await setup('complete');
    const id = randomUUID();
    const settle = vi
      .spyOn(env.ctx.repos.pluginAuthority, 'settleOperation')
      .mockResolvedValueOnce(false);
    try {
      await env.call('start_goal_run', env.input, id);
      settle.mockRestore();
      const hostId = env.host.jobs.list()[0]?.id;
      if (!hostId) throw new Error('host job missing');
      await env.host.jobs.wait(hostId, 2000);
      const requests = env.adapter.requests.length;
      expect(requests).toBe(2);
      expect(await env.service.reconcile(env.principal, id)).toMatchObject({
        ok: true,
        data: { state: 'succeeded', result: { ok: true, data: { goalId: `goal:${id}` } } },
      });
      await env.service.reconcile(env.principal, id);
      expect(env.adapter.requests).toHaveLength(requests);
      expect((await env.read(`goal:${id}`)).status).toBe('completed');
    } finally {
      settle.mockRestore();
      await env.close();
    }
  });
  it('binds accounts and request identity and denies execution without external capability', async () => {
    const env = await setup('complete');
    try {
      expect(
        (
          await env.service.prepare(env.principal, {
            id: randomUUID(),
            tool: 'start_goal_run',
            input: { ...env.input, accountId: 'other-account' },
          })
        ).ok,
      ).toBe(false);
      expect(
        (
          await env.service.prepare(env.principal, {
            id: randomUUID(),
            tool: 'start_goal_run',
            input: { ...env.input, requestId: 'forged' },
          })
        ).ok,
      ).toBe(false);
      const service = createPluginOperationService({
        repository: env.ctx.repos.pluginAuthority,
        policies: createGoalOperationPolicies(),
        capabilities: ['read', 'write'],
        policyVersion: 1,
        now: () => NOW.getTime(),
        context: () => env.ctx,
      });
      expect(
        (
          await service.prepare(env.principal, {
            id: randomUUID(),
            tool: 'start_goal_run',
            input: env.input,
          })
        ).ok,
      ).toBe(false);
      expect(env.adapter.requests).toHaveLength(0);
    } finally {
      await env.close();
    }
  });
});
