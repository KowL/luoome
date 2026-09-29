import {
  assertChatMessageInvariants,
  assertChatSessionInvariants,
  type ChatMessage,
  type ChatRepository,
  type ChatSession,
  InvariantError,
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
    const existing = this.messages.get(message.id);
    if (existing !== undefined && existing.sessionId !== message.sessionId) {
      throw new InvariantError('chat message 不可移动到其它会话');
    }
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

  async insertMessageIfAbsent(message: ChatMessage): Promise<boolean> {
    assertChatMessageInvariants(message);
    if (this.messages.has(message.id)) return false;
    if (!this.sessions.has(message.sessionId)) {
      throw new Error(`chat session 不存在: ${message.sessionId}`);
    }
    this.messages.set(message.id, message);
    return true;
  }

  async listMessages(sessionId: string, limit = 200): Promise<readonly ChatMessage[]> {
    return [...this.messages.values()]
      .filter((message) => message.sessionId === sessionId)
      .sort(
        (a, b) =>
          a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
      )
      .slice(-limit);
  }

  async findMessageById(sessionId: string, messageId: string): Promise<ChatMessage | null> {
    const message = this.messages.get(messageId);
    return message?.sessionId === sessionId ? message : null;
  }

  async compareAndSetMessageParts(
    message: ChatMessage,
    expectedParts: ChatMessage['parts'],
  ): Promise<boolean> {
    assertChatMessageInvariants(message);
    const current = this.messages.get(message.id);
    if (
      current?.sessionId !== message.sessionId ||
      JSON.stringify(current.parts) !== JSON.stringify(expectedParts)
    )
      return false;
    this.messages.set(message.id, { ...current, parts: message.parts });
    return true;
  }
}
