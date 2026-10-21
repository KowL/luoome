import {
  attributionHeaders,
  type GenerateOptions,
  LlmAdapter,
  type StreamChunk,
  ToolCallId,
} from '@deepseek-ai/dsh-llm';
import { z } from 'zod';
import type { JsonObject, JsonValue } from './protocol.js';
import type { PluginConfig } from './runtime-config.js';

const ChunkSchema = z.object({
  choices: z.array(
    z.object({
      index: z.number().int(),
      delta: z.object({
        content: z.string().nullable().optional(),
        tool_calls: z
          .array(
            z.object({
              index: z.number().int().nonnegative().max(127),
              id: z.string().optional(),
              function: z
                .object({ name: z.string().optional(), arguments: z.string().optional() })
                .optional(),
            }),
          )
          .optional(),
      }),
      finish_reason: z.string().nullable().optional(),
    }),
  ),
  usage: z
    .object({
      prompt_tokens: z.number().int().nonnegative(),
      completion_tokens: z.number().int().nonnegative(),
      total_tokens: z.number().int().nonnegative().optional(),
      prompt_tokens_details: z
        .object({ cached_tokens: z.number().int().nonnegative().optional() })
        .optional(),
    })
    .nullable()
    .optional(),
});

export function projectMessages(options: GenerateOptions): JsonValue[] {
  const messages: JsonValue[] = [];
  if (options.system !== undefined) messages.push({ role: 'system', content: options.system });
  for (const message of options.messages) {
    let content = '';
    const toolCalls: JsonObject[] = [];
    for (const block of message.content) {
      if (block.type === 'text') content += block.text;
      else if (block.type === 'tool-call') {
        toolCalls.push({
          id: block.id,
          type: 'function',
          function: { name: block.name, arguments: block.arguments },
        });
      } else if (
        block.type !== 'reasoning' &&
        block.type !== 'tool-addition' &&
        block.type !== 'tool-removal'
      ) {
        throw new Error('This development model route supports text and tool calls only');
      }
    }
    if (message.role === 'tool') {
      messages.push({ role: 'tool', tool_call_id: message.toolCallId, content });
    } else {
      messages.push({
        role: message.role,
        content,
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      });
    }
  }
  return messages;
}

export class ModelProxyAdapter extends LlmAdapter {
  private calls = 0;
  constructor(
    private readonly config: PluginConfig,
    private readonly lifecycle: AbortSignal,
  ) {
    super();
  }

  override async resolveModel(provider: string, model: string) {
    if (provider !== 'luoome-metered' || model !== this.config.host.model.model) {
      throw new Error('Unapproved model route');
    }
    return {
      provider,
      id: model,
      name: model,
      contextWindow: this.config.host.model.contextWindow,
    };
  }

  override async *stream(options: GenerateOptions): AsyncGenerator<StreamChunk> {
    const { host, run } = this.config;
    if (Date.now() >= Date.parse(run.expiresAt)) throw new Error('Run authorization expired');
    if (options.model !== host.model.model || options.provider !== 'luoome-metered')
      throw new Error('Unapproved model route');
    if (++this.calls > host.limits.maxModelCalls) throw new Error('Run model-call limit exceeded');
    const signal = AbortSignal.any([
      this.lifecycle,
      ...(options.signal ? [options.signal] : []),
      AbortSignal.timeout(host.limits.runTimeoutMs),
    ]);
    const response = await fetch(host.model.endpoint, {
      method: 'POST',
      headers: {
        ...attributionHeaders(),
        authorization: `Bearer ${host.model.token}`,
        'content-type': 'application/json',
        'x-luoome-run-id': run.runId,
      },
      body: JSON.stringify({
        model: host.model.model,
        messages: projectMessages(options),
        stream: true,
        stream_options: { include_usage: true },
        max_tokens: Math.min(options.maxTokens ?? host.model.maxTokens, host.model.maxTokens),
        ...(options.tools?.length
          ? {
              tools: options.tools.map((tool) => ({
                type: 'function',
                function: {
                  name: tool.name,
                  description: tool.description,
                  parameters: tool.parameters,
                },
              })),
            }
          : {}),
      }),
      redirect: 'error',
      signal,
    });
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new Error(`Model proxy rejected request (${response.status})`);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let eventData: string[] = [];
    let eventSize = 0;
    let text = '';
    let textStarted = false;
    let finish: string | undefined;
    let doneMarker = false;
    const calls = new Map<number, { id: string; name: string; args: string }>();
    try {
      while (!doneMarker) {
        const next = await reader.read();
        if (next.done) break;
        buffer += decoder.decode(next.value, { stream: true });
        if (buffer.length > 2_000_000) throw new Error('Model SSE frame exceeds limit');
        let boundary = buffer.indexOf('\n');
        while (boundary >= 0) {
          const line = buffer.slice(0, boundary).replace(/\r$/, '');
          buffer = buffer.slice(boundary + 1);
          boundary = buffer.indexOf('\n');
          if (line.startsWith('data:')) {
            const value = line.slice(5);
            eventData.push(value.startsWith(' ') ? value.slice(1) : value);
            eventSize += line.length + 1;
            if (eventSize > 2_000_000) throw new Error('Model SSE frame exceeds limit');
            continue;
          }
          if (line !== '' || eventData.length === 0) continue;
          const data = eventData.join('\n');
          eventData = [];
          eventSize = 0;
          if (data === '[DONE]') {
            doneMarker = true;
            break;
          }
          const chunk = ChunkSchema.parse(JSON.parse(data));
          for (const choice of chunk.choices) {
            if (finish !== undefined)
              throw new Error('Model emitted choices after terminal finish');
            if (choice.index !== 0) throw new Error('Multiple model choices are unsupported');
            if (choice.delta.content) {
              if (!textStarted) {
                textStarted = true;
                yield { type: 'block-start', index: 0, blockType: 'text' };
              }
              text += choice.delta.content;
              if (text.length > 1_000_000) throw new Error('Model text exceeds limit');
              yield { type: 'text-delta', index: 0, text: choice.delta.content };
            }
            for (const delta of choice.delta.tool_calls ?? []) {
              let call = calls.get(delta.index);
              if (!call) {
                if (!delta.id || !delta.function?.name)
                  throw new Error('Tool delta lacks initial identity');
                call = { id: delta.id, name: delta.function.name, args: '' };
                calls.set(delta.index, call);
                yield { type: 'block-start', index: delta.index + 1, blockType: 'tool-call' };
              }
              if (delta.id && delta.id !== call.id)
                throw new Error('Tool delta changed call identity');
              if (delta.function?.name && delta.function.name !== call.name)
                throw new Error('Tool delta changed tool name');
              const part = delta.function?.arguments ?? '';
              call.args += part;
              if (call.args.length > 256000) throw new Error('Tool input exceeds limit');
              yield {
                type: 'tool-call-delta',
                index: delta.index + 1,
                id: ToolCallId(call.id),
                name: call.name,
                argumentsDelta: part,
              };
            }
            if (choice.finish_reason) finish = choice.finish_reason;
          }
          if (chunk.usage) {
            const cached = chunk.usage.prompt_tokens_details?.cached_tokens ?? 0;
            if (cached > chunk.usage.prompt_tokens) throw new Error('Inconsistent provider usage');
            yield {
              type: 'usage',
              usage: {
                inputTokens: chunk.usage.prompt_tokens - cached,
                outputTokens: chunk.usage.completion_tokens,
                cacheReadTokens: cached,
                ...(chunk.usage.total_tokens === undefined
                  ? {}
                  : { totalTokens: chunk.usage.total_tokens }),
              },
            };
          }
        }
      }
      if (!doneMarker || !finish) throw new Error('Model stream ended without terminal receipt');
      if (!['stop', 'tool_calls', 'length'].includes(finish))
        throw new Error('Unsupported provider finish reason');
      if ((finish === 'stop' && calls.size > 0) || (finish === 'tool_calls' && calls.size === 0))
        throw new Error('Provider tool calls and finish reason are inconsistent');
      if (textStarted) yield { type: 'block-end', index: 0, block: { type: 'text', text } };
      for (const [index, call] of calls) {
        yield {
          type: 'block-end',
          index: index + 1,
          block: {
            type: 'tool-call',
            id: ToolCallId(call.id),
            name: call.name,
            arguments: call.args,
          },
        };
      }
      yield {
        type: 'finish',
        reason: {
          kind:
            finish === 'tool_calls' ? 'tool-calls' : finish === 'length' ? 'max-tokens' : 'stop',
        },
      };
    } finally {
      await reader.cancel();
      reader.releaseLock();
    }
  }
}
