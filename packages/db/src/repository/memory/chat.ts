import {
  assertChatMessageInvariants,
  assertChatSessionInvariants,
  type ChatMessage,
  type ChatRepository,
  type ChatSession,
} from '@luoome/core';

export class InMemoryChatRepository implements ChatRepository {
  private readonly sessions = new Map<string, ChatSession>();
  private readonly messages = new Map<string, ChatMessage>();

  putSession(session: ChatSession): void {
    assertChatSessionInvariants(session);
    this.sessions.set(session.id, session);
  }

  putMessage(message: ChatMessage): void {
    assertChatMessageInvariants(message);
    this.messages.set(message.id, message);
  }

  async saveSession(session: ChatSession): Promise<void> {
    this.putSession(session);
  }

  async findSessionById(id: string): Promise<ChatSession | null> {
    return this.sessions.get(id) ?? null;
  }

  async listSessions(accountId: string, limit = 100): Promise<readonly ChatSession[]> {
    return [...this.sessions.values()]
      .filter((session) => session.accountId === accountId)
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
      .slice(0, limit);
  }

  async removeSession(id: string): Promise<void> {
    this.sessions.delete(id);
    for (const [messageId, message] of this.messages) {
      if (message.sessionId === id) this.messages.delete(messageId);
    }
  }

  async saveMessage(message: ChatMessage): Promise<void> {
    if (!this.sessions.has(message.sessionId)) {
      throw new Error(`chat session 不存在: ${message.sessionId}`);
    }
    this.putMessage(message);
  }

  async listMessages(sessionId: string, limit = 200): Promise<readonly ChatMessage[]> {
    return [...this.messages.values()]
      .filter((message) => message.sessionId === sessionId)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .slice(-limit);
  }
}
