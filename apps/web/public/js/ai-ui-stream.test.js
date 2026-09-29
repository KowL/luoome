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
              '1"}\n\ndata: {"type":"text-delta","id":"t1","delta":"你好"}\n\ndata: {"type":"finish"}\n\ndata: [DONE]\n\n',
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
      { type: 'finish' },
    ]);
  });

  it('保留标准 finish metadata 和工具结果，即使 CRLF 及末行没有换行', async () => {
    const metadata = {
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      finishReason: 'stop',
    };
    const parts = [
      { type: 'tool-output-available', toolCallId: 'call-1', output: { __luoomeDraft: true } },
      { type: 'finish', messageMetadata: metadata },
    ];
    const response = new Response(
      parts.map((part) => `data: ${JSON.stringify(part)}`).join('\r\n\r\n'),
    );
    const received = [];
    await consumeUIMessageStream(response, (part) => received.push(part));
    expect(received).toEqual(parts);
  });

  it('截断流不视为正常完成，已收到的正文仍保留', async () => {
    const response = new Response(
      'data: {"type":"text-delta","delta":"部分回答"}\n\ndata: [DONE]\n',
    );
    const parts = [];
    await expect(consumeUIMessageStream(response, (part) => parts.push(part))).rejects.toThrow(
      '回复中途断开',
    );
    expect(parts).toEqual([{ type: 'text-delta', delta: '部分回答' }]);
    expect(response.body.locked).toBe(false);
  });

  it('处理器遇到流错误时取消读取，释放流锁', async () => {
    let cancelled = false;
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode('data: {"type":"error","errorText":"模型暂不可用"}\n'),
          );
        },
        cancel() {
          cancelled = true;
        },
      }),
    );
    await expect(
      consumeUIMessageStream(response, (part) => {
        throw new Error(part.errorText);
      }),
    ).rejects.toThrow('模型暂不可用');
    expect(cancelled).toBe(true);
    expect(response.body.locked).toBe(false);
  });

  it('非 2xx 响应透传 ToolResult 错误信息', async () => {
    const response = new Response(
      JSON.stringify({ ok: false, error: { kind: 'llm_error', cause: '模型未配置' } }),
      { status: 503, headers: { 'content-type': 'application/json' } },
    );
    await expect(consumeUIMessageStream(response, () => {})).rejects.toThrow('模型未配置');
  });
});
