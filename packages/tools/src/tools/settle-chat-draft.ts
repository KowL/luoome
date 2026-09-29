import { CHAT_MESSAGE_PARTS_MAX, type ChatMessage, type ToolContext } from '@luoome/core';
import { z } from 'zod';
import { AGENT_DRAFT_TOOL_KINDS } from '../agent/scenarios.js';
import { defineTool, errInvalidInput, errNotFound } from '../define-tool.js';
import { toolRegistry } from '../registry.js';

/** 旧版文本处理记录向后扫描的消息条数。 */
const LEGACY_SETTLEMENT_SCAN_LIMIT = 500;

export const ChatDraftSettlementSchema = z.object({
  toolCallId: z.string().min(1),
  tool: z.string().min(1),
  status: z.enum(['executing', 'succeeded', 'failed', 'cancelled']),
  result: z
    .object({ ok: z.boolean(), data: z.unknown().optional(), error: z.unknown().optional() })
    .optional(),
});

export type ChatDraftSettlement = z.infer<typeof ChatDraftSettlementSchema>;

export const parseChatDraftSettlements = (parts: ChatMessage['parts']): ChatDraftSettlement[] =>
  parts.flatMap((part) => {
    if (part.type !== 'data-luoome-draft-settlement') return [];
    const parsed = ChatDraftSettlementSchema.safeParse(part.data);
    return parsed.success ? [parsed.data] : [];
  });

/** 从 UI message part 还原工具名；非工具 part 返回 undefined。 */
export const chatToolNameOfPart = (part: {
  type?: unknown;
  toolName?: unknown;
}): string | undefined => {
  if (part.type === 'dynamic-tool') {
    return typeof part.toolName === 'string' ? part.toolName : undefined;
  }
  if (typeof part.type === 'string' && part.type.startsWith('tool-')) return part.type.slice(5);
  return undefined;
};

const ownedSession = async (sessionId: string, accountId: string, ctx: ToolContext) => {
  const session = await ctx.repos.chat.findSessionById(sessionId);
  return session?.accountId === accountId ? session : null;
};

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
    const settlements = parseChatDraftSettlements(message.parts);
    const existing = settlements.find((item) => item.toolCallId === input.toolCallId);
    if (existing !== undefined) {
      // 遗留 executing 不自动重试（可能已部分生效）；用户核对账本后可显式取消，避免状态死锁。
      if (existing.status !== 'executing' || input.approved) return existing;
      const cancelled: ChatDraftSettlement = { ...existing, status: 'cancelled' };
      const parts = message.parts.map((part) => {
        if (part.type !== 'data-luoome-draft-settlement') return part;
        const parsed = ChatDraftSettlementSchema.safeParse(part.data);
        return parsed.success && parsed.data.toolCallId === input.toolCallId
          ? { ...part, data: cancelled }
          : part;
      });
      const saved = await ctx.repos.chat.compareAndSetMessageParts(
        { ...message, parts },
        message.parts,
      );
      if (!saved) return errInvalidInput('草案状态已变化，请刷新会话后重试');
      return cancelled;
    }
    if (message.parts.length >= CHAT_MESSAGE_PARTS_MAX) {
      return errInvalidInput('该消息已达到记录上限，请重新生成草案');
    }
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
    const toolName = part === undefined ? undefined : chatToolNameOfPart(part);
    if (toolName !== draft.tool || AGENT_DRAFT_TOOL_KINDS[draft.tool] !== draft.kind) {
      return errInvalidInput('草案工具不在允许列表中');
    }
    const history = await ctx.repos.chat.listMessages(session.id, LEGACY_SETTLEMENT_SCAN_LIMIT);
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
    const state: ChatDraftSettlement = {
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
