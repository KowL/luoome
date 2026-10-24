import { z } from 'zod';
import type { AlertPlan } from '../entity/alert-plan.js';
import { type Stock, StockSchema } from '../entity/stock.js';
import type { Watchlist, WatchlistMember, WatchlistMemberSource } from '../entity/watchlist.js';
import { WatchlistMemberSourceSchema } from '../entity/watchlist.js';
import { InvariantError } from '../error/index.js';
import { HashSchema } from './hash.js';
import { PersonalOperationReceiptSchema } from './receipt.js';

export const WatchlistImportRowSchema = z.object({
  row: z.number().int().positive(),
  text: z.string(),
  status: z.enum(['ready', 'duplicate', 'unknown', 'ambiguous']),
  candidates: z.array(StockSchema),
  stockId: z.string().optional(),
  duplicateOf: z.number().int().positive().optional(),
});
export type WatchlistImportRow = z.infer<typeof WatchlistImportRowSchema>;
export const WatchlistImportPreviewSchema = z.object({
  id: z.string().min(1),
  watchlistId: z.string().min(1),
  ownerUserId: z.string().min(1),
  inputHash: HashSchema,
  watchlistRevision: HashSchema,
  mappingVersion: HashSchema,
  rows: z.array(WatchlistImportRowSchema).min(1).max(100),
  ignoredColumns: z.array(z.string()),
  createdAt: z.coerce.date(),
});
export type WatchlistImportPreview = z.infer<typeof WatchlistImportPreviewSchema>;
export const WatchlistImportSelectionSchema = z.object({
  row: z.number().int().positive(),
  stockId: z.string().min(1),
});
export type WatchlistImportSelection = z.infer<typeof WatchlistImportSelectionSchema>;
export const WatchlistImportResultSchema = z.object({
  importBatchId: z.string().min(1),
  watchlistId: z.string().min(1),
  stockIds: z.array(z.string()),
  enteredCount: z.number().int().nonnegative(),
  unchangedCount: z.number().int().nonnegative(),
  distinctStockCount: z.number().int().nonnegative(),
  receipt: PersonalOperationReceiptSchema,
});
export type WatchlistImportResult = z.infer<typeof WatchlistImportResultSchema>;
export const WatchlistRemovalResultSchema = z.object({
  results: z.array(
    z.object({
      stockId: z.string(),
      archived: z.boolean(),
      remainingSources: z.array(WatchlistMemberSourceSchema),
    }),
  ),
  receipt: PersonalOperationReceiptSchema,
});
export type WatchlistRemovalResult = z.infer<typeof WatchlistRemovalResultSchema>;

export const watchlistRevisionInput = (
  watchlist: Watchlist,
  members: readonly WatchlistMember[],
  sources: readonly WatchlistMemberSource[],
): string =>
  JSON.stringify({
    watchlist,
    members: [...members].sort((a, b) => a.id.localeCompare(b.id)),
    sources: [...sources].sort((a, b) => a.id.localeCompare(b.id)),
  });
export const watchlistRuleRevisionInput = (plans: readonly AlertPlan[]): string =>
  JSON.stringify([...plans].sort((a, b) => a.id.localeCompare(b.id)));

const csvRows = (content: string): string[][] => {
  const rows: string[][] = [];
  let cells: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < content.length; i += 1) {
    const c = content[i];
    if (c === '"') {
      if (quoted && content[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (quoted || cell.length === 0) quoted = !quoted;
      else throw new InvariantError('CSV 引号位置无效');
    } else if (!quoted && (c === ',' || c === '\n')) {
      cells.push(cell.replace(/\r$/, '').trim());
      cell = '';
      if (c === '\n') {
        rows.push(cells);
        cells = [];
      }
    } else cell += c;
  }
  if (quoted) throw new InvariantError('CSV 引号未闭合');
  cells.push(cell.replace(/\r$/, '').trim());
  if (cells.some((value) => value.length > 0)) rows.push(cells);
  return rows.filter((row) => row.some((value) => value.length > 0));
};

export const parseWatchlistImport = (
  content: string,
  format: 'text' | 'csv',
  catalog: readonly Stock[],
): { rows: WatchlistImportRow[]; ignoredColumns: string[]; normalizedInput: string } => {
  if (new TextEncoder().encode(content).length > 1_048_576)
    throw new InvariantError('自选输入不得超过 1 MiB');
  const clean = content.replace(/^\uFEFF/, '').normalize('NFKC');
  let tokens: string[];
  let ignoredColumns: string[] = [];
  if (format === 'csv') {
    const records = csvRows(clean);
    const header = records[0] ?? [];
    const names = [
      'stockid',
      'code',
      '证券代码',
      '股票代码',
      '代码',
      'name',
      '证券名称',
      '股票名称',
      '名称',
    ];
    const column = names.reduce(
      (found, name) =>
        found >= 0 ? found : header.findIndex((value) => value.toLowerCase() === name),
      -1,
    );
    const data = column < 0 ? records : records.slice(1);
    const index = Math.max(column, 0);
    ignoredColumns = header
      .filter((_, i) => i !== index)
      .map((value, i) => (column < 0 ? `column-${i + 2}` : value));
    tokens = data.map((row) => row[index] ?? '');
  } else
    tokens = clean
      .split(/\r?\n/)
      .map((row) => row.trim())
      .filter(Boolean);
  if (tokens.length === 0 || tokens.length > 100)
    throw new InvariantError('自选输入需为 1 至 100 行');
  const seen = new Map<string, number>();
  const rows = tokens.map((text, index): WatchlistImportRow => {
    const identity = text.trim().toUpperCase();
    const prefix = /^(SH|SZ|BJ)[.:]?(\d{6})$/.exec(identity);
    const normalized = prefix === null ? identity : `${prefix[2]}.${prefix[1]}`;
    const candidates = catalog.filter(
      (stock) =>
        stock.id.toUpperCase() === normalized ||
        stock.code === normalized ||
        stock.name === text.trim(),
    );
    const row = index + 1;
    if (candidates.length === 0) return { row, text, status: 'unknown', candidates };
    if (candidates.length > 1) return { row, text, status: 'ambiguous', candidates };
    const stockId = candidates[0]?.id as string;
    const duplicateOf = seen.get(stockId);
    if (duplicateOf !== undefined)
      return { row, text, status: 'duplicate', candidates, stockId, duplicateOf };
    seen.set(stockId, row);
    return { row, text, status: 'ready', candidates, stockId };
  });
  return { rows, ignoredColumns, normalizedInput: JSON.stringify({ format, tokens }) };
};

export const selectWatchlistImportStocks = (
  preview: WatchlistImportPreview,
  selections: readonly WatchlistImportSelection[],
  excludedRows: readonly number[],
  acknowledgeExtraColumns: boolean,
): string[] => {
  if (preview.ignoredColumns.length > 0 && !acknowledgeExtraColumns)
    throw new InvariantError('请确认额外列仅忽略，不会建立持仓或成交');
  const selected = new Map(selections.map((selection) => [selection.row, selection.stockId]));
  const excluded = new Set(excludedRows);
  if (
    selected.size !== selections.length ||
    excluded.size !== excludedRows.length ||
    selected.size === 0
  )
    throw new InvariantError('选择行需唯一且至少选择一只股票');
  if (selected.size + excluded.size !== preview.rows.length)
    throw new InvariantError('每一行必须明确选择或排除');
  for (const row of preview.rows) {
    const stockId = selected.get(row.row);
    if ((stockId !== undefined) === excluded.has(row.row))
      throw new InvariantError('每一行必须明确选择或排除');
    if (
      stockId !== undefined &&
      (row.status === 'duplicate' || !row.candidates.some((stock) => stock.id === stockId))
    )
      throw new InvariantError('不可选择重复或无法唯一识别的股票');
  }
  const stockIds = [...selected.values()];
  if (new Set(stockIds).size !== stockIds.length)
    throw new InvariantError('选择的规范股票身份不得重复');
  return stockIds;
};

export const buildWatchlistImportMutation = (input: {
  watchlist: Watchlist;
  members: readonly WatchlistMember[];
  sources: readonly WatchlistMemberSource[];
  stockIds: readonly string[];
  ownerUserId: string;
  importBatchId: string;
  maxDistinctStocks: number;
  now: Date;
}): {
  members: WatchlistMember[];
  sources: WatchlistMemberSource[];
  enteredCount: number;
  unchangedCount: number;
  distinctStockCount: number;
} => {
  if (input.watchlist.kind !== 'personal' || !input.watchlist.enabled)
    throw new InvariantError('导入只允许启用的个人自选');
  const currentMemberIds = new Set(
    input.sources.filter((source) => source.status !== 'ended').map((source) => source.memberId),
  );
  const distinct = new Set(
    input.members
      .filter((member) => member.stage !== 'archived' && currentMemberIds.has(member.id))
      .map((member) => member.stockId),
  );
  for (const stockId of input.stockIds) distinct.add(stockId);
  if (distinct.size > input.maxDistinctStocks)
    throw new InvariantError('关注股票数量超过当前套餐上限');
  const members: WatchlistMember[] = [];
  const sources: WatchlistMemberSource[] = [];
  let enteredCount = 0;
  const sourceKey = `import:${input.ownerUserId}`;
  for (const stockId of input.stockIds) {
    const old = input.members.find(
      (member) => member.watchlistId === input.watchlist.id && member.stockId === stockId,
    );
    const member: WatchlistMember = {
      id: old?.id ?? `${input.watchlist.id}:${stockId}`,
      watchlistId: input.watchlist.id,
      stockId,
      stage: old === undefined || old.stage === 'archived' ? 'watching' : old.stage,
      priority: old?.priority ?? 'normal',
      firstAddedAt: old?.firstAddedAt ?? input.now,
      lastActivityAt: input.now,
    };
    members.push(member);
    const current = input.sources.find(
      (source) =>
        source.memberId === member.id &&
        source.sourceKey === sourceKey &&
        source.status !== 'ended',
    );
    if (current !== undefined) continue;
    enteredCount += 1;
    sources.push({
      id: `${input.importBatchId}:${member.id}`,
      memberId: member.id,
      kind: 'import',
      sourceKey,
      ownerUserId: input.ownerUserId,
      importBatchId: input.importBatchId,
      reason: '用户确认的自选导入',
      status: 'active',
      evidence: [],
      validFrom: input.now,
    });
  }
  return {
    members,
    sources,
    enteredCount,
    unchangedCount: input.stockIds.length - enteredCount,
    distinctStockCount: distinct.size,
  };
};

export const buildPersonalMemberRemoval = (input: {
  members: readonly WatchlistMember[];
  sources: readonly WatchlistMemberSource[];
  ownerUserId: string;
  now: Date;
}): {
  members: WatchlistMember[];
  sources: WatchlistMemberSource[];
  results: { stockId: string; archived: boolean; remainingSources: WatchlistMemberSource[] }[];
} => {
  const members: WatchlistMember[] = [];
  const sources: WatchlistMemberSource[] = [];
  const results: {
    stockId: string;
    archived: boolean;
    remainingSources: WatchlistMemberSource[];
  }[] = [];
  for (const member of input.members) {
    const current = input.sources.filter(
      (source) => source.memberId === member.id && source.status !== 'ended',
    );
    const own = current.filter(
      (source) =>
        (source.kind === 'manual' || source.kind === 'import') &&
        (source.ownerUserId === undefined || source.ownerUserId === input.ownerUserId),
    );
    sources.push(
      ...own.map(
        (source): WatchlistMemberSource => ({ ...source, status: 'ended', validUntil: input.now }),
      ),
    );
    const remainingSources = current.filter(
      (source) => !own.some((ended) => ended.id === source.id),
    );
    const archived = remainingSources.length === 0;
    members.push(
      archived
        ? { ...member, stage: 'archived', archivedAt: input.now, lastActivityAt: input.now }
        : { ...member, lastActivityAt: input.now },
    );
    results.push({ stockId: member.stockId, archived, remainingSources });
  }
  return { members, sources, results };
};
