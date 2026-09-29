import { describe, expect, it } from 'vitest';

import { buildTestContext } from '../testing/context.js';
import {
  appendChatMessageTool,
  createChatSessionTool,
  deleteChatSessionTool,
  getChatSessionTool,
  listChatSessionsTool,
  renameChatSessionTool,
  settleChatDraftTool,
} from './chat-session.js';

describe('chat session tools', () => {
  it('创建、自动标题、读取、重命名和级联删除会话', async () => {
    const ctx = await buildTestContext();
    const created = await createChatSessionTool.execute({}, ctx);
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const sessionId = created.data.session.id;
    const appended = await appendChatMessageTool.execute(
      {
        sessionId,
        messageId: 'user-message-1',
        role: 'user',
        parts: [{ type: 'text', text: '  分析贵州茅台的长期竞争力  ' }],
      },
      ctx,
    );
    expect(appended.ok).toBe(true);
    if (!appended.ok) return;
    expect(appended.data.session.title).toBe('分析贵州茅台的长期竞争力');

    const loaded = await getChatSessionTool.execute({ sessionId }, ctx);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.data.messages.map((message) => message.id)).toEqual(['user-message-1']);

    const renamed = await renameChatSessionTool.execute({ sessionId, title: '茅台研究' }, ctx);
    expect(renamed.ok).toBe(true);
    if (renamed.ok) expect(renamed.data.session.title).toBe('茅台研究');

    const listed = await listChatSessionsTool.execute({}, ctx);
    expect(listed.ok).toBe(true);
    if (listed.ok) expect(listed.data.sessions.map((session) => session.id)).toContain(sessionId);

    expect((await deleteChatSessionTool.execute({ sessionId }, ctx)).ok).toBe(true);
    expect((await getChatSessionTool.execute({ sessionId }, ctx)).ok).toBe(false);
    expect(await ctx.repos.chat.listMessages(sessionId)).toEqual([]);
  });

  it('拒绝访问其它账户的会话', async () => {
    const ctx = await buildTestContext();
    const now = ctx.clock();
    await ctx.repos.chat.saveSession({
      id: 'other-account-session',
      accountId: 'other-account',
      title: '不可见',
      createdAt: now,
      updatedAt: now,
    });

    const result = await getChatSessionTool.execute({ sessionId: 'other-account-session' }, ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('not_found');
  });

  it('并发重传相同 ID 时只接受一份原文，不同输入不可覆盖', async () => {
    const ctx = await buildTestContext();
    const created = await createChatSessionTool.execute({}, ctx);
    if (!created.ok) throw new Error('session setup failed');
    const sessionId = created.data.session.id;
    const request = { sessionId, messageId: 'concurrent', role: 'user' as const };
    const results = await Promise.all(
      ['first', 'second'].map((text) =>
        appendChatMessageTool.execute({ ...request, parts: [{ type: 'text', text }] }, ctx),
      ),
    );
    const accepted = results.find((result) => result.ok);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toHaveLength(1);
    if (!accepted?.ok) throw new Error('message not saved');
    expect(await ctx.repos.chat.findMessageById(sessionId, request.messageId)).toEqual(
      accepted.data.message,
    );
    const replays = await Promise.all([
      appendChatMessageTool.execute({ ...request, parts: accepted.data.message.parts }, ctx),
      appendChatMessageTool.execute({ ...request, parts: accepted.data.message.parts }, ctx),
    ]);
    expect(
      replays.every(
        (result) =>
          result.ok &&
          result.data.message.createdAt.getTime() === accepted.data.message.createdAt.getTime(),
      ),
    ).toBe(true);
    expect(await ctx.repos.chat.listMessages(sessionId)).toHaveLength(1);
  });
});

describe('chat draft settlement', () => {
  it('确认工具仅供 Web 专用端点，不进入模型或 MCP 的通用注册表', async () => {
    const { toolRegistry } = await import('../registry.js');
    expect(toolRegistry.get('settle_chat_draft')).toBeUndefined();
  });
  const setup = async () => {
    const ctx = await buildTestContext();
    const created = await createChatSessionTool.execute({}, ctx);
    if (!created.ok) throw new Error('session setup failed');
    const sessionId = created.data.session.id;
    const draft = (callId: string, input: unknown) => ({
      type: 'tool-create_portfolio_cash_flow',
      toolCallId: callId,
      state: 'output-available',
      input,
      output: {
        __luoomeDraft: true,
        draft: { tool: 'create_portfolio_cash_flow', kind: 'portfolio', input },
      },
    });
    const input = {
      accountId: ctx.user.defaultAccountId,
      occurredAt: '2026-09-29T01:00:00Z',
      kind: 'deposit',
      amount: 1000,
    };
    const appended = await appendChatMessageTool.execute(
      {
        sessionId,
        messageId: 'drafts',
        role: 'assistant',
        parts: [draft('first', input), draft('second', { ...input, amount: 2000 })],
      },
      ctx,
    );
    if (!appended.ok) throw new Error('message setup failed');
    return { ctx, sessionId, input, message: appended.data.message };
  };

  it('并发确认只入金一次，重放返回真实结果；多个草案独立取消', async () => {
    const { ctx, sessionId } = await setup();
    const before = await ctx.repos.account.findById(ctx.user.defaultAccountId);
    const request = { sessionId, messageId: 'drafts', toolCallId: 'first', approved: true };
    const results = await Promise.all([
      settleChatDraftTool.execute(request, ctx),
      settleChatDraftTool.execute(request, ctx),
    ]);
    expect(results.some((result) => result.ok && result.data.status === 'succeeded')).toBe(true);
    const replay = await settleChatDraftTool.execute(request, ctx);
    expect(replay.ok).toBe(true);
    if (!replay.ok) return;
    expect(replay.data.status).toBe('succeeded');
    expect(replay.data.result?.ok).toBe(true);
    expect((await ctx.repos.account.findById(ctx.user.defaultAccountId))?.cashBalance).toBe(
      Number(before?.cashBalance) + 1000,
    );
    const cancelled = await settleChatDraftTool.execute(
      { ...request, toolCallId: 'second', approved: false },
      ctx,
    );
    expect(cancelled.ok && cancelled.data.status).toBe('cancelled');
    expect(await settleChatDraftTool.execute({ ...request, toolCallId: 'second' }, ctx)).toEqual(
      cancelled,
    );
    const saved = await ctx.repos.chat.findMessageById(sessionId, 'drafts');
    expect(
      saved?.parts.filter((part) => part.type === 'data-luoome-draft-settlement'),
    ).toHaveLength(2);
  });

  it('旧版文本处理记录无法确认具体调用，不允许重放可能已执行的草案', async () => {
    const { ctx, sessionId } = await setup();
    await appendChatMessageTool.execute(
      {
        sessionId,
        role: 'user',
        parts: [{ type: 'text', text: '[草案处理记录] ok create_portfolio_cash_flow 执行成功' }],
      },
      ctx,
    );
    const before = await ctx.repos.account.findById(ctx.user.defaultAccountId);
    const result = await settleChatDraftTool.execute(
      { sessionId, messageId: 'drafts', toolCallId: 'first', approved: true },
      ctx,
    );
    expect(result.ok).toBe(false);
    expect((await ctx.repos.account.findById(ctx.user.defaultAccountId))?.cashBalance).toEqual(
      before?.cashBalance,
    );
  });

  it('失败作为该调用的终态保存，不把失败当成功或重新执行', async () => {
    const { ctx, sessionId, message } = await setup();
    await ctx.repos.account.remove(ctx.user.defaultAccountId);
    const request = { sessionId, messageId: 'drafts', toolCallId: 'first', approved: true };
    const result = await settleChatDraftTool.execute(request, ctx);
    expect(result.ok && result.data.status).toBe('failed');
    expect(result.ok && result.data.result?.ok).toBe(false);
    expect(await settleChatDraftTool.execute(request, ctx)).toEqual(result);
    expect((await ctx.repos.chat.findMessageById(sessionId, 'drafts'))?.createdAt).toEqual(
      message.createdAt,
    );
  });

  it('拒绝替换输入、跨账户会话和未知调用', async () => {
    const { ctx, sessionId } = await setup();
    const request = { sessionId, messageId: 'drafts', toolCallId: 'first', approved: true };
    expect((await settleChatDraftTool.execute({ ...request, input: { amount: 1 } }, ctx)).ok).toBe(
      false,
    );
    expect((await settleChatDraftTool.execute({ ...request, toolCallId: 'unknown' }, ctx)).ok).toBe(
      false,
    );
    expect(
      (
        await settleChatDraftTool.execute(request, {
          ...ctx,
          user: { ...ctx.user, defaultAccountId: 'other' },
        })
      ).ok,
    ).toBe(false);
  });

  it('中断后保留执行中状态，重新加载不能重复入金', async () => {
    const { ctx, sessionId, message } = await setup();
    await ctx.repos.chat.compareAndSetMessageParts(
      {
        ...message,
        parts: [
          ...message.parts,
          {
            type: 'data-luoome-draft-settlement',
            data: { toolCallId: 'first', tool: 'create_portfolio_cash_flow', status: 'executing' },
          },
        ],
      },
      message.parts,
    );
    const before = await ctx.repos.account.findById(ctx.user.defaultAccountId);
    const result = await settleChatDraftTool.execute(
      { sessionId, messageId: 'drafts', toolCallId: 'first', approved: true },
      ctx,
    );
    expect(result.ok && result.data.status).toBe('executing');
    expect((await ctx.repos.account.findById(ctx.user.defaultAccountId))?.cashBalance).toEqual(
      before?.cashBalance,
    );
  });

  it('工具名不匹配或 trade 草案不能执行', async () => {
    const { ctx, sessionId, message } = await setup();
    await ctx.repos.chat.saveMessage({
      ...message,
      parts: [
        {
          ...message.parts[0],
          type: 'tool-add_trade',
        },
      ],
    });
    expect(
      (
        await settleChatDraftTool.execute(
          { sessionId, messageId: 'drafts', toolCallId: 'first', approved: true },
          ctx,
        )
      ).ok,
    ).toBe(false);
  });

  it('已保存消息不可覆盖，重传相同消息不改变顺序', async () => {
    const { ctx, sessionId, message } = await setup();
    const request = { sessionId, messageId: message.id, role: message.role, parts: message.parts };
    const replay = await appendChatMessageTool.execute(request, ctx);
    expect(replay.ok && replay.data.message.createdAt).toEqual(message.createdAt);
    expect((await appendChatMessageTool.execute({ ...request, role: 'user' }, ctx)).ok).toBe(false);
    expect(
      (
        await appendChatMessageTool.execute(
          { ...request, parts: [{ type: 'text', text: '伪造' }] },
          ctx,
        )
      ).ok,
    ).toBe(false);
  });
});
