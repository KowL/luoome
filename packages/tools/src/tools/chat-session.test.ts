import { describe, expect, it } from 'vitest';

import { buildTestContext } from '../testing/context.js';
import {
  appendChatMessageTool,
  createChatSessionTool,
  deleteChatSessionTool,
  getChatSessionTool,
  listChatSessionsTool,
  renameChatSessionTool,
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
});
