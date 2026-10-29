import { randomUUID } from 'node:crypto';
import { Context } from '@deepseek-ai/cordis';
import { ToolCallId } from '@deepseek-ai/dsh-llm/brand';
import { type ToolExecution, ToolRuntime } from '@deepseek-ai/dsh-tools';
import {
  createPluginOperationService,
  decisionReviewOperation,
  getDecisionReviewContextTool,
} from '@luoome/tools';
import { buildTestContext } from '@luoome/tools/testing';
import { describe, expect, it, vi } from 'vitest';
import { createOperationHandler, createScheduledOperationInvoker } from './operations.js';

const post = (path: string, input: unknown, origin = 'https://dsh.example') =>
  new Request(`https://dsh.example/api/luoome/operations/${path}`, {
    method: 'POST',
    headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
const setup = async () => {
  const ctx = await buildTestContext();
  const principal = { userId: 'user', accountId: ctx.user.defaultAccountId };
  const context = vi.fn(() => ctx);
  const service = createPluginOperationService({
    repository: ctx.repos.pluginAuthority,
    policies: [decisionReviewOperation],
    capabilities: ['write'],
    policyVersion: 1,
    now: () => 1000,
    context,
  });
  return { ctx, principal, context, service };
};

describe('operation transport boundaries', () => {
  it('requires authenticated principal, same origin and strict confirmation fields', async () => {
    const { service, principal, context } = await setup();
    const handle = createOperationHandler(service, () => principal);
    const id = randomUUID();
    expect((await createOperationHandler(service, () => null)(post('prepare', {}))).status).toBe(
      403,
    );
    expect((await handle(post('prepare', {}, 'https://evil.example'))).status).toBe(403);
    for (const body of [
      { token: 'x', input: {} },
      { token: 'x', approved: true },
      { token: 'x', accountId: 'other' },
    ])
      expect((await handle(post(`${id}/confirm`, body))).status).toBe(400);
    expect((await handle(post('prepare', { id, tool: 'create_account', input: {} }))).status).toBe(
      403,
    );
    expect(context).not.toHaveBeenCalled();
  });
  it('executes HTTP prepare immediately and replays without another business write', async () => {
    const { service, principal, ctx } = await setup();
    const [advice] = await ctx.repos.advice.query({ includeExpired: true, limit: 1 });
    if (!advice) throw new Error('Missing advice fixture');
    const subject = { kind: 'advice' as const, id: advice.id };
    const preview = await getDecisionReviewContextTool.execute({ subject }, ctx);
    if (!preview.ok || !preview.data.context) throw new Error('Missing review context');
    const id = randomUUID();
    const handle = createOperationHandler(service, () => principal);
    const call = () =>
      handle(
        post('prepare', {
          id,
          tool: 'save_decision_review',
          input: {
            subject,
            contextHash: preview.data.context?.contextHash,
            expectedRevision: 0,
            content: { note: 'direct HTTP execution' },
          },
        }),
      );
    const first = await call();
    expect(first.status).toBe(200);
    const result = (await first.json()) as {
      ok: boolean;
      data: { state: string; input: { requestId: string }; confirmationToken?: string };
    };
    expect(result).toMatchObject({
      ok: true,
      data: { state: 'succeeded', input: { requestId: id } },
    });
    expect(result.data.confirmationToken).toBeUndefined();
    const replay = await call();
    expect(replay.status).toBe(200);
    expect(
      await ctx.repos.decisionReview.findBySubject({ accountId: principal.accountId, subject }),
    ).toMatchObject({ review: { currentRevision: 1 } });
  });
  it('keeps operation lookup account-scoped and never returns stored credential hashes', async () => {
    const { service, principal, ctx } = await setup();
    const id = randomUUID();
    await ctx.repos.pluginAuthority.insertOperation({
      id,
      ...principal,
      tool: 'save_decision_review',
      inputJson: '{}',
      inputHash: 'a'.repeat(64),
      policyVersion: 1,
      requiredCapabilities: ['write'],
      authorization: { kind: 'human', tokenHash: 'b'.repeat(64) },
      state: 'pending',
      claimToken: null,
      resultJson: null,
      createdAt: 1000,
      updatedAt: 1000,
      expiresAt: 2000,
    });
    const req = new Request(`https://dsh.example/api/luoome/operations/${id}`);
    const own = await createOperationHandler(service, () => principal)(req);
    expect(own.status).toBe(200);
    expect(own.headers.get('cache-control')).toBe('no-store');
    expect(await own.text()).not.toContain('tokenHash');
    expect(
      (
        await createOperationHandler(
          service,
          () => principal,
        )(new Request(`https://dsh.example/api/luoome/operations/${id.replaceAll('-', '%2D')}`))
      ).status,
    ).toBe(200);
    expect(
      (
        await createOperationHandler(
          service,
          () => principal,
        )(new Request('https://dsh.example/api/luoome/operations/bad%2Fid'))
      ).status,
    ).toBe(400);
    expect(
      (await createOperationHandler(service, () => ({ ...principal, accountId: 'other' }))(req))
        .status,
    ).toBe(403);
  });
  it('denies missing trusted schedule metadata and rejects caller-supplied task identity', async () => {
    const { service, context } = await setup();
    const resolve = vi.fn(async (_execution: ToolExecution) => null);
    const invoke = createScheduledOperationInvoker(service, resolve);
    const host = new Context();
    host.provide('systemPrompt', { tools: () => () => undefined });
    const tools = new ToolRuntime(host);
    const arguments_ = { grantId: 'g', grantVersion: 1, accountId: 'a', tool: 'batch', input: {} };
    const remove = tools.register({
      name: 'scheduled_fixture',
      description: 'fixture',
      parameters: { type: 'object' },
      output: { schema: {}, render: () => [] },
      execute: (args, execution) => invoke(execution, args),
    });
    const execute = (args: unknown) =>
      tools.execute({
        name: 'scheduled_fixture',
        callId: ToolCallId('schedule'),
        arguments: args,
        signal: new AbortController().signal,
      });
    expect((await execute(arguments_)).value).toMatchObject({
      ok: false,
      error: { kind: 'permission_denied' },
    });
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(
      (await execute({ ...arguments_, taskId: 'pretend', occurrenceId: 'pretend' })).value,
    ).toMatchObject({ ok: false, error: { kind: 'invalid_input' } });
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(context).not.toHaveBeenCalled();
    remove();
  });
});
