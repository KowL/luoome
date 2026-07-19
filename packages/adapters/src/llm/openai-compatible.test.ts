import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { OpenAICompatibleAdapter, OpenAICompatibleAdapterError } from './openai-compatible.js';

const TestSchema = z.object({
  decision: z.enum(['buy', 'sell', 'hold']),
  confidence: z.number().min(0).max(100),
});

const makeCfg = () => ({
  provider: 'openai-compatible' as const,
  apiKey: 'sk-test',
  baseUrl: 'https://api.example.com/v1',
  model: 'test-model',
});

describe('llm/openai-compatible', () => {
  describe('构造校验', () => {
    it('缺 apiKey 时构造抛错', () => {
      expect(
        () =>
          new OpenAICompatibleAdapter({
            provider: 'openai-compatible',
            model: 'm',
          } as never),
      ).toThrow(OpenAICompatibleAdapterError);
    });

    it('provider 错配时构造抛错', () => {
      expect(
        () =>
          new OpenAICompatibleAdapter({
            provider: 'anthropic',
            apiKey: 'sk',
            model: 'm',
          } as never),
      ).toThrow(OpenAICompatibleAdapterError);
    });
  });

  describe('generate', () => {
    it('解析 chat completions 响应；返回含 raw', async () => {
      let capturedBody: unknown;
      const adapter = new OpenAICompatibleAdapter(makeCfg(), {
        fetchImpl: ((_url: string, init: { body?: string }) => {
          capturedBody = JSON.parse(init.body ?? '{}');
          return Promise.resolve(
            new Response(
              JSON.stringify({
                choices: [
                  {
                    message: { role: 'assistant', content: '{"decision":"hold","confidence":65}' },
                  },
                ],
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
      expect(out.decision).toBe('hold');
      expect(out.confidence).toBe(65);
      expect(out.raw).toContain('"decision":"hold"');

      // 验证 body 包含 response_format.json_schema
      const body = capturedBody as {
        model: string;
        messages: { role: string; content: string }[];
        response_format: { type: string; json_schema: { name: string; strict: boolean } };
      };
      expect(body.model).toBe('test-model');
      expect(body.messages).toHaveLength(2);
      expect(body.messages[0]?.role).toBe('system');
      expect(body.messages[1]?.role).toBe('user');
      expect(body.response_format.type).toBe('json_schema');
      expect(body.response_format.json_schema.strict).toBe(true);
    });

    it('响应缺 content 时抛错', async () => {
      const adapter = new OpenAICompatibleAdapter(makeCfg(), {
        fetchImpl: (async () =>
          new Response(JSON.stringify({ choices: [{ message: {} }] }), { status: 200 })) as never,
      });
      await expect(
        adapter.generate({
          system: 's',
          schema: TestSchema,
          data: {},
        }),
      ).rejects.toBeInstanceOf(OpenAICompatibleAdapterError);
    });

    it('响应 JSON 不符合 schema 时抛错（由 Manager 触发 fallback）', async () => {
      const adapter = new OpenAICompatibleAdapter(makeCfg(), {
        fetchImpl: (async () =>
          new Response(
            JSON.stringify({
              choices: [{ message: { content: '{"decision":"INVALID","confidence":50}' } }],
            }),
            { status: 200 },
          )) as never,
      });
      await expect(
        adapter.generate({
          system: 's',
          schema: TestSchema,
          data: {},
        }),
      ).rejects.toBeInstanceOf(OpenAICompatibleAdapterError);
    });

    it('HTTP 500 抛错并带 statusCode', async () => {
      const adapter = new OpenAICompatibleAdapter(makeCfg(), {
        fetchImpl: (async () =>
          new Response('oops', { status: 500, statusText: 'Server Error' })) as never,
      });
      try {
        await adapter.generate({ system: 's', schema: TestSchema, data: {} });
        expect.unreachable('should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(OpenAICompatibleAdapterError);
        expect((e as OpenAICompatibleAdapterError).statusCode).toBe(500);
      }
    });

    it('缺 schema 时抛错（protocol-level 校验）', async () => {
      const adapter = new OpenAICompatibleAdapter(makeCfg());
      await expect(adapter.generate({ system: 's', data: {} })).rejects.toBeInstanceOf(
        OpenAICompatibleAdapterError,
      );
    });
  });
});
