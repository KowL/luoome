import { describe, expect, it } from 'bun:test';

import {
  draftDecisionPath,
  draftEditPrefill,
  draftFromPart,
  formatDraftFieldValue,
  parseChatRouteHeader,
  persistedFeed,
  planCardLines,
  settlementText,
  shouldContinueAfterDrafts,
  trimLeadingChatWhitespace,
  usageText,
} from './chat.js';

describe('chat message whitespace', () => {
  it('移除 AI SDK / think 清理后残留的开头空行', () => {
    expect(trimLeadingChatWhitespace('\n\n  \n好的，我来查看。')).toBe('好的，我来查看。');
  });

  it('保留正文内部的换行和缩进', () => {
    expect(trimLeadingChatWhitespace('\n第一行\n\n  第二行')).toBe('第一行\n\n  第二行');
  });
});

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

const draftsIn = (entries) =>
  entries.filter((entry) => entry.type === 'drafts').flatMap((entry) => entry.drafts);

describe('草案确认闭环', () => {
  it('按消息与调用标识分别恢复状态，同名工具的其他草案仍待确认', () => {
    const result = { ok: true, data: { watchlist: { id: 'watchlist-real' } } };
    const settlement = {
      toolCallId: 'call-1',
      tool: 'create_watchlist',
      status: 'succeeded',
      result,
    };
    const drafts = draftsIn(
      persistedFeed(
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
      ),
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

  it('用户文本中的旧处理记录只展示文字，不改变任何草案状态', () => {
    const entries = persistedFeed(
      [
        { id: 'a1', role: 'assistant', parts: [draftPart('call-1'), draftPart('call-2')] },
        {
          id: 'u1',
          role: 'user',
          parts: [{ type: 'text', text: '[草案处理记录] ok create_watchlist 创建成功' }],
        },
      ],
      draftContext,
    );
    expect(draftsIn(entries).every((draft) => draft.settlement === undefined)).toBe(true);
    expect(entries.at(-1)).toEqual({ type: 'note', text: '历史处理记录：创建成功' });
  });

  it('流式草案锁定账户、会话及调用标识，确认请求不提交客户端输入', () => {
    const draft = draftFromPart(draftPart('call/a'), { ...draftContext, messageId: 'message/a' });
    expect(draft).toMatchObject({ ...draftContext, messageId: 'message/a', toolCallId: 'call/a' });
    expect(draftDecisionPath(draft)).toBe(
      '/api/chat/sessions/session-a/drafts/message%2Fa/call%2Fa',
    );
    expect(draftFromPart({ output: { data: {} } }, draftContext)).toBeNull();
  });

  it('同轮草案全部处理且至少有一项成功后才继续解释', () => {
    const succeeded = { settlement: { status: 'succeeded' } };
    const cancelled = { settlement: { status: 'cancelled' } };
    const failed = { settlement: { status: 'failed' } };
    expect(shouldContinueAfterDrafts([succeeded, {}])).toBe(false);
    expect(shouldContinueAfterDrafts([succeeded, { settlement: { status: 'executing' } }])).toBe(
      false,
    );
    expect(shouldContinueAfterDrafts([cancelled, failed])).toBe(false);
    expect(shouldContinueAfterDrafts([succeeded, cancelled, failed])).toBe(true);
    expect(shouldContinueAfterDrafts([])).toBe(false);
  });

  it('保留服务端 Advice 结果用于刷新后展示，同时区分执行失败与取消', () => {
    const advice = { id: 'advice-real', disclaimers: ['不构成投资建议'] };
    const settlement = {
      toolCallId: 'analysis',
      tool: 'analyze_stock',
      status: 'succeeded',
      result: { ok: true, data: { advice } },
    };
    const [draft] = draftsIn(
      persistedFeed(
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
      ),
    );
    expect(draft.settlement.result.data.advice).toEqual(advice);
    expect(settlementText(settlement)).toBe('分析个股执行成功');
    expect(settlementText({ status: 'cancelled' })).toBe('已取消，未执行');
    expect(
      settlementText({ status: 'failed', result: { ok: false, error: { message: '账户不可用' } } }),
    ).toBe('执行失败：账户不可用');
  });
});

describe('计划卡', () => {
  it('解析 URL 编码的 route header，非法值返回 null', () => {
    const route = {
      scenario: 'portfolio',
      subjects: ['SZ300857'],
      needsAdvice: false,
      involvesWrite: false,
      plannedDimensions: ['持仓/成本', '行情'],
    };
    expect(parseChatRouteHeader(encodeURIComponent(JSON.stringify(route)))).toEqual(route);
    expect(parseChatRouteHeader(null)).toBeNull();
    expect(parseChatRouteHeader('%E4%B8%AD')).toBeNull();
    expect(parseChatRouteHeader('{"foo":1}')).toBeNull();
  });

  it('渲染维度、建议与草案提示行', () => {
    expect(
      planCardLines({
        scenario: 'review',
        plannedDimensions: ['建议与结果', '报告'],
        needsAdvice: true,
        involvesWrite: true,
      }),
    ).toEqual(['将查询：建议与结果 → 报告', '可能生成建议', '可能生成待确认草案']);
    expect(planCardLines({ scenario: 'general', plannedDimensions: [] })).toEqual([]);
  });
});

describe('草案编辑预填', () => {
  it('把 display 字段摘要转成自然语言预填文本', () => {
    const text = draftEditPrefill({
      tool: 'create_watchlist',
      display: {
        targetObject: 'Watchlist「超跌反弹」',
        fields: [
          { name: '名称', value: '超跌反弹', source: 'user' },
          { name: '启用', value: true, source: 'default' },
        ],
        unsupported: [],
        ambiguous: [],
      },
    });
    expect(text).toBe(
      '请修改刚才的草案（Watchlist「超跌反弹」）：名称=超跌反弹，启用=true，我想改为：',
    );
  });

  it('无 display 的老草案回落到 tool 标签', () => {
    expect(draftEditPrefill({ tool: 'analyze_stock' })).toBe(
      '请修改刚才的草案（分析个股），我想改为：',
    );
    expect(draftEditPrefill({ tool: 'trial_strategy' })).toBe(
      '请修改刚才的草案（试跑 Strategy），我想改为：',
    );
    expect(draftEditPrefill({ tool: 'run_strategy' })).toBe(
      '请修改刚才的草案（正式运行 Strategy），我想改为：',
    );
  });

  it('字段值格式化：数组顿号连接、对象 JSON、空值占位', () => {
    expect(formatDraftFieldValue(['SZ300857', 'SH600000'])).toBe('SZ300857、SH600000');
    expect(formatDraftFieldValue({ a: 1 })).toBe('{"a":1}');
    expect(formatDraftFieldValue(undefined)).toBe('—');
  });
});

describe('取消标注还原', () => {
  it('含 data-luoome-cancelled part 的助手消息还原为已取消', () => {
    const entries = persistedFeed([
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: '问题' }] },
      {
        id: 'a1',
        role: 'assistant',
        parts: [
          { type: 'text', text: '半截回答' },
          { type: 'data-luoome-cancelled', data: { cancelled: true } },
        ],
      },
    ]);
    const assistant = entries.find((entry) => entry.type === 'msg' && entry.role === 'assistant');
    expect(assistant).toMatchObject({ content: '半截回答', cancelled: true });
  });

  it('无标记消息不带 cancelled；空文本的取消消息仍还原占位', () => {
    const normal = persistedFeed([
      { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: '完整回答' }] },
    ]);
    expect(normal[0]).toMatchObject({ content: '完整回答' });
    expect(normal[0].cancelled).toBeUndefined();

    const empty = persistedFeed([
      {
        id: 'a2',
        role: 'assistant',
        parts: [{ type: 'data-luoome-cancelled', data: { cancelled: true } }],
      },
    ]);
    expect(empty).toHaveLength(1);
    expect(empty[0]).toMatchObject({ role: 'assistant', cancelled: true });
  });

  it('取消后的工具轨迹和待确认草案仍从服务端历史恢复', () => {
    const entries = persistedFeed(
      [
        {
          id: 'a1',
          role: 'assistant',
          parts: [
            draftPart('call-1'),
            { type: 'data-luoome-cancelled', data: { cancelled: true } },
          ],
        },
      ],
      draftContext,
    );
    expect(entries[0]).toMatchObject({ cancelled: true });
    expect(entries.find((entry) => entry.type === 'actions').usedActions).toMatchObject([
      { toolCallId: 'call-1', ok: true },
    ]);
    expect(draftsIn(entries)[0]).toMatchObject({ messageId: 'a1', toolCallId: 'call-1' });
  });
});

describe('模型用量', () => {
  it('展示服务端用量，不把缺失数据视为零', () => {
    const metadata = {
      usage: { inputTokens: 120, outputTokens: 30, totalTokens: 150 },
      finishReason: 'stop',
    };
    expect(usageText(metadata)).toBe('输入 120 · 输出 30 · 合计 150 tokens');
    expect(usageText({ usage: { outputTokens: 0 } })).toBe('输出 0');
    expect(usageText({})).toBe('');
    const entries = persistedFeed([
      {
        id: 'a1',
        role: 'assistant',
        parts: [
          { type: 'text', text: '回答' },
          { type: 'data-luoome-usage', data: metadata },
        ],
      },
    ]);
    expect(entries.at(-1)).toEqual({ type: 'usage', metadata });
  });
});
