import {
  CHAT_MESSAGE_PARTS_MAX,
  type ChatMessage,
  ChatMessagePartSchema,
  ChatMessageSchema,
  type ChatSession,
  ChatSessionSchema,
  type ToolContext,
} from '@luoome/core';
import { z } from 'zod';
import { defineTool, errInvalidInput, errNotFound } from '../define-tool.js';

const ownedSession = async (sessionId: string, accountId: string, ctx: ToolContext) => {
  const session = await ctx.repos.chat.findSessionById(sessionId);
  return session?.accountId === accountId ? session : null;
};

export const createChatSessionTool = defineTool({
  name: 'create_chat_session',
  description: '为当前账户创建一个 AI 对话会话',
  sideEffect: 'write',
  input: z.object({ title: z.string().trim().min(1).max(80).optional() }),
  output: z.object({ session: ChatSessionSchema }),
  handler: async (input, ctx) => {
    const now = ctx.clock();
    const session: ChatSession = {
      id: `chat_${crypto.randomUUID()}`,
      accountId: ctx.user.defaultAccountId,
      title: input.title ?? '新会话',
      createdAt: now,
      updatedAt: now,
    };
    await ctx.repos.chat.saveSession(session);
    return { session };
  },
});

export const listChatSessionsTool = defineTool({
  name: 'list_chat_sessions',
  description: '列出当前账户最近更新的 AI 对话会话',
  sideEffect: 'read',
  input: z.object({ limit: z.number().int().min(1).max(200).default(100) }),
  output: z.object({ sessions: z.array(ChatSessionSchema) }),
  handler: async (input, ctx) => ({
    sessions: [...(await ctx.repos.chat.listSessions(ctx.user.defaultAccountId, input.limit))],
  }),
});

export const getChatSessionTool = defineTool({
  name: 'get_chat_session',
  description: '读取当前账户的 AI 对话会话及消息',
  sideEffect: 'read',
  input: z.object({
    sessionId: z.string().min(1),
    messageLimit: z.number().int().min(1).max(500).default(200),
  }),
  output: z.object({ session: ChatSessionSchema, messages: z.array(ChatMessageSchema) }),
  handler: async (input, ctx) => {
    const session = await ownedSession(input.sessionId, ctx.user.defaultAccountId, ctx);
    if (session === null) return errNotFound('ChatSession', input.sessionId);
    return {
      session,
      messages: [...(await ctx.repos.chat.listMessages(session.id, input.messageLimit))],
    };
  },
});

export const renameChatSessionTool = defineTool({
  name: 'rename_chat_session',
  description: '重命名当前账户的 AI 对话会话',
  sideEffect: 'write',
  input: z.object({ sessionId: z.string().min(1), title: z.string().trim().min(1).max(80) }),
  output: z.object({ session: ChatSessionSchema }),
  handler: async (input, ctx) => {
    const session = await ownedSession(input.sessionId, ctx.user.defaultAccountId, ctx);
    if (session === null) return errNotFound('ChatSession', input.sessionId);
    const updated = { ...session, title: input.title, updatedAt: ctx.clock() };
    await ctx.repos.chat.saveSession(updated);
    return { session: updated };
  },
});

/** 探测消息条数时的单次读取上限；超过即判定为「至少这么多条」。 */
const MESSAGE_COUNT_PROBE_LIMIT = 500;

/**
 * 会话删除摘要（决策 3-B，外部评审裁定）。
 *
 * ## 为什么不带 `title` / 消息正文
 *
 * 会话标题与正文是用户自己写的 **PII**。删除的语义是让它消失——
 * 把标题复制进回执等于**换个地方继续留着**，比「信息不足」更糟。
 * 所以这里只有身份与时间元数据，`id` 之外的任何用户文本一律不出现。
 *
 * ## 为什么 `messageCount` 是一个带 `lowerBound` 的对象
 *
 * 仓储只有 `listMessages(sessionId, limit = 200)`，**没有 `countMessages`**，
 * 且 memory/drizzle 都按 `slice(-limit)` 截断。直接 `listMessages(id).length`
 * 在 2000 条的会话上会**静默给出 200**——那是本会话反复消灭的「看似可用的形状」。
 *
 * 加仓储方法要动 core 接口 + 双实现 + contract，超出本任务范围；而**删除场景也不需要精确条数**
 * （用户要知道的是「删掉的是那个有 12 条的会话」）。所以：
 * - 读到 < 上限 → `value` 是**精确值**，`lowerBound: false`
 * - 读到 = 上限 → `value` 是**至少**这么多，`lowerBound: true`（真实条数可能更多）
 *
 * 形状刻意做成对象而不是 `number | null`：`null` 会被读成「未知/没数据」，
 * 而这里要表达的是「**至少** N 条」——一个界限，不是缺失。
 */
export const ChatSessionDeletionSummarySchema = z
  .object({
    sessionId: z.string().min(1),
    createdAt: z.coerce.date(),
    /** 删除前最后更新时间。 */
    updatedAt: z.coerce.date(),
    /** 随会话一并删除的消息条数；`lowerBound: true` 时是下界而非精确值。 */
    messageCount: z
      .object({
        value: z.number().int().nonnegative(),
        lowerBound: z.boolean(),
      })
      .strict(),
  })
  .strict();

export const deleteChatSessionTool = defineTool({
  name: 'delete_chat_session',
  description: '删除当前账户的 AI 对话会话及其全部消息',
  sideEffect: 'write',
  input: z.object({ sessionId: z.string().min(1) }),
  output: z.object({
    deleted: z.literal(true),
    /** 删除摘要：**必填**（理由同 `delete_strategy`——可选等于允许新代码退化成布尔值）。 */
    summary: ChatSessionDeletionSummarySchema,
  }),
  handler: async (input, ctx) => {
    const session = await ownedSession(input.sessionId, ctx.user.defaultAccountId, ctx);
    if (session === null) return errNotFound('ChatSession', input.sessionId);
    // 多读一条用于判断「是否到达上限」，从而区分精确值与下界。
    const messages = await ctx.repos.chat.listMessages(session.id, MESSAGE_COUNT_PROBE_LIMIT + 1);
    const messageCount =
      messages.length > MESSAGE_COUNT_PROBE_LIMIT
        ? { value: messages.length - 1, lowerBound: true }
        : { value: messages.length, lowerBound: false };
    await ctx.repos.chat.removeSession(session.id);
    return {
      deleted: true as const,
      summary: {
        sessionId: session.id,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        messageCount,
      },
    };
  },
});

export const appendChatMessageTool = defineTool({
  name: 'append_chat_message',
  description: '向当前账户的 AI 对话会话追加一条 UI message',
  sideEffect: 'write',
  input: z.object({
    sessionId: z.string().min(1),
    messageId: z.string().min(1).max(200).optional(),
    role: z.enum(['user', 'assistant']),
    parts: z.array(ChatMessagePartSchema).min(1).max(CHAT_MESSAGE_PARTS_MAX),
  }),
  output: z.object({ session: ChatSessionSchema, message: ChatMessageSchema }),
  handler: async (input, ctx) => {
    const session = await ownedSession(input.sessionId, ctx.user.defaultAccountId, ctx);
    if (session === null) return errNotFound('ChatSession', input.sessionId);
    const latest = (await ctx.repos.chat.listMessages(session.id, 1))[0];
    const now = new Date(Math.max(ctx.clock().getTime(), (latest?.createdAt.getTime() ?? 0) + 1));
    const message: ChatMessage = {
      id: input.messageId ?? `msg_${crypto.randomUUID()}`,
      sessionId: session.id,
      role: input.role,
      parts: input.parts,
      createdAt: now,
    };
    if (!(await ctx.repos.chat.insertMessageIfAbsent(message))) {
      const existing = await ctx.repos.chat.findMessageById(session.id, message.id);
      if (
        existing === null ||
        existing.role !== input.role ||
        JSON.stringify(existing.parts) !== JSON.stringify(input.parts)
      ) {
        return errInvalidInput('已有消息不可覆盖，请使用新的 messageId');
      }
      return { session, message: existing };
    }
    const firstText = input.parts.find(
      (part) => part.type === 'text' && typeof part.text === 'string',
    )?.text;
    const autoTitle =
      input.role === 'user' && session.title === '新会话' && typeof firstText === 'string'
        ? firstText.trim().replace(/\s+/g, ' ').slice(0, 32)
        : session.title;
    const updated: ChatSession = { ...session, title: autoTitle || session.title, updatedAt: now };
    await ctx.repos.chat.saveSession(updated);
    return { session: updated, message };
  },
});
