import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  buildSystemContent,
  normalizeOpenAISchema,
  recoverMalformedText,
  stripThinkAndFences,
  toNormalizedJsonSchema,
} from './provider-quirks.js';

describe('llm/provider-quirks', () => {
  it('递归把 additionalProperties 空 schema 归一化为 true', () => {
    expect(
      normalizeOpenAISchema({
        type: 'object',
        properties: {
          meta: { type: 'object', additionalProperties: {} },
        },
      }),
    ).toEqual({
      type: 'object',
      properties: {
        meta: { type: 'object', additionalProperties: true },
      },
    });
  });

  it('Zod record 转换与 toolRegistry 保持同一口径', () => {
    const schema = z.object({ meta: z.record(z.string(), z.unknown()) });
    const json = toNormalizedJsonSchema(schema);
    const properties = json.properties as Record<string, Record<string, unknown>>;
    expect(properties.meta?.additionalProperties).toBe(true);
  });

  it('剥离 think 与代码围栏后仍用原 Zod schema 校验', () => {
    const schema = z.object({ decision: z.literal('hold'), confidence: z.number() });
    const raw = '<think>internal</think>\n```json\n{"decision":"hold","confidence":65}\n```';
    expect(stripThinkAndFences(raw)).toBe('{"decision":"hold","confidence":65}');
    expect(recoverMalformedText(raw, schema)).toEqual({ decision: 'hold', confidence: 65 });
    expect(() =>
      recoverMalformedText('<think>x</think>{"decision":"buy","confidence":65}', schema),
    ).toThrow();
  });

  it('schema prompt 同时包含原 system 与归一化 schema', () => {
    const text = buildSystemContent('system', {
      type: 'object',
      additionalProperties: true,
    });
    expect(text).toContain('system');
    expect(text).toContain('JSON Schema:');
    expect(text).toContain('"additionalProperties":true');
  });
});
