import { z } from 'zod';

import { defineTool, errNotFound } from '../define-tool.js';

export const DeleteResearchNoteInput = z.object({
  noteId: z.string().min(1),
});

export const DeleteResearchNoteOutput = z.object({
  ok: z.literal(true),
});

/**
 * delete_research_note（ruo 迁移 §7.1，write）。
 * 只删笔记，不动关联实体；删 active thesis 后该股票无当前假设（不自动复活旧版本）。
 */
export const deleteResearchNoteTool = defineTool({
  name: 'delete_research_note',
  description: '删除研究笔记（不连锁关联实体；删当前 thesis 后不自动复活旧版本）',
  sideEffect: 'write',
  input: DeleteResearchNoteInput,
  output: DeleteResearchNoteOutput,
  handler: async (input, ctx) => {
    const existing = await ctx.repos.researchNote.findById(input.noteId);
    if (existing === null) return errNotFound('ResearchNote', input.noteId);
    await ctx.repos.researchNote.remove(input.noteId);
    return { ok: true as const };
  },
});
