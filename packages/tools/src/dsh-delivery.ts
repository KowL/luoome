import type {
  AgentSessionBinding,
  AgentSessionContextMode,
  RepositoryRegistry,
} from '@luoome/core';
import { chatToolNameOfPart } from './tools/settle-chat-draft.js';

/**
 * DSH 增量投递（docs/ddd/dsh-plugin-platform-design.md §7、research-plan R06/R07）。
 *
 * 会话以 Luoome 的 ChatMessage 为产品事实来源。这里只负责把「游标之后的新消息」
 * 和「游标之后新结算的草案确认回执」整理成下一轮投递，并在 assistant 消息保存成功后
 * 推进游标。回执只是已发生事实，不会调用任何业务工具。
 */

/** Host 目前每次运行使用独立 DSH_HOME，没有可 resume 的持久会话日志；不声称恢复了原始运行。 */
const CONTEXT_MODE: AgentSessionContextMode = 'rebuilt-history';

export type DshDeliveryMode = 'incremental' | 'rebuilt-history';

export type DshDraftReceiptStatus = 'succeeded' | 'failed' | 'cancelled';

export interface DshDraftReceipt {
  readonly messageId: string;
  readonly toolCallId: string;
  readonly tool: string;
  readonly draftStatus: DshDraftReceiptStatus;
  /** settle_chat_draft 的权威结果；只作事实补充。 */
  readonly result: unknown;
}

export interface DshDeliveryPlan {
  readonly mode: DshDeliveryMode;
  readonly contextMode: AgentSessionContextMode;
  /** 仅 incremental 且存在可复用绑定时给出；Host 用它延续 runtime session 身份。 */
  readonly dshSessionId: string | null;
  /** 本轮需要投递的历史：incremental 只有游标之后的新消息。 */
  readonly history: readonly unknown[];
  /** 游标之前已结算但尚未投递的确认回执。 */
  readonly receipts: readonly DshDraftReceipt[];
  /** 上一轮投递未确认完成（崩溃/中断），本轮已从可信历史重建。 */
  readonly recovered: boolean;
}

export interface DshTurnLease {
  readonly conversationId: string;
  readonly runId: string;
  readonly accountId: string;
  readonly agentDefinitionId: string;
  readonly configHash: string;
  readonly profileHash: string | null;
  /** 本轮保存成功后应写入的回执游标。 */
  readonly receiptsCursor: string | null;
  readonly plan: DshDeliveryPlan;
}

export interface BeginDshTurnInput {
  readonly conversationId: string;
  readonly accountId: string;
  readonly agentDefinitionId: string;
  readonly runId: string;
  /** 本轮预期保存的 assistant message id；崩溃后据此判定结果是否已物化。 */
  readonly assistantMessageId: string;
  readonly configHash: string;
  /** 服务端核验过的模型历史窗口（含本轮 user 消息）。 */
  readonly messages: readonly unknown[];
  readonly now: Date;
  /** pending 认领的有效期；超过后另一轮可判定为中断并接管。 */
  readonly leaseMs: number;
}

export type BeginDshTurnResult =
  | { readonly kind: 'ready'; readonly lease: DshTurnLease }
  | { readonly kind: 'busy' }
  | { readonly kind: 'conflict'; readonly message: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const receiptKeyOf = (messageId: string, toolCallId: string): string =>
  `${messageId}:${toolCallId}`;

const messageIdOf = (message: unknown): string | null =>
  isRecord(message) && typeof message.id === 'string' ? message.id : null;

const lastMessageIdOf = (messages: readonly unknown[]): string | null => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const id = messageIdOf(messages[index]);
    if (id !== null) return id;
  }
  return null;
};

/**
 * 从已投影的模型历史中提取已结算的草案回执。
 * modelHistory 把 settlement 折叠成 `output.draftStatus`；executing 尚未结算，不算回执。
 * 同一 toolCallId 只保留最后一条，避免重复确认被当成两次事实。
 */
export const draftReceiptsOf = (messages: readonly unknown[]): readonly DshDraftReceipt[] => {
  const receipts = new Map<string, DshDraftReceipt>();
  for (const message of messages) {
    const messageId = messageIdOf(message);
    if (messageId === null || !isRecord(message) || !Array.isArray(message.parts)) continue;
    if (message.role !== 'assistant') continue;
    for (const part of message.parts) {
      if (!isRecord(part) || typeof part.toolCallId !== 'string') continue;
      const tool = chatToolNameOfPart(part);
      const output = isRecord(part.output) ? part.output : undefined;
      const status = output?.draftStatus;
      if (typeof tool !== 'string') continue;
      if (status !== 'succeeded' && status !== 'failed' && status !== 'cancelled') continue;
      receipts.set(receiptKeyOf(messageId, part.toolCallId), {
        messageId,
        toolCallId: part.toolCallId,
        tool,
        draftStatus: status,
        result: output?.result ?? null,
      });
    }
  }
  return [...receipts.values()];
};

const latestCursor = (left: string | null, right: string | null): string | null => right ?? left;

const emptyBinding = (input: BeginDshTurnInput): AgentSessionBinding => ({
  conversationId: input.conversationId,
  accountId: input.accountId,
  agentDefinitionId: input.agentDefinitionId,
  dshSessionId: null,
  profileHash: null,
  configHash: input.configHash,
  lastSyncedMessageId: null,
  settledDraftReceiptsCursor: null,
  status: 'active',
  contextMode: CONTEXT_MODE,
  pendingRunId: null,
  pendingAssistantMessageId: null,
  pendingMessageId: null,
  pendingReceiptsCursor: null,
  pendingClaimedAt: null,
  updatedAt: input.now,
});

/**
 * 认领本轮投递并生成增量计划。
 *
 * 崩溃窗口的确定行为：
 * - pending 存在且预期 assistant 消息已落库 → 视为已送达，补齐游标后继续（不重复注入）；
 * - pending 存在但未落库且租约已过期 → 标记 interrupted、从可信历史重建；
 * - 租约未过期 → busy（同会话并发请求得到明确冲突，不并行执行）。
 */
export const beginDshTurn = async (
  repos: Pick<RepositoryRegistry, 'agentSessionBinding' | 'chat'>,
  input: BeginDshTurnInput,
): Promise<BeginDshTurnResult> => {
  const repo = repos.agentSessionBinding;
  let binding = await repo.findByConversation(input.conversationId);
  if (binding === null) {
    binding = emptyBinding(input);
    await repo.save(binding);
  } else if (binding.accountId !== input.accountId) {
    return { kind: 'conflict', message: '会话执行绑定属于其它账户' };
  }

  let recovered = false;
  if (binding.pendingRunId !== null) {
    const pendingRunId = binding.pendingRunId;
    const saved =
      binding.pendingAssistantMessageId === null
        ? null
        : await repos.chat.findMessageById(
            binding.conversationId,
            binding.pendingAssistantMessageId,
          );
    if (saved !== null) {
      // 答案已落库但游标写失败：按已送达补齐，避免重启后重复注入同一回执/消息。
      await repo.commit({
        conversationId: binding.conversationId,
        runId: pendingRunId,
        dshSessionId: binding.dshSessionId,
        profileHash: binding.profileHash,
        configHash: binding.configHash,
        lastSyncedMessageId: saved.id,
        settledDraftReceiptsCursor: latestCursor(
          binding.settledDraftReceiptsCursor,
          binding.pendingReceiptsCursor,
        ),
        status: binding.status === 'invalidated' ? 'invalidated' : 'active',
        contextMode: binding.contextMode,
        updatedAt: input.now,
      });
    } else {
      const expired =
        binding.pendingClaimedAt === null ||
        binding.pendingClaimedAt.getTime() + input.leaseMs <= input.now.getTime();
      if (!expired) return { kind: 'busy' };
      // 结果无法核对：不重发原投递，标记中断并从可信历史重建。
      await repo.release({
        conversationId: binding.conversationId,
        runId: pendingRunId,
        status: 'interrupted',
        contextMode: CONTEXT_MODE,
        updatedAt: input.now,
      });
      recovered = true;
    }
    const refreshed = await repo.findByConversation(binding.conversationId);
    if (refreshed === null) return { kind: 'busy' };
    if (refreshed.pendingRunId !== null) return { kind: 'busy' };
    binding = refreshed;
  }

  if (
    binding.dshSessionId !== null &&
    binding.configHash !== null &&
    binding.configHash !== input.configHash
  ) {
    // profile/config 快照变化：旧 runtime 会话不可续接，下一轮从可信历史重建。
    binding = {
      ...binding,
      dshSessionId: null,
      status: 'invalidated',
      updatedAt: input.now,
    };
    await repo.save(binding);
    recovered = true;
  }

  const receipts = draftReceiptsOf(input.messages);
  const receiptKeys = receipts.map((receipt) =>
    receiptKeyOf(receipt.messageId, receipt.toolCallId),
  );
  const cursorIndex =
    binding.lastSyncedMessageId === null
      ? -1
      : input.messages.findIndex((message) => messageIdOf(message) === binding.lastSyncedMessageId);
  const incremental =
    binding.status === 'active' && binding.dshSessionId !== null && cursorIndex >= 0;
  const messageIndex = new Map(
    input.messages.flatMap((message, index): [string, number][] => {
      const id = messageIdOf(message);
      return id === null ? [] : [[id, index]];
    }),
  );
  const receiptsIndex = new Map(receiptKeys.map((key, index) => [key, index]));
  const receiptsCursorPosition =
    binding.settledDraftReceiptsCursor === null
      ? -1
      : (receiptsIndex.get(binding.settledDraftReceiptsCursor) ?? -1);
  // 游标不在窗口内（历史被截断）时不再补投旧回执，只把游标推进到窗口末尾，避免重复。
  const injectable =
    binding.settledDraftReceiptsCursor === null
      ? receipts
      : receipts.slice(receiptsCursorPosition + 1);
  const receiptsToInject = incremental
    ? injectable.filter((receipt) => (messageIndex.get(receipt.messageId) ?? -1) <= cursorIndex)
    : [];
  const lastReceiptKey = receiptKeys.at(-1) ?? binding.settledDraftReceiptsCursor;
  const history = incremental ? input.messages.slice(cursorIndex + 1) : input.messages;

  const claimed = await repo.claim({
    ...binding,
    agentDefinitionId: input.agentDefinitionId,
    pendingRunId: input.runId,
    pendingAssistantMessageId: input.assistantMessageId,
    pendingMessageId: lastMessageIdOf(input.messages),
    pendingReceiptsCursor: lastReceiptKey,
    pendingClaimedAt: input.now,
    updatedAt: input.now,
  });
  if (!claimed) return { kind: 'busy' };

  return {
    kind: 'ready',
    lease: {
      conversationId: input.conversationId,
      runId: input.runId,
      accountId: input.accountId,
      agentDefinitionId: input.agentDefinitionId,
      configHash: input.configHash,
      profileHash: binding.profileHash,
      receiptsCursor: lastReceiptKey,
      plan: {
        mode: incremental ? 'incremental' : 'rebuilt-history',
        contextMode: incremental ? 'resumed' : 'rebuilt-history',
        dshSessionId: incremental ? binding.dshSessionId : null,
        history,
        receipts: receiptsToInject,
        recovered,
      },
    },
  };
};

export interface CommitDshTurnInput {
  readonly conversationId: string;
  readonly runId: string;
  readonly assistantMessageId: string;
  readonly dshSessionId: string | null;
  readonly observedProfileHash: string | null;
  /** begin 时读到的 profileHash；变化时使旧会话失效。 */
  readonly expectedProfileHash: string | null;
  readonly configHash: string;
  /** 本轮是否干净完成，可安全 resume 该 runtime session。 */
  readonly sessionReusable: boolean;
  /** 本轮是否真的续接了既有 runtime session（决定 binding 的上下文标注）。 */
  readonly resumed: boolean;
  readonly receiptsCursor: string | null;
  readonly now: Date;
}

/** assistant 消息保存成功后推进游标；CAS 保证并发轮次只有一个能提交。 */
export const commitDshTurn = async (
  repos: Pick<RepositoryRegistry, 'agentSessionBinding'>,
  input: CommitDshTurnInput,
): Promise<boolean> => {
  const invalidated =
    input.expectedProfileHash !== null &&
    input.observedProfileHash !== null &&
    input.expectedProfileHash !== input.observedProfileHash;
  const reusable = !invalidated && input.sessionReusable && input.dshSessionId !== null;
  return repos.agentSessionBinding.commit({
    conversationId: input.conversationId,
    runId: input.runId,
    dshSessionId: reusable ? input.dshSessionId : null,
    profileHash: input.observedProfileHash ?? input.expectedProfileHash,
    configHash: input.configHash,
    lastSyncedMessageId: input.assistantMessageId,
    settledDraftReceiptsCursor: input.receiptsCursor,
    status: invalidated
      ? 'invalidated'
      : reusable || input.dshSessionId === null
        ? 'active'
        : 'interrupted',
    contextMode: input.resumed && !invalidated ? 'resumed' : 'rebuilt-history',
    updatedAt: input.now,
  });
};

/** 释放本轮认领；未确认落库的投递标记 interrupted，下一轮从可信历史重建。 */
export const abortDshTurn = async (
  repos: Pick<RepositoryRegistry, 'agentSessionBinding'>,
  input: { readonly conversationId: string; readonly runId: string; readonly now: Date },
): Promise<boolean> =>
  repos.agentSessionBinding.release({
    conversationId: input.conversationId,
    runId: input.runId,
    status: 'interrupted',
    contextMode: CONTEXT_MODE,
    updatedAt: input.now,
  });
