import { type ResearchNote, ResearchNoteSchema, ResearchStanceSchema } from '@luoome/core';
import { z } from 'zod';

import { defineTool, errNotFound } from '../define-tool.js';

export const UpdateResearchNoteInput = z.object({
  noteId: z.string().min(1),
  title: z.string().max(120).optional(),
  content: z.string().min(1).max(10000).optional(),
  stance: ResearchStanceSchema.optional(),
  tags: z.array(z.string().min(1).max(32)).max(16).optional(),
  /** thesis 专用：把本版本恢复为当前假设。 */
  setActive: z.boolean().optional(),
});

export const UpdateResearchNoteOutput = z.object({
  note: ResearchNoteSchema,
  /** thesis 内容/立场变更时返回被取代的旧版本。 */
  superseded: ResearchNoteSchema.optional(),
});

/**
 * update_research_note（ruo 迁移 §7.1，write）。
 *
 * - thesis 内容/立场变更 → 插入新版本行（supersedesId 串联，返回 superseded = 旧行）
 * - setActive=true → 恢复历史版本为当前假设（停用其它 thesis）
 * - 非内容字段（tags/title）原地更新；非 thesis 一律原地更新
 */
export const updateResearchNoteTool = defineTool({
  name: 'update_research_note',
  description: '更新研究笔记（thesis 内容变更插入新版本，历史版本保留在时间线）',
  sideEffect: 'write',
  input: UpdateResearchNoteInput,
  output: UpdateResearchNoteOutput,
  handler: async (input, ctx) => {
    const existing = await ctx.repos.researchNote.findById(input.noteId);
    if (existing === null) return errNotFound('ResearchNote', input.noteId);
    const now = ctx.clock();

    const contentChanged = input.content !== undefined && input.content !== existing.content;
    const stanceChanged = input.stance !== undefined && input.stance !== existing.stance;

    if (existing.kind === 'thesis' && (contentChanged || stanceChanged)) {
      // 插入新版本行（旧行由 repo.save(active thesis) 停用）
      const next: ResearchNote = {
        ...existing,
        id: `note_${globalThis.crypto.randomUUID().slice(0, 8)}`,
        content: input.content ?? existing.content,
        ...(input.stance !== undefined ? { stance: input.stance } : {}),
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.tags !== undefined ? { tags: input.tags } : {}),
        active: true,
        supersedesId: existing.id,
        createdAt: now,
        updatedAt: now,
      };
      await ctx.repos.researchNote.save(next);
      const supersededRow = await ctx.repos.researchNote.findById(existing.id);
      return { note: next, ...(supersededRow !== null ? { superseded: supersededRow } : {}) };
    }

    // 原地更新（含 setActive 恢复历史版本、非 thesis、仅 tags/title 改动）
    const updated: ResearchNote = {
      ...existing,
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.content !== undefined ? { content: input.content } : {}),
      ...(input.stance !== undefined ? { stance: input.stance } : {}),
      ...(input.tags !== undefined ? { tags: input.tags } : {}),
      ...(existing.kind === 'thesis' && input.setActive === true ? { active: true } : {}),
      updatedAt: now,
    };
    await ctx.repos.researchNote.save(updated);
    return { note: updated };
  },
});
