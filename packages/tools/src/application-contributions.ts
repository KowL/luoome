import type { ToolContributions } from '@luoome/toolkit';
import { settleChatDraftTool } from './tools/settle-chat-draft.js';

export const applicationToolContributions = {
  settle_chat_draft: { owner: 'platform.chat', tool: settleChatDraftTool, agent: false },
} as const satisfies ToolContributions;
