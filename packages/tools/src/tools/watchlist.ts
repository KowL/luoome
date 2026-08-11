import {
  AlertPlanSchema,
  assertWatchlistInvariants,
  assertWatchlistMemberInvariants,
  assertWatchlistMemberSourceInvariants,
  MembershipSnapshotSchema,
  ReportMissingDimensionSchema,
  type ToolContext,
  WatchlistMemberSchema,
  WatchlistMemberSourceSchema,
  WatchlistSchema,
  WatchlistSourceCandidateSchema,
  WatchlistSyncRunSchema,
} from '@luoome/core';
import { z } from 'zod';

import { defineTool, errInvalidInput, errNotFound } from '../define-tool.js';

const WatchlistSlugSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{1,63}$/);
const WatchlistMemberViewSchema = z.object({
  member: WatchlistMemberSchema,
  sources: z.array(WatchlistMemberSourceSchema),
});

export const ListWatchlistsInput = z.object({
  kind: WatchlistSchema.shape.kind.optional(),
  enabledOnly: z.boolean().default(false),
});
export const ListWatchlistsOutput = z.object({
  items: z.array(
    z.object({
      watchlist: WatchlistSchema,
      memberCount: z.number().int().nonnegative(),
      sourceHealth: z.object({
        active: z.number().int().nonnegative(),
        stale: z.number().int().nonnegative(),
      }),
    }),
  ),
  total: z.number().int().nonnegative(),
});

export const listWatchlistsTool = defineTool({
  name: 'list_watchlists',
  description: '列出 Watchlist、当前成员数和来源健康状态',
  sideEffect: 'read',
  input: ListWatchlistsInput,
  output: ListWatchlistsOutput,
  handler: async (input, ctx) => {
    const watchlists = await ctx.repos.watchlist.list({
      enabledOnly: input.enabledOnly,
      ...(input.kind === undefined ? {} : { kind: input.kind }),
    });
    const items = await Promise.all(
      watchlists.map(async (watchlist) => {
        const members = await ctx.repos.watchlistMember.listMembers(watchlist.id);
        const sources = (
          await Promise.all(
            members.map((member) => ctx.repos.watchlistMember.listSources(member.id)),
          )
        ).flat();
        return {
          watchlist,
          memberCount: members.length,
          sourceHealth: {
            active: sources.filter((source) => source.status === 'active').length,
            stale: sources.filter((source) => source.status === 'stale').length,
          },
        };
      }),
    );
    return { items, total: items.length };
  },
});

export const GetWatchlistInput = z.object({
  watchlistId: z.string().min(1),
  includeArchivedMembers: z.boolean().default(false),
});
export const GetWatchlistOutput = z.object({
  watchlist: WatchlistSchema,
  members: z.array(WatchlistMemberViewSchema),
  alertPlans: z.array(AlertPlanSchema),
});

export const getWatchlistTool = defineTool({
  name: 'get_watchlist',
  description: '查询 Watchlist、成员及其当前来源',
  sideEffect: 'read',
  input: GetWatchlistInput,
  output: GetWatchlistOutput,
  handler: async (input, ctx) => {
    const watchlist = await ctx.repos.watchlist.findById(input.watchlistId);
    if (watchlist === null) return errNotFound('Watchlist', input.watchlistId);
    const members = await ctx.repos.watchlistMember.listMembers(watchlist.id, {
      includeArchived: input.includeArchivedMembers,
    });
    return {
      watchlist,
      members: await Promise.all(
        members.map(async (member) => ({
          member,
          sources: await ctx.repos.watchlistMember.listSources(member.id),
        })),
      ),
      alertPlans: await ctx.repos.alertPlan.list({ watchlistId: watchlist.id }),
    };
  },
});

export const CreateWatchlistInput = z.object({
  id: WatchlistSlugSchema.optional(),
  name: z.string().min(1).max(80),
  description: z.string().max(1000).optional(),
  kind: z.enum(['personal', 'strategy', 'portfolio']),
  membershipPolicy: WatchlistSchema.shape.membershipPolicy,
  enabled: z.boolean().default(true),
});
export const CreateWatchlistOutput = z.object({ watchlist: WatchlistSchema });

export const createWatchlistTool = defineTool({
  name: 'create_watchlist',
  description: '创建 Watchlist；system 类型不开放给用户创建',
  sideEffect: 'write',
  input: CreateWatchlistInput,
  output: CreateWatchlistOutput,
  handler: async (input, ctx) => {
    const id = input.id ?? `watchlist-${globalThis.crypto.randomUUID().slice(0, 8)}`;
    if ((await ctx.repos.watchlist.findById(id)) !== null) {
      return errInvalidInput(`Watchlist id 已存在: ${id}`);
    }
    const now = ctx.clock();
    const watchlist = WatchlistSchema.parse({
      id,
      name: input.name,
      ...(input.description === undefined ? {} : { description: input.description }),
      kind: input.kind,
      membershipPolicy: input.membershipPolicy,
      enabled: input.enabled,
      createdAt: now,
      updatedAt: now,
    });
    assertWatchlistInvariants(watchlist);
    await ctx.repos.watchlist.save(watchlist);
    return { watchlist };
  },
});

export const UpdateWatchlistInput = z
  .object({
    watchlistId: z.string().min(1),
    name: z.string().min(1).max(80).optional(),
    description: z.string().max(1000).optional(),
    membershipPolicy: WatchlistSchema.shape.membershipPolicy.optional(),
    enabled: z.boolean().optional(),
  })
  .refine(
    (input) =>
      input.name !== undefined ||
      input.description !== undefined ||
      input.membershipPolicy !== undefined ||
      input.enabled !== undefined,
    { message: '至少提供一个更新字段' },
  );
export const UpdateWatchlistOutput = z.object({ watchlist: WatchlistSchema });

export const updateWatchlistTool = defineTool({
  name: 'update_watchlist',
  description: '更新 Watchlist 基础字段、成员策略或启用状态',
  sideEffect: 'write',
  input: UpdateWatchlistInput,
  output: UpdateWatchlistOutput,
  handler: async (input, ctx) => {
    const current = await ctx.repos.watchlist.findById(input.watchlistId);
    if (current === null) return errNotFound('Watchlist', input.watchlistId);
    if (current.kind === 'system') return errInvalidInput('system Watchlist 不允许用户修改');
    const watchlist = WatchlistSchema.parse({
      ...current,
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.description === undefined ? {} : { description: input.description }),
      ...(input.membershipPolicy === undefined ? {} : { membershipPolicy: input.membershipPolicy }),
      ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
      updatedAt: ctx.clock(),
    });
    assertWatchlistInvariants(watchlist);
    await ctx.repos.watchlist.save(watchlist);
    return { watchlist };
  },
});

export const ArchiveWatchlistInput = z.object({ watchlistId: z.string().min(1) });
export const ArchiveWatchlistOutput = z.object({ watchlist: WatchlistSchema });

export const archiveWatchlistTool = defineTool({
  name: 'archive_watchlist',
  description: '软归档 Watchlist；不会删除成员、来源或同步历史',
  sideEffect: 'write',
  input: ArchiveWatchlistInput,
  output: ArchiveWatchlistOutput,
  handler: async (input, ctx) => {
    const current = await ctx.repos.watchlist.findById(input.watchlistId);
    if (current === null) return errNotFound('Watchlist', input.watchlistId);
    if (current.kind === 'system') return errInvalidInput('system Watchlist 不允许用户归档');
    if ((await ctx.repos.alertPlan.list({ watchlistId: current.id })).length > 0) {
      return errInvalidInput('存在引用该 Watchlist 的 AlertPlan，不能归档');
    }
    await ctx.repos.watchlist.archive(current.id, ctx.clock());
    const watchlist = await ctx.repos.watchlist.findById(current.id);
    if (watchlist === null) return errNotFound('Watchlist', current.id);
    return { watchlist };
  },
});

export const AddWatchlistMemberInput = z.object({
  watchlistId: z.string().min(1),
  stockId: z.string().min(1),
  reason: z.string().min(1).max(1000).default('用户手工添加'),
  stage: z.enum(['discovered', 'watching', 'researching', 'confirmed']).default('watching'),
  priority: WatchlistMemberSchema.shape.priority.default('normal'),
});
export const AddWatchlistMemberOutput = WatchlistMemberViewSchema;

const BatchWatchlistMemberItemSchema = AddWatchlistMemberInput.omit({ watchlistId: true });
export const AddWatchlistMembersInput = z.object({
  watchlistId: z.string().min(1),
  members: z.array(BatchWatchlistMemberItemSchema).min(1).max(100),
});
export const AddWatchlistMembersOutput = z.object({
  members: z.array(WatchlistMemberViewSchema),
  created: z.number().int().nonnegative(),
});

const resolveStockId = async (value: string, ctx: ToolContext): Promise<string | null> => {
  const normalized = value.trim().toUpperCase();
  const exact = await ctx.repos.stock.findById(normalized);
  if (exact !== null) return exact.id;
  const byCode = await ctx.repos.stock.findByCode(normalized);
  return byCode?.id ?? null;
};

export const addWatchlistMembersTool = defineTool({
  name: 'add_watchlist_members',
  description: '一次为可手工维护的 Watchlist 批量添加成员；整批校验并原子写入',
  sideEffect: 'write',
  input: AddWatchlistMembersInput,
  output: AddWatchlistMembersOutput,
  handler: async (input, ctx) => {
    const watchlist = await ctx.repos.watchlist.findById(input.watchlistId);
    if (watchlist === null) return errNotFound('Watchlist', input.watchlistId);
    if (watchlist.membershipPolicy === 'synced') {
      return errInvalidInput('synced Watchlist 不允许手工添加成员');
    }
    const resolved = await Promise.all(
      input.members.map(async (item) => ({
        item,
        stockId: await resolveStockId(item.stockId, ctx),
      })),
    );
    const missing = resolved.filter((row) => row.stockId === null).map((row) => row.item.stockId);
    if (missing.length > 0) return errNotFound('Stock', missing.join(', '));
    const stockIds = resolved.map((row) => row.stockId as string);
    if (new Set(stockIds).size !== stockIds.length) {
      return errInvalidInput('members 中存在重复股票');
    }
    const now = ctx.clock();
    const rows = [];
    for (const [index, stockId] of stockIds.entries()) {
      const item = input.members[index];
      if (item === undefined) continue;
      const existing = await ctx.repos.watchlistMember.findMember(watchlist.id, stockId);
      const member = WatchlistMemberSchema.parse(
        existing === null
          ? {
              id: `${watchlist.id}:${stockId}`,
              watchlistId: watchlist.id,
              stockId,
              stage: item.stage,
              priority: item.priority,
              firstAddedAt: now,
              lastActivityAt: now,
            }
          : {
              ...existing,
              stage: existing.stage === 'archived' ? item.stage : existing.stage,
              priority: item.priority,
              lastActivityAt: now,
              archivedAt: undefined,
            },
      );
      const sourceKey = `manual:${member.id}`;
      if ((await ctx.repos.watchlistMember.currentSource(member.id, sourceKey)) !== null) {
        return errInvalidInput(`成员已存在 manual source: ${stockId}`);
      }
      const source = WatchlistMemberSourceSchema.parse({
        id: `${sourceKey}:${globalThis.crypto.randomUUID().slice(0, 8)}`,
        memberId: member.id,
        kind: 'manual',
        sourceKey,
        reason: item.reason,
        status: 'active',
        evidence: [],
        validFrom: now,
      });
      assertWatchlistMemberInvariants(member);
      assertWatchlistMemberSourceInvariants(source);
      rows.push({ member, source });
    }
    await ctx.repos.watchlistMember.commitManualMembers(rows);
    return {
      members: await Promise.all(
        rows.map(async ({ member }) => ({
          member,
          sources: await ctx.repos.watchlistMember.listSources(member.id),
        })),
      ),
      created: rows.length,
    };
  },
});

export const addWatchlistMemberTool = defineTool({
  name: 'add_watchlist_member',
  description: '为可手工维护的 Watchlist 添加 manual source',
  sideEffect: 'write',
  input: AddWatchlistMemberInput,
  output: AddWatchlistMemberOutput,
  handler: async (input, ctx) => {
    const result = await addWatchlistMembersTool.execute(
      { watchlistId: input.watchlistId, members: [input] },
      ctx,
    );
    if (!result.ok) return result;
    const first = result.data.members[0];
    if (first === undefined) return errInvalidInput('批量成员写入未返回结果');
    return first;
  },
});

export const UpdateWatchlistMemberInput = z
  .object({
    watchlistId: z.string().min(1),
    stockId: z.string().min(1),
    stage: WatchlistMemberSchema.shape.stage.exclude(['archived']).optional(),
    priority: WatchlistMemberSchema.shape.priority.optional(),
  })
  .refine((input) => input.stage !== undefined || input.priority !== undefined, {
    message: '至少提供 stage 或 priority',
  });
export const UpdateWatchlistMemberOutput = WatchlistMemberViewSchema;

export const updateWatchlistMemberTool = defineTool({
  name: 'update_watchlist_member',
  description: '更新 WatchlistMember 的研究阶段或优先级',
  sideEffect: 'write',
  input: UpdateWatchlistMemberInput,
  output: UpdateWatchlistMemberOutput,
  handler: async (input, ctx) => {
    const member = await ctx.repos.watchlistMember.findMember(input.watchlistId, input.stockId);
    if (member === null) {
      return errNotFound('WatchlistMember', `${input.watchlistId}:${input.stockId}`);
    }
    const updated = WatchlistMemberSchema.parse({
      ...member,
      ...(input.stage === undefined ? {} : { stage: input.stage }),
      ...(input.priority === undefined ? {} : { priority: input.priority }),
      lastActivityAt: ctx.clock(),
      archivedAt: undefined,
    });
    assertWatchlistMemberInvariants(updated);
    await ctx.repos.watchlistMember.saveMember(updated);
    return {
      member: updated,
      sources: await ctx.repos.watchlistMember.listSources(updated.id),
    };
  },
});

export const ArchiveWatchlistMemberInput = z.object({
  watchlistId: z.string().min(1),
  stockId: z.string().min(1),
});
export const ArchiveWatchlistMemberOutput = z.object({
  member: WatchlistMemberSchema,
  sources: z.array(WatchlistMemberSourceSchema),
});

export const archiveWatchlistMemberTool = defineTool({
  name: 'archive_watchlist_member',
  description: '结束成员的 manual source；无其它来源时归档成员',
  sideEffect: 'write',
  input: ArchiveWatchlistMemberInput,
  output: ArchiveWatchlistMemberOutput,
  handler: async (input, ctx) => {
    const member = await ctx.repos.watchlistMember.findMember(input.watchlistId, input.stockId);
    if (member === null) {
      return errNotFound('WatchlistMember', `${input.watchlistId}:${input.stockId}`);
    }
    const now = ctx.clock();
    const sources = await ctx.repos.watchlistMember.listSources(member.id, true);
    let endedManual = false;
    for (const source of sources) {
      if (source.kind !== 'manual' || source.status === 'ended') continue;
      endedManual = true;
      await ctx.repos.watchlistMember.saveSource({
        ...source,
        status: 'ended',
        validUntil: now,
      });
    }
    if (!endedManual) return errInvalidInput('成员没有可结束的 manual source');
    const current = await ctx.repos.watchlistMember.listSources(member.id);
    const updated = WatchlistMemberSchema.parse(
      current.length === 0
        ? { ...member, stage: 'archived', lastActivityAt: now, archivedAt: now }
        : { ...member, lastActivityAt: now },
    );
    await ctx.repos.watchlistMember.saveMember(updated);
    return {
      member: updated,
      sources: await ctx.repos.watchlistMember.listSources(member.id, true),
    };
  },
});

export const SyncWatchlistSourceInput = z.object({
  watchlistId: z.string().min(1),
  sourceKind: z.enum(['strategy', 'ai', 'portfolio', 'import']),
  sourceKey: z.string().min(1),
  sourceId: z.string().min(1).optional(),
  sourceVersionId: z.string().min(1).optional(),
  producerRunId: z.string().min(1).optional(),
  status: z.enum(['complete', 'partial', 'failed']),
  candidates: z.array(WatchlistSourceCandidateSchema),
  dataAsOf: z.coerce.date().optional(),
  missingDimensions: z.array(ReportMissingDimensionSchema).default([]),
  error: z.string().min(1).optional(),
});
export const SyncWatchlistSourceOutput = z.object({
  run: WatchlistSyncRunSchema,
  snapshots: z.array(MembershipSnapshotSchema),
});

export const syncWatchlistSourceTool = defineTool({
  name: 'sync_watchlist_source',
  description: '内部原子同步一个 Watchlist source；不进入公共 tool registry',
  sideEffect: 'write',
  input: SyncWatchlistSourceInput,
  output: SyncWatchlistSourceOutput,
  handler: async (input, ctx) => {
    if ((await ctx.repos.watchlist.findById(input.watchlistId)) === null) {
      return errNotFound('Watchlist', input.watchlistId);
    }
    if (!input.sourceKey.startsWith(`${input.sourceKind}:`)) {
      return errInvalidInput('sourceKey 前缀必须与 sourceKind 一致');
    }
    if (input.status === 'failed' && input.error === undefined) {
      return errInvalidInput('failed sync 必须提供 error');
    }
    if (input.status === 'failed' && input.candidates.length > 0) {
      return errInvalidInput('failed sync 不得携带 candidates');
    }
    for (const candidate of input.candidates) {
      if ((await ctx.repos.stock.findById(candidate.stockId)) === null) {
        return errNotFound('Stock', candidate.stockId);
      }
    }
    const now = ctx.clock();
    const run = WatchlistSyncRunSchema.parse({
      id: `watchlist-sync-${globalThis.crypto.randomUUID()}`,
      watchlistId: input.watchlistId,
      sourceKind: input.sourceKind,
      sourceKey: input.sourceKey,
      ...(input.producerRunId === undefined ? {} : { producerRunId: input.producerRunId }),
      status: input.status,
      ...(input.dataAsOf === undefined ? {} : { dataAsOf: input.dataAsOf }),
      startedAt: now,
      finishedAt: now,
      enteredCount: 0,
      exitedCount: 0,
      unchangedCount: 0,
      missingDimensions: input.missingDimensions,
      ...(input.error === undefined ? {} : { error: input.error }),
    });
    const committed = await ctx.repos.watchlistMember.commitWatchlistSync({
      run,
      candidates: input.candidates,
      ...(input.sourceId === undefined ? {} : { sourceId: input.sourceId }),
      ...(input.sourceVersionId === undefined ? {} : { sourceVersionId: input.sourceVersionId }),
    });
    return {
      run: committed,
      snapshots: await ctx.repos.watchlistMember.listSnapshots(committed.id),
    };
  },
});

export const ListWatchlistChangesInput = z.object({
  watchlistId: z.string().min(1),
  limit: z.number().int().positive().max(200).default(50),
});
export const ListWatchlistChangesOutput = z.object({
  watchlist: WatchlistSchema,
  runs: z.array(
    z.object({
      run: WatchlistSyncRunSchema,
      snapshots: z.array(MembershipSnapshotSchema),
    }),
  ),
});

export const listWatchlistChangesTool = defineTool({
  name: 'list_watchlist_changes',
  description: '查询 Watchlist 同步运行及 entered/unchanged/exited 快照',
  sideEffect: 'read',
  input: ListWatchlistChangesInput,
  output: ListWatchlistChangesOutput,
  handler: async (input, ctx) => {
    const watchlist = await ctx.repos.watchlist.findById(input.watchlistId);
    if (watchlist === null) return errNotFound('Watchlist', input.watchlistId);
    const runs = await ctx.repos.watchlistMember.listSyncRuns(watchlist.id, input.limit);
    return {
      watchlist,
      runs: await Promise.all(
        runs.map(async (run) => ({
          run,
          snapshots: await ctx.repos.watchlistMember.listSnapshots(run.id),
        })),
      ),
    };
  },
});
