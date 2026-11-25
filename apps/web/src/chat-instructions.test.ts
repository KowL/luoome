import { describe, expect, it } from 'bun:test';

import type { AgentCallableTool } from '@luoome/core';
import { createChatSessionTool } from '@luoome/tools';
import { buildTestContext } from '@luoome/tools/testing';

import { type ChatStreamRuntime, createChatStreamResponse } from './chat.js';

interface Turn {
  readonly instructions: string;
  readonly tools: readonly AgentCallableTool[];
  readonly route: string;
}

const ask = async (text: string): Promise<Turn> => {
  const ctx = await buildTestContext({ clock: () => new Date('2026-11-24T09:30:00Z') });
  const created = await createChatSessionTool.execute({}, ctx);
  if (!created.ok) throw new Error('session fixture failed');
  let instructions = '';
  let tools: readonly AgentCallableTool[] = [];
  const runtime: ChatStreamRuntime = {
    createUIMessageStreamResponse: async (request) => {
      instructions = request.instructions;
      tools = request.tools;
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
  return {
    instructions,
    tools,
    route: decodeURIComponent(response.headers.get('x-luoome-chat-route') ?? '{}'),
  };
};

const toolNames = (turn: Turn): string[] => turn.tools.map((tool) => tool.name);

describe('chat 指令装配：通用问答不被投资流程约束', () => {
  it('通用问题只带共享规则，直接使用模型通用知识', async () => {
    const turn = await ask('解释一下什么是复利效应');
    expect(turn.instructions).toContain('直接用你自己的知识回答');
    expect(turn.instructions).toContain('不得编造');
    expect(turn.instructions).toContain('不得自动交易');
    expect(turn.instructions).not.toContain('结论摘要');
    expect(turn.instructions).not.toContain('五段输出');
    expect(turn.instructions).not.toContain('本轮核验的讨论主体');
    expect(turn.instructions).not.toContain('get_account_overview');
  });

  it('投资问题仍保留事实、写入确认、风险与建议边界', async () => {
    const turn = await ask('看一下我持仓的风险');
    expect(turn.instructions).toContain('结论摘要');
    expect(turn.instructions).toContain('风险与未知项');
    expect(turn.instructions).toContain('不构成投资建议');
    expect(turn.instructions).toContain('写入工具只生成待用户确认的草案');
    expect(turn.instructions).toContain('只生成待确认草案');
  });
});

describe('chat 提示词行为：场景 → Tool 装配一致', () => {
  it('通用代码问题只保留股票发现 Tool，不注入本地账户上下文', async () => {
    const turn = await ask('帮我分析这段代码为什么报错');
    expect(JSON.parse(turn.route).scenario).toBe('general');
    expect(toolNames(turn)).toEqual(['search_stocks', 'get_stock_brief', 'list_stock_briefs']);
    expect(turn.instructions).not.toContain('当前本地上下文');
    expect(turn.instructions).not.toContain('结论摘要');
  });

  it('自然股票提问保留搜索与 Brief 入口，不要求重复澄清标的', async () => {
    const turn = await ask('看看比亚迪');
    expect(JSON.parse(turn.route).scenario).toBe('general');
    expect(toolNames(turn)).toEqual(['search_stocks', 'get_stock_brief', 'list_stock_briefs']);
    expect(turn.instructions).toContain('标识不清时先用 search_stocks');
    expect(toolNames(turn)).not.toContain('analyze_stock');
  });

  it('持仓纠错：portfolio 场景可生成 update_holding 草案，并可用账户事实核对 holdingId', async () => {
    const turn = await ask('纠错持仓数量');
    expect(JSON.parse(turn.route).scenario).toBe('portfolio');
    expect(toolNames(turn)).toEqual(expect.arrayContaining(['update_holding', 'list_trades']));
    expect(toolNames(turn)).not.toContain('save_decision_review');
    expect(turn.instructions).toContain('update_holding');
    expect(turn.instructions).toContain('纠正账本记录，不会买卖股票');
    expect(turn.instructions).toContain('当前本地上下文');
  });

  it('个股问题先读 StockBrief：research 场景同时提供 Brief 只读与 analyze_stock 草案', async () => {
    const turn = await ask('600519 的走势和估值怎么样');
    expect(JSON.parse(turn.route).scenario).toBe('research');
    expect(toolNames(turn)).toEqual(
      expect.arrayContaining(['get_stock_brief', 'list_stock_briefs', 'analyze_stock']),
    );
    expect(toolNames(turn)).not.toContain('update_holding');
    expect(toolNames(turn)).not.toContain('save_decision_review');
    expect(turn.instructions).toContain('有观察时直接引用');
  });

  it('复盘可读建议成绩、confidence 校准与报告', async () => {
    const turn = await ask('复盘一下最近的建议准不准');
    expect(JSON.parse(turn.route).scenario).toBe('review');
    expect(toolNames(turn)).toEqual(
      expect.arrayContaining([
        'get_decision_loop_review',
        'get_confidence_calibration',
        'list_reports',
        'get_report',
        'save_decision_review',
      ]),
    );
    expect(turn.instructions).toContain('get_decision_loop_review');
    expect(turn.instructions).toContain('描述性统计');
  });
});
