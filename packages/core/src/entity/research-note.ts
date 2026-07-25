import { z } from 'zod';

import { InvariantError } from '../error/index.js';

/**
 * 研究档案笔记（ruo 能力迁移 Phase 1A，docs/ddd/ruo-feature-migration-detailed-design.md §3.1）。
 *
 * 事实 / 观点 / 建议分层：ResearchNote 承载「观点」（thesis / note / source-summary），
 * 与 StockEvent（事实）、Advice（建议）互不嵌入。
 *
 * - thesis（当前假设）：同 stockId 至多一条 active=true；编辑内容 = 插入新版本行，
 *   supersedesId 串联旧版本，历史保留在时间线。
 * - source-summary（来源摘要）：sourceUrl / fetchedAt 必填；无法验证来源 → sourceStatus='unverified'。
 * - note（普通笔记）：自由文本，恒 active=false。
 */

export const ResearchNoteKindSchema = z.enum(['thesis', 'note', 'source-summary']);
export type ResearchNoteKind = z.infer<typeof ResearchNoteKindSchema>;

export const ResearchStanceSchema = z.enum(['bullish', 'bearish', 'neutral']);
export type ResearchStance = z.infer<typeof ResearchStanceSchema>;

/** 引用来源：标题 + URL + 可选摘录。 */
export const CitationSchema = z.object({
  title: z.string().min(1),
  url: z.string().url(),
  quote: z.string().max(500).optional(),
});
export type Citation = z.infer<typeof CitationSchema>;

export const ResearchNoteSchema = z.object({
  /** note_${uuid8}。 */
  id: z.string().min(1),
  stockId: z.string().min(1),
  kind: ResearchNoteKindSchema,
  title: z.string().max(120).optional(),
  content: z.string().min(1).max(10000),
  stance: ResearchStanceSchema.optional(),
  /** thesis 专用：当前生效假设；非 thesis 恒 false。 */
  active: z.boolean().default(false),
  /** thesis 专用：本版本取代的上一条 id。 */
  supersedesId: z.string().optional(),
  sourceUrl: z.string().url().optional(),
  sourceTitle: z.string().max(300).optional(),
  sourceStatus: z.enum(['verified', 'unverified']).optional(),
  fetchedAt: z.coerce.date().optional(),
  citations: z.array(CitationSchema).max(16).optional(),
  relatedHoldingId: z.string().optional(),
  relatedAdviceId: z.string().optional(),
  relatedWatchTriggerId: z.string().optional(),
  tags: z.array(z.string().min(1).max(32)).max(16).default([]),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});

export type ResearchNote = z.infer<typeof ResearchNoteSchema>;

/**
 * 研究档案笔记不变量（docs/.../§3.1）。
 *
 * 仅断言单实体可校验的约束；跨实体约束（同 stockId active 唯一、supersedesId 指向同股 thesis
 * 且不成环）由 repo 事务 / tool 层保证。
 *
 * - kind='source-summary' → sourceUrl / fetchedAt 必填；无法验证来源时 sourceStatus 应为 'unverified'
 * - kind≠'thesis' → active=false、supersedesId 为空
 * - updatedAt ≥ createdAt
 */
export const assertResearchNoteInvariants = (note: ResearchNote): void => {
  if (note.updatedAt.getTime() < note.createdAt.getTime()) {
    throw new InvariantError('research note updatedAt < createdAt');
  }
  if (note.kind === 'source-summary') {
    if (note.sourceUrl === undefined) {
      throw new InvariantError('source-summary 笔记必须有 sourceUrl');
    }
    if (note.fetchedAt === undefined) {
      throw new InvariantError('source-summary 笔记必须有 fetchedAt');
    }
  }
  if (note.kind !== 'thesis') {
    if (note.active) {
      throw new InvariantError(`非 thesis 笔记 active 必须为 false（kind=${note.kind}）`);
    }
    if (note.supersedesId !== undefined) {
      throw new InvariantError(`非 thesis 笔记不能有 supersedesId（kind=${note.kind}）`);
    }
  }
};
