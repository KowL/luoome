import { describe, expect, it } from 'bun:test';

import { createChatSessionTool } from '@luoome/tools';
import { buildTestContext } from '@luoome/tools/testing';

import { type ChatStreamRuntime, createChatStreamResponse } from './chat.js';

const ask = async (text: string): Promise<string> => {
  const ctx = await buildTestContext({ clock: () => new Date('2026-11-24T09:30:00Z') });
  const created = await createChatSessionTool.execute({}, ctx);
  if (!created.ok) throw new Error('session fixture failed');
  let instructions = '';
  const runtime: ChatStreamRuntime = {
    createUIMessageStreamResponse: async (request) => {
      instructions = request.instructions;
      await request.onFinish?.({
        id: 'assistant-1',
        cancelled: false,
        parts: [{ type: 'text', text: 'fixture' }],
      });
      return Response.json({ ok: true });
    },
  };
  const response = await createChatStreamResponse(
    {
      sessionId: created.data.session.id,
      messages: [{ id: 'user-1', role: 'user', parts: [{ type: 'text', text }] }],
    },
    ctx,
    runtime,
  );
  expect(response.status).toBe(200);
  return instructions;
};

describe('chat 指令装配：通用问答不被投资流程约束', () => {
  it('通用问题只带共享规则，直接使用模型通用知识', async () => {
    const instructions = await ask('解释一下什么是复利效应');
    expect(instructions).toContain('直接用你自己的知识回答');
    expect(instructions).toContain('不得编造');
    expect(instructions).toContain('不得自动交易');
    expect(instructions).not.toContain('结论摘要');
    expect(instructions).not.toContain('五段输出');
    expect(instructions).not.toContain('本轮核验的讨论主体');
    expect(instructions).not.toContain('get_account_overview');
  });

  it('投资问题仍保留事实、写入确认、风险与建议边界', async () => {
    const instructions = await ask('看一下我持仓的风险');
    expect(instructions).toContain('结论摘要');
    expect(instructions).toContain('风险与未知项');
    expect(instructions).toContain('不构成投资建议');
    expect(instructions).toContain('写入工具只生成待用户确认的草案');
    expect(instructions).toContain('只生成待确认草案');
  });
});
