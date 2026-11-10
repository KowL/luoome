import { ReportSchema } from '@luoome/core';
import { z } from 'zod';

import { defineTool } from '../define-tool.js';
import { createResearchDocumentTool } from './research-vault.js';
import { saveReportTool } from './save-report.js';

export const SaveResearchDocumentInput = z.object({
  target: z.enum(['note', 'report']),
  note: z
    .object({
      title: z.string().trim().min(1).max(300),
      kind: z.enum([
        'analysis',
        'article',
        'filing',
        'note',
        'report',
        'thesis',
        'timeline-update',
        'transcript',
      ]),
      body: z.string().max(200_000),
      author: z.string().trim().max(200).optional(),
      sourceUrl: z.string().url().optional(),
      sourceStatus: z.enum(['verified', 'unverified']).optional(),
      publishedAt: z.coerce.date().optional(),
      observedAt: z.coerce.date().optional(),
      stockCodes: z.array(z.string().trim().min(1).max(32)).max(200).default([]),
      tags: z.array(z.string().trim().min(1).max(64)).max(32).default([]),
    })
    .optional(),
  report: ReportSchema.optional(),
  deliveryAttemptId: z.string().min(1).optional(),
});

export const SaveResearchDocumentOutput = z.record(z.string(), z.unknown());

export const saveResearchDocumentTool = defineTool({
  name: 'save_research_document',
  description:
    '保存结构化研究笔记（写入本地 Vault 并重建索引）或深度报告（合并 create_research_document + save_report）',
  sideEffect: 'write',
  input: SaveResearchDocumentInput,
  output: SaveResearchDocumentOutput,
  handler: async (input, ctx) => {
    if (input.target === 'note') {
      if (input.note === undefined) {
        return {
          ok: false as const,
          error: {
            kind: 'invalid_input' as const,
            message: 'target=note 时必须提供 note',
            issues: [],
          },
        };
      }
      const result = await createResearchDocumentTool.execute(input.note, ctx);
      if (!result.ok) return result;
      return { target: 'note', ...result.data };
    }
    if (input.report === undefined) {
      return {
        ok: false as const,
        error: {
          kind: 'invalid_input' as const,
          message: 'target=report 时必须提供 report',
          issues: [],
        },
      };
    }
    const result = await saveReportTool.execute(
      {
        report: input.report,
        ...(input.deliveryAttemptId === undefined
          ? {}
          : { deliveryAttemptId: input.deliveryAttemptId }),
      },
      ctx,
    );
    if (!result.ok) return result;
    return { target: 'report', ...result.data };
  },
});
