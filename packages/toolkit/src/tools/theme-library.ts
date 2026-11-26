import {
  buildThemeLibraryAutoStatus,
  buildThemeLibrarySeed,
  ThemeLibraryAutoStatusSchema,
  type ThemeLibraryImportSummary,
  ThemeLibraryImportSummarySchema,
  ThemeLibraryMemberSchema,
  ThemeLibrarySeedSkipSchema,
  type ThemeLibraryState,
  ThemeLibraryStateSchema,
  ThemeLibraryThemeSchema,
} from '@luoome/core';
import { z } from 'zod';

import { defineTool, errInvalidInput, errNotFound } from '../define-tool.js';

/**
 * 系统题材库管理：只读视图 + 显式导入 + 人工维护。
 *
 * - 导入只补齐缺失的种子题材与首版成分，不覆盖已存在题材的改名 / 归档 / 顺序 / 成分增删；
 * - 增删成分都写生效区间，回放按当时区间取成分，不重写历史；
 * - 全部写操作要求 write opt-in；无本地扶摇来源时导入明确失败，不标记成功。
 */

const ThemeLibraryIdSchema = z.string().trim().min(1).max(64);
const ThemeNameSchema = z.string().trim().min(1).max(40);
const StockIdsSchema = z.array(z.string().trim().min(1)).min(1).max(500);

export const ThemeLibrarySummaryItemSchema = z.object({
  theme: ThemeLibraryThemeSchema,
  sourceCount: z.number().int().nonnegative(),
  memberCount: z.number().int().nonnegative(),
  activeMemberCount: z.number().int().nonnegative(),
});
export type ThemeLibrarySummaryItem = z.infer<typeof ThemeLibrarySummaryItemSchema>;

export const ThemeLibraryMemberViewSchema = z.object({
  member: ThemeLibraryMemberSchema,
  code: z.string().min(1),
  name: z.string().min(1).nullable(),
});
export type ThemeLibraryMemberView = z.infer<typeof ThemeLibraryMemberViewSchema>;

export const ThemeLibraryDetailSchema = z.object({
  theme: ThemeLibraryThemeSchema,
  sources: z.array(
    z.object({
      vendorCode: z.string().min(1),
      sectorId: z.string().min(1),
      name: z.string().min(1),
      createdAt: z.coerce.date(),
    }),
  ),
  members: z.array(ThemeLibraryMemberViewSchema),
});
export type ThemeLibraryDetail = z.infer<typeof ThemeLibraryDetailSchema>;

export const GetThemeLibraryInput = z.object({
  state: z.enum(['active', 'archived', 'all']).default('all'),
  themeId: ThemeLibraryIdSchema.optional(),
});
export type GetThemeLibraryInputT = z.infer<typeof GetThemeLibraryInput>;

export const GetThemeLibraryOutput = z.object({
  initialized: z.boolean(),
  themes: z.array(ThemeLibrarySummaryItemSchema),
  lastImport: ThemeLibraryImportSummarySchema.nullable(),
  /** 自动维护开关、最近执行与待核对项；管理页一块展示。 */
  auto: ThemeLibraryAutoStatusSchema,
  detail: ThemeLibraryDetailSchema.nullable(),
});
export type GetThemeLibraryOutputT = z.infer<typeof GetThemeLibraryOutput>;

const stateFilter = (state: GetThemeLibraryInputT['state']): ThemeLibraryState | 'all' =>
  state === 'all' ? 'all' : ThemeLibraryStateSchema.parse(state);

export const getThemeLibraryTool = defineTool({
  name: 'get_theme_library',
  description:
    '读取系统题材库：已导入 / 新建的题材、固定顺序、来源概念映射与成分生效区间；可选 themeId 返回单题材明细（含历史区间与股票代码）；只读，不触发塞入或采集',
  sideEffect: 'read',
  input: GetThemeLibraryInput,
  output: GetThemeLibraryOutput,
  handler: async (input, ctx) => {
    const themes = await ctx.repos.themeLibrary.listThemes({ state: stateFilter(input.state) });
    const initialized =
      themes.length > 0 || (await ctx.repos.themeLibrary.listThemes({ state: 'all' })).length > 0;
    const themeIds = themes.map((theme) => theme.id);
    const [sources, members, lastImport, autoSettings, autoRuns] = await Promise.all([
      ctx.repos.themeLibrary.listSources(themeIds),
      ctx.repos.themeLibrary.listMembers({ themeIds }),
      ctx.repos.themeLibrary.latestImport(),
      ctx.repos.themeLibrary.getAutoSettings(),
      ctx.repos.themeLibrary.listAutoRuns({ limit: 30 }),
    ]);
    const sourceCounts = new Map<string, number>();
    for (const source of sources) {
      sourceCounts.set(source.themeId, (sourceCounts.get(source.themeId) ?? 0) + 1);
    }
    const memberCounts = new Map<string, number>();
    const activeCounts = new Map<string, number>();
    for (const member of members) {
      memberCounts.set(member.themeId, (memberCounts.get(member.themeId) ?? 0) + 1);
      if (member.effectiveTo === null) {
        activeCounts.set(member.themeId, (activeCounts.get(member.themeId) ?? 0) + 1);
      }
    }
    const items: ThemeLibrarySummaryItem[] = themes.map((theme) => ({
      theme,
      sourceCount: sourceCounts.get(theme.id) ?? 0,
      memberCount: memberCounts.get(theme.id) ?? 0,
      activeMemberCount: activeCounts.get(theme.id) ?? 0,
    }));

    let detail: ThemeLibraryDetail | null = null;
    if (input.themeId !== undefined) {
      const target = themes.find((theme) => theme.id === input.themeId);
      if (target === undefined) return errNotFound('ThemeLibrary', input.themeId);
      const themeMembers = members.filter((member) => member.themeId === target.id);
      const names = new Map<string, string>();
      if (themeMembers.length > 0) {
        const current = await ctx.repos.stockUniverse.listCurrentMembers({
          coverage: 'CN_A_SHARES_SH_SZ',
        });
        for (const { stock } of current) names.set(stock.id, stock.name);
        const missing = themeMembers
          .map((member) => member.stockId)
          .filter((stockId) => !names.has(stockId));
        for (const stockId of new Set(missing)) {
          const stock = await ctx.repos.stock.findById(stockId);
          if (stock !== null) names.set(stock.id, stock.name);
        }
      }
      detail = {
        theme: target,
        sources: sources
          .filter((source) => source.themeId === target.id)
          .map(({ vendorCode, sectorId, name, createdAt }) => ({
            vendorCode,
            sectorId,
            name,
            createdAt,
          })),
        members: themeMembers
          .map((member) => ({
            member,
            code: member.stockId.split('.')[0] ?? member.stockId,
            name: names.get(member.stockId) ?? null,
          }))
          .sort(
            (left, right) =>
              Number(right.member.effectiveTo === null) -
                Number(left.member.effectiveTo === null) ||
              right.member.effectiveFrom.getTime() - left.member.effectiveFrom.getTime() ||
              left.member.stockId.localeCompare(right.member.stockId),
          ),
      };
    }

    return {
      initialized,
      themes: items,
      lastImport,
      auto: buildThemeLibraryAutoStatus({ settings: autoSettings, runs: autoRuns }),
      detail,
    };
  },
});

export const ImportThemeLibraryInput = z.object({});
export const ImportThemeLibraryOutput = z.object({
  import: ThemeLibraryImportSummarySchema,
  themeCount: z.number().int().nonnegative(),
  memberCount: z.number().int().nonnegative(),
});
export type ImportThemeLibraryOutputT = z.infer<typeof ImportThemeLibraryOutput>;

/**
 * 显式首版导入：读取本地已同步扶摇概念目录与 active 成分，按 core 标准题材定义生成种子。
 * 没有本地来源时返回 invalid_input，不写导入审计、不标记成功。
 */
export const importThemeLibraryTool = defineTool({
  name: 'import_theme_library',
  description:
    '从本地已同步的扶摇概念目录与 active 成分导入系统题材库首版种子：按 core 标准题材分类合并有效成分并去重，保留稳定题材 id 与来源映射；只补齐缺失题材，重复导入不覆盖人工改名 / 归档 / 顺序 / 成分增删；无本地来源时明确失败，不标记导入成功；写本地库，不访问外部',
  sideEffect: 'write',
  input: ImportThemeLibraryInput,
  output: ImportThemeLibraryOutput,
  handler: async (_input, ctx) => {
    const catalog = await ctx.repos.sectorCatalog.listSectors({
      kinds: ['concept'],
      state: 'active',
    });
    if (catalog.length === 0) {
      return errInvalidInput(
        '本地没有已同步的扶摇概念目录，请先执行 sync_sector_catalog（或检查扶摇凭据）后再导入',
      );
    }
    const members = await ctx.repos.sectorCatalog.listBySectors({
      sectorIds: catalog.map((sector) => sector.id),
    });
    if (members.length === 0) {
      return errInvalidInput(
        '本地没有已同步的扶摇概念成分，请先执行 sync_sector_catalog（或检查扶摇凭据）后再导入',
      );
    }
    const seed = buildThemeLibrarySeed({ catalog, members });
    if (seed.themes.length === 0) {
      return errInvalidInput(
        '本地扶摇概念里没有标准题材可用的有效成分，未导入任何题材，不改动现有题材库',
      );
    }
    const appliedAt = ctx.clock();
    const source = [...new Set(catalog.map((sector) => sector.source))].sort().join('+');
    const summary = await ctx.repos.themeLibrary.importSeed({
      importId: crypto.randomUUID(),
      source: source.length === 0 ? 'fuyao-concept' : source,
      appliedAt,
      seed: {
        themes: seed.themes,
        skipped: seed.skipped.map((entry) => ThemeLibrarySeedSkipSchema.parse(entry)),
      },
    });
    const [themes, allMembers] = await Promise.all([
      ctx.repos.themeLibrary.listThemes({ state: 'all' }),
      ctx.repos.themeLibrary.listMembers(),
    ]);
    return {
      import: summary,
      themeCount: themes.length,
      memberCount: allMembers.filter((member) => member.effectiveTo === null).length,
    };
  },
});

const CreateThemeInput = z.object({
  action: z.literal('create'),
  name: ThemeNameSchema,
});
const RenameThemeInput = z.object({
  action: z.literal('rename'),
  themeId: ThemeLibraryIdSchema,
  name: ThemeNameSchema,
});
const ArchiveThemeInput = z.object({
  action: z.literal('archive'),
  themeId: ThemeLibraryIdSchema,
});
const ReorderThemesInput = z.object({
  action: z.literal('reorder'),
  themeIds: z.array(ThemeLibraryIdSchema).min(1).max(500),
});
const AddThemeMembersInput = z.object({
  action: z.literal('add-members'),
  themeId: ThemeLibraryIdSchema,
  stockIds: StockIdsSchema,
});
const RemoveThemeMemberInput = z.object({
  action: z.literal('remove-member'),
  themeId: ThemeLibraryIdSchema,
  stockId: z.string().trim().min(1),
});
const SetThemeAutoInput = z.object({
  action: z.literal('auto-maintenance'),
  enabled: z.boolean(),
});

export const UpdateThemeLibraryInput = z.discriminatedUnion('action', [
  CreateThemeInput,
  RenameThemeInput,
  ArchiveThemeInput,
  ReorderThemesInput,
  AddThemeMembersInput,
  RemoveThemeMemberInput,
  SetThemeAutoInput,
]);
export type UpdateThemeLibraryInputT = z.infer<typeof UpdateThemeLibraryInput>;

export const UpdateThemeLibraryOutput = z.object({
  action: z.enum([
    'create',
    'rename',
    'archive',
    'reorder',
    'add-members',
    'remove-member',
    'auto-maintenance',
  ]),
  themeId: z.string().min(1).nullable(),
  changed: z.number().int().nonnegative(),
});
export type UpdateThemeLibraryOutputT = z.infer<typeof UpdateThemeLibraryOutput>;

const requireTheme = async (
  ctx: Parameters<typeof getThemeLibraryTool.execute>[1],
  themeId: string,
) => {
  const theme = await ctx.repos.themeLibrary.findTheme(themeId);
  if (theme === null) return errNotFound('ThemeLibrary', themeId);
  return theme;
};

export const updateThemeLibraryTool = defineTool({
  name: 'update_theme_library',
  description:
    '维护系统题材库：新建 / 改名 / 归档题材、调整固定顺序、批量新增关联股票或结束单只股票成分、启停盘后自动维护；每次成分变更写生效区间，不覆盖历史；题材名不可重复；只写本地库',
  sideEffect: 'write',
  input: UpdateThemeLibraryInput,
  output: UpdateThemeLibraryOutput,
  handler: async (input, ctx) => {
    switch (input.action) {
      case 'create': {
        const existing = await ctx.repos.themeLibrary.findThemeByName(input.name);
        if (existing !== null) {
          return errInvalidInput(`题材名已存在：${input.name}`);
        }
        const theme = await ctx.repos.themeLibrary.createTheme({
          id: crypto.randomUUID(),
          name: input.name,
          at: ctx.clock(),
        });
        return { action: 'create', themeId: theme.id, changed: 1 };
      }
      case 'rename': {
        const theme = await requireTheme(ctx, input.themeId);
        if ('ok' in theme) return theme;
        const conflict = await ctx.repos.themeLibrary.findThemeByName(input.name);
        if (conflict !== null && conflict.id !== theme.id) {
          return errInvalidInput(`题材名已存在：${input.name}`);
        }
        const renamed = await ctx.repos.themeLibrary.renameTheme({
          themeId: theme.id,
          name: input.name,
          at: ctx.clock(),
        });
        if (renamed === null) return errNotFound('ThemeLibrary', input.themeId);
        return {
          action: 'rename',
          themeId: theme.id,
          changed: renamed.name === theme.name ? 0 : 1,
        };
      }
      case 'archive': {
        const theme = await requireTheme(ctx, input.themeId);
        if ('ok' in theme) return theme;
        if (theme.state === 'archived') {
          return errInvalidInput(`题材已归档：${theme.name}`);
        }
        const archived = await ctx.repos.themeLibrary.archiveTheme({
          themeId: theme.id,
          at: ctx.clock(),
        });
        if (archived === null) return errNotFound('ThemeLibrary', input.themeId);
        return { action: 'archive', themeId: theme.id, changed: 1 };
      }
      case 'reorder': {
        const themes = await ctx.repos.themeLibrary.listThemes({ state: 'all' });
        const expected = new Set(themes.map((theme) => theme.id));
        if (
          expected.size !== input.themeIds.length ||
          input.themeIds.some((themeId) => !expected.has(themeId))
        ) {
          return errInvalidInput('题材顺序列表必须覆盖当前全部题材，且不能重复');
        }
        const before = new Map(themes.map((theme) => [theme.id, theme.sortOrder]));
        await ctx.repos.themeLibrary.reorderThemes({
          themeIds: input.themeIds,
          at: ctx.clock(),
        });
        const changed = input.themeIds.filter(
          (themeId, index) => before.get(themeId) !== index,
        ).length;
        return { action: 'reorder', themeId: null, changed };
      }
      case 'add-members': {
        const theme = await requireTheme(ctx, input.themeId);
        if ('ok' in theme) return theme;
        if (theme.state !== 'active') {
          return errInvalidInput(`题材已归档，不能新增成分：${theme.name}`);
        }
        const stockIds = [...new Set(input.stockIds)];
        const stocks = await Promise.all(
          stockIds.map((stockId) => ctx.repos.stock.findById(stockId)),
        );
        const missing = stockIds.filter((_stockId, index) => stocks[index] === null);
        if (missing.length > 0) {
          return errInvalidInput(`本地股票目录不存在：${missing.join(', ')}`);
        }
        const changed = await ctx.repos.themeLibrary.addMembers({
          themeId: theme.id,
          stockIds,
          origin: 'manual',
          at: ctx.clock(),
        });
        return { action: 'add-members', themeId: theme.id, changed };
      }
      case 'remove-member': {
        const theme = await requireTheme(ctx, input.themeId);
        if ('ok' in theme) return theme;
        if (theme.state !== 'active') {
          return errInvalidInput(`题材已归档，不能修改成分：${theme.name}`);
        }
        const removed = await ctx.repos.themeLibrary.removeMember({
          themeId: theme.id,
          stockId: input.stockId,
          at: ctx.clock(),
        });
        if (!removed) {
          return errInvalidInput(`该股票不在题材当前生效成分中：${input.stockId}`);
        }
        return { action: 'remove-member', themeId: theme.id, changed: 1 };
      }
      case 'auto-maintenance': {
        const current = await ctx.repos.themeLibrary.getAutoSettings();
        if (current.enabled === input.enabled) {
          return { action: 'auto-maintenance', themeId: null, changed: 0 };
        }
        await ctx.repos.themeLibrary.saveAutoSettings({ enabled: input.enabled, at: ctx.clock() });
        return { action: 'auto-maintenance', themeId: null, changed: 1 };
      }
    }
  },
});

export const ThemeLibraryImportSummaryForTest = ThemeLibraryImportSummarySchema;
export type { ThemeLibraryImportSummary };
