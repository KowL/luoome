import type { ToolContributions } from '@luoome/toolkit';

import { collectForumDigestTool } from './tools/collect-forum-digest.js';

export const forumToolContributions = {
  collect_forum_digest: {
    execution: 'p3',
    owner: 'business.forum',
    tool: collectForumDigestTool,
    agent: false,
  },
} as const satisfies ToolContributions;
