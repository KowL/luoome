import {
  assertChatMessageInvariants,
  assertChatSessionInvariants,
  type ChatMessage,
  type ChatRepository,
  type ChatSession,
  InvariantError,
} from '@luoome/core';
import { and, desc, eq } from 'drizzle-orm';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';
import { chatMessages, chatSessions, type Schema } from '../../schema/index.js';

export class DrizzleChatRepository implements ChatRepository {
  constructor(private readonly db: BunSQLiteDatabase<Schema>) {}

  async saveSession(session: ChatSession): Promise<void> {
    assertChatSessionInvariants(session);
    this.db
      .insert(chatSessions)
      .values(session)
      .onConflictDoUpdate({ target: chatSessions.id, set: session })
      .run();
  }

  async findSessionById(id: string): Promise<ChatSession | null> {
    return this.db.select().from(chatSessions).where(eq(chatSessions.id, id)).get() ?? null;
  }

  async listSessions(accountId: string, limit = 100): Promise<readonly ChatSession[]> {
    return this.db
      .select()
      .from(chatSessions)
      .where(eq(chatSessions.accountId, accountId))
      .orderBy(desc(chatSessions.updatedAt))
      .limit(limit)
      .all();
  }

  async removeSession(id: string): Promise<void> {
    this.db.transaction((tx) => {
      tx.delete(chatMessages).where(eq(chatMessages.sessionId, id)).run();
      tx.delete(chatSessions).where(eq(chatSessions.id, id)).run();
    });
  }

  async saveMessage(message: ChatMessage): Promise<void> {
    assertChatMessageInvariants(message);
    this.db.transaction((tx) => {
      const existing = tx.select().from(chatMessages).where(eq(chatMessages.id, message.id)).get();
      if (existing !== undefined && existing.sessionId !== message.sessionId) {
        throw new InvariantError('chat message 不可移动到其它会话');
      }
      tx.insert(chatMessages)
        .values(message)
        .onConflictDoUpdate({ target: chatMessages.id, set: message })
        .run();
    });
  }

  async insertMessageIfAbsent(message: ChatMessage): Promise<boolean> {
    assertChatMessageInvariants(message);
    return (
      this.db
        .insert(chatMessages)
        .values(message)
        .onConflictDoNothing({ target: chatMessages.id })
        .returning({ id: chatMessages.id })
        .all().length === 1
    );
  }

  async listMessages(sessionId: string, limit = 200): Promise<readonly ChatMessage[]> {
    return this.db
      .select()
      .from(chatMessages)
      .where(eq(chatMessages.sessionId, sessionId))
      .orderBy(desc(chatMessages.createdAt), desc(chatMessages.id))
      .limit(limit)
      .all()
      .reverse()
      .map((message) => ({ ...message, parts: [...message.parts] }));
  }

  async findMessageById(sessionId: string, messageId: string): Promise<ChatMessage | null> {
    const message = this.db
      .select()
      .from(chatMessages)
      .where(and(eq(chatMessages.id, messageId), eq(chatMessages.sessionId, sessionId)))
      .get();
    return message === undefined ? null : { ...message, parts: [...message.parts] };
  }

  async compareAndSetMessageParts(
    message: ChatMessage,
    expectedParts: ChatMessage['parts'],
  ): Promise<boolean> {
    assertChatMessageInvariants(message);
    return (
      this.db
        .update(chatMessages)
        .set({ parts: message.parts })
        .where(
          and(
            eq(chatMessages.id, message.id),
            eq(chatMessages.sessionId, message.sessionId),
            eq(chatMessages.parts, expectedParts),
          ),
        )
        .returning({ id: chatMessages.id })
        .all().length === 1
    );
  }
}
