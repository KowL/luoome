import { describe, expect, it } from 'bun:test';
import type { RuntimeBinding, RuntimeEvent } from '@luoome/dsh-bridge/protocol';
import { DshChatProjection, type UIStreamPart } from './chat-projection.js';
import { DshEventAdapter } from './event-adapter.js';

const binding: RuntimeBinding = {
  runtimeInstanceId: 'node1',
  sessionId: 'session1',
  runId: 'run1',
  conversationId: 'conversation1',
  profileHash: `sha256:${'1'.repeat(64)}`,
  configHash: `sha256:${'2'.repeat(64)}`,
};
const event = (
  sequence: number,
  type: RuntimeEvent['type'],
  payload: RuntimeEvent['payload'],
): RuntimeEvent => ({
  protocolVersion: 1,
  runId: binding.runId,
  conversationId: binding.conversationId,
  agentId: binding.sessionId,
  source: 'plugin',
  sourceEventId: `e${sequence}`,
  sequence,
  timestamp: '2026-10-20T00:00:00Z',
  type,
  payload,
});
const textIdentity = { messageId: 'attempt1', attemptId: 'attempt1', turnId: 'session1:0' };
const setup = () => {
  const chunks: UIStreamPart[] = [];
  const projection = new DshChatProjection(
    'a1',
    (part) => chunks.push(part),
    new Set(['fetch_quote']),
  );
  return { chunks, adapter: new DshEventAdapter(binding, projection), projection };
};

describe('DSH event bridge adaptation (A plugin payloads)', () => {
  it('merges transient/durable text and ignores repeated source IDs', () => {
    const { chunks, adapter } = setup();
    const first = event(0, 'text.delta', { ...textIdentity, delta: '事实', index: 0 });
    adapter.accept(first);
    adapter.accept(first);
    adapter.accept(event(1, 'assistant.message', { ...textIdentity, text: '事实来源' }));
    adapter.accept({ ...event(0, 'run.terminal', { status: 'completed' }), source: 'host' });
    expect(
      chunks
        .filter((part) => part.type === 'text-delta')
        .map((part) => part.delta)
        .join(''),
    ).toBe('事实来源');
    expect(adapter.terminal).toBe('completed');
  });

  it('rejects foreign identities, changed repeated IDs and out of order events', () => {
    const { adapter } = setup();
    const first = event(2, 'diagnostic', { code: 'fixture' });
    adapter.accept(first);
    expect(() => adapter.accept({ ...first, payload: { code: 'changed' } })).toThrow('conflicting');
    expect(() => adapter.accept(event(1, 'diagnostic', {}))).toThrow('order');
    expect(() =>
      adapter.accept({ ...event(3, 'diagnostic', {}), conversationId: 'foreign' }),
    ).toThrow('binding');
  });

  it('does not publish SDK reasoning, diagnostics or failed tools as successful text', () => {
    const { adapter, chunks } = setup();
    adapter.accept(event(0, 'diagnostic', { reasoning: 'hidden-private-thoughts' }));
    adapter.accept(event(1, 'tool.call', { callId: 'read1', toolName: 'fetch_quote', input: {} }));
    adapter.accept(
      event(2, 'tool.result', {
        callId: 'read1',
        ok: false,
        output: { error: { kind: 'not_found' } },
      }),
    );
    adapter.accept(event(3, 'run.terminal', { status: 'failed' }));
    expect(adapter.terminal).toBe('failed');
    expect(JSON.stringify(chunks)).not.toContain('private');
    expect(chunks.at(-1)).toMatchObject({
      type: 'tool-output-available',
      output: { error: { kind: 'not_found' } },
    });
  });
});
