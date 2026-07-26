import {
  type ChatMessage,
  ChatMessagePartSchema,
  ChatMessageSchema,
  type ChatSession,
  ChatSessionSchema,
  type ToolContext,
} from '@luoome/core';
import { z } from 'zod';
import { defineTool, errNotFound } from '../define-tool.js';

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

export const deleteChatSessionTool = defineTool({
  name: 'delete_chat_session',
  description: '删除当前账户的 AI 对话会话及其全部消息',
  sideEffect: 'write',
  input: z.object({ sessionId: z.string().min(1) }),
  output: z.object({ deleted: z.literal(true) }),
  handler: async (input, ctx) => {
    const session = await ownedSession(input.sessionId, ctx.user.defaultAccountId, ctx);
    if (session === null) return errNotFound('ChatSession', input.sessionId);
    await ctx.repos.chat.removeSession(session.id);
    return { deleted: true as const };
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
    parts: z.array(ChatMessagePartSchema).min(1).max(100),
  }),
  output: z.object({ session: ChatSessionSchema, message: ChatMessageSchema }),
  handler: async (input, ctx) => {
    const session = await ownedSession(input.sessionId, ctx.user.defaultAccountId, ctx);
    if (session === null) return errNotFound('ChatSession', input.sessionId);
    const now = ctx.clock();
    const message: ChatMessage = {
      id: input.messageId ?? `msg_${crypto.randomUUID()}`,
      sessionId: session.id,
      role: input.role,
      parts: input.parts,
      createdAt: now,
    };
    await ctx.repos.chat.saveMessage(message);
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
