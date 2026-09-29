import {
  type ChatMessage,
  ChatMessagePartSchema,
  ChatMessageSchema,
  type ChatSession,
  ChatSessionSchema,
  type ToolContext,
} from '@luoome/core';
import { z } from 'zod';
import { AGENT_DRAFT_TOOL_KINDS } from '../agent/scenarios.js';
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

export const ChatDraftSettlementSchema = z.object({
  toolCallId: z.string().min(1),
  tool: z.string().min(1),
  status: z.enum(['executing', 'succeeded', 'failed', 'cancelled']),
  result: z
    .object({ ok: z.boolean(), data: z.unknown().optional(), error: z.unknown().optional() })
    .optional(),
});

export const settleChatDraftTool = defineTool({
  name: 'settle_chat_draft',
  description:
    '确认或取消当前账户会话中已保存的指定草案；仅执行服务器保存的输入，重复确认返回已有结果',
  sideEffect: 'write',
  requiredCapabilities: ['write', 'external'],
  input: z
    .object({
      sessionId: z.string().min(1).max(100),
      messageId: z.string().min(1).max(200),
      toolCallId: z.string().min(1).max(200),
      approved: z.boolean(),
    })
    .strict(),
  output: ChatDraftSettlementSchema,
  handler: async (input, ctx) => {
    const session = await ownedSession(input.sessionId, ctx.user.defaultAccountId, ctx);
    if (session === null) return errNotFound('ChatSession', input.sessionId);
    const message = await ctx.repos.chat.findMessageById(session.id, input.messageId);
    if (message?.role !== 'assistant') return errNotFound('ChatDraft', input.toolCallId);
    const settlements = message.parts.flatMap((part) => {
      if (part.type !== 'data-luoome-draft-settlement') return [];
      const parsed = ChatDraftSettlementSchema.safeParse(part.data);
      return parsed.success ? [parsed.data] : [];
    });
    const existing = settlements.find((item) => item.toolCallId === input.toolCallId);
    if (existing !== undefined) return existing;
    if (message.parts.length >= 100) return errInvalidInput('该消息已达到记录上限，请重新生成草案');
    // 同一消息串行处理草案，避免两个结果更新互相覆盖；跨进程由 repository CAS 认领。
    if (settlements.some((item) => item.status === 'executing')) {
      return errInvalidInput('该消息有草案正在执行；若进程曾中断，请先核对实际数据，不要重复操作');
    }
    const part = message.parts.find(
      (item) => item.toolCallId === input.toolCallId && item.state === 'output-available',
    );
    const output = z
      .object({
        __luoomeDraft: z.literal(true),
        draft: z.object({ tool: z.string(), kind: z.string(), input: z.unknown() }),
      })
      .safeParse(part?.output);
    if (!output.success) return errNotFound('ChatDraft', input.toolCallId);
    const draft = output.data.draft;
    const toolName = part?.type === 'dynamic-tool' ? part.toolName : String(part?.type).slice(5);
    if (toolName !== draft.tool || AGENT_DRAFT_TOOL_KINDS[draft.tool] !== draft.kind) {
      return errInvalidInput('草案工具不在允许列表中');
    }
    const history = await ctx.repos.chat.listMessages(session.id, 500);
    const legacySettlement = history.some(
      (entry) =>
        entry.role === 'user' &&
        entry.createdAt >= message.createdAt &&
        entry.parts.some((item) => {
          const text = item.text;
          return (
            item.type === 'text' &&
            typeof text === 'string' &&
            ['ok', 'fail'].some((status) =>
              text.startsWith(`[草案处理记录] ${status} ${draft.tool} `),
            )
          );
        }),
    );
    if (legacySettlement)
      return errInvalidInput(
        '该工具存在无法关联调用 ID 的旧版处理记录；请先核对实际数据，再重新生成草案',
      );
    const { toolRegistry } = await import('../registry.js');
    const target = toolRegistry.get(draft.tool);
    if (
      target === undefined ||
      target.sideEffect === 'trade' ||
      target.requiredCapabilities.includes('trade')
    ) {
      return errInvalidInput('草案工具不可执行');
    }
    const parsed = target.inputSchema.safeParse(draft.input);
    if (!parsed.success) return errInvalidInput('草案输入不再符合工具要求，请重新生成');
    const state: z.infer<typeof ChatDraftSettlementSchema> = {
      toolCallId: input.toolCallId,
      tool: draft.tool,
      status: input.approved ? 'executing' : 'cancelled',
    };
    const marker = { type: 'data-luoome-draft-settlement', data: state };
    const claimed: ChatMessage = { ...message, parts: [...message.parts, marker] };
    if (!(await ctx.repos.chat.compareAndSetMessageParts(claimed, message.parts))) {
      return errInvalidInput('草案状态已变化，请刷新会话后重试');
    }
    if (!input.approved) return state;
    const result = await target.execute(parsed.data, ctx);
    const settled = {
      ...state,
      status: result.ok ? ('succeeded' as const) : ('failed' as const),
      result,
    };
    const saved = await ctx.repos.chat.compareAndSetMessageParts(
      {
        ...message,
        parts: [...message.parts, { ...marker, data: settled }],
      },
      claimed.parts,
    );
    if (!saved)
      return errInvalidInput('操作已执行，但会话记录发生冲突；请核对实际数据，不要重复操作');
    return settled;
  },
});
