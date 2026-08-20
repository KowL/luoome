import { createHash } from 'node:crypto';

import { parseResearchMarkdown } from '@luoome/adapters';
import {
  AdviceSchema,
  EvidenceRefSchema,
  normalizeResearchSubject,
  ResearchBriefSchema,
  type ResearchDocumentChunk,
  type ResearchDocumentIndex,
  ResearchDocumentIndexSchema,
  ResearchDocumentKindSchema,
  type ResearchIndexStatus,
  type ResearchSubjectLink,
  ResearchSubjectLinkSchema,
  type ResearchTopicDocument,
  ResearchTopicDocumentSchema,
  type ResearchTopicIndex,
  ResearchTopicIndexSchema,
  ResearchTopicKindSchema,
  type ResearchVaultEntry,
  type ResearchVaultSyncRun,
  researchDocumentDate,
  StockEventSchema,
  type StockResearchProfileFact,
  StockResearchProfileSchema,
  StrategySignalSchema,
  type ToolContext,
  TradeSchema,
  WatchTriggerSchema,
} from '@luoome/core';
import { z } from 'zod';

import { defineTool, errAdapterError, errInvalidInput, errNotFound } from '../define-tool.js';
import {
  currentLimitUpDate,
  loadStockLimitUpFacts,
  StockLimitUpFactsSchema,
} from '../internal/limit-up-facts.js';
import {
  readStrategySignalsByStock,
  StrategySignalScopeSchema,
} from '../internal/strategy-signal-scope.js';

const availability = z.enum(['available', 'missing', 'invalid', 'conflict']);
const indexStatusSchema = z.object({
  vaultId: z.string(),
  freshness: z.enum(['fresh', 'stale', 'unavailable']),
  lastSyncAt: z.coerce.date().optional(),
  diagnostic: z.string().optional(),
});
const topicSummary = ResearchTopicIndexSchema;
const documentSummary = ResearchDocumentIndexSchema;
const timelineItem = z.object({
  id: z.string().min(1),
  kind: z.enum([
    'topic',
    'document',
    'stock-event',
    'strategy-signal',
    'watch-trigger',
    'advice',
    'trade',
    'limit-up',
  ]),
  occurredAt: z.coerce.date(),
  title: z.string().min(1),
  summary: z.string().optional(),
});
const topicSections = z.object({
  evidence: z.array(z.string().max(500)).max(20),
  counterEvidence: z.array(z.string().max(500)).max(20),
  unresolved: z.array(z.string().max(500)).max(20),
});

const extractTopicSections = (body: string): z.infer<typeof topicSections> => {
  const sections: Record<keyof z.infer<typeof topicSections>, string[]> = {
    evidence: [],
    counterEvidence: [],
    unresolved: [],
  };
  let current: keyof z.infer<typeof topicSections> | null = null;
  const headingMap: Record<string, keyof z.infer<typeof topicSections>> = {
    支持证据: 'evidence',
    证据: 'evidence',
    反证与风险: 'counterEvidence',
    反证: 'counterEvidence',
    待验证问题: 'unresolved',
    未解决问题: 'unresolved',
  };
  for (const rawLine of body.split('\n')) {
    const heading = rawLine.match(/^#{1,6}\s+(.+)$/)?.[1]?.trim();
    if (heading !== undefined) {
      current = headingMap[heading] ?? null;
      continue;
    }
    if (current === null) continue;
    const value = rawLine.replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+)/, '').trim();
    if (value.length > 0 && !value.startsWith('```')) sections[current].push(value.slice(0, 500));
  }
  return topicSections.parse(sections);
};
type Frontmatter = Record<string, string | string[] | undefined>;

const vaultRequired = (ctx: ToolContext) =>
  ctx.researchVault
    ? null
    : errAdapterError('research-vault', '未配置 LUOOME_RESEARCH_VAULT', false);

const listValue = (value: string | string[] | undefined): string[] =>
  Array.isArray(value) ? value : value ? [value] : [];

const field = (frontmatter: Frontmatter, key: string): string | string[] | undefined =>
  frontmatter[key];

const date = (value: string | string[] | undefined): Date | undefined =>
  typeof value === 'string' && value ? new Date(value) : undefined;

const documentChunks = (
  documentId: string,
  contentHash: string,
  body: string,
): ResearchDocumentChunk[] => {
  const targetSize = 2000;
  const overlap = 100;
  const output: ResearchDocumentChunk[] = [];
  let heading = '';
  let buffer: string[] = [];
  const push = (text: string): void => {
    if (text) {
      output.push({
        documentId,
        ordinal: output.length,
        headingPath: heading,
        contentHash,
        body: text,
      });
    }
  };
  const flush = (): void => {
    push(buffer.join('\n').trim());
    buffer = [];
  };
  const append = (line: string): void => {
    const lineChars = [...line];
    if (lineChars.length > targetSize) {
      flush();
      for (let start = 0; start < lineChars.length; start += targetSize - overlap) {
        push(
          lineChars
            .slice(start, start + targetSize)
            .join('')
            .trim(),
        );
        if (start + targetSize >= lineChars.length) break;
      }
      return;
    }
    const nextLength =
      buffer.length === 0 ? lineChars.length : buffer.join('\n').length + 1 + lineChars.length;
    if (nextLength > targetSize) flush();
    buffer.push(line);
  };
  for (const line of body.split('\n')) {
    const match = line.match(/^(#{1,6})\s+(.+)$/);
    if (match?.[2] !== undefined) {
      flush();
      heading = match[2].trim();
    }
    append(line);
  }
  flush();
  return output;
};

const subjectLinks = (
  ownerKind: 'topic' | 'document',
  ownerId: string,
  frontmatter: Frontmatter,
): ResearchSubjectLink[] => {
  const mapping: ReadonlyArray<[string, ResearchSubjectLink['relation']]> = [
    ['primary_subjects', 'primary'],
    ['subjects', 'related'],
    ['mentioned_subjects', 'mentioned'],
    ['evidence_subjects', 'evidence'],
  ];
  const result: ResearchSubjectLink[] = [];
  for (const [key, relation] of mapping) {
    for (const raw of listValue(field(frontmatter, key))) {
      const normalized = normalizeResearchSubject(raw);
      result.push({
        ownerKind,
        ownerId,
        subjectKind: normalized.kind,
        subjectKey: normalized.key,
        relation,
      });
    }
  }
  return result;
};

interface ParsedEntry {
  readonly topic?: ResearchTopicIndex;
  readonly document?: ResearchDocumentIndex;
  readonly links: readonly ResearchSubjectLink[];
  readonly relations: readonly ResearchTopicDocument[];
  readonly chunks: readonly ResearchDocumentChunk[];
}

const parseEntry = async (
  ctx: ToolContext,
  entry: ResearchVaultEntry,
): Promise<ParsedEntry | null> => {
  if (!ctx.researchVault) throw new Error('research vault unavailable');
  const content = await ctx.researchVault.readText({
    relativePath: entry.relativePath,
    maxBytes: 10 * 1024 * 1024,
  });
  const parsed = parseResearchMarkdown(content);
  const frontmatter = parsed.frontmatter;
  const type = field(frontmatter, 'luoome_type');
  if (type !== 'research-topic' && type !== 'research-document') return null;
  const id = field(frontmatter, 'luoome_id');
  const title = field(frontmatter, 'title');
  if (typeof id !== 'string' || typeof title !== 'string') {
    throw new Error('luoome_id and title are required');
  }

  if (type === 'research-topic') {
    const topic = ResearchTopicIndexSchema.parse({
      id,
      title,
      kind: field(frontmatter, 'topic_kind'),
      summary: field(frontmatter, 'summary'),
      tags: listValue(field(frontmatter, 'tags')),
      vaultId: ctx.researchVault.vaultId,
      relativePath: entry.relativePath,
      contentHash: entry.contentHash,
      archivedAt: date(field(frontmatter, 'archived_at')),
      fileModifiedAt: entry.modifiedAt,
      indexedAt: ctx.clock(),
      availability: 'available',
    });
    const relations: ResearchTopicDocument[] = [
      ...listValue(field(frontmatter, 'primary_documents')).map((documentId) => ({
        topicId: id,
        documentId,
        relation: 'primary' as const,
      })),
      ...listValue(field(frontmatter, 'counter_evidence_documents')).map((documentId) => ({
        topicId: id,
        documentId,
        relation: 'counter-evidence' as const,
      })),
      ...listValue(field(frontmatter, 'update_documents')).map((documentId) => ({
        topicId: id,
        documentId,
        relation: 'update' as const,
      })),
    ];
    return {
      topic,
      links: subjectLinks('topic', id, frontmatter),
      relations,
      chunks: [],
    };
  }

  const body = parsed.body.trim();
  const document = ResearchDocumentIndexSchema.parse({
    id,
    title,
    kind: field(frontmatter, 'document_kind'),
    author: field(frontmatter, 'author'),
    sourceUrl: field(frontmatter, 'source_url'),
    sourceStatus: field(frontmatter, 'source_status'),
    publishedAt: date(field(frontmatter, 'published_at')),
    observedAt: date(field(frontmatter, 'observed_at')),
    importedAt: date(field(frontmatter, 'imported_at')) ?? ctx.clock(),
    tags: listValue(field(frontmatter, 'tags')),
    vaultId: ctx.researchVault.vaultId,
    relativePath: entry.relativePath,
    attachmentPaths: listValue(field(frontmatter, 'attachments')),
    contentHash: entry.contentHash,
    excerpt: body.slice(0, 1000),
    fileModifiedAt: entry.modifiedAt,
    indexedAt: ctx.clock(),
    availability: body ? 'available' : 'invalid',
    ...(body ? {} : { diagnostic: '研究资料正文为空' }),
  });
  return {
    document,
    links: subjectLinks('document', id, frontmatter),
    relations: listValue(field(frontmatter, 'topic_ids')).map((topicId) => ({
      topicId,
      documentId: id,
      relation: 'supporting' as const,
    })),
    chunks: body ? documentChunks(id, document.contentHash, parsed.body) : [],
  };
};

const currentIndexStatus = async (
  ctx: ToolContext,
  fallbackVaultId?: string,
): Promise<ResearchIndexStatus> => {
  const vaultId = ctx.researchVault?.vaultId ?? fallbackVaultId ?? 'unconfigured';
  const latest =
    vaultId === 'unconfigured'
      ? undefined
      : (await ctx.repos.researchVaultSyncRun.list(vaultId, 1))[0];
  if (!ctx.researchVault) {
    return {
      vaultId,
      freshness: 'unavailable',
      ...(latest?.finishedAt ? { lastSyncAt: latest.finishedAt } : {}),
      diagnostic: 'Vault 当前未配置；结果来自可重建索引',
    };
  }
  return {
    vaultId,
    freshness:
      latest === undefined || latest.status === 'partial' || latest.status === 'failed'
        ? 'stale'
        : 'fresh',
    ...(latest?.finishedAt ? { lastSyncAt: latest.finishedAt } : {}),
    ...(latest?.error
      ? { diagnostic: latest.error }
      : latest === undefined
        ? { diagnostic: '尚未完成一次 Vault 同步' }
        : {}),
  };
};

export const ListResearchTopicsInput = z.object({
  kind: ResearchTopicKindSchema.optional(),
  subject: z.string().optional(),
  tags: z.array(z.string()).optional(),
  includeArchived: z.boolean().default(false),
  availability: availability.optional(),
  limit: z.number().int().positive().max(200).default(50),
  cursor: z.string().optional(),
});
export const ListResearchTopicsOutput = z.object({
  topics: z.array(topicSummary),
  indexStatus: indexStatusSchema,
  nextCursor: z.string().optional(),
});
export const listResearchTopicsTool = defineTool({
  name: 'list_research_topics',
  description: '查询研究主题；主题不要求关联股票',
  sideEffect: 'read',
  input: ListResearchTopicsInput,
  output: ListResearchTopicsOutput,
  handler: async (input, ctx) => {
    const query = {
      ...(input.kind ? { kind: input.kind } : {}),
      ...(input.subject ? { subject: input.subject } : {}),
      ...(input.tags ? { tags: input.tags } : {}),
      includeArchived: input.includeArchived,
      ...(input.availability ? { availability: input.availability } : {}),
      limit: input.limit,
      ...(input.cursor ? { cursor: input.cursor } : {}),
    };
    const topics = await ctx.repos.researchIndex.listTopics(query);
    return {
      topics: [...topics],
      indexStatus: await currentIndexStatus(ctx, topics[0]?.vaultId),
    };
  },
});

export const GetResearchTopicInput = z.object({ topicId: z.string().min(1) });
export const GetResearchTopicOutput = z.object({
  topic: topicSummary,
  documents: z.array(documentSummary),
  subjects: z.array(ResearchSubjectLinkSchema),
  documentRelations: z.array(ResearchTopicDocumentSchema),
  currentThesis: documentSummary.optional(),
  sections: topicSections,
  timeline: z.array(timelineItem),
  obsidianUri: z.string().optional(),
  indexStatus: indexStatusSchema,
});
export const getResearchTopicTool = defineTool({
  name: 'get_research_topic',
  description: '读取研究主题索引、关联资料和 Obsidian URI',
  sideEffect: 'read',
  input: GetResearchTopicInput,
  output: GetResearchTopicOutput,
  handler: async (input, ctx) => {
    const topic = await ctx.repos.researchIndex.findTopic(input.topicId);
    if (!topic) return errNotFound('ResearchTopic', input.topicId);
    const documents = await ctx.repos.researchIndex.listDocuments({
      topicId: input.topicId,
      limit: 200,
    });
    const [subjects, documentRelations] = await Promise.all([
      ctx.repos.researchIndex.listSubjectLinks({ ownerKind: 'topic', ownerId: topic.id }),
      ctx.repos.researchIndex.listTopicDocuments(topic.id),
    ]);
    let sections = topicSections.parse({ evidence: [], counterEvidence: [], unresolved: [] });
    if (ctx.researchVault) {
      try {
        const content = await ctx.researchVault.readText({
          relativePath: topic.relativePath,
          maxBytes: 64 * 1024,
        });
        sections = extractTopicSections(parseResearchMarkdown(content).body);
      } catch (error) {
        ctx.logger.warn('get_research_topic: 主题正文不可读，保留索引结果', {
          topicId: topic.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    const currentThesis = documents.find((document) => document.kind === 'thesis');
    const timeline = [
      {
        id: topic.id,
        kind: 'topic' as const,
        occurredAt: topic.indexedAt,
        title: topic.title,
        ...(topic.summary === undefined ? {} : { summary: topic.summary }),
      },
      ...documents.map((document) => ({
        id: document.id,
        kind: 'document' as const,
        occurredAt: researchDocumentDate(document),
        title: document.title,
        ...(document.excerpt === undefined ? {} : { summary: document.excerpt }),
      })),
    ].sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime() || a.id.localeCompare(b.id));
    return {
      topic,
      documents: [...documents],
      subjects: [...subjects],
      documentRelations: [...documentRelations],
      ...(currentThesis === undefined ? {} : { currentThesis }),
      sections,
      timeline,
      ...(ctx.researchVault
        ? { obsidianUri: ctx.researchVault.buildOpenUri(topic.relativePath) }
        : {}),
      indexStatus: await currentIndexStatus(ctx, topic.vaultId),
    };
  },
});

export const ListResearchDocumentsInput = z.object({
  topicId: z.string().optional(),
  subject: z.string().optional(),
  kind: ResearchDocumentKindSchema.optional(),
  tags: z.array(z.string()).optional(),
  availability: availability.optional(),
  publishedFrom: z.coerce.date().optional(),
  publishedTo: z.coerce.date().optional(),
  limit: z.number().int().positive().max(200).default(50),
  cursor: z.string().optional(),
});
export const ListResearchDocumentsOutput = z.object({
  documents: z.array(documentSummary),
  indexStatus: indexStatusSchema,
});
export const listResearchDocumentsTool = defineTool({
  name: 'list_research_documents',
  description: '查询研究资料索引',
  sideEffect: 'read',
  input: ListResearchDocumentsInput,
  output: ListResearchDocumentsOutput,
  handler: async (input, ctx) => {
    const documents = await ctx.repos.researchIndex.listDocuments({
      ...(input.topicId ? { topicId: input.topicId } : {}),
      ...(input.subject ? { subject: input.subject } : {}),
      ...(input.kind ? { kind: input.kind } : {}),
      ...(input.tags ? { tags: input.tags } : {}),
      ...(input.availability ? { availability: input.availability } : {}),
      ...(input.publishedFrom ? { publishedFrom: input.publishedFrom } : {}),
      ...(input.publishedTo ? { publishedTo: input.publishedTo } : {}),
      limit: input.limit,
      ...(input.cursor ? { cursor: input.cursor } : {}),
    });
    return {
      documents: [...documents],
      indexStatus: await currentIndexStatus(ctx, documents[0]?.vaultId),
    };
  },
});

export const GetResearchDocumentInput = z.object({
  documentId: z.string().min(1),
  includeContent: z.boolean().default(false),
  maxChars: z.number().int().positive().max(100_000).default(20_000),
  startOffset: z.number().int().nonnegative().default(0),
});
export const GetResearchDocumentOutput = z.object({
  document: documentSummary,
  content: z.string().optional(),
  truncated: z.boolean().optional(),
  nextOffset: z.number().int().optional(),
  obsidianUri: z.string().optional(),
  indexStatus: indexStatusSchema,
});
export const getResearchDocumentTool = defineTool({
  name: 'get_research_document',
  description: '读取研究资料元数据，正文按窗口读取',
  sideEffect: 'read',
  input: GetResearchDocumentInput,
  output: GetResearchDocumentOutput,
  handler: async (input, ctx) => {
    const document = await ctx.repos.researchIndex.findDocument(input.documentId);
    if (!document) return errNotFound('ResearchDocument', input.documentId);
    if (input.includeContent && !ctx.researchVault) return vaultRequired(ctx);
    const output: {
      document: ResearchDocumentIndex;
      content?: string;
      truncated?: boolean;
      nextOffset?: number;
      obsidianUri?: string;
      indexStatus: ResearchIndexStatus;
    } = {
      document,
      ...(ctx.researchVault
        ? { obsidianUri: ctx.researchVault.buildOpenUri(document.relativePath) }
        : {}),
      indexStatus: await currentIndexStatus(ctx, document.vaultId),
    };
    if (input.includeContent && ctx.researchVault) {
      const text = await ctx.researchVault.readText({
        relativePath: document.relativePath,
        maxBytes: 10 * 1024 * 1024,
      });
      output.content = text.slice(input.startOffset, input.startOffset + input.maxChars);
      if (input.startOffset + input.maxChars < text.length) {
        output.truncated = true;
        output.nextOffset = input.startOffset + input.maxChars;
      }
    }
    return output;
  },
});

export const SearchResearchDocumentsInput = z.object({
  text: z.string().trim().min(1),
  topicId: z.string().optional(),
  subject: z.string().optional(),
  kind: ResearchDocumentKindSchema.optional(),
  limit: z.number().int().positive().max(200).default(50),
});
export const SearchResearchDocumentsOutput = z.object({
  hits: z.array(
    z.object({
      document: documentSummary,
      ordinal: z.number().int().nonnegative().optional(),
      headingPath: z.string().optional(),
      snippet: z.string(),
      score: z.number().optional(),
    }),
  ),
  capability: z.enum(['fts', 'metadata']),
  indexStatus: indexStatusSchema,
});
export const searchResearchDocumentsTool = defineTool({
  name: 'search_research_documents',
  description: '搜索研究资料；不可用时明确返回 capability',
  sideEffect: 'read',
  input: SearchResearchDocumentsInput,
  output: SearchResearchDocumentsOutput,
  handler: async (input, ctx) => {
    const hits = await ctx.repos.researchIndex.searchDocuments({
      text: input.text,
      ...(input.topicId ? { topicId: input.topicId } : {}),
      ...(input.subject ? { subject: input.subject } : {}),
      ...(input.kind ? { kind: input.kind } : {}),
      limit: input.limit,
    });
    return {
      hits: [...hits],
      capability: ctx.repos.researchIndex.searchCapability(),
      indexStatus: await currentIndexStatus(ctx, hits[0]?.document.vaultId),
    };
  },
});

export const BuildResearchBriefInput = z.object({
  scope: z.string().trim().min(1).max(500),
  stockId: z.string().min(1).optional(),
  topicId: z.string().min(1).optional(),
  subject: z.string().trim().min(1).optional(),
  limit: z.number().int().positive().max(20).default(10),
  strategySignalScope: StrategySignalScopeSchema.default('operational'),
  strategyEvaluationSessionId: z.string().min(1).optional(),
});
export const BuildResearchBriefOutput = ResearchBriefSchema;

const boundedEvidenceText = (parts: readonly (string | undefined)[]): string =>
  parts
    .filter((part): part is string => part !== undefined && part.trim().length > 0)
    .join('；')
    .trim()
    .slice(0, 500);

/**
 * 生成只含真实对象引用的确定性 ResearchBrief。
 * 这里不调用 LLM，也不写入任何仓储；Agent 可以在此结果之上提出草案，但不能伪造引用。
 */
export const buildResearchBriefTool = defineTool({
  name: 'build_research_brief',
  description: '按研究范围聚合可审计事实并生成结构化 ResearchBrief；不写入研究资料',
  sideEffect: 'read',
  input: BuildResearchBriefInput,
  output: BuildResearchBriefOutput,
  handler: async (input, ctx) => {
    const failures: string[] = [];
    const safe = async <T>(label: string, run: () => Promise<T>, fallback: T): Promise<T> => {
      try {
        return await run();
      } catch (error) {
        failures.push(label);
        ctx.logger.warn('build_research_brief: 事实源读取失败，保留部分结果', {
          source: label,
          error: error instanceof Error ? error.message : String(error),
        });
        return fallback;
      }
    };

    const hits = await safe(
      'research-documents',
      () =>
        ctx.repos.researchIndex.searchDocuments({
          text: input.scope,
          ...(input.topicId ? { topicId: input.topicId } : {}),
          ...(input.subject ? { subject: input.subject } : {}),
          limit: input.limit,
        }),
      [],
    );
    const refs: z.infer<typeof EvidenceRefSchema>[] = hits.map((hit) =>
      EvidenceRefSchema.parse({
        kind: 'document-chunk',
        id: `${hit.document.id}:${hit.ordinal ?? 0}`,
        documentId: hit.document.id,
        ordinal: hit.ordinal ?? 0,
        relativePath: hit.document.relativePath,
        headingPath: hit.headingPath ?? '',
        quote: hit.snippet.slice(0, 500),
        occurredAt: researchDocumentDate(hit.document),
      }),
    );
    const documentStatuses = hits.map((hit) =>
      hit.document.sourceStatus === 'verified' ? 'verified' : 'unverified',
    );

    const stockId = input.stockId;
    if (stockId !== undefined) {
      const [events, signals, triggers, advices] = await Promise.all([
        safe('stock-events', () => ctx.repos.stockEvent.list({ stockId, limit: input.limit }), []),
        safe(
          'strategy-signals',
          () =>
            readStrategySignalsByStock(ctx, {
              stockId,
              scope: input.strategySignalScope,
              ...(input.strategyEvaluationSessionId === undefined
                ? {}
                : { evaluationSessionId: input.strategyEvaluationSessionId }),
            }),
          [],
        ),
        safe(
          'watch-triggers',
          () =>
            ctx.repos.watchTrigger
              .listRecent({ limit: 10_000 })
              .then((items) =>
                items.filter((item) => item.stockId === stockId).slice(0, input.limit),
              ),
          [],
        ),
        safe(
          'advices',
          () =>
            ctx.repos.advice.query({
              subjectKind: 'stock',
              subjectId: stockId,
              includeExpired: true,
              limit: input.limit,
            }),
          [],
        ),
      ]);
      refs.push(
        ...events.slice(0, input.limit).map((event) =>
          EvidenceRefSchema.parse({
            kind: 'stock-event',
            id: event.id,
            occurredAt: event.occursAt,
            quote: boundedEvidenceText([event.title, event.description]),
          }),
        ),
        ...signals.slice(0, input.limit).map((signal) =>
          EvidenceRefSchema.parse({
            kind: 'strategy-signal',
            id: signal.id,
            occurredAt: signal.ts,
            quote: boundedEvidenceText(signal.evidence),
          }),
        ),
        ...triggers.slice(0, input.limit).map((trigger) =>
          EvidenceRefSchema.parse({
            kind: 'watch-trigger',
            id: trigger.id,
            occurredAt: trigger.createdAt,
            quote: boundedEvidenceText([trigger.reason, ...trigger.evidence]),
          }),
        ),
        ...advices.slice(0, input.limit).map((advice) =>
          EvidenceRefSchema.parse({
            kind: 'advice',
            id: advice.id,
            occurredAt: advice.createdAt,
            quote: boundedEvidenceText([advice.reasoning.premise, ...advice.reasoning.evidence]),
          }),
        ),
      );
    }

    const facts = refs.slice(0, 50);
    const sourceStatus =
      facts.length === 0
        ? ('unavailable' as const)
        : documentStatuses.length === 0 || documentStatuses.every((status) => status === 'verified')
          ? ('verified' as const)
          : documentStatuses.every((status) => status === 'unverified')
            ? ('unverified' as const)
            : ('mixed' as const);
    const unknowns = [
      ...(facts.length === 0 ? ['未找到与当前 scope 匹配的可引用事实'] : []),
      ...failures.map((source) => `事实源 ${source} 不可用，结果可能不完整`),
      ...(sourceStatus === 'unverified' || sourceStatus === 'mixed'
        ? ['部分研究资料缺少可验证来源']
        : []),
    ];
    return ResearchBriefSchema.parse({
      scope: input.scope,
      conclusion:
        facts.length === 0
          ? '当前范围没有足够的可引用事实，不能形成完整结论。'
          : `已聚合 ${facts.length} 条可审计事实；结论仅基于这些引用，仍需结合未知项核验。`,
      facts,
      inferences: [],
      counterEvidence: [],
      risks: [
        ...(sourceStatus === 'unverified' || sourceStatus === 'mixed'
          ? ['研究资料来源未全部验证']
          : []),
        ...(failures.length > 0 ? ['部分事实源读取失败'] : []),
      ],
      unknowns,
      dataAsOf: ctx.clock(),
      sourceStatus,
      suggestedFollowUps:
        facts.length === 0
          ? ['扩大研究范围或先同步 Research Vault', '补充结构化事件、信号或 Advice 事实']
          : sourceStatus === 'verified'
            ? ['检查反证与风险是否有新的结构化事实']
            : ['核验未验证资料的来源与发布时间'],
    });
  },
});

export const GetStockResearchViewInput = z.object({
  stockId: z.string().min(1),
  limit: z.number().int().positive().max(200).default(50),
  strategySignalScope: StrategySignalScopeSchema.default('operational'),
  strategyEvaluationSessionId: z.string().min(1).optional(),
});
export const GetStockResearchViewOutput = z.object({
  stockId: z.string(),
  profile: StockResearchProfileSchema,
  topics: z.array(topicSummary),
  documents: z.array(documentSummary),
  events: z.array(StockEventSchema),
  signals: z.array(StrategySignalSchema),
  triggers: z.array(WatchTriggerSchema),
  advices: z.array(AdviceSchema),
  trades: z.array(TradeSchema),
  timeline: z.array(timelineItem),
  limitUp: StockLimitUpFactsSchema,
  indexStatus: indexStatusSchema,
});
export const getStockResearchViewTool = defineTool({
  name: 'get_stock_research_view',
  description: '按显式 stock SubjectLink 聚合股票研究，不自动扩散产业研究',
  sideEffect: 'read',
  input: GetStockResearchViewInput,
  output: GetStockResearchViewOutput,
  handler: async (input, ctx) => {
    const subject = `stock:${input.stockId}`;
    const [topics, directDocuments, events, signals, triggers, advices, trades] = await Promise.all(
      [
        ctx.repos.researchIndex.listTopics({ subject, limit: input.limit }),
        ctx.repos.researchIndex.listDocuments({ subject, limit: input.limit }),
        ctx.repos.stockEvent.list({ stockId: input.stockId, limit: input.limit }),
        readStrategySignalsByStock(ctx, {
          stockId: input.stockId,
          scope: input.strategySignalScope,
          ...(input.strategyEvaluationSessionId === undefined
            ? {}
            : { evaluationSessionId: input.strategyEvaluationSessionId }),
        }),
        ctx.repos.watchTrigger
          .listRecent({ limit: 10_000 })
          .then((items) =>
            items.filter((trigger) => trigger.stockId === input.stockId).slice(0, input.limit),
          ),
        ctx.repos.advice.query({
          subjectKind: 'stock',
          subjectId: input.stockId,
          includeExpired: true,
          limit: input.limit,
        }),
        ctx.user.defaultAccountId === ''
          ? Promise.resolve([])
          : ctx.repos.trade
              .listByAccount(ctx.user.defaultAccountId)
              .then((items) =>
                items.filter((trade) => trade.stockId === input.stockId).slice(0, input.limit),
              ),
      ],
    );
    const stock = await ctx.repos.stock.findById(input.stockId);
    const code = stock?.code ?? input.stockId.split('.')[0] ?? '';
    const limitUp = /^\d{6}$/.test(code)
      ? await loadStockLimitUpFacts(input.stockId, code, currentLimitUpDate(ctx), ctx)
      : StockLimitUpFactsSchema.parse({
          stockId: input.stockId,
          code: '000000',
          status: 'unavailable',
          today: null,
          recent: [],
          asOf: null,
          warnings: ['stock-code-unavailable'],
        });
    const topicDocuments = await Promise.all(
      topics.map((topic) =>
        ctx.repos.researchIndex.listDocuments({ topicId: topic.id, limit: input.limit }),
      ),
    );
    const topicRelations = (
      await Promise.all(topics.map((topic) => ctx.repos.researchIndex.listTopicDocuments(topic.id)))
    ).flat();
    const documents = [
      ...new Map(
        [...directDocuments, ...topicDocuments.flat()].map((document) => [document.id, document]),
      ).values(),
    ].slice(0, input.limit);
    const timeline = [
      ...topics.map((topic) => ({
        id: topic.id,
        kind: 'topic' as const,
        occurredAt: topic.indexedAt,
        title: topic.title,
        ...(topic.summary === undefined ? {} : { summary: topic.summary }),
      })),
      ...documents.map((document) => ({
        id: document.id,
        kind: 'document' as const,
        occurredAt: researchDocumentDate(document),
        title: document.title,
        ...(document.excerpt === undefined ? {} : { summary: document.excerpt }),
      })),
      ...events.map((event) => ({
        id: event.id,
        kind: 'stock-event' as const,
        occurredAt: event.occursAt,
        title: event.title,
        ...(event.description === undefined ? {} : { summary: event.description }),
      })),
      ...signals.map((signal) => ({
        id: signal.id,
        kind: 'strategy-signal' as const,
        occurredAt: signal.ts,
        title: `策略信号 ${signal.direction}`,
        summary: `score=${signal.score}`,
      })),
      ...triggers.map((trigger) => ({
        id: trigger.id,
        kind: 'watch-trigger' as const,
        occurredAt: trigger.createdAt,
        title: trigger.reason,
        summary: trigger.deliveryStatus,
      })),
      ...advices.map((advice) => ({
        id: advice.id,
        kind: 'advice' as const,
        occurredAt: advice.createdAt,
        title: `Advice ${advice.decision}`,
        summary: advice.reasoning.premise,
      })),
      ...trades.map((trade) => ({
        id: trade.id,
        kind: 'trade' as const,
        occurredAt: trade.executedAt,
        title: `交易 ${trade.side}`,
        summary: `${trade.quantity} @ ${trade.price}`,
      })),
      ...limitUp.recent.map((item) => ({
        id: `${input.stockId}:${item.date}`,
        kind: 'limit-up' as const,
        occurredAt: new Date(`${item.date}T00:00:00.000Z`),
        title: `${item.ladderLevel} 连板 · ${item.date}`,
        ...(item.reason === '--' ? {} : { summary: item.reason }),
      })),
    ]
      .sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime() || a.id.localeCompare(b.id))
      .slice(0, input.limit * 3);
    const counterDocumentIds = new Set(
      topicRelations
        .filter((relation) => relation.relation === 'counter-evidence')
        .map((relation) => relation.documentId),
    );
    const fact = (
      item: Omit<StockResearchProfileFact, 'sourceStatus'> & {
        readonly sourceStatus?: StockResearchProfileFact['sourceStatus'];
      },
    ): StockResearchProfileFact => ({ sourceStatus: 'not-applicable', ...item });
    const researchFacts = [
      ...topics.map((topic) =>
        fact({
          kind: 'topic',
          id: topic.id,
          summary: topic.summary ?? topic.title,
          occurredAt: topic.indexedAt,
          sourceStatus: 'not-applicable',
        }),
      ),
      ...documents
        .filter((document) => !counterDocumentIds.has(document.id))
        .map((document) =>
          fact({
            kind: 'document',
            id: document.id,
            summary: document.excerpt ?? document.title,
            occurredAt: researchDocumentDate(document),
            sourceStatus: document.sourceStatus === 'verified' ? 'verified' : 'unverified',
          }),
        ),
      ...events.map((event) =>
        fact({
          kind: 'stock-event',
          id: event.id,
          summary: event.description ?? event.title,
          occurredAt: event.occursAt,
        }),
      ),
      ...signals
        .filter((signal) => signal.direction !== 'bearish')
        .map((signal) =>
          fact({
            kind: 'strategy-signal',
            id: signal.id,
            summary: signal.evidence.join('；').slice(0, 500),
            occurredAt: signal.ts,
          }),
        ),
      ...triggers.map((trigger) =>
        fact({
          kind: 'watch-trigger',
          id: trigger.id,
          summary: [trigger.reason, ...trigger.evidence].join('；').slice(0, 500),
          occurredAt: trigger.createdAt,
        }),
      ),
      ...limitUp.recent.map((item) =>
        fact({
          kind: 'limit-up',
          id: `${input.stockId}:${item.date}`,
          summary: `${item.ladderLevel} 连板${item.reason === '--' ? '' : `；${item.reason}`}`,
          occurredAt: new Date(`${item.date}T00:00:00.000Z`),
        }),
      ),
    ].slice(0, 100);
    const counterFacts = [
      ...documents
        .filter((document) => counterDocumentIds.has(document.id))
        .map((document) =>
          fact({
            kind: 'document',
            id: document.id,
            summary: document.excerpt ?? document.title,
            occurredAt: researchDocumentDate(document),
            sourceStatus: document.sourceStatus === 'verified' ? 'verified' : 'unverified',
          }),
        ),
      ...signals
        .filter((signal) => signal.direction === 'bearish')
        .map((signal) =>
          fact({
            kind: 'strategy-signal',
            id: signal.id,
            summary: signal.evidence.join('；').slice(0, 500),
            occurredAt: signal.ts,
          }),
        ),
    ].slice(0, 100);
    const datedFacts = [...researchFacts, ...counterFacts]
      .flatMap((item) => (item.occurredAt === undefined ? [] : [item.occurredAt]))
      .sort((left, right) => left.getTime() - right.getTime());
    const indexStatus = await currentIndexStatus(ctx, topics[0]?.vaultId ?? documents[0]?.vaultId);
    const unknowns = [
      ...(stock === null ? ['本地股票目录无法解析该股票身份'] : []),
      ...(indexStatus.freshness === 'fresh'
        ? []
        : [`Research Vault index ${indexStatus.freshness}，研究资料可能不完整`]),
      ...(topics.length + documents.length === 0 ? ['没有显式关联的 ResearchTopic/Document'] : []),
      ...(counterFacts.length === 0 ? ['没有显式反证资料或 bearish StrategySignal'] : []),
      ...(limitUp.status === 'unavailable' ? ['涨停天梯事实不可用'] : []),
    ];
    const profile = StockResearchProfileSchema.parse({
      stock: {
        stockId: input.stockId,
        stockName: stock?.name ?? '名称暂缺',
        nameStatus: stock?.name === undefined ? 'unavailable' : 'resolved',
      },
      status:
        researchFacts.length + counterFacts.length === 0
          ? 'unavailable'
          : unknowns.length > 0
            ? 'partial'
            : 'complete',
      ...(datedFacts.at(-1) === undefined ? {} : { factsAsOf: datedFacts.at(-1) }),
      ...(datedFacts[0] === undefined ? {} : { oldestEvidenceAt: datedFacts[0] }),
      coverage: {
        topics: topics.length,
        documents: documents.length,
        events: events.length,
        strategySignals: signals.length,
        watchTriggers: triggers.length,
      },
      evidence: researchFacts,
      counterEvidence: counterFacts,
      unknowns,
      limitations: [
        'Stock profile 是显式研究关系与持久事实的读模型，不是 market-visible Strategy。',
        'StrategySignal score 只表示规则强度；本读模型不输出收益概率或 Advice confidence。',
        '读取 profile 不会自动生成 Advice、修改 Watchlist 或触发交易。',
      ],
    });
    return {
      stockId: input.stockId,
      profile,
      topics: [...topics],
      documents: [...documents],
      events: [...events],
      signals: [...signals],
      triggers: [...triggers],
      advices: advices.map((advice) => AdviceSchema.parse(advice)),
      trades: [...trades],
      timeline,
      limitUp,
      indexStatus,
    };
  },
});

export const SyncResearchVaultInput = z.object({
  mode: z.enum(['manual', 'scheduled']).default('manual'),
});
export const SyncResearchVaultOutput = z.object({
  vaultId: z.string(),
  scanned: z.number().int().nonnegative(),
  added: z.number().int().nonnegative(),
  updated: z.number().int().nonnegative(),
  unchanged: z.number().int().nonnegative(),
  missing: z.number().int().nonnegative(),
  invalid: z.number().int().nonnegative(),
  conflicts: z.number().int().nonnegative(),
  status: z.enum(['succeeded', 'partial', 'failed']),
});
export const syncResearchVaultTool = defineTool({
  name: 'sync_research_vault',
  description: '扫描本地 Obsidian Vault 并重建研究索引',
  sideEffect: 'write',
  input: SyncResearchVaultInput,
  output: SyncResearchVaultOutput,
  handler: async (input, ctx) => {
    const missingVault = vaultRequired(ctx);
    if (!ctx.researchVault) {
      return missingVault ?? errAdapterError('research-vault', 'Vault 不可用', false);
    }
    const vault = ctx.researchVault;
    const startedAt = ctx.clock();
    const runId = `vault_run_${globalThis.crypto.randomUUID().slice(0, 12)}`;
    const running: ResearchVaultSyncRun = {
      id: runId,
      vaultId: vault.vaultId,
      mode: input.mode,
      status: 'running',
      scanned: 0,
      added: 0,
      updated: 0,
      unchanged: 0,
      missing: 0,
      invalid: 0,
      conflicts: 0,
      startedAt,
    };
    await ctx.repos.researchVaultSyncRun.save(running);

    try {
      const entries = await vault.scan();
      const parsed: ParsedEntry[] = [];
      let parseInvalid = 0;
      for (const entry of entries) {
        try {
          const result = await parseEntry(ctx, entry);
          if (result) parsed.push(result);
        } catch (error) {
          parseInvalid++;
          ctx.logger.warn('research vault file skipped', {
            relativePath: entry.relativePath,
            reason: error instanceof Error ? error.message : String(error),
          });
        }
      }

      const rawTopics = parsed.flatMap((entry) => (entry.topic ? [entry.topic] : []));
      const rawDocuments = parsed.flatMap((entry) => (entry.document ? [entry.document] : []));
      const topicCounts = new Map<string, number>();
      const documentCounts = new Map<string, number>();
      for (const topic of rawTopics) {
        topicCounts.set(topic.id, (topicCounts.get(topic.id) ?? 0) + 1);
      }
      for (const document of rawDocuments) {
        documentCounts.set(document.id, (documentCounts.get(document.id) ?? 0) + 1);
      }
      const duplicateConflicts = [...topicCounts.values(), ...documentCounts.values()].filter(
        (count) => count > 1,
      ).length;
      const topics = rawTopics.filter((topic) => topicCounts.get(topic.id) === 1);
      const documents = rawDocuments.filter((document) => documentCounts.get(document.id) === 1);
      const acceptedOwners = new Set([
        ...topics.map((topic) => `topic:${topic.id}`),
        ...documents.map((document) => `document:${document.id}`),
      ]);
      const acceptedTopicIds = new Set(topics.map((topic) => topic.id));
      const acceptedDocumentIds = new Set(documents.map((document) => document.id));
      const completeness =
        parseInvalid > 0 || duplicateConflicts > 0 ? ('partial' as const) : ('complete' as const);
      const summary = await ctx.repos.researchIndex.applyIndexBatch({
        vaultId: vault.vaultId,
        completeness,
        topics,
        documents,
        topicDocuments: parsed
          .flatMap((entry) => entry.relations)
          .filter(
            (relation) =>
              acceptedTopicIds.has(relation.topicId) &&
              acceptedDocumentIds.has(relation.documentId),
          ),
        subjectLinks: parsed
          .flatMap((entry) => entry.links)
          .filter((link) => acceptedOwners.has(`${link.ownerKind}:${link.ownerId}`)),
        chunks: parsed
          .flatMap((entry) => entry.chunks)
          .filter((chunk) => acceptedDocumentIds.has(chunk.documentId)),
        seenTopicIds: new Set(topics.map((topic) => topic.id)),
        seenDocumentIds: new Set(documents.map((document) => document.id)),
        indexedAt: ctx.clock(),
      });
      const invalid = summary.invalid + parseInvalid;
      const conflicts = summary.conflicts + duplicateConflicts;
      const status = invalid > 0 || conflicts > 0 ? ('partial' as const) : ('succeeded' as const);
      const output = {
        vaultId: vault.vaultId,
        scanned: entries.length,
        added: summary.added,
        updated: summary.updated,
        unchanged: summary.unchanged,
        missing: summary.missing,
        invalid,
        conflicts,
        status,
      };
      await ctx.repos.researchVaultSyncRun.save({
        id: runId,
        mode: input.mode,
        ...output,
        startedAt,
        finishedAt: ctx.clock(),
      });
      return output;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await ctx.repos.researchVaultSyncRun.save({
        ...running,
        status: 'failed',
        finishedAt: ctx.clock(),
        error: message.slice(0, 500),
      });
      return errAdapterError('research-vault', message, true);
    }
  },
});

const researchId = (prefix: 'topic' | 'doc'): string =>
  `${prefix}_${globalThis.crypto.randomUUID().replaceAll('-', '').slice(0, 20)}`;

const singleLine = (value: string, label: string): string => {
  if (value.includes('\n') || value.includes('\r') || value.includes('\0')) {
    throw new Error(`${label} must be a single line`);
  }
  return value.trim();
};

const yamlScalar = (value: string): string => {
  const normalized = singleLine(value, 'frontmatter value');
  return normalized.length === 0 ? '""' : normalized;
};

const yamlList = (values: readonly string[]): string[] =>
  values.map((value) => `  - ${yamlScalar(value)}`);

const renderFrontmatter = (
  values: Readonly<Record<string, string | readonly string[] | undefined>>,
): string => {
  const lines = ['---'];
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      lines.push(`${key}:`, ...yamlList(value));
    } else if (typeof value === 'string') {
      lines.push(`${key}: ${yamlScalar(value)}`);
    }
  }
  lines.push('---');
  return `${lines.join('\n')}\n`;
};

const managedRoot = (ctx: ToolContext): string =>
  ctx.researchVault?.managedRoot ?? 'Research/Luoome';

const slug = (value: string): string => {
  const normalized = value
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return normalized || 'research';
};

const missingResearchVault = () => ({
  ok: false as const,
  error: { kind: 'permission_denied' as const, required: 'LUOOME_RESEARCH_VAULT' },
});

const syncStatusAfterWrite = async (ctx: ToolContext) => {
  const result = await syncResearchVaultTool.execute({ mode: 'manual' }, ctx);
  if (result.ok) {
    return {
      indexed: result.data.status === 'succeeded',
      syncStatus: result.data.status,
      ...(result.data.status === 'succeeded'
        ? {}
        : { diagnostic: `索引${result.data.status === 'partial' ? '部分' : '未'}完成` }),
    };
  }
  const error = result.error;
  return {
    indexed: false,
    syncStatus: 'failed' as const,
    diagnostic:
      error.kind === 'adapter_error'
        ? error.cause
        : error.kind === 'permission_denied'
          ? `需要 ${error.required}`
          : '索引失败，下次同步将修复',
  };
};

const ManagedWriteStatusSchema = z.object({
  vaultId: z.string().min(1),
  relativePath: z.string().min(1),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  indexed: z.boolean(),
  syncStatus: z.enum(['succeeded', 'partial', 'failed']),
  diagnostic: z.string().optional(),
});

const TopicSubjectsInput = z.array(z.string().trim().min(3).max(200)).max(64).default([]);

const normalizeSubjects = (values: readonly string[]): string[] => {
  const output = new Set<string>();
  for (const value of values) {
    const normalized = normalizeResearchSubject(value);
    output.add(`${normalized.kind}:${normalized.key}`);
  }
  return [...output];
};

const TopicTagsInput = z.array(z.string().trim().min(1).max(64)).max(32).default([]);

const CreateResearchTopicInput = z.object({
  title: z.string().trim().min(1).max(200),
  kind: ResearchTopicKindSchema,
  summary: z.string().trim().max(1000).optional(),
  subjects: TopicSubjectsInput,
  tags: TopicTagsInput,
});
export const CreateResearchTopicOutput = ManagedWriteStatusSchema.extend({
  topicId: z.string().regex(/^topic_[A-Za-z0-9_-]+$/),
});
export const createResearchTopicTool = defineTool({
  name: 'create_research_topic',
  description: '在 managed Vault 中创建研究主题 Markdown',
  sideEffect: 'write',
  input: CreateResearchTopicInput,
  output: CreateResearchTopicOutput,
  handler: async (input, ctx) => {
    if (!ctx.researchVault) return missingResearchVault();
    const topicId = researchId('topic');
    const subjects = normalizeSubjects(input.subjects);
    const relativePath = `${managedRoot(ctx)}/Topics/${slug(input.title)}-${topicId}.md`;
    const content = `${renderFrontmatter({
      luoome_schema: '1',
      luoome_type: 'research-topic',
      luoome_id: topicId,
      title: input.title,
      topic_kind: input.kind,
      ...(input.summary === undefined ? {} : { summary: input.summary }),
      ...(subjects.length === 0 ? {} : { subjects }),
      ...(input.tags.length === 0 ? {} : { tags: input.tags }),
    })}\n# ${input.title}\n\n## 当前判断\n\n## 支持证据\n\n## 反证与风险\n\n## 待验证问题\n`;
    const entry = await ctx.researchVault.createManagedDocument({ relativePath, content });
    const indexed = await syncStatusAfterWrite(ctx);
    return {
      vaultId: ctx.researchVault.vaultId,
      topicId,
      relativePath: entry.relativePath,
      contentHash: entry.contentHash,
      ...indexed,
    };
  },
});

const DocumentMetadataInput = z.object({
  title: z.string().trim().min(1).max(300),
  kind: ResearchDocumentKindSchema,
  body: z.string().max(200_000),
  author: z.string().trim().max(200).optional(),
  sourceUrl: z.string().url().optional(),
  sourceStatus: z.enum(['verified', 'unverified']).optional(),
  publishedAt: z.coerce.date().optional(),
  observedAt: z.coerce.date().optional(),
  topicIds: z
    .array(z.string().regex(/^topic_[A-Za-z0-9_-]+$/))
    .max(64)
    .default([]),
  subjects: TopicSubjectsInput,
  tags: TopicTagsInput,
});

const validateDocumentMetadata = (input: z.infer<typeof DocumentMetadataInput>): string[] => {
  if (input.sourceStatus === 'verified' && input.sourceUrl === undefined) {
    throw new Error('sourceStatus=verified requires sourceUrl');
  }
  return normalizeSubjects(input.subjects);
};

const documentContent = (
  input: z.infer<typeof DocumentMetadataInput>,
  id: string,
  now: Date,
  attachmentPaths: readonly string[] = [],
) => {
  const subjects = validateDocumentMetadata(input);
  return `${renderFrontmatter({
    luoome_schema: '1',
    luoome_type: 'research-document',
    luoome_id: id,
    title: input.title,
    document_kind: input.kind,
    ...(input.author === undefined ? {} : { author: input.author }),
    ...(input.sourceUrl === undefined ? {} : { source_url: input.sourceUrl }),
    ...(input.sourceStatus === undefined ? {} : { source_status: input.sourceStatus }),
    ...(input.publishedAt === undefined ? {} : { published_at: input.publishedAt.toISOString() }),
    ...(input.observedAt === undefined ? {} : { observed_at: input.observedAt.toISOString() }),
    imported_at: now.toISOString(),
    ...(input.topicIds.length === 0 ? {} : { topic_ids: input.topicIds }),
    ...(subjects.length === 0 ? {} : { subjects }),
    ...(input.tags.length === 0 ? {} : { tags: input.tags }),
    ...(attachmentPaths.length === 0 ? {} : { attachments: [...attachmentPaths] }),
  })}\n${input.body.trim()}\n`;
};

const decodeHtmlEntities = (value: string): string =>
  value
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([\da-f]+);/gi, (_, code: string) =>
      String.fromCodePoint(Number.parseInt(code, 16)),
    );

const extractHtml = (bytes: Uint8Array): { readonly title?: string; readonly body: string } => {
  const html = new TextDecoder().decode(bytes);
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  const body = decodeHtmlEntities(
    html
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
      .replace(/<br\s*\/?\s*>/gi, '\n')
      .replace(/<\/(p|div|li|h[1-6]|tr|section|article)>/gi, '\n')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/[ \t\r\f]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return {
    ...(title === undefined
      ? {}
      : { title: decodeHtmlEntities(title).replace(/\s+/g, ' ').trim() }),
    body,
  };
};

const pdfLiteral = (value: string): string =>
  value
    .replace(/\\([\\()])/g, '$1')
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t')
    .replace(/\\([0-7]{1,3})/g, (_, octal: string) =>
      String.fromCharCode(Number.parseInt(octal, 8)),
    );

const extractPdf = (bytes: Uint8Array): string => {
  // PDF operators and simple literal strings are ASCII; compressed/CMap text is
  // intentionally reported unavailable rather than guessed.
  const source = new TextDecoder().decode(bytes);
  const text: string[] = [];
  for (const match of source.matchAll(/\(((?:\\.|[^\\()])*)\)\s*T[Jj]/g)) {
    if (match[1] !== undefined) text.push(pdfLiteral(match[1]));
  }
  for (const match of source.matchAll(/<([\da-fA-F\s]+)>\s*T[Jj]/g)) {
    if (match[1] === undefined) continue;
    const hex = match[1].replace(/\s/g, '');
    if (hex.length % 2 !== 0) continue;
    const decoded = new Uint8Array(hex.length / 2);
    for (let index = 0; index < decoded.length; index += 1) {
      decoded[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
    }
    text.push(new TextDecoder('utf-8', { fatal: false }).decode(decoded));
  }
  return text
    .join('\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
};

const remoteBody = (
  mediaType: string,
  content: Uint8Array,
): {
  readonly title?: string;
  readonly body: string;
  readonly extractionStatus: 'extracted' | 'unavailable';
} => {
  if (mediaType === 'application/pdf') {
    const body = extractPdf(content);
    return body.length > 0
      ? { body, extractionStatus: 'extracted' }
      : {
          body: 'PDF 原件已保存，但当前运行环境无法提取其正文；请在 Obsidian 中查看附件。',
          extractionStatus: 'unavailable',
        };
  }
  if (mediaType === 'text/html' || mediaType === 'application/xhtml+xml') {
    const extracted = extractHtml(content);
    return { ...extracted, extractionStatus: 'extracted' };
  }
  return { body: new TextDecoder().decode(content).trim(), extractionStatus: 'extracted' };
};

export const CreateResearchDocumentInput = DocumentMetadataInput;
export const CreateResearchDocumentOutput = ManagedWriteStatusSchema.extend({
  documentId: z.string().regex(/^doc_[A-Za-z0-9_-]+$/),
});
export const createResearchDocumentTool = defineTool({
  name: 'create_research_document',
  description: '在 managed Vault 中创建研究文档',
  sideEffect: 'write',
  input: CreateResearchDocumentInput,
  output: CreateResearchDocumentOutput,
  handler: async (input, ctx) => {
    if (!ctx.researchVault) return missingResearchVault();
    const documentId = researchId('doc');
    const relativePath = `${managedRoot(ctx)}/Documents/${slug(input.title)}-${documentId}.md`;
    const content = documentContent(input, documentId, ctx.clock());
    const entry = await ctx.researchVault.createManagedDocument({ relativePath, content });
    const indexed = await syncStatusAfterWrite(ctx);
    return {
      vaultId: ctx.researchVault.vaultId,
      documentId,
      relativePath: entry.relativePath,
      contentHash: entry.contentHash,
      ...indexed,
    };
  },
});

export const ImportLocalResearchDocumentInput = DocumentMetadataInput.extend({
  format: z.enum(['markdown', 'text']).default('markdown'),
});
export const importLocalResearchDocumentTool = defineTool({
  name: 'import_local_research_document',
  description: '把用户明确提供的 Markdown/TXT 内容复制为 managed ResearchDocument',
  sideEffect: 'write',
  input: ImportLocalResearchDocumentInput,
  output: CreateResearchDocumentOutput,
  handler: async (input, ctx) => {
    if (!ctx.researchVault) return missingResearchVault();
    const body = input.format === 'markdown' ? parseResearchMarkdown(input.body).body : input.body;
    const normalized = { ...input, body };
    const documentId = researchId('doc');
    const relativePath = `${managedRoot(ctx)}/Documents/${slug(input.title)}-${documentId}.md`;
    const content = documentContent(normalized, documentId, ctx.clock());
    const entry = await ctx.researchVault.createManagedDocument({ relativePath, content });
    const indexed = await syncStatusAfterWrite(ctx);
    return {
      vaultId: ctx.researchVault.vaultId,
      documentId,
      relativePath: entry.relativePath,
      contentHash: entry.contentHash,
      ...indexed,
    };
  },
});

export const ImportRemoteResearchDocumentInput = z.object({
  url: z.string().url(),
  title: z.string().trim().min(1).max(300).optional(),
  kind: ResearchDocumentKindSchema.default('article'),
  sourceStatus: z.enum(['verified', 'unverified']).default('unverified'),
  topicIds: z
    .array(z.string().regex(/^topic_[A-Za-z0-9_-]+$/))
    .max(64)
    .default([]),
  subjects: TopicSubjectsInput,
  tags: TopicTagsInput,
  maxBytes: z
    .number()
    .int()
    .positive()
    .max(20 * 1024 * 1024)
    .default(20 * 1024 * 1024),
  timeoutMs: z.number().int().positive().max(30_000).default(15_000),
  maxRedirects: z.number().int().nonnegative().max(5).default(3),
});
export const ImportRemoteResearchDocumentOutput = CreateResearchDocumentOutput.extend({
  requestedUrl: z.string().url(),
  finalUrl: z.string().url(),
  mediaType: z.string().min(1),
  attachmentPath: z.string().min(1),
  extractionStatus: z.enum(['extracted', 'unavailable']),
});
export const importRemoteResearchDocumentTool = defineTool({
  name: 'import_remote_research_document',
  description: '抓取经安全校验的 URL 研究资料，保存原件并创建 untrusted managed Document',
  sideEffect: 'external',
  requiredCapabilities: ['write', 'external'],
  input: ImportRemoteResearchDocumentInput,
  output: ImportRemoteResearchDocumentOutput,
  handler: async (input, ctx) => {
    if (!ctx.researchVault) return missingResearchVault();
    if (!ctx.researchRemote) {
      return errAdapterError('research-remote', '未配置远程资料 adapter', false);
    }
    let remote: Awaited<ReturnType<NonNullable<typeof ctx.researchRemote>['fetchDocument']>>;
    try {
      remote = await ctx.researchRemote.fetchDocument({
        url: input.url,
        maxBytes: input.maxBytes,
        timeoutMs: input.timeoutMs,
        maxRedirects: input.maxRedirects,
      });
    } catch (error) {
      return errAdapterError(
        'research-remote',
        error instanceof Error ? error.message : String(error),
        true,
      );
    }
    const extracted = remoteBody(remote.mediaType, remote.content);
    const title =
      input.title ??
      extracted.title ??
      (decodeURIComponent(
        new URL(remote.finalUrl).pathname.split('/').filter(Boolean).at(-1) ?? '远程研究资料',
      )
        .replace(/\.[a-z0-9]+$/i, '')
        .slice(0, 300) ||
        '远程研究资料');
    const extension =
      remote.mediaType === 'application/pdf'
        ? '.pdf'
        : remote.mediaType === 'text/plain'
          ? '.txt'
          : '.html';
    let attachment: ResearchVaultEntry;
    try {
      attachment = await ctx.researchVault.importAttachment({
        suggestedName: `source${extension}`,
        content: remote.content,
        mediaType: remote.mediaType,
      });
    } catch (error) {
      return errAdapterError(
        'research-vault',
        error instanceof Error ? error.message : String(error),
        false,
      );
    }
    const documentId = researchId('doc');
    const metadata = {
      title,
      kind: input.kind,
      body: extracted.body,
      sourceUrl: input.url,
      sourceStatus: input.sourceStatus,
      observedAt: remote.fetchedAt,
      topicIds: input.topicIds,
      subjects: input.subjects,
      tags: input.tags,
    };
    const relativePath = `${managedRoot(ctx)}/Documents/${slug(title)}-${documentId}.md`;
    let entry: ResearchVaultEntry;
    try {
      entry = await ctx.researchVault.createManagedDocument({
        relativePath,
        content: documentContent(metadata, documentId, ctx.clock(), [attachment.relativePath]),
      });
    } catch (error) {
      return errAdapterError(
        'research-vault',
        error instanceof Error ? error.message : String(error),
        false,
      );
    }
    const indexed = await syncStatusAfterWrite(ctx);
    return {
      vaultId: ctx.researchVault.vaultId,
      documentId,
      relativePath: entry.relativePath,
      contentHash: entry.contentHash,
      requestedUrl: remote.requestedUrl,
      finalUrl: remote.finalUrl,
      mediaType: remote.mediaType,
      attachmentPath: attachment.relativePath,
      extractionStatus: extracted.extractionStatus,
      ...indexed,
    };
  },
});

const LinkResearchDocumentInput = z.object({
  topicId: z.string().regex(/^topic_[A-Za-z0-9_-]+$/),
  documentId: z.string().regex(/^doc_[A-Za-z0-9_-]+$/),
  relation: z.enum(['primary', 'supporting', 'counter-evidence', 'update']),
  expectedContentHash: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
});
export const LinkResearchDocumentOutput = ManagedWriteStatusSchema.extend({
  topicId: z.string(),
  documentId: z.string(),
  relation: z.enum(['primary', 'supporting', 'counter-evidence', 'update']),
});

const isManagedPath = (ctx: ToolContext, relativePath: string): boolean =>
  relativePath.startsWith(`${managedRoot(ctx)}/`);

const patchManagedFrontmatter = async (
  ctx: ToolContext,
  relativePath: string,
  expectedContentHash: string | undefined,
  patch: (frontmatter: Frontmatter) => void,
): Promise<{ readonly entry: ResearchVaultEntry; readonly contentHash: string }> => {
  if (!ctx.researchVault) throw new Error('research vault unavailable');
  if (!isManagedPath(ctx, relativePath)) throw new Error('unmanaged file is read-only');
  const content = await ctx.researchVault.readText({ relativePath, maxBytes: 10 * 1024 * 1024 });
  const currentHash = createHash('sha256').update(content).digest('hex');
  if (expectedContentHash !== undefined && expectedContentHash !== currentHash) {
    throw new Error('content hash mismatch');
  }
  const parsed = parseResearchMarkdown(content);
  patch(parsed.frontmatter);
  const next = `${renderFrontmatter(parsed.frontmatter)}${parsed.body}`;
  const updater = ctx.researchVault.updateManagedDocument;
  if (updater === undefined)
    throw new Error('research vault adapter does not support managed updates');
  const entry = await updater({
    relativePath,
    content: next,
    expectedContentHash: expectedContentHash ?? currentHash,
  });
  return { entry, contentHash: entry.contentHash };
};

export const linkResearchDocumentTool = defineTool({
  name: 'link_research_document',
  description: '在 managed Topic/Document 之间建立研究资料关系（带乐观并发校验）',
  sideEffect: 'write',
  input: LinkResearchDocumentInput,
  output: LinkResearchDocumentOutput,
  handler: async (input, ctx) => {
    if (!ctx.researchVault) return missingResearchVault();
    const [topic, document] = await Promise.all([
      ctx.repos.researchIndex.findTopic(input.topicId),
      ctx.repos.researchIndex.findDocument(input.documentId),
    ]);
    if (topic === null) return errNotFound('ResearchTopic', input.topicId);
    if (document === null) return errNotFound('ResearchDocument', input.documentId);
    const target =
      input.relation === 'primary' ||
      input.relation === 'counter-evidence' ||
      input.relation === 'update'
        ? topic
        : document;
    if (!isManagedPath(ctx, target.relativePath)) {
      return {
        ok: false as const,
        error: { kind: 'permission_denied' as const, required: 'managed research file' },
      };
    }
    const key =
      input.relation === 'primary'
        ? 'primary_documents'
        : input.relation === 'counter-evidence'
          ? 'counter_evidence_documents'
          : input.relation === 'update'
            ? 'update_documents'
            : 'topic_ids';
    const value = target.id === topic.id ? document.id : topic.id;
    let patched: { readonly entry: ResearchVaultEntry; readonly contentHash: string };
    try {
      patched = await patchManagedFrontmatter(
        ctx,
        target.relativePath,
        input.expectedContentHash,
        (frontmatter) => {
          frontmatter[key] = [...new Set([...listValue(frontmatter[key]), value])];
        },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message === 'unmanaged file is read-only') {
        return {
          ok: false as const,
          error: { kind: 'permission_denied' as const, required: 'managed research file' },
        };
      }
      if (message === 'content hash mismatch')
        return errInvalidInput('研究文件已被修改，请重新同步后重试');
      throw error;
    }
    const indexed = await syncStatusAfterWrite(ctx);
    return {
      vaultId: ctx.researchVault.vaultId,
      relativePath: patched.entry.relativePath,
      contentHash: patched.contentHash,
      topicId: input.topicId,
      documentId: input.documentId,
      relation: input.relation,
      ...indexed,
    };
  },
});

const ArchiveResearchTopicInput = z.object({
  topicId: z.string().regex(/^topic_[A-Za-z0-9_-]+$/),
  expectedContentHash: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
});
export const archiveResearchTopicTool = defineTool({
  name: 'archive_research_topic',
  description: '归档 managed ResearchTopic，不删除正文、关系或历史索引',
  sideEffect: 'write',
  input: ArchiveResearchTopicInput,
  output: ManagedWriteStatusSchema.extend({ topicId: z.string() }),
  handler: async (input, ctx) => {
    if (!ctx.researchVault) return missingResearchVault();
    const topic = await ctx.repos.researchIndex.findTopic(input.topicId);
    if (topic === null) return errNotFound('ResearchTopic', input.topicId);
    if (!isManagedPath(ctx, topic.relativePath)) {
      return {
        ok: false as const,
        error: { kind: 'permission_denied' as const, required: 'managed research file' },
      };
    }
    let patched: { readonly entry: ResearchVaultEntry; readonly contentHash: string };
    try {
      patched = await patchManagedFrontmatter(
        ctx,
        topic.relativePath,
        input.expectedContentHash,
        (frontmatter) => {
          frontmatter.archived_at = ctx.clock().toISOString();
        },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message === 'unmanaged file is read-only') {
        return {
          ok: false as const,
          error: { kind: 'permission_denied' as const, required: 'managed research file' },
        };
      }
      if (message === 'content hash mismatch')
        return errInvalidInput('研究文件已被修改，请重新同步后重试');
      throw error;
    }
    const indexed = await syncStatusAfterWrite(ctx);
    return {
      vaultId: ctx.researchVault.vaultId,
      topicId: input.topicId,
      relativePath: patched.entry.relativePath,
      contentHash: patched.contentHash,
      ...indexed,
    };
  },
});
