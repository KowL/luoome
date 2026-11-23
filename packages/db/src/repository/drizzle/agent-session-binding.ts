import {
  type AgentSessionBinding,
  type AgentSessionBindingRepository,
  type AgentSessionBindingStatus,
  type AgentSessionContextMode,
  assertAgentSessionBindingInvariants,
} from '@luoome/core';
import { and, asc, eq, isNull, or } from 'drizzle-orm';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';
import { agentSessionBindings, type Schema } from '../../schema/index.js';

type BindingRow = typeof agentSessionBindings.$inferSelect;

const toBinding = (row: BindingRow): AgentSessionBinding => ({
  conversationId: row.conversationId,
  accountId: row.accountId,
  agentDefinitionId: row.agentDefinitionId,
  dshSessionId: row.dshSessionId,
  profileHash: row.profileHash,
  configHash: row.configHash,
  lastSyncedMessageId: row.lastSyncedMessageId,
  settledDraftReceiptsCursor: row.settledDraftReceiptsCursor,
  status: row.status,
  contextMode: row.contextMode,
  pendingRunId: row.pendingRunId,
  pendingAssistantMessageId: row.pendingAssistantMessageId,
  pendingMessageId: row.pendingMessageId,
  pendingReceiptsCursor: row.pendingReceiptsCursor,
  pendingClaimedAt: row.pendingClaimedAt,
  updatedAt: row.updatedAt,
});

const toRow = (binding: AgentSessionBinding): typeof agentSessionBindings.$inferInsert => ({
  conversationId: binding.conversationId,
  accountId: binding.accountId,
  agentDefinitionId: binding.agentDefinitionId,
  dshSessionId: binding.dshSessionId,
  profileHash: binding.profileHash,
  configHash: binding.configHash,
  lastSyncedMessageId: binding.lastSyncedMessageId,
  settledDraftReceiptsCursor: binding.settledDraftReceiptsCursor,
  status: binding.status,
  contextMode: binding.contextMode,
  pendingRunId: binding.pendingRunId,
  pendingAssistantMessageId: binding.pendingAssistantMessageId,
  pendingMessageId: binding.pendingMessageId,
  pendingReceiptsCursor: binding.pendingReceiptsCursor,
  pendingClaimedAt: binding.pendingClaimedAt,
  updatedAt: binding.updatedAt,
});

/** DSH 执行绑定：claim / commit / release 都以 pendingRunId 做条件更新（跨进程单轮串行）。 */
export class DrizzleAgentSessionBindingRepository implements AgentSessionBindingRepository {
  constructor(private readonly db: BunSQLiteDatabase<Schema>) {}

  async findByConversation(conversationId: string): Promise<AgentSessionBinding | null> {
    const row = this.db
      .select()
      .from(agentSessionBindings)
      .where(eq(agentSessionBindings.conversationId, conversationId))
      .get();
    return row === undefined ? null : toBinding(row);
  }

  async save(binding: AgentSessionBinding): Promise<void> {
    assertAgentSessionBindingInvariants(binding);
    const row = toRow(binding);
    this.db
      .insert(agentSessionBindings)
      .values(row)
      .onConflictDoUpdate({ target: agentSessionBindings.conversationId, set: row })
      .run();
  }

  async list(options?: { readonly accountId?: string }): Promise<readonly AgentSessionBinding[]> {
    const rows = this.db
      .select()
      .from(agentSessionBindings)
      .where(
        options?.accountId === undefined
          ? undefined
          : eq(agentSessionBindings.accountId, options.accountId),
      )
      .orderBy(asc(agentSessionBindings.updatedAt))
      .all();
    return rows.map(toBinding);
  }

  async claim(binding: AgentSessionBinding): Promise<boolean> {
    assertAgentSessionBindingInvariants(binding);
    const row = toRow(binding);
    return (
      this.db
        .update(agentSessionBindings)
        .set(row)
        .where(
          and(
            eq(agentSessionBindings.conversationId, binding.conversationId),
            binding.pendingRunId === null
              ? isNull(agentSessionBindings.pendingRunId)
              : or(
                  isNull(agentSessionBindings.pendingRunId),
                  eq(agentSessionBindings.pendingRunId, binding.pendingRunId),
                ),
          ),
        )
        .returning({ conversationId: agentSessionBindings.conversationId })
        .all().length === 1
    );
  }

  async commit(input: {
    readonly conversationId: string;
    readonly runId: string;
    readonly dshSessionId: string | null;
    readonly profileHash: string | null;
    readonly configHash: string | null;
    readonly lastSyncedMessageId: string | null;
    readonly settledDraftReceiptsCursor: string | null;
    readonly status: AgentSessionBindingStatus;
    readonly contextMode: AgentSessionContextMode;
    readonly updatedAt: Date;
  }): Promise<boolean> {
    return (
      this.db
        .update(agentSessionBindings)
        .set({
          dshSessionId: input.dshSessionId,
          profileHash: input.profileHash,
          configHash: input.configHash,
          lastSyncedMessageId: input.lastSyncedMessageId,
          settledDraftReceiptsCursor: input.settledDraftReceiptsCursor,
          status: input.status,
          contextMode: input.contextMode,
          pendingRunId: null,
          pendingAssistantMessageId: null,
          pendingMessageId: null,
          pendingReceiptsCursor: null,
          pendingClaimedAt: null,
          updatedAt: input.updatedAt,
        })
        .where(
          and(
            eq(agentSessionBindings.conversationId, input.conversationId),
            eq(agentSessionBindings.pendingRunId, input.runId),
          ),
        )
        .returning({ conversationId: agentSessionBindings.conversationId })
        .all().length === 1
    );
  }

  async release(input: {
    readonly conversationId: string;
    readonly runId: string;
    readonly status: AgentSessionBindingStatus;
    readonly contextMode: AgentSessionContextMode;
    readonly updatedAt: Date;
  }): Promise<boolean> {
    return (
      this.db
        .update(agentSessionBindings)
        .set({
          pendingRunId: null,
          pendingAssistantMessageId: null,
          pendingMessageId: null,
          pendingReceiptsCursor: null,
          pendingClaimedAt: null,
          status: input.status,
          contextMode: input.contextMode,
          updatedAt: input.updatedAt,
        })
        .where(
          and(
            eq(agentSessionBindings.conversationId, input.conversationId),
            eq(agentSessionBindings.pendingRunId, input.runId),
          ),
        )
        .returning({ conversationId: agentSessionBindings.conversationId })
        .all().length === 1
    );
  }

  async remove(conversationId: string): Promise<void> {
    this.db
      .delete(agentSessionBindings)
      .where(eq(agentSessionBindings.conversationId, conversationId))
      .run();
  }
}
