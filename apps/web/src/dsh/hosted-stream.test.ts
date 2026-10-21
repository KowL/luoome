import { describe, expect, it } from 'bun:test';
import { FakeMarketAdapter } from '@luoome/adapters/testing';
import type { ToolContext } from '@luoome/core';
import { createInMemoryRepos } from '@luoome/db';
import { AGENT_SCENARIOS, buildContext } from '@luoome/tools';
import type { ChatStreamRuntime } from '../chat.js';
import { createHostedChatStreamResponse } from './hosted-stream.js';

const encoder = new TextEncoder();
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((value) => {
    resolve = value;
  });
  return { promise, resolve };
};
const base = () =>
  buildContext({
    repos: createInMemoryRepos(),
    adapters: {
      market: new FakeMarketAdapter(),
      llm: {
        name: 'unused',
        generate: async () => {
          throw new Error('unused');
        },
      },
    },
  });

describe('hosted UI stream lifetime', () => {
  it('delivers actual first bytes before source completion and holds execution through persistence', async () => {
    const ctx = base();
    const tail = deferred<void>();
    const saving = deferred<void>();
    const startedSaving = deferred<void>();
    const settled = deferred<void>();
    const settleGate = deferred<void>();
    const retainedReleased = deferred<void>();
    let released = false;
    let active = false;
    const runtime: ChatStreamRuntime = {
      async createUIMessageStreamResponse(request) {
        return new Response(
          new ReadableStream({
            async start(controller) {
              controller.enqueue(
                encoder.encode('data: {"type":"text-delta","id":"t","delta":"首块"}\n\n'),
              );
              await tail.promise;
              await request.onFinish?.({
                id: 'a',
                parts: [{ type: 'text', text: '首块' }],
                cancelled: false,
              });
              controller.enqueue(encoder.encode('data: {"type":"finish"}\n\ndata: [DONE]\n\n'));
              controller.close();
            },
          }),
          {
            headers: { 'content-type': 'text/event-stream', 'x-vercel-ai-ui-message-stream': 'v1' },
          },
        );
      },
    };
    const execution: NonNullable<ToolContext['llmExecution']> = {
      async run(_name, input, context, work) {
        expect(input).toMatchObject({ runId: 'fixture-run' });
        active = true;
        try {
          const result = await work({
            ...context,
            agent: runtime as unknown as NonNullable<ToolContext['agent']>,
          });
          await settleGate.promise;
          return result;
        } finally {
          active = false;
          settled.resolve();
        }
      },
    };
    const response = await createHostedChatStreamResponse(execution, ctx, {
      instructions: '',
      uiMessages: [],
      tools: [],
      onFinish: async () => {
        startedSaving.resolve();
        await saving.promise;
      },
      execution: {
        context: ctx,
        runId: 'fixture-run',
        conversationId: 'fixture',
        scenario: AGENT_SCENARIOS.general,
        historyTruncated: false,
        retainRuntime: () => () => {
          released = true;
          retainedReleased.resolve();
        },
      },
    });
    const reader = response.body?.getReader();
    if (reader === undefined) throw new Error('missing response body');
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('首块');
    expect(active).toBe(true);
    tail.resolve();
    await startedSaving.promise;
    expect(active).toBe(true);
    saving.resolve();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('finish');
    expect(released).toBe(false);
    settleGate.resolve();
    while (!(await reader.read()).done) {}
    await settled.promise;
    await retainedReleased.promise;
    expect(released).toBe(true);
    expect(active).toBe(false);
    expect(response.headers.get('x-vercel-ai-ui-message-stream')).toBe('v1');
  });

  it('rejects a recovered operation without replaying a stored successful stream', async () => {
    const execution: NonNullable<ToolContext['llmExecution']> = {
      run: async <T>() => ({ streamed: true }) as T,
    };
    await expect(
      createHostedChatStreamResponse(execution, base(), {
        instructions: '',
        uiMessages: [],
        tools: [],
      }),
    ).rejects.toThrow();
  });

  it('sanitizes failures after headers without reporting a successful end', async () => {
    const execution: NonNullable<ToolContext['llmExecution']> = {
      async run(_name, _input, ctx, work) {
        const runtime: ChatStreamRuntime = {
          async createUIMessageStreamResponse(request) {
            await request.onFinish?.({
              id: 'a',
              parts: [{ type: 'text', text: 'partial' }],
              cancelled: false,
            });
            return new Response('data: {"type":"text-delta","id":"t","delta":"partial"}\n\n');
          },
        };
        await work({ ...ctx, agent: runtime as unknown as NonNullable<ToolContext['agent']> });
        throw new Error('private-provider-key-must-not-leak');
      },
    };
    const response = await createHostedChatStreamResponse(execution, base(), {
      instructions: '',
      uiMessages: [],
      tools: [],
    });
    const body = await response.text();
    expect(body).toContain('partial');
    expect(body).toContain('"type":"error"');
    expect(body).not.toContain('private-provider-key');
  });
});
