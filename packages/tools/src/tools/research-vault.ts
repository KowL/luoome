import { parseResearchMarkdown } from '@luoome/adapters';
import {
  normalizeResearchSubject,
  type ResearchDocumentChunk,
  type ResearchDocumentIndex,
  ResearchDocumentIndexSchema,
  ResearchDocumentKindSchema,
  type ResearchIndexStatus,
  type ResearchSubjectLink,
  type ResearchTopicDocument,
  type ResearchTopicIndex,
  ResearchTopicIndexSchema,
  ResearchTopicKindSchema,
  type ResearchVaultEntry,
  type ResearchVaultSyncRun,
  type ToolContext,
} from '@luoome/core';
import { z } from 'zod';

import { defineTool, errAdapterError, errNotFound } from '../define-tool.js';

const availability = z.enum(['available', 'missing', 'invalid', 'conflict']);
const indexStatusSchema = z.object({
  vaultId: z.string(),
  freshness: z.enum(['fresh', 'stale', 'unavailable']),
  lastSyncAt: z.coerce.date().optional(),
  diagnostic: z.string().optional(),
});
const topicSummary = ResearchTopicIndexSchema;
const documentSummary = ResearchDocumentIndexSchema;
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
  const output: ResearchDocumentChunk[] = [];
  let heading = '';
  let buffer: string[] = [];
  const flush = (): void => {
    const text = buffer.join('\n').trim();
    if (text) {
      output.push({
        documentId,
        ordinal: output.length,
        headingPath: heading,
        contentHash,
        body: text.slice(0, 2500),
      });
    }
    buffer = [];
  };
  for (const line of body.split('\n')) {
    const match = line.match(/^(#{1,6})\s+(.+)$/);
    if (match?.[2] !== undefined) {
      flush();
      heading = match[2].trim();
    }
    buffer.push(line);
    if (buffer.join('\n').length >= 2000) flush();
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
    freshness: latest?.status === 'partial' || latest?.status === 'failed' ? 'stale' : 'fresh',
    ...(latest?.finishedAt ? { lastSyncAt: latest.finishedAt } : {}),
    ...(latest?.error ? { diagnostic: latest.error } : {}),
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
  subjects: z.array(z.record(z.string(), z.unknown())),
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
    return {
      topic,
      documents: [...documents],
      subjects: [],
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
      capability: 'metadata' as const,
      indexStatus: await currentIndexStatus(ctx, hits[0]?.document.vaultId),
    };
  },
});

export const GetStockResearchViewInput = z.object({
  stockId: z.string().min(1),
  limit: z.number().int().positive().max(200).default(50),
});
export const GetStockResearchViewOutput = z.object({
  stockId: z.string(),
  topics: z.array(topicSummary),
  documents: z.array(documentSummary),
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
    const [topics, documents] = await Promise.all([
      ctx.repos.researchIndex.listTopics({ subject, limit: input.limit }),
      ctx.repos.researchIndex.listDocuments({ subject, limit: input.limit }),
    ]);
    return {
      stockId: input.stockId,
      topics: [...topics],
      documents: [...documents],
      indexStatus: await currentIndexStatus(ctx, topics[0]?.vaultId ?? documents[0]?.vaultId),
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
