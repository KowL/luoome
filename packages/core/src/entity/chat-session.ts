import { z } from 'zod';
import { InvariantError } from '../error/index.js';

export const ChatSessionSchema = z.object({
  id: z.string().min(1).max(100),
  accountId: z.string().max(100),
  title: z.string().trim().min(1).max(80),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});
export type ChatSession = z.infer<typeof ChatSessionSchema>;

export const ChatMessagePartSchema = z
  .record(z.string(), z.unknown())
  .refine((part) => typeof part.type === 'string', 'chat message part.type 必须是 string');
export type ChatMessagePart = z.infer<typeof ChatMessagePartSchema>;

export const ChatMessageSchema = z.object({
  id: z.string().min(1).max(200),
  sessionId: z.string().min(1).max(100),
  role: z.enum(['user', 'assistant']),
  parts: z.array(ChatMessagePartSchema).min(1).max(100),
  createdAt: z.coerce.date(),
});
export type ChatMessage = z.infer<typeof ChatMessageSchema>;

export const assertChatSessionInvariants = (session: ChatSession): void => {
  if (session.updatedAt.getTime() < session.createdAt.getTime()) {
    throw new InvariantError('chat session updatedAt < createdAt');
  }
};

export const assertChatMessageInvariants = (message: ChatMessage): void => {
  const hasText = message.parts.some(
    (part) => part.type === 'text' && typeof part.text === 'string' && part.text.trim().length > 0,
  );
  if (!hasText && message.role === 'user') {
    throw new InvariantError('user chat message 必须包含非空 text part');
  }
};
