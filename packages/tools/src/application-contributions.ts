import type { ToolContributions } from '@luoome/toolkit';
import { saveResearchDocumentTool } from './tools/save-research-document.js';
import { settleChatDraftTool } from './tools/settle-chat-draft.js';

export const applicationToolContributions = {
  save_research_document: {
    owner: 'business.research',
    tool: saveResearchDocumentTool,
    agent: true,
    dependencies: ['researchVault'],
  },
  settle_chat_draft: { owner: 'platform.chat', tool: settleChatDraftTool, agent: false },
} as const satisfies ToolContributions;
