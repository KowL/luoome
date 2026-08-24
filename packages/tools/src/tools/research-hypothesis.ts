import {
  ResearchContentHashSchema,
  type ResearchHypothesisVersion,
  ResearchHypothesisVersionSchema,
} from '@luoome/core';
import { z } from 'zod';

import { defineTool, errInvalidInput, errNotFound } from '../define-tool.js';

const topicIdSchema = z.string().regex(/^topic_[A-Za-z0-9_-]+$/);
const documentIdSchema = z.string().regex(/^doc_[A-Za-z0-9_-]+$/);

export const CreateResearchHypothesisVersionInput = z.object({
  topicId: topicIdSchema,
  documentId: documentIdSchema,
  documentContentHash: ResearchContentHashSchema,
  summary: z.string().trim().min(1).max(2000).optional(),
});

export const CreateResearchHypothesisVersionOutput = z.object({
  hypothesisVersion: ResearchHypothesisVersionSchema,
});

const hypothesisId = (): string =>
  `hypothesis_${globalThis.crypto.randomUUID().replaceAll('-', '').slice(0, 20)}`;

export const createResearchHypothesisVersionTool = defineTool({
  name: 'create_research_hypothesis_version',
  description: '基于 Topic 的 thesis ResearchDocument 创建不可变研究假设版本',
  sideEffect: 'write',
  input: CreateResearchHypothesisVersionInput,
  output: CreateResearchHypothesisVersionOutput,
  handler: async (input, ctx) => {
    const topic = await ctx.repos.researchIndex.findTopic(input.topicId);
    if (topic === null) return errNotFound('ResearchTopic', input.topicId);
    const document = await ctx.repos.researchIndex.findDocument(input.documentId);
    if (document === null) return errNotFound('ResearchDocument', input.documentId);
    if (document.kind !== 'thesis') {
      return errInvalidInput('ResearchHypothesisVersion 只能引用 kind=thesis 的 ResearchDocument');
    }
    if (document.contentHash !== input.documentContentHash) {
      return errInvalidInput('ResearchDocument.contentHash 已变化，请重新同步后重试');
    }

    const existing = await ctx.repos.researchHypothesisVersion.list({
      topicId: topic.id,
      limit: Number.MAX_SAFE_INTEGER,
    });
    const latest = existing[0];
    const version: ResearchHypothesisVersion = {
      id: hypothesisId(),
      topicId: topic.id,
      documentId: document.id,
      documentContentHash: input.documentContentHash,
      version: (latest?.version ?? 0) + 1,
      status: 'active',
      ...(latest === undefined ? {} : { supersedesId: latest.id }),
      ...(input.summary === undefined ? {} : { summary: input.summary }),
      createdAt: ctx.clock(),
    };
    await ctx.repos.researchHypothesisVersion.create(version);
    return { hypothesisVersion: version };
  },
});

export const ListResearchHypothesisVersionsInput = z.object({
  topicId: topicIdSchema.optional(),
  status: ResearchHypothesisVersionSchema.shape.status.optional(),
  limit: z.number().int().positive().max(500).default(100),
});

export const ListResearchHypothesisVersionsOutput = z.object({
  hypothesisVersions: z.array(ResearchHypothesisVersionSchema),
});

export const listResearchHypothesisVersionsTool = defineTool({
  name: 'list_research_hypothesis_versions',
  description: '查询 Topic 级研究假设版本（按 version 倒序）',
  sideEffect: 'read',
  input: ListResearchHypothesisVersionsInput,
  output: ListResearchHypothesisVersionsOutput,
  handler: async (input, ctx) => ({
    hypothesisVersions: [
      ...(await ctx.repos.researchHypothesisVersion.list({
        ...(input.topicId === undefined ? {} : { topicId: input.topicId }),
        ...(input.status === undefined ? {} : { status: input.status }),
        limit: input.limit,
      })),
    ],
  }),
});
