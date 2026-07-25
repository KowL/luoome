import {
  CitationSchema,
  type ResearchNote,
  ResearchNoteKindSchema,
  ResearchNoteSchema,
  ResearchStanceSchema,
} from '@luoome/core';
import { z } from 'zod';

import { defineTool, errInvalidInput } from '../define-tool.js';

export const AddResearchNoteInput = z.object({
  stockId: z.string().min(1),
  kind: ResearchNoteKindSchema,
  title: z.string().max(120).optional(),
  content: z.string().min(1).max(10000),
  stance: ResearchStanceSchema.optional(),
  tags: z.array(z.string().min(1).max(32)).max(16).optional(),
  sourceUrl: z.string().url().optional(),
  sourceTitle: z.string().max(300).optional(),
  sourceStatus: z.enum(['verified', 'unverified']).optional(),
  fetchedAt: z.coerce.date().optional(),
  citations: z.array(CitationSchema).max(16).optional(),
  relatedHoldingId: z.string().optional(),
  relatedAdviceId: z.string().optional(),
  relatedWatchTriggerId: z.string().optional(),
});

export const AddResearchNoteOutput = z.object({
  note: ResearchNoteSchema,
});

/**
 * add_research_note（ruo 迁移 §7.1，write）。
 *
 * - kind=thesis → 自动 active=true，repo 停用同股旧 thesis
 * - kind=source-summary → sourceUrl / fetchedAt 必填；sourceStatus 缺省 'unverified'
 */
export const addResearchNoteTool = defineTool({
  name: 'add_research_note',
  description: '新增研究笔记（thesis 自动设为当前假设并停用旧版本）',
  sideEffect: 'write',
  input: AddResearchNoteInput,
  output: AddResearchNoteOutput,
  handler: async (input, ctx) => {
    if (input.kind === 'source-summary') {
      if (input.sourceUrl === undefined) return errInvalidInput('source-summary 笔记必须提供 sourceUrl');
      if (input.fetchedAt === undefined) return errInvalidInput('source-summary 笔记必须提供 fetchedAt');
    }
    const now = ctx.clock();
    const note: ResearchNote = {
      id: `note_${globalThis.crypto.randomUUID().slice(0, 8)}`,
      stockId: input.stockId,
      kind: input.kind,
      ...(input.title !== undefined ? { title: input.title } : {}),
      content: input.content,
      ...(input.stance !== undefined ? { stance: input.stance } : {}),
      active: input.kind === 'thesis',
      ...(input.sourceUrl !== undefined ? { sourceUrl: input.sourceUrl } : {}),
      ...(input.sourceTitle !== undefined ? { sourceTitle: input.sourceTitle } : {}),
      ...(input.kind === 'source-summary'
        ? { sourceStatus: input.sourceStatus ?? 'unverified' }
        : input.sourceStatus !== undefined
          ? { sourceStatus: input.sourceStatus }
          : {}),
      ...(input.fetchedAt !== undefined ? { fetchedAt: input.fetchedAt } : {}),
      ...(input.citations !== undefined ? { citations: input.citations } : {}),
      ...(input.relatedHoldingId !== undefined ? { relatedHoldingId: input.relatedHoldingId } : {}),
      ...(input.relatedAdviceId !== undefined ? { relatedAdviceId: input.relatedAdviceId } : {}),
      ...(input.relatedWatchTriggerId !== undefined
        ? { relatedWatchTriggerId: input.relatedWatchTriggerId }
        : {}),
      tags: input.tags ?? [],
      createdAt: now,
      updatedAt: now,
    };
    await ctx.repos.researchNote.save(note);
    return { note };
  },
});
