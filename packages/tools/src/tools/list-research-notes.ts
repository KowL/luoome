import { ResearchNoteKindSchema, ResearchNoteSchema } from '@luoome/core';
import { z } from 'zod';

import { defineTool } from '../define-tool.js';

export const ListResearchNotesInput = z.object({
  stockId: z.string().min(1),
  kind: ResearchNoteKindSchema.optional(),
  /** true 只返回当前生效假设（active thesis）。 */
  activeOnly: z.boolean().optional(),
  since: z.coerce.date().optional(),
  limit: z.number().int().positive().max(500).default(100),
});

export const ListResearchNotesOutput = z.object({
  notes: z.array(ResearchNoteSchema),
});

/** list_research_notes（ruo 迁移 §7.1，read）。 */
export const listResearchNotesTool = defineTool({
  name: 'list_research_notes',
  description: '查询某股票的研究笔记（thesis / note / source-summary，按时间倒序）',
  sideEffect: 'read',
  input: ListResearchNotesInput,
  output: ListResearchNotesOutput,
  handler: async (input, ctx) => {
    const notes = await ctx.repos.researchNote.listByStock(input.stockId, {
      ...(input.kind !== undefined ? { kind: input.kind } : {}),
      ...(input.activeOnly !== undefined ? { activeOnly: input.activeOnly } : {}),
      ...(input.since !== undefined ? { since: input.since } : {}),
      limit: input.limit,
    });
    return { notes: [...notes] };
  },
});
