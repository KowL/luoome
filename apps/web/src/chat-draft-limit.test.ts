import { describe, expect, it } from 'bun:test';

import type { AgentCallableTool } from '@luoome/core';
import { createChatSessionTool } from '@luoome/tools';
import { buildTestContext } from '@luoome/tools/testing';

import { type ChatStreamRuntime, createChatStreamResponse } from './chat.js';

/**
 * P2-7 硬限：同一条用户消息最多 1 个 advice 草案（design §3.1）。
 *
 * 草案工具在对话里只返回待确认草案、不执行分析，因此这里直接调用 callable
 * 就能验证配额，不需要真实 LLM。目标响应时间 ≤3s（不含模型自身生成）不在
 * stub 测试范围内。
 */
describe('chat advice 草案硬限', () => {
  it('同一轮第二次 advice 草案被拒绝，且不触发 analyze_stock 执行', async () => {
    const ctx = await buildTestContext({ clock: () => new Date('2026-11-24T09:30:00Z') });
    const created = await createChatSessionTool.execute({}, ctx);
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    let advertised: readonly AgentCallableTool[] = [];
    let executions = 0;
    const runtime: ChatStreamRuntime = {
      createUIMessageStreamResponse: async (request) => {
        advertised = request.tools;
        const analyze = request.tools.find((tool) => tool.name === 'analyze_stock');
        if (analyze === undefined) throw new Error('missing analyze_stock callable');
        const first = await analyze.execute({ stockId: '002594.SZ' });
        executions += 1;
        const second = await analyze.execute({ stockId: '600519.SH' });
        executions += 1;
        await request.onFinish?.({
          id: 'assistant-1',
          cancelled: false,
          parts: [{ type: 'text', text: 'fixture' }],
        });
        return Response.json({ first, second });
      },
    };

    const response = await createChatStreamResponse(
      {
        sessionId: created.data.session.id,
        messages: [
          {
            id: 'user-1',
            role: 'user',
            parts: [{ type: 'text', text: '看看比亚迪这只股票的走势' }],
          },
        ],
      },
      ctx,
      runtime,
    );
    expect(response.status).toBe(200);
    expect(advertised.some((tool) => tool.name === 'analyze_stock')).toBe(true);
    // brief 读工具在基线；生成工具不进对话（agent:false），模型无法在聊天里批量生成。
    expect(advertised.map((tool) => tool.name)).toContain('get_stock_brief');
    expect(advertised.map((tool) => tool.name)).not.toContain('generate_stock_briefs');

    const payload = (await response.json()) as {
      first: { ok: boolean; output: { __luoomeDraft?: boolean } };
      second: { ok: boolean; output: { error?: { kind: string; required: string } } };
    };
    expect(payload.first.ok).toBe(true);
    expect(payload.first.output.__luoomeDraft).toBe(true);
    expect(payload.second.ok).toBe(false);
    expect(payload.second.output.error?.kind).toBe('permission_denied');
    expect(payload.second.output.error?.required).toContain('最多 1 个 advice 草案');
    // 两次调用只产生一个草案；analyze_stock 本身没有被执行（否则会抛 LLM 未配置）。
    expect(executions).toBe(2);
  });
});
