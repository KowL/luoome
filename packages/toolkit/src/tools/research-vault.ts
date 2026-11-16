import { parseResearchMarkdown } from '@luoome/adapters';
import {
  type ResearchDocumentIndex,
  ResearchDocumentIndexSchema,
  ResearchDocumentKindSchema,
  type ResearchIndexStatus,
  type ResearchVaultEntry,
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
const documentSummary = ResearchDocumentIndexSchema;

type Frontmatter = Record<string, string | string[] | undefined>;

const listValue = (value: string | string[] | undefined): string[] =>
  Array.isArray(value) ? value : value ? [value] : [];

const field = (frontmatter: Frontmatter, key: string): string | string[] | undefined =>
  frontmatter[key];

const asDate = (value: string | string[] | undefined): Date | undefined =>
  typeof value === 'string' && value ? new Date(value) : undefined;

const vaultRequired = (ctx: ToolContext) =>
  ctx.adapters.researchVault
    ? null
    : errAdapterError('research-vault', '未配置 LUOOME_RESEARCH_VAULT', false);

const missingResearchVault = () => ({
  ok: false as const,
  error: { kind: 'permission_denied' as const, required: 'LUOOME_RESEARCH_VAULT' },
});

const managedRoot = (ctx: ToolContext): string =>
  ctx.adapters.researchVault?.managedRoot ?? 'Research/Luoome';

const researchId = (): string =>
  `doc_${globalThis.crypto.randomUUID().replaceAll('-', '').slice(0, 20)}`;

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

const renderFrontmatter = (
  values: Readonly<Record<string, string | readonly string[] | undefined>>,
): string => {
  const lines = ['---'];
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      lines.push(`${key}:`, ...value.map((item) => `  - ${yamlScalar(item)}`));
    } else if (typeof value === 'string') {
      lines.push(`${key}: ${yamlScalar(value)}`);
    }
  }
  lines.push('---');
  return `${lines.join('\n')}\n`;
};

const slug = (value: string): string => {
  const normalized = value
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return normalized || 'research';
};

/** 没有同步运行表后，freshness 只能表达「Vault 已配置 / 未配置」。 */
const currentIndexStatus = async (
  ctx: ToolContext,
  fallbackVaultId?: string,
): Promise<ResearchIndexStatus> => {
  const vaultId = ctx.adapters.researchVault?.vaultId ?? fallbackVaultId ?? 'unconfigured';
  if (!ctx.adapters.researchVault) {
    return {
      vaultId,
      freshness: 'unavailable',
      diagnostic: 'Vault 当前未配置；结果来自可重建索引',
    };
  }
  return {
    vaultId,
    freshness: 'stale',
    diagnostic: '索引由最近一次 Vault 同步写入，未记录逐次运行审计',
  };
};

const stockCodesOf = (frontmatter: Frontmatter): string[] => [
  ...new Set(
    listValue(field(frontmatter, 'stock_codes'))
      .map((code) => code.trim().toUpperCase())
      .filter((code) => code.length > 0),
  ),
];

const ManagedWriteStatusSchema = z.object({
  vaultId: z.string().min(1),
  relativePath: z.string().min(1),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  indexed: z.boolean(),
  syncStatus: z.enum(['succeeded', 'partial', 'failed']),
  diagnostic: z.string().optional(),
});

const ResearchTagsInput = z.array(z.string().trim().min(1).max(64)).max(32).default([]);
const ResearchStockCodesInput = z.array(z.string().trim().min(1).max(32)).max(200).default([]);

export const DocumentMetadataInput = z
  .object({
    title: z.string().trim().min(1).max(300),
    kind: ResearchDocumentKindSchema,
    body: z.string().max(200_000),
    author: z.string().trim().max(200).optional(),
    sourceUrl: z.string().url().optional(),
    sourceStatus: z.enum(['verified', 'unverified']).optional(),
    publishedAt: z.coerce.date().optional(),
    observedAt: z.coerce.date().optional(),
    stockCodes: ResearchStockCodesInput,
    tags: ResearchTagsInput,
  })
  .superRefine((input, ctx) => {
    if (input.sourceStatus === 'verified' && input.sourceUrl === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['sourceUrl'],
        message: 'sourceStatus=verified 必须提供 sourceUrl',
      });
    }
  });

const documentContent = (
  input: z.infer<typeof DocumentMetadataInput>,
  id: string,
  now: Date,
): string =>
  `${renderFrontmatter({
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
    ...(input.stockCodes.length === 0 ? {} : { stock_codes: [...input.stockCodes] }),
    ...(input.tags.length === 0 ? {} : { tags: [...input.tags] }),
  })}\n${input.body.trim()}\n`;

interface ParsedDocumentEntry {
  readonly document: ResearchDocumentIndex;
  readonly body: string;
}

const isMarkdownPath = (relativePath: string): boolean =>
  relativePath.toLowerCase().endsWith('.md');

const parseDocumentEntry = async (
  ctx: ToolContext,
  entry: ResearchVaultEntry,
): Promise<ParsedDocumentEntry | null> => {
  if (!ctx.adapters.researchVault) throw new Error('research vault unavailable');
  const content = await ctx.adapters.researchVault.readText({
    relativePath: entry.relativePath,
    maxBytes: 10 * 1024 * 1024,
  });
  const parsed = parseResearchMarkdown(content);
  const frontmatter = parsed.frontmatter;
  if (field(frontmatter, 'luoome_type') !== 'research-document') return null;
  const id = field(frontmatter, 'luoome_id');
  const title = field(frontmatter, 'title');
  if (typeof id !== 'string' || typeof title !== 'string') {
    throw new Error('luoome_id and title are required');
  }
  const body = parsed.body.trim();
  const document = ResearchDocumentIndexSchema.parse({
    id,
    title,
    kind: field(frontmatter, 'document_kind'),
    ...(field(frontmatter, 'author') === undefined ? {} : { author: field(frontmatter, 'author') }),
    ...(field(frontmatter, 'source_url') === undefined
      ? {}
      : { sourceUrl: field(frontmatter, 'source_url') }),
    ...(field(frontmatter, 'source_status') === undefined
      ? {}
      : { sourceStatus: field(frontmatter, 'source_status') }),
    ...(asDate(field(frontmatter, 'published_at')) === undefined
      ? {}
      : { publishedAt: asDate(field(frontmatter, 'published_at')) }),
    ...(asDate(field(frontmatter, 'observed_at')) === undefined
      ? {}
      : { observedAt: asDate(field(frontmatter, 'observed_at')) }),
    importedAt: asDate(field(frontmatter, 'imported_at')) ?? ctx.clock(),
    tags: listValue(field(frontmatter, 'tags')),
    stockCodes: stockCodesOf(frontmatter),
    vaultId: ctx.adapters.researchVault.vaultId,
    relativePath: entry.relativePath,
    attachmentPaths: listValue(field(frontmatter, 'attachments')),
    contentHash: entry.contentHash,
    excerpt: body.slice(0, 1000),
    fileModifiedAt: entry.modifiedAt,
    indexedAt: ctx.clock(),
    availability: body ? 'available' : 'invalid',
    ...(body ? {} : { diagnostic: '研究资料正文为空' }),
  });
  return { document, body };
};

// --- sync（workflow-only；不进公共 registry） ---------------------------------

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
  description: '扫描本地 Obsidian Vault 并重建研究笔记索引（workflow-only）',
  sideEffect: 'write',
  input: SyncResearchVaultInput,
  output: SyncResearchVaultOutput,
  handler: async (_input, ctx) => {
    const missingVault = vaultRequired(ctx);
    if (!ctx.adapters.researchVault) {
      return missingVault ?? errAdapterError('research-vault', 'Vault 不可用', false);
    }
    const vault = ctx.adapters.researchVault;
    try {
      const entries = await vault.scan();
      const parsed: ParsedDocumentEntry[] = [];
      let parseInvalid = 0;
      for (const entry of entries) {
        if (!isMarkdownPath(entry.relativePath)) continue;
        try {
          const result = await parseDocumentEntry(ctx, entry);
          if (result) parsed.push(result);
        } catch (error) {
          parseInvalid += 1;
          ctx.logger.warn('research vault file skipped', {
            relativePath: entry.relativePath,
            reason: error instanceof Error ? error.message : String(error),
          });
        }
      }

      const counts = new Map<string, number>();
      for (const entry of parsed) {
        counts.set(entry.document.id, (counts.get(entry.document.id) ?? 0) + 1);
      }
      const duplicateConflicts = [...counts.values()].filter((count) => count > 1).length;
      const documents = parsed
        .filter((entry) => counts.get(entry.document.id) === 1)
        .map((entry) => entry.document);
      const contents = Object.fromEntries(
        parsed
          .filter((entry) => counts.get(entry.document.id) === 1)
          .map((entry) => [entry.document.id, entry.body] as const),
      );
      const completeness =
        parseInvalid > 0 || duplicateConflicts > 0 ? ('partial' as const) : ('complete' as const);
      const summary = await ctx.repos.researchIndex.applyIndexBatch({
        vaultId: vault.vaultId,
        completeness,
        documents,
        contents,
        seenDocumentIds: new Set(documents.map((document) => document.id)),
        indexedAt: ctx.clock(),
      });
      const invalid = summary.invalid + parseInvalid;
      const conflicts = summary.conflicts + duplicateConflicts;
      return {
        vaultId: vault.vaultId,
        scanned: entries.length,
        added: summary.added,
        updated: summary.updated,
        unchanged: summary.unchanged,
        missing: summary.missing,
        invalid,
        conflicts,
        status: invalid > 0 || conflicts > 0 ? ('partial' as const) : ('succeeded' as const),
      };
    } catch (error) {
      return errAdapterError(
        'research-vault',
        error instanceof Error ? error.message : String(error),
        true,
      );
    }
  },
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

// --- 4 个 Research Note Tool ---------------------------------------------------

export const CreateResearchDocumentInput = DocumentMetadataInput;
export const CreateResearchDocumentOutput = ManagedWriteStatusSchema.extend({
  documentId: z.string().regex(/^doc_[A-Za-z0-9_-]+$/),
});
export const createResearchDocumentTool = defineTool({
  name: 'create_research_document',
  description: '在 managed Vault 中创建研究笔记（写入后可被检索）',
  sideEffect: 'write',
  input: CreateResearchDocumentInput,
  output: CreateResearchDocumentOutput,
  handler: async (input, ctx) => {
    if (!ctx.adapters.researchVault) return missingResearchVault();
    const documentId = researchId();
    const relativePath = `${managedRoot(ctx)}/Documents/${slug(input.title)}-${documentId}.md`;
    const content = documentContent(input, documentId, ctx.clock());
    const entry = await ctx.adapters.researchVault.createManagedDocument({ relativePath, content });
    const indexed = await syncStatusAfterWrite(ctx);
    return {
      vaultId: ctx.adapters.researchVault.vaultId,
      documentId,
      relativePath: entry.relativePath,
      contentHash: entry.contentHash,
      ...indexed,
    };
  },
});

export const ListResearchDocumentsInput = z.object({
  kind: ResearchDocumentKindSchema.optional(),
  tags: z.array(z.string()).optional(),
  availability: availability.optional(),
  stockCode: z.string().trim().min(1).optional(),
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
  description: '查询研究笔记索引；可按 kind/tag/availability/股票代码/披露区间过滤',
  sideEffect: 'read',
  input: ListResearchDocumentsInput,
  output: ListResearchDocumentsOutput,
  handler: async (input, ctx) => {
    const documents = await ctx.repos.researchIndex.listDocuments({
      ...(input.kind ? { kind: input.kind } : {}),
      ...(input.tags ? { tags: input.tags } : {}),
      ...(input.availability ? { availability: input.availability } : {}),
      ...(input.stockCode ? { stockCode: input.stockCode.toUpperCase() } : {}),
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
  description: '读取研究笔记元数据，正文按窗口读取',
  sideEffect: 'read',
  input: GetResearchDocumentInput,
  output: GetResearchDocumentOutput,
  handler: async (input, ctx) => {
    const document = await ctx.repos.researchIndex.findDocument(input.documentId);
    if (!document) return errNotFound('ResearchDocument', input.documentId);
    if (input.includeContent && !ctx.adapters.researchVault) return vaultRequired(ctx);
    const output: {
      document: ResearchDocumentIndex;
      content?: string;
      truncated?: boolean;
      nextOffset?: number;
      obsidianUri?: string;
      indexStatus: ResearchIndexStatus;
    } = {
      document,
      ...(ctx.adapters.researchVault
        ? { obsidianUri: ctx.adapters.researchVault.buildOpenUri(document.relativePath) }
        : {}),
      indexStatus: await currentIndexStatus(ctx, document.vaultId),
    };
    if (input.includeContent && ctx.adapters.researchVault) {
      const text = await ctx.adapters.researchVault.readText({
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
  kind: ResearchDocumentKindSchema.optional(),
  stockCode: z.string().trim().min(1).optional(),
  limit: z.number().int().positive().max(200).default(50),
});
export const SearchResearchDocumentsOutput = z.object({
  hits: z.array(
    z.object({
      document: documentSummary,
      snippet: z.string(),
      score: z.number().optional(),
    }),
  ),
  capability: z.enum(['fts', 'metadata']),
  indexStatus: indexStatusSchema,
});
export const searchResearchDocumentsTool = defineTool({
  name: 'search_research_documents',
  description: '全文检索研究笔记；FTS5 不可用时明确返回 metadata capability',
  sideEffect: 'read',
  input: SearchResearchDocumentsInput,
  output: SearchResearchDocumentsOutput,
  handler: async (input, ctx) => {
    const hits = await ctx.repos.researchIndex.searchDocuments({
      text: input.text,
      ...(input.kind ? { kind: input.kind } : {}),
      ...(input.stockCode ? { stockCode: input.stockCode.toUpperCase() } : {}),
      limit: input.limit,
    });
    return {
      hits: [...hits],
      capability: ctx.repos.researchIndex.searchCapability(),
      indexStatus: await currentIndexStatus(ctx, hits[0]?.document.vaultId),
    };
  },
});
