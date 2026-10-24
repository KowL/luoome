import { describe, expect, it } from 'bun:test';

import {
  draftDecisionPath,
  draftFromPart,
  formatDraftFieldValue,
  sessionDrafts,
  settlementText,
} from './drafts.js';

const draftPart = (toolCallId, tool = 'create_watchlist') => ({
  type: `tool-${tool}`,
  toolCallId,
  state: 'output-available',
  output: {
    __luoomeDraft: true,
    draft: { tool, kind: 'watchlist', input: { name: toolCallId } },
  },
});

const draftContext = { sessionId: 'session-a', accountId: 'account-a' };

describe('草案确认闭环', () => {
  it.each([
    ['unavailable', '事实不足，未生成方向'],
    ['failed', '研究未完成，未生成可用方向'],
  ])('研究记录保存成功但 %s 时，不把写入成功显示为研究成功', (status, text) => {
    const result = settlementText({
      tool: 'research_investment_directions',
      status: 'succeeded',
      result: { ok: true, data: { research: { status, limitations: ['实际证据未满足要求'] } } },
    });
    expect(result).toContain(text);
    expect(result).toContain('实际证据未满足要求');
    expect(result).not.toContain('执行成功');
  });

  it('共识保存、部分跟踪和跟踪失败分别展示，不宣称已经开始盯盘或送达', () => {
    const settlement = (tool, data) =>
      settlementText({
        tool,
        status: 'succeeded',
        result: { ok: true, data },
      });
    expect(
      settlement('save_investment_consensus', {
        consensus: { version: 2, status: 'confirmed' },
      }),
    ).toContain('共识 v2 已保存；方向跟踪需另行确认');
    expect(settlement('set_investment_tracking', { tracking: { status: 'partial' } })).toContain(
      '候选同步部分可用',
    );
    expect(settlement('set_investment_tracking', { tracking: { status: 'failed' } })).toContain(
      '方向跟踪启动失败',
    );
    expect(settlement('set_investment_tracking', { tracking: { status: 'tracking' } })).toContain(
      '后台运行与手机送达仍需核对',
    );
  });

  it('按消息与调用标识分别恢复状态，同名工具的其他草案仍待确认', () => {
    const result = { ok: true, data: { watchlist: { id: 'watchlist-real' } } };
    const settlement = {
      toolCallId: 'call-1',
      tool: 'create_watchlist',
      status: 'succeeded',
      result,
    };
    const drafts = sessionDrafts(
      [
        {
          id: 'a1',
          role: 'assistant',
          parts: [
            draftPart('call-1'),
            draftPart('call-2'),
            { type: 'data-luoome-draft-settlement', data: settlement },
          ],
        },
        { id: 'a2', role: 'assistant', parts: [draftPart('call-1')] },
      ],
      draftContext,
    );
    expect(drafts).toHaveLength(3);
    expect(drafts[0]).toMatchObject({
      ...draftContext,
      messageId: 'a1',
      toolCallId: 'call-1',
      settlement,
    });
    expect(drafts[1].settlement).toBeUndefined();
    expect(drafts[2].settlement).toBeUndefined();
  });

  it('草案确认请求只提交服务端已保存的标识', () => {
    const draft = draftFromPart(draftPart('call/a'), { ...draftContext, messageId: 'message/a' });
    expect(draft).toMatchObject({ ...draftContext, messageId: 'message/a', toolCallId: 'call/a' });
    expect(draftDecisionPath(draft)).toBe(
      '/api/chat/sessions/session-a/drafts/message%2Fa/call%2Fa',
    );
    expect(draftFromPart({ output: { data: {} } }, draftContext)).toBeNull();
  });

  it('保留服务端 Advice 结果用于刷新后展示，同时区分执行失败与取消', () => {
    const advice = { id: 'advice-real', disclaimers: ['不构成投资建议'] };
    const settlement = {
      toolCallId: 'analysis',
      tool: 'analyze_stock',
      status: 'succeeded',
      result: { ok: true, data: { advice } },
    };
    const [draft] = sessionDrafts(
      [
        {
          id: 'a1',
          role: 'assistant',
          parts: [
            draftPart('analysis', 'analyze_stock'),
            { type: 'data-luoome-draft-settlement', data: settlement },
          ],
        },
      ],
      draftContext,
    );
    expect(draft.settlement.result.data.advice).toEqual(advice);
    expect(settlementText(settlement)).toBe('分析个股执行成功');
    expect(settlementText({ status: 'cancelled' })).toBe('已取消，未执行');
    expect(
      settlementText({ status: 'failed', result: { ok: false, error: { message: '账户不可用' } } }),
    ).toBe('执行失败：账户不可用');
  });

  it('字段值格式化：数组顿号连接、对象 JSON、空值占位', () => {
    expect(formatDraftFieldValue(['a', 'b'])).toBe('a、b');
    expect(formatDraftFieldValue({ a: 1 })).toBe('{"a":1}');
    expect(formatDraftFieldValue(null)).toBe('—');
  });
});
