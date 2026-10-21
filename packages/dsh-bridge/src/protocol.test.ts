import { describe, expect, it } from 'vitest';
import {
  canonicalJson,
  HostCommandSchema,
  JsonValueSchema,
  RunRequestSchema,
  RuntimeEventSchema,
  ToolCallSchema,
  ToolManifestSchema,
  ToolReplySchema,
} from './protocol.js';

const hash = `sha256:${'a'.repeat(64)}`;
const tool = {
  name: 'fetch_quote',
  description: 'Read a quote',
  inputSchema: { type: 'object', properties: { stockId: { type: 'string' } } },
  callMode: 'execute',
  domain: 'market',
  sourcePlugin: 'luoome-business',
  executionLocation: 'bun-gateway',
  sideEffect: 'read',
  requiredCapabilities: [],
  costPolicy: 'business-ledger',
};
const manifest = { protocolVersion: 1, manifestHash: hash, tools: [tool] };

describe('DSH wire protocol', () => {
  it('preserves callable failures, drafts, nested values and date strings losslessly', () => {
    for (const output of [
      { error: { kind: 'adapter_error', message: 'Unavailable' } },
      { __luoomeDraft: true, draft: { id: 'draft-1', input: { amount: 1.0001 } } },
      { nested: [null, false, '2026-10-20T08:00:00Z', { values: [1, 2] }] },
    ]) {
      const reply = { protocolVersion: 1, runId: 'r1', callId: 'c1', ok: false, output };
      expect(ToolReplySchema.parse(JSON.parse(JSON.stringify(reply)))).toEqual(reply);
    }
  });

  it('rejects protocol/identity injection and mismatched manifest binding', () => {
    const call = {
      protocolVersion: 1,
      runId: 'r1',
      callId: 'c1',
      toolName: 'fetch_quote',
      input: { stockId: '000001.SZ' },
      manifestHash: hash,
    };
    expect(ToolCallSchema.parse(call)).toEqual(call);
    expect(ToolCallSchema.safeParse({ ...call, accountId: 'other' }).success).toBe(false);
    expect(ToolCallSchema.safeParse({ ...call, protocolVersion: 2 }).success).toBe(false);
    const run = {
      protocolVersion: 1,
      runId: 'r1',
      conversationId: 'chat1',
      manifestHash: hash,
      manifest,
      configRef: 'local-test-v1',
      instructions: 'Research only',
      prompt: 'quote?',
      expiresAt: '2026-10-20T09:00:00Z',
    };
    expect(RunRequestSchema.parse(run)).toEqual(run);
    expect(
      RunRequestSchema.safeParse({ ...run, manifestHash: `sha256:${'b'.repeat(64)}` }).success,
    ).toBe(false);
    expect(HostCommandSchema.safeParse({ type: 'run', request: run }).success).toBe(true);
  });

  it('rejects duplicate tools and trade manifests', () => {
    expect(ToolManifestSchema.safeParse(manifest).success).toBe(true);
    expect(ToolManifestSchema.safeParse({ ...manifest, tools: [tool, tool] }).success).toBe(false);
    expect(
      ToolManifestSchema.safeParse({ ...manifest, tools: [{ ...tool, sideEffect: 'trade' }] })
        .success,
    ).toBe(false);
  });

  it('rejects non-JSON data and retains zero, null and enum values', () => {
    for (const value of [undefined, NaN, Infinity, new Date(), 1n, () => 0]) {
      expect(JsonValueSchema.safeParse(value).success).toBe(false);
    }
    expect(canonicalJson({ z: null, b: [0, false], a: { y: 1, x: 'read' } })).toBe(
      '{"a":{"x":"read","y":1},"b":[0,false],"z":null}',
    );
  });

  it('validates event source identity without treating source sequence as a global clock', () => {
    const event = {
      protocolVersion: 1,
      runId: 'r1',
      conversationId: 'chat1',
      agentId: 'session1',
      source: 'plugin',
      sourceEventId: 'stream1:0',
      sequence: 0,
      timestamp: '2026-10-20T08:00:00Z',
      type: 'text.delta',
      payload: { messageId: 'm1', turnId: 't1', attemptId: 'a1', delta: 'hello' },
    };
    expect(RuntimeEventSchema.parse(event)).toEqual(event);
    expect(RuntimeEventSchema.safeParse({ ...event, sequence: -1 }).success).toBe(false);
  });
});
