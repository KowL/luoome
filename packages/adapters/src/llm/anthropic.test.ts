import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { AnthropicAdapter, AnthropicAdapterError } from './anthropic.js';

const TestSchema = z.object({
  decision: z.enum(['buy', 'sell', 'hold']),
  confidence: z.number().min(0).max(100),
});

const makeCfg = () => ({
  provider: 'anthropic' as const,
  apiKey: 'sk-ant-test',
  baseUrl: 'https://api.anthropic.com',
  model: 'claude-haiku-4-5',
});

describe('llm/anthropic', () => {
  describe('构造校验', () => {
    it('缺 apiKey 时构造抛错', () => {
      expect(
        () =>
          new AnthropicAdapter({
            provider: 'anthropic',
            model: 'm',
          } as never),
      ).toThrow(AnthropicAdapterError);
    });

    it('provider 错配时构造抛错', () => {
      expect(
        () =>
          new AnthropicAdapter({
            provider: 'openai-compatible',
            apiKey: 'sk',
            model: 'm',
          } as never),
      ).toThrow(AnthropicAdapterError);
    });
  });

  describe('generate', () => {
    it('解析 tool_use 块；raw 含 content', async () => {
      let capturedHeaders: Record<string, string> = {};
      let capturedBody: unknown;
      const adapter = new AnthropicAdapter(makeCfg(), {
        fetchImpl: ((_url: string, init: { headers?: Record<string, string>; body?: string }) => {
          capturedHeaders = init.headers ?? {};
          capturedBody = JSON.parse(init.body ?? '{}');
          return Promise.resolve(
            new Response(
              JSON.stringify({
                content: [
                  { type: 'text', text: 'thinking...' },
                  {
                    type: 'tool_use',
                    name: 'emit_advice',
                    input: { decision: 'buy', confidence: 80 },
                  },
                ],
                stop_reason: 'tool_use',
              }),
              { status: 200 },
            ),
          );
        }) as never,
      });
      const out = await adapter.generate<{ decision: string; confidence: number }>({
        system: 'you are an advisor',
        schema: TestSchema,
        data: { stockId: 'X' },
      });
      expect(out.decision).toBe('buy');
      expect(out.confidence).toBe(80);
      expect(out.raw).toContain('"tool_use"');

      // 验证 Anthropic 头 + body
      expect(capturedHeaders['x-api-key']).toBe('sk-ant-test');
      expect(capturedHeaders['anthropic-version']).toBe('2023-06-01');
      const body = capturedBody as {
        model: string;
        tools: { name: string; input_schema: unknown }[];
        tool_choice: { type: string; name: string };
        max_tokens: number;
      };
      expect(body.model).toBe('claude-haiku-4-5');
      expect(body.tools[0]?.name).toBe('emit_advice');
      expect(body.tool_choice).toEqual({ type: 'tool', name: 'emit_advice' });
      expect(body.max_tokens).toBeGreaterThan(0);
    });

    it('响应无 tool_use 块时抛错', async () => {
      const adapter = new AnthropicAdapter(makeCfg(), {
        fetchImpl: (async () =>
          new Response(
            JSON.stringify({
              content: [{ type: 'text', text: 'refused' }],
              stop_reason: 'end_turn',
            }),
            { status: 200 },
          )) as never,
      });
      await expect(
        adapter.generate({ system: 's', schema: TestSchema, data: {} }),
      ).rejects.toBeInstanceOf(AnthropicAdapterError);
    });

    it('tool_use input 不符合 schema 时抛错', async () => {
      const adapter = new AnthropicAdapter(makeCfg(), {
        fetchImpl: (async () =>
          new Response(
            JSON.stringify({
              content: [{ type: 'tool_use', name: 'emit_advice', input: { decision: 'INVALID' } }],
            }),
            { status: 200 },
          )) as never,
      });
      await expect(
        adapter.generate({ system: 's', schema: TestSchema, data: {} }),
      ).rejects.toBeInstanceOf(AnthropicAdapterError);
    });
  });
});
