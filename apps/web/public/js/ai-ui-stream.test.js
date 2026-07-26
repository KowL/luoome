import { describe, expect, it } from 'bun:test';
import { consumeUIMessageStream } from './ai-ui-stream.js';

describe('AI SDK UI Message Stream 消费器', () => {
  it('可处理跨网络 chunk 拆分的 SSE part 和 [DONE]', async () => {
    const encoder = new TextEncoder();
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode('data: {"type":"text-start","id":"t'));
          controller.enqueue(
            encoder.encode(
              '1"}\n\ndata: {"type":"text-delta","id":"t1","delta":"你好"}\n\ndata: [DONE]\n\n',
            ),
          );
          controller.close();
        },
      }),
      { headers: { 'content-type': 'text/event-stream' } },
    );
    const parts = [];
    await consumeUIMessageStream(response, (part) => parts.push(part));
    expect(parts).toEqual([
      { type: 'text-start', id: 't1' },
      { type: 'text-delta', id: 't1', delta: '你好' },
    ]);
  });

  it('非 2xx 响应透传 ToolResult 错误信息', async () => {
    const response = new Response(
      JSON.stringify({ ok: false, error: { kind: 'llm_error', cause: '模型未配置' } }),
      { status: 503, headers: { 'content-type': 'application/json' } },
    );
    await expect(consumeUIMessageStream(response, () => {})).rejects.toThrow('模型未配置');
  });
});
