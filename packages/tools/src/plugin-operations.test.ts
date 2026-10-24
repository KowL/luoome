import { randomUUID } from 'node:crypto';
import type { PluginAutomationGrant, ToolResult } from '@luoome/core';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { decisionReviewOperation } from './decision-review-operation.js';
import { defineTool } from './define-tool.js';
import {
  type ConfirmablePluginTool,
  createPluginOperationService,
  pluginInputHash,
  pluginInputJson,
} from './plugin-operations.js';
import { buildTestContext } from './testing/context.js';
import { getDecisionReviewContextTool } from './tools/decision-review.js';

const data = (result: ToolResult<unknown>) => {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.data as {
    operationId: string;
    confirmationToken: string;
    state: string;
    result: unknown;
  };
};
const signal = () => new AbortController().signal;
const setup = async () => {
  const ctx = await buildTestContext();
  const principal = { userId: 'user', accountId: ctx.user.defaultAccountId };
  const handler = vi.fn((_input: unknown) => ({ done: true }));
  const tool = defineTool({
    name: 'fixture_batch',
    description: 'fixture',
    sideEffect: 'write',
    requiredCapabilities: ['write', 'external'],
    input: z.object({ accountId: z.string(), count: z.number().int().min(1).max(3) }).strict(),
    output: z.object({ done: z.boolean() }),
    handler,
  });
  const policy: ConfirmablePluginTool = {
    tool,
    scheduled: true,
    bind(raw, owner) {
      const input = tool.inputSchema.parse(raw);
      if (input.accountId !== owner.accountId) throw new Error('Wrong account');
      return input;
    },
    receipt: async () => null,
  };
  let now = 1000;
  const options = {
    validateGrant: async () => true,
    repository: ctx.repos.pluginAuthority,
    policies: [policy, decisionReviewOperation],
    capabilities: ['write', 'external'] as const,
    policyVersion: 1,
    now: () => now,
    context: () => ctx,
  };
  return {
    ctx,
    principal,
    handler,
    options,
    service: createPluginOperationService(options),
    advance: (ms: number) => {
      now += ms;
    },
  };
};

describe('persistent operation execution', () => {
  it('uses locale-independent key ordering while retaining array order in durable input hashes', () => {
    const left = { 中: 3, a: { Z: 2, A: 1 }, list: [2, 1] };
    const right = { list: [2, 1], a: { A: 1, Z: 2 }, 中: 3 };
    expect(pluginInputJson(left)).toBe('{"a":{"A":1,"Z":2},"list":[2,1],"中":3}');
    expect(pluginInputHash(left)).toBe(pluginInputHash(right));
    expect(pluginInputHash(left)).not.toBe(pluginInputHash({ ...left, list: [1, 2] }));
  });
  it('freezes inputs and confirms once across concurrent callers and service recreation', async () => {
    const { service, options, principal, handler } = await setup();
    const id = randomUUID();
    const input = { accountId: principal.accountId, count: 1 };
    const prepared = data(await service.prepare(principal, { id, tool: 'fixture_batch', input }));
    input.count = 3;
    expect(handler).not.toHaveBeenCalled();
    expect((await service.prepare(principal, { id, tool: 'fixture_batch', input })).ok).toBe(false);
    expect((await service.confirm(principal, { id, token: 'forged' }, signal())).ok).toBe(false);
    expect(
      (
        await service.confirm(
          { ...principal, accountId: 'other' },
          { id, token: prepared.confirmationToken },
          signal(),
        )
      ).ok,
    ).toBe(false);
    const second = createPluginOperationService(options);
    await Promise.all([
      service.confirm(principal, { id, token: prepared.confirmationToken }, signal()),
      second.confirm(principal, { id, token: prepared.confirmationToken }, signal()),
    ]);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0]?.[0]).toMatchObject({ count: 1 });
    expect(
      data(await second.confirm(principal, { id, token: prepared.confirmationToken }, signal()))
        .state,
    ).toBe('succeeded');
    expect(handler).toHaveBeenCalledTimes(1);
    const stored = JSON.stringify(await options.repository.findOperation({ ...principal, id }));
    expect(stored).not.toContain(prepared.confirmationToken);
    expect(JSON.stringify(await service.get(principal, id))).not.toContain('tokenHash');
  });
  it('denies stale, cancelled, disposed and missing-capability execution', async () => {
    const { service, principal, handler, advance, options } = await setup();
    const request = () => ({
      id: randomUUID(),
      tool: 'fixture_batch',
      input: { accountId: principal.accountId, count: 1 },
    });
    expect(
      (
        await createPluginOperationService({ ...options, capabilities: ['write'] }).prepare(
          principal,
          request(),
        )
      ).ok,
    ).toBe(false);
    const cancelled = data(await service.prepare(principal, request()));
    await service.cancel(principal, {
      id: cancelled.operationId,
      token: cancelled.confirmationToken,
    });
    expect(
      data(
        await service.confirm(
          principal,
          { id: cancelled.operationId, token: cancelled.confirmationToken },
          signal(),
        ),
      ).state,
    ).toBe('cancelled');
    const expired = data(await service.prepare(principal, request()));
    advance(600_000);
    expect(
      (
        await service.confirm(
          principal,
          { id: expired.operationId, token: expired.confirmationToken },
          signal(),
        )
      ).ok,
    ).toBe(false);
    const disposed = data(await service.prepare(principal, request()));
    service.dispose();
    expect(
      (
        await service.confirm(
          principal,
          { id: disposed.operationId, token: disposed.confirmationToken },
          signal(),
        )
      ).ok,
    ).toBe(false);
    expect(handler).not.toHaveBeenCalled();
  });
  it('recovers a real decision-review commit after the operation receipt write fails, without re-execution', async () => {
    const { service, principal, ctx, options } = await setup();
    const [advice] = await ctx.repos.advice.query({ includeExpired: true, limit: 1 });
    if (!advice) throw new Error('Missing advice fixture');
    const subject = { kind: 'advice', id: advice.id };
    const preview = await getDecisionReviewContextTool.execute({ subject }, ctx);
    if (!preview.ok || !preview.data.context) throw new Error('Missing review context');
    const prepared = data(
      await service.prepare(principal, {
        id: randomUUID(),
        tool: 'save_decision_review',
        input: {
          subject,
          contextHash: preview.data.context.contextHash,
          expectedRevision: 0,
          content: { tradeIds: [], adviceFeedback: null, triggerFeedback: null, note: 'review' },
        },
      }),
    );
    const settle = vi
      .spyOn(options.repository, 'settleOperation')
      .mockRejectedValueOnce(new Error('lost acknowledgement'));
    expect(
      (
        await service.confirm(
          principal,
          { id: prepared.operationId, token: prepared.confirmationToken },
          signal(),
        )
      ).ok,
    ).toBe(false);
    expect(data(await service.get(principal, prepared.operationId)).state).toBe('executing');
    const restarted = createPluginOperationService(options);
    expect(data(await restarted.reconcile(principal, prepared.operationId)).state).toBe(
      'succeeded',
    );
    const review = await ctx.repos.decisionReview.findBySubject({
      accountId: principal.accountId,
      subject: { kind: 'advice', id: advice.id },
    });
    expect(review?.review.currentRevision).toBe(1);
    settle.mockRestore();
  });
  it('keeps uncertain effects unknown and never automatically retries them', async () => {
    const { service, principal, handler } = await setup();
    handler.mockImplementation(() => {
      throw new Error('after possible side effect');
    });
    const prepared = data(
      await service.prepare(principal, {
        id: randomUUID(),
        tool: 'fixture_batch',
        input: { accountId: principal.accountId, count: 1 },
      }),
    );
    for (let i = 0; i < 2; i++)
      expect(
        data(
          await service.confirm(
            principal,
            { id: prepared.operationId, token: prepared.confirmationToken },
            signal(),
          ),
        ).state,
      ).toBe('unknown');
    expect(data(await service.reconcile(principal, prepared.operationId)).state).toBe('unknown');
    expect(handler).toHaveBeenCalledTimes(1);
  });
});

describe('confirmed automation authorization', () => {
  it('requires a confirmed, exact, current grant and deduplicates repeated occurrences', async () => {
    const { service, principal, handler } = await setup();
    const identity = {
      userId: principal.userId,
      profile: 'web',
      sessionId: 'session',
      taskId: 'task',
    };
    const input = { accountId: principal.accountId, count: 1 };
    const grant: PluginAutomationGrant = {
      id: 'grant',
      identity,
      scheduleHash: 'd'.repeat(64),
      version: 1,
      policyVersion: 1,
      enabled: true,
      allowedCalls: [
        {
          tool: 'fixture_batch',
          accountId: principal.accountId,
          inputHash: pluginInputHash(input),
          inputJson: pluginInputJson(input),
          capabilities: ['write', 'external'],
        },
      ],
      createdAt: 1000,
      updatedAt: 1000,
      expiresAt: 100_000,
    };
    const request = {
      grantId: 'grant',
      grantVersion: 1,
      occurrenceId: 'tick-1',
      tool: 'fixture_batch',
      accountId: principal.accountId,
      input,
    };
    const pending = data(
      await service.prepare(principal, {
        id: randomUUID(),
        tool: 'configure_plugin_automation',
        input: { grant, expectedVersion: null },
      }),
    );
    expect((await service.executeScheduled(identity, request, signal())).ok).toBe(false);
    expect(
      data(
        await service.confirm(
          principal,
          { id: pending.operationId, token: pending.confirmationToken },
          signal(),
        ),
      ).state,
    ).toBe('succeeded');
    expect(
      (await service.executeScheduled({ ...identity, sessionId: 'forged' }, request, signal())).ok,
    ).toBe(false);
    expect(
      (
        await service.executeScheduled(
          identity,
          { ...request, input: { ...input, count: 2 } },
          signal(),
        )
      ).ok,
    ).toBe(false);
    expect(
      (
        await service.executeScheduled(
          identity,
          { ...request, input: { ...input, force: true } },
          signal(),
        )
      ).ok,
    ).toBe(false);
    await Promise.all([
      service.executeScheduled(identity, request, signal()),
      service.executeScheduled(identity, request, signal()),
    ]);
    expect(handler).toHaveBeenCalledTimes(1);
    const revoke = data(
      await service.prepare(principal, {
        id: randomUUID(),
        tool: 'configure_plugin_automation',
        input: { grant: { ...grant, version: 2, enabled: false }, expectedVersion: 1 },
      }),
    );
    await service.confirm(
      principal,
      { id: revoke.operationId, token: revoke.confirmationToken },
      signal(),
    );
    expect(
      (await service.executeScheduled(identity, { ...request, occurrenceId: 'tick-2' }, signal()))
        .ok,
    ).toBe(false);
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
