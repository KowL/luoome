import { z } from 'zod';
import { InvariantError } from '../error/index.js';

/**
 * DSH 会话的执行绑定与投递游标（docs/ddd/dsh-plugin-platform-design.md §5.3、§7）。
 *
 * 记录一个产品会话在受控运行时中的执行身份（runtime session、profile/config 快照）
 * 和已确认送达的上下文水位。它是技术执行记录，不是产品历史：对话与草案确认仍以
 * ChatSession / ChatMessage 为权威，本实体只用于增量投递、续接判断和重启去重。
 */

export const AgentSessionBindingStatusSchema = z.enum(['active', 'interrupted', 'invalidated']);
export type AgentSessionBindingStatus = z.infer<typeof AgentSessionBindingStatusSchema>;

/**
 * 上下文构建方式。当前 Host 每次运行使用独立 DSH_HOME（D07 隔离与清理），
 * 没有可 resume 的持久会话日志，因此只产生 rebuilt-history；
 * resumed 留给 SDK 持久会话落地后再启用，不能只凭复用 sessionId 声称恢复。
 */
export const AgentSessionContextModeSchema = z.enum(['rebuilt-history', 'resumed']);
export type AgentSessionContextMode = z.infer<typeof AgentSessionContextModeSchema>;

export const AgentSessionBindingSchema = z.object({
  conversationId: z.string().min(1).max(100),
  accountId: z.string().min(1).max(100),
  /** 场景/Agent 定义（例如 general、portfolio）。 */
  agentDefinitionId: z.string().min(1).max(100),
  dshSessionId: z.string().min(1).max(256).nullable(),
  profileHash: z.string().min(1).max(128).nullable(),
  configHash: z.string().min(1).max(128).nullable(),
  /** 已送达运行时的最后一条 chat message id；null 表示尚未确认送达。 */
  lastSyncedMessageId: z.string().min(1).max(200).nullable(),
  /** 已送达的最后一个草案确认回执键 `${messageId}:${toolCallId}`。 */
  settledDraftReceiptsCursor: z.string().min(1).max(400).nullable(),
  status: AgentSessionBindingStatusSchema,
  contextMode: AgentSessionContextModeSchema,
  /** 本轮投递认领；非空表示有一次运行尚未确认完成。 */
  pendingRunId: z.string().min(1).max(100).nullable(),
  /** 本轮预期的 assistant message id；用于崩溃后判定结果是否已物化。 */
  pendingAssistantMessageId: z.string().min(1).max(200).nullable(),
  pendingMessageId: z.string().min(1).max(200).nullable(),
  pendingReceiptsCursor: z.string().min(1).max(400).nullable(),
  pendingClaimedAt: z.coerce.date().nullable(),
  updatedAt: z.coerce.date(),
});
export type AgentSessionBinding = z.infer<typeof AgentSessionBindingSchema>;

export const assertAgentSessionBindingInvariants = (binding: AgentSessionBinding): void => {
  const required = [
    binding.pendingRunId,
    binding.pendingAssistantMessageId,
    binding.pendingClaimedAt,
  ];
  const claimed = required.filter((value) => value !== null).length;
  if (claimed !== 0 && claimed !== required.length) {
    throw new InvariantError('agent session binding 的 pending 投递字段必须同时存在');
  }
  if (
    binding.pendingRunId === null &&
    (binding.pendingMessageId !== null || binding.pendingReceiptsCursor !== null)
  ) {
    throw new InvariantError('agent session binding 没有 pending run 时不得残留投递游标');
  }
  if (binding.status === 'invalidated' && binding.dshSessionId !== null) {
    throw new InvariantError('invalidated binding 不得保留 dshSessionId');
  }
  if (binding.pendingClaimedAt !== null && binding.pendingClaimedAt > binding.updatedAt) {
    throw new InvariantError('agent session binding pendingClaimedAt > updatedAt');
  }
};
