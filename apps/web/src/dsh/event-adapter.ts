import {
  canonicalJson,
  type JsonValue,
  type RuntimeBinding,
  RuntimeEventSchema,
  type TerminalStatus,
  TerminalStatusSchema,
} from '@luoome/dsh-bridge/protocol';
import { z } from 'zod';
import type { DshChatProjection } from './chat-projection.js';

const identity = z.object({
  messageId: z.string().min(1),
  attemptId: z.string().min(1),
  turnId: z.string().min(1),
});
const delta = identity.extend({ delta: z.string(), index: z.number().int().nonnegative() });
const durable = identity.extend({ text: z.string() });
const call = z.object({
  callId: z.string().min(1),
  toolName: z.string().min(1),
  input: z.unknown(),
});
const result = z.object({ callId: z.string().min(1), ok: z.boolean(), output: z.unknown() });

/** Reads A's actual bridge payloads; unknown diagnostics never become product content. */
export class DshEventAdapter {
  readonly #seen = new Map<string, string>();
  readonly #sequences = new Map<string, number>();
  #terminal: TerminalStatus | undefined;

  constructor(
    private readonly binding: RuntimeBinding,
    private readonly projection: DshChatProjection,
  ) {}

  get terminal(): TerminalStatus | undefined {
    return this.#terminal;
  }

  accept(raw: unknown): void {
    const event = RuntimeEventSchema.parse(raw);
    if (
      event.runId !== this.binding.runId ||
      event.conversationId !== this.binding.conversationId ||
      (event.source !== 'host' && event.agentId !== this.binding.sessionId) ||
      event.parentAgentId !== undefined
    )
      throw new Error('DSH event binding mismatch');
    const key = `${event.source}:${event.agentId}:${event.sourceEventId}`;
    const fingerprint = canonicalJson(event as unknown as JsonValue);
    const previous = this.#seen.get(key);
    if (previous !== undefined) {
      if (previous !== fingerprint) throw new Error('DSH conflicting repeated event');
      return;
    }
    if (this.#seen.size >= 10_000) throw new Error('DSH event count limit exceeded');
    const source = `${event.source}:${event.agentId}`;
    if (event.sequence <= (this.#sequences.get(source) ?? -1))
      throw new Error('DSH event order invalid');
    this.#seen.set(key, fingerprint);
    this.#sequences.set(source, event.sequence);
    if (this.#terminal !== undefined) throw new Error('DSH event after terminal');
    if (event.type === 'text.delta' || event.type === 'assistant.message') {
      const parsed =
        event.type === 'text.delta' ? delta.parse(event.payload) : durable.parse(event.payload);
      const textId = canonicalJson([
        event.agentId,
        parsed.turnId,
        parsed.attemptId,
        parsed.messageId,
      ]);
      if ('delta' in parsed) this.projection.textDelta(textId, parsed.delta);
      else this.projection.durableText(textId, parsed.text);
    } else if (event.type === 'tool.call') {
      const parsed = call.parse(event.payload);
      this.projection.toolCall(parsed.callId, parsed.toolName, parsed.input);
    } else if (event.type === 'tool.result' || event.type === 'native-tool.result') {
      const parsed = result.parse(event.payload);
      this.projection.toolResult(parsed.callId, parsed.ok, parsed.output);
    } else if (event.type === 'run.terminal') {
      this.#terminal = TerminalStatusSchema.parse(event.payload.status);
      this.projection.end();
    }
  }
}
