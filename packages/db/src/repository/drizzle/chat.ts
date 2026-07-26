import {
  assertChatMessageInvariants,
  assertChatSessionInvariants,
  type ChatMessage,
  type ChatRepository,
  type ChatSession,
} from '@luoome/core';
import { asc, desc, eq } from 'drizzle-orm';
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
    this.db
      .insert(chatMessages)
      .values(message)
      .onConflictDoUpdate({ target: chatMessages.id, set: message })
      .run();
  }

  async listMessages(sessionId: string, limit = 200): Promise<readonly ChatMessage[]> {
    return this.db
      .select()
      .from(chatMessages)
      .where(eq(chatMessages.sessionId, sessionId))
      .orderBy(asc(chatMessages.createdAt))
      .limit(limit)
      .all()
      .map((message) => ({ ...message, parts: [...message.parts] }));
  }
}
