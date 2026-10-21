import { HostedLLMError, type ToolContext } from '@luoome/core';
import type { ChatStreamRuntime } from '../chat.js';

type StreamRequest = Parameters<ChatStreamRuntime['createUIMessageStreamResponse']>[0];
const STREAM_ERROR = 'AI 响应未完成，请读取会话核对后再继续。';
const encoder = new TextEncoder();

/** 保持账本操作存活至实际响应消费和保存完成；返回值只保存可序列化的完成标记。 */
export const createHostedChatStreamResponse = async (
  execution: NonNullable<ToolContext['llmExecution']>,
  base: ToolContext,
  request: StreamRequest,
): Promise<Response> => {
  const release = request.execution?.retainRuntime?.();
  let executionStopped = true;
  const abort = new AbortController();
  const signal = AbortSignal.any([
    abort.signal,
    ...(request.abortSignal === undefined ? [] : [request.abortSignal]),
  ]);
  let publish!: (response: Response) => void;
  let reject!: (error: unknown) => void;
  const ready = new Promise<Response>((resolve, fail) => {
    publish = resolve;
    reject = fail;
  });
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  let detached = false;
  let published = false;
  let streamFailed = false;
  const enqueue = (value: Uint8Array) => {
    if (detached || controller === undefined) return;
    if ((controller.desiredSize ?? 0) < -262_144) {
      detached = true;
      abort.abort();
      controller.error(new Error(STREAM_ERROR));
      return;
    }
    controller.enqueue(value);
  };
  void execution
    .run(
      'hosted_chat_stream',
      {
        ...(request.execution === undefined ? {} : { runId: request.execution.runId }),
        instructions: request.instructions,
        uiMessages: request.uiMessages,
      },
      base,
      async (ctx) => {
        const runtime = ctx.agent as unknown as ChatStreamRuntime;
        let finish!: (error?: unknown) => void;
        const saved = new Promise<unknown>((resolve) => {
          finish = resolve;
        });
        const response = await runtime.createUIMessageStreamResponse({
          ...request,
          abortSignal: signal,
          onFinish: async (message) => {
            executionStopped = message.executionStopped !== false;
            try {
              await request.onFinish?.(message);
              finish();
            } catch (error) {
              finish(error);
              throw error;
            }
          },
        });
        if (!response.ok || response.body === null) throw new HostedLLMError('provider_failed');
        const reader = response.body.getReader();
        const output = new ReadableStream<Uint8Array>(
          {
            start(value) {
              controller = value;
            },
            cancel() {
              detached = true;
              abort.abort();
            },
          },
          { highWaterMark: 65_536, size: (chunk) => chunk?.byteLength ?? 0 },
        );
        publish(new Response(output, { status: response.status, headers: response.headers }));
        published = true;
        const decoder = new TextDecoder();
        let pending = '';
        try {
          while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            pending += decoder.decode(chunk.value, { stream: true });
            const lines = pending.split('\n');
            pending = lines.pop() ?? '';
            if (pending.length > 262_144) throw new HostedLLMError('provider_failed');
            for (const line of lines) {
              if (!line.startsWith('data: ') || line === 'data: [DONE]') continue;
              const part = JSON.parse(line.slice(6)) as { type?: string };
              if (part.type === 'error') streamFailed = true;
            }
            enqueue(chunk.value);
          }
          let timer: ReturnType<typeof setTimeout> | undefined;
          const saveError = await Promise.race([
            saved,
            new Promise<Error>((resolve) => {
              timer = setTimeout(() => resolve(new Error(STREAM_ERROR)), 5_000);
            }),
          ]).finally(() => clearTimeout(timer));
          if (saveError !== undefined) throw new HostedLLMError('provider_failed');
          if (streamFailed) throw new HostedLLMError('provider_failed');
          return { streamed: true };
        } catch (error) {
          abort.abort();
          await reader.cancel().catch(() => {});
          throw error;
        } finally {
          reader.releaseLock();
        }
      },
    )
    .then(
      () => {
        if (!published) reject(new HostedLLMError('operation_closed'));
        else if (!detached) controller?.close();
      },
      (error: unknown) => {
        if (!published) reject(error);
        else if (!detached) {
          if (!streamFailed)
            enqueue(
              encoder.encode(
                `data: ${JSON.stringify({ type: 'error', errorText: STREAM_ERROR })}\n\n`,
              ),
            );
          controller?.close();
        }
      },
    )
    .finally(() => {
      if (executionStopped) release?.();
    });
  return ready;
};
