import {
  InvariantError,
  type ThemeLibraryAutoPlan,
  ThemeLibraryAutoPlanSchema,
  type ThemeLibraryAutoRun,
  ThemeLibraryAutoRunSchema,
  type ThemeLibraryAutoRunStatus,
  type ThemeLibraryAutoSettings,
  type ThemeLibraryAutoSkipReason,
  type ThemeLibraryImportInput,
  type ThemeLibraryImportSummary,
  ThemeLibraryImportSummarySchema,
  type ThemeLibraryMember,
  type ThemeLibraryMemberOrigin,
  type ThemeLibraryRepository,
  ThemeLibrarySeedSkipSchema,
  type ThemeLibraryState,
  type ThemeLibraryTheme,
  type ThemeLibraryThemeSource,
} from '@luoome/core';
import { and, asc, desc, eq, gt, inArray, isNull, lte, or, type SQL } from 'drizzle-orm';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';
import {
  type Schema,
  themeLibraryAutoRuns,
  themeLibraryAutoSettings,
  themeLibraryImports,
  themeLibraryMembers,
  themeLibraryThemeSources,
  themeLibraryThemes,
} from '../../schema/index.js';
import { RepositoryWriteScope } from '../../write-scope.js';

type ThemeRow = typeof themeLibraryThemes.$inferSelect;
type SourceRow = typeof themeLibraryThemeSources.$inferSelect;
type MemberRow = typeof themeLibraryMembers.$inferSelect;
type ImportRow = typeof themeLibraryImports.$inferSelect;
type AutoRunRow = typeof themeLibraryAutoRuns.$inferSelect;

const AUTO_SETTINGS_ID = 'default';

const toTheme = (row: ThemeRow): ThemeLibraryTheme => ({
  id: row.id,
  name: row.name,
  state: row.state,
  sortOrder: row.sortOrder,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
  archivedAt: row.archivedAt,
});

const toSource = (row: SourceRow): ThemeLibraryThemeSource => ({
  themeId: row.themeId,
  vendorCode: row.vendorCode,
  sectorId: row.sectorId,
  name: row.name,
  createdAt: row.createdAt,
});

const toMember = (row: MemberRow): ThemeLibraryMember => ({
  id: row.id,
  themeId: row.themeId,
  stockId: row.stockId,
  origin: row.origin,
  effectiveFrom: row.effectiveFrom,
  effectiveTo: row.effectiveTo,
  createdAt: row.createdAt,
});

const summaryFromImport = (row: ImportRow): ThemeLibraryImportSummary =>
  ThemeLibraryImportSummarySchema.parse({
    importId: row.id,
    source: row.source,
    status: row.status,
    appliedAt: row.appliedAt,
    createdThemes: row.createdThemes,
    createdMembers: row.createdMembers,
    createdSources: row.createdSources,
    skippedThemes: row.skippedThemes,
  });

const autoRunId = (tradingDay: string, source: string): string => `${tradingDay}|${source}`;

const toAutoRun = (row: AutoRunRow): ThemeLibraryAutoRun =>
  ThemeLibraryAutoRunSchema.parse({
    tradingDay: row.tradingDay,
    source: row.source,
    status: row.status,
    attempt: row.attempt,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    effectiveFrom: row.effectiveFrom,
    appliedAt: row.appliedAt,
    createdThemes: row.createdThemes,
    createdMembers: row.createdMembers,
    skippedMembers: row.skippedMembers,
    poolCount: row.poolCount,
    pendingCount: row.pendingCount,
    plan: row.plan === null ? null : ThemeLibraryAutoPlanSchema.parse(row.plan),
    pending: row.pending,
    skipReason: row.skipReason,
    errorKind: row.errorKind,
    errorMessage: row.errorMessage,
  });

/** 重新领取执行权时清空的审计字段：不让上一轮的结果污染新一轮。 */
const autoRunReset = () => ({
  finishedAt: null,
  effectiveFrom: null,
  appliedAt: null,
  createdThemes: 0,
  createdMembers: 0,
  skippedMembers: 0,
  poolCount: 0,
  pendingCount: 0,
  plan: null,
  pending: [] as AutoRunRow['pending'],
  skipReason: null,
  errorKind: null,
  errorMessage: null,
});

const effectiveFilter = (at: Date): SQL =>
  and(
    lte(themeLibraryMembers.effectiveFrom, at),
    or(isNull(themeLibraryMembers.effectiveTo), gt(themeLibraryMembers.effectiveTo, at)) as SQL,
  ) as SQL;

export class DrizzleThemeLibraryRepository implements ThemeLibraryRepository {
  constructor(
    private readonly db: BunSQLiteDatabase<Schema>,
    private readonly writes = new RepositoryWriteScope(),
  ) {}

  async importSeed(input: ThemeLibraryImportInput): Promise<ThemeLibraryImportSummary> {
    const seedThemes = input.seed.themes;
    if (seedThemes.length === 0) {
      throw new InvariantError('题材库种子为空，不能标记导入成功');
    }
    return this.writes.transaction(this.db, (tx) => {
      const replay = tx
        .select()
        .from(themeLibraryImports)
        .where(eq(themeLibraryImports.id, input.importId))
        .get();
      if (replay !== undefined) return summaryFromImport(replay);

      const existing = tx.select().from(themeLibraryThemes).all();
      const idSet = new Set(existing.map((row) => row.id));
      const nameSet = new Set(existing.map((row) => row.name));
      const skipped = input.seed.skipped.map((entry) =>
        ThemeLibrarySeedSkipSchema.parse({
          themeId: entry.themeId,
          name: entry.name,
          reason: entry.reason,
        }),
      );
      let createdThemes = 0;
      let createdMembers = 0;
      let createdSources = 0;
      for (const theme of seedThemes) {
        if (idSet.has(theme.id)) continue;
        if (nameSet.has(theme.name)) {
          skipped.push({
            themeId: theme.id,
            name: theme.name,
            reason: 'name_conflict',
          });
          continue;
        }
        tx.insert(themeLibraryThemes)
          .values({
            id: theme.id,
            name: theme.name,
            state: 'active',
            sortOrder: theme.sortOrder,
            createdAt: input.appliedAt,
            updatedAt: input.appliedAt,
            archivedAt: null,
          })
          .run();
        for (const source of theme.sources) {
          tx.insert(themeLibraryThemeSources)
            .values({
              themeId: theme.id,
              vendorCode: source.vendorCode,
              sectorId: source.sectorId,
              name: source.name,
              createdAt: input.appliedAt,
            })
            .run();
          createdSources += 1;
        }
        for (const stockId of theme.stockIds) {
          tx.insert(themeLibraryMembers)
            .values({
              id: crypto.randomUUID(),
              themeId: theme.id,
              stockId,
              origin: 'seed',
              effectiveFrom: input.appliedAt,
              effectiveTo: null,
              createdAt: input.appliedAt,
            })
            .run();
          createdMembers += 1;
        }
        idSet.add(theme.id);
        nameSet.add(theme.name);
        createdThemes += 1;
      }
      const status = createdThemes > 0 ? ('imported' as const) : ('unchanged' as const);
      const summary: ThemeLibraryImportSummary = {
        importId: input.importId,
        source: input.source,
        status,
        appliedAt: input.appliedAt,
        createdThemes,
        createdMembers,
        createdSources,
        skippedThemes: skipped,
      };
      tx.insert(themeLibraryImports)
        .values({
          id: input.importId,
          source: input.source,
          status,
          appliedAt: input.appliedAt,
          createdThemes,
          createdMembers,
          createdSources,
          skippedThemes: skipped,
        })
        .run();
      return summary;
    });
  }

  async latestImport(): Promise<ThemeLibraryImportSummary | null> {
    const row = this.db
      .select()
      .from(themeLibraryImports)
      .orderBy(desc(themeLibraryImports.appliedAt), desc(themeLibraryImports.id))
      .limit(1)
      .get();
    return row === undefined ? null : summaryFromImport(row);
  }

  async listThemes(input?: {
    readonly state?: ThemeLibraryState | 'all';
  }): Promise<readonly ThemeLibraryTheme[]> {
    const state = input?.state ?? 'all';
    return this.db
      .select()
      .from(themeLibraryThemes)
      .where(state === 'all' ? undefined : eq(themeLibraryThemes.state, state))
      .orderBy(asc(themeLibraryThemes.sortOrder), asc(themeLibraryThemes.id))
      .all()
      .map(toTheme);
  }

  async findTheme(id: string): Promise<ThemeLibraryTheme | null> {
    const row = this.db
      .select()
      .from(themeLibraryThemes)
      .where(eq(themeLibraryThemes.id, id))
      .get();
    return row === undefined ? null : toTheme(row);
  }

  async findThemeByName(name: string): Promise<ThemeLibraryTheme | null> {
    const row = this.db
      .select()
      .from(themeLibraryThemes)
      .where(eq(themeLibraryThemes.name, name))
      .get();
    return row === undefined ? null : toTheme(row);
  }

  async listSources(themeIds?: readonly string[]): Promise<readonly ThemeLibraryThemeSource[]> {
    if (themeIds !== undefined && themeIds.length === 0) return [];
    return this.db
      .select()
      .from(themeLibraryThemeSources)
      .where(
        themeIds === undefined
          ? undefined
          : inArray(themeLibraryThemeSources.themeId, [...themeIds]),
      )
      .orderBy(asc(themeLibraryThemeSources.themeId), asc(themeLibraryThemeSources.vendorCode))
      .all()
      .map(toSource);
  }

  async listMembers(input?: {
    readonly themeIds?: readonly string[];
    readonly at?: Date;
  }): Promise<readonly ThemeLibraryMember[]> {
    const themeIds = input?.themeIds;
    if (themeIds !== undefined && themeIds.length === 0) return [];
    const filters: SQL[] = [];
    if (themeIds !== undefined) {
      filters.push(inArray(themeLibraryMembers.themeId, [...themeIds]));
    }
    if (input?.at !== undefined) filters.push(effectiveFilter(input.at));
    return this.db
      .select()
      .from(themeLibraryMembers)
      .where(filters.length === 0 ? undefined : and(...filters))
      .orderBy(
        asc(themeLibraryMembers.themeId),
        asc(themeLibraryMembers.effectiveFrom),
        asc(themeLibraryMembers.stockId),
      )
      .all()
      .map(toMember);
  }

  async createTheme(input: {
    readonly id: string;
    readonly name: string;
    readonly at: Date;
  }): Promise<ThemeLibraryTheme> {
    return this.writes.transaction(this.db, (tx) => {
      const last = tx
        .select({ sortOrder: themeLibraryThemes.sortOrder })
        .from(themeLibraryThemes)
        .orderBy(asc(themeLibraryThemes.sortOrder))
        .all()
        .at(-1);
      const sortOrder = last === undefined ? 0 : last.sortOrder + 1;
      tx.insert(themeLibraryThemes)
        .values({
          id: input.id,
          name: input.name,
          state: 'active',
          sortOrder,
          createdAt: input.at,
          updatedAt: input.at,
          archivedAt: null,
        })
        .run();
      return {
        id: input.id,
        name: input.name,
        state: 'active' as const,
        sortOrder,
        createdAt: input.at,
        updatedAt: input.at,
        archivedAt: null,
      };
    });
  }

  async renameTheme(input: {
    readonly themeId: string;
    readonly name: string;
    readonly at: Date;
  }): Promise<ThemeLibraryTheme | null> {
    return this.writes.transaction(this.db, (tx) => {
      const existing = tx
        .select()
        .from(themeLibraryThemes)
        .where(eq(themeLibraryThemes.id, input.themeId))
        .get();
      if (existing === undefined) return null;
      tx.update(themeLibraryThemes)
        .set({ name: input.name, updatedAt: input.at })
        .where(eq(themeLibraryThemes.id, input.themeId))
        .run();
      return toTheme({ ...existing, name: input.name, updatedAt: input.at });
    });
  }

  async archiveTheme(input: {
    readonly themeId: string;
    readonly at: Date;
  }): Promise<ThemeLibraryTheme | null> {
    return this.writes.transaction(this.db, (tx) => {
      const existing = tx
        .select()
        .from(themeLibraryThemes)
        .where(eq(themeLibraryThemes.id, input.themeId))
        .get();
      if (existing === undefined) return null;
      tx.update(themeLibraryThemes)
        .set({ state: 'archived', archivedAt: input.at, updatedAt: input.at })
        .where(eq(themeLibraryThemes.id, input.themeId))
        .run();
      return toTheme({
        ...existing,
        state: 'archived',
        archivedAt: input.at,
        updatedAt: input.at,
      });
    });
  }

  async reorderThemes(input: {
    readonly themeIds: readonly string[];
    readonly at: Date;
  }): Promise<readonly ThemeLibraryTheme[]> {
    return this.writes.transaction(this.db, (tx) => {
      const existing = tx.select().from(themeLibraryThemes).all();
      if (existing.length !== input.themeIds.length) {
        throw new InvariantError('题材顺序列表必须覆盖当前全部题材');
      }
      const byId = new Map(existing.map((row) => [row.id, row]));
      const seen = new Set<string>();
      for (const id of input.themeIds) {
        if (!byId.has(id) || seen.has(id)) {
          throw new InvariantError(`题材顺序列表无效：${id}`);
        }
        seen.add(id);
      }
      for (const [index, id] of input.themeIds.entries()) {
        tx.update(themeLibraryThemes)
          .set({ sortOrder: index, updatedAt: input.at })
          .where(eq(themeLibraryThemes.id, id))
          .run();
      }
      return tx
        .select()
        .from(themeLibraryThemes)
        .orderBy(asc(themeLibraryThemes.sortOrder), asc(themeLibraryThemes.id))
        .all()
        .map(toTheme);
    });
  }

  async addMembers(input: {
    readonly themeId: string;
    readonly stockIds: readonly string[];
    readonly origin: ThemeLibraryMemberOrigin;
    readonly at: Date;
  }): Promise<number> {
    return this.writes.transaction(this.db, (tx) => {
      const theme = tx
        .select({ id: themeLibraryThemes.id })
        .from(themeLibraryThemes)
        .where(eq(themeLibraryThemes.id, input.themeId))
        .get();
      if (theme === undefined) throw new InvariantError(`题材不存在：${input.themeId}`);
      const open = tx
        .select()
        .from(themeLibraryMembers)
        .where(
          and(
            eq(themeLibraryMembers.themeId, input.themeId),
            isNull(themeLibraryMembers.effectiveTo),
          ),
        )
        .all();
      const openStocks = new Set(open.map((row) => row.stockId));
      let created = 0;
      for (const stockId of input.stockIds) {
        if (openStocks.has(stockId)) continue;
        tx.insert(themeLibraryMembers)
          .values({
            id: crypto.randomUUID(),
            themeId: input.themeId,
            stockId,
            origin: input.origin,
            effectiveFrom: input.at,
            effectiveTo: null,
            createdAt: input.at,
          })
          .run();
        openStocks.add(stockId);
        created += 1;
      }
      return created;
    });
  }

  async removeMember(input: {
    readonly themeId: string;
    readonly stockId: string;
    readonly at: Date;
  }): Promise<boolean> {
    return this.writes.transaction(this.db, (tx) => {
      const row = tx
        .select()
        .from(themeLibraryMembers)
        .where(
          and(
            eq(themeLibraryMembers.themeId, input.themeId),
            eq(themeLibraryMembers.stockId, input.stockId),
            isNull(themeLibraryMembers.effectiveTo),
          ),
        )
        .get();
      if (row === undefined) return false;
      const end =
        input.at.getTime() > row.effectiveFrom.getTime()
          ? input.at
          : new Date(row.effectiveFrom.getTime() + 1);
      tx.update(themeLibraryMembers)
        .set({ effectiveTo: end })
        .where(eq(themeLibraryMembers.id, row.id))
        .run();
      return true;
    });
  }

  async getAutoSettings(): Promise<ThemeLibraryAutoSettings> {
    const row = this.db
      .select()
      .from(themeLibraryAutoSettings)
      .where(eq(themeLibraryAutoSettings.id, AUTO_SETTINGS_ID))
      .get();
    return row === undefined
      ? { enabled: false, updatedAt: null }
      : { enabled: row.enabled, updatedAt: row.updatedAt };
  }

  async saveAutoSettings(input: {
    readonly enabled: boolean;
    readonly at: Date;
  }): Promise<ThemeLibraryAutoSettings> {
    return this.writes.transaction(this.db, (tx) => {
      tx.insert(themeLibraryAutoSettings)
        .values({ id: AUTO_SETTINGS_ID, enabled: input.enabled, updatedAt: input.at })
        .onConflictDoUpdate({
          target: themeLibraryAutoSettings.id,
          set: { enabled: input.enabled, updatedAt: input.at },
        })
        .run();
      return { enabled: input.enabled, updatedAt: input.at };
    });
  }

  async claimAutoRun(input: {
    readonly tradingDay: string;
    readonly source: string;
    readonly now: Date;
    readonly staleBefore: Date;
  }): Promise<{ readonly claimed: boolean; readonly run: ThemeLibraryAutoRun }> {
    const id = autoRunId(input.tradingDay, input.source);
    return this.writes.transaction(this.db, (tx) => {
      const read = (): ThemeLibraryAutoRun => {
        const row = tx
          .select()
          .from(themeLibraryAutoRuns)
          .where(eq(themeLibraryAutoRuns.id, id))
          .get();
        if (row === undefined) throw new InvariantError(`自动维护执行记录丢失：${id}`);
        return toAutoRun(row);
      };
      const existing = tx
        .select()
        .from(themeLibraryAutoRuns)
        .where(eq(themeLibraryAutoRuns.id, id))
        .get();
      if (existing === undefined) {
        tx.insert(themeLibraryAutoRuns)
          .values({
            id,
            tradingDay: input.tradingDay,
            source: input.source,
            status: 'running',
            attempt: 1,
            startedAt: input.now,
            ...autoRunReset(),
          })
          .run();
        return { claimed: true, run: read() };
      }
      const retryable =
        existing.status === 'failed' ||
        existing.status === 'skipped' ||
        (existing.status === 'running' &&
          existing.startedAt.getTime() <= input.staleBefore.getTime());
      if (!retryable) return { claimed: false, run: toAutoRun(existing) };
      tx.update(themeLibraryAutoRuns)
        .set({
          status: 'running',
          attempt: existing.attempt + 1,
          startedAt: input.now,
          ...autoRunReset(),
        })
        .where(
          and(
            eq(themeLibraryAutoRuns.id, id),
            eq(themeLibraryAutoRuns.attempt, existing.attempt),
            eq(themeLibraryAutoRuns.status, existing.status),
          ),
        )
        .run();
      const current = read();
      return {
        claimed: current.status === 'running' && current.attempt === existing.attempt + 1,
        run: current,
      };
    });
  }

  async applyAutoPlan(input: {
    readonly tradingDay: string;
    readonly source: string;
    readonly attempt: number;
    readonly plan: ThemeLibraryAutoPlan;
    readonly effectiveFrom: Date;
    readonly appliedAt: Date;
  }): Promise<ThemeLibraryAutoRun> {
    const plan = ThemeLibraryAutoPlanSchema.parse(input.plan);
    if (plan.tradingDate !== input.tradingDay || plan.source !== input.source) {
      throw new InvariantError('自动维护计划的交易日 / 源与执行记录不一致');
    }
    const id = autoRunId(input.tradingDay, input.source);
    return this.writes.transaction(this.db, (tx) => {
      const read = (): ThemeLibraryAutoRun => {
        const row = tx
          .select()
          .from(themeLibraryAutoRuns)
          .where(eq(themeLibraryAutoRuns.id, id))
          .get();
        if (row === undefined) throw new InvariantError(`自动维护执行记录丢失：${id}`);
        return toAutoRun(row);
      };
      const existing = read();
      // 已成功或有别的执行者接管时直接返回当前状态，不重复写成分。
      if (existing.status !== 'running' || existing.attempt !== input.attempt) return existing;

      const themeRows = tx.select().from(themeLibraryThemes).all();
      const themeIds = new Set(themeRows.map((row) => row.id));
      const themeNames = new Set(themeRows.map((row) => row.name));
      let sortOrder = themeRows.reduce((max, row) => Math.max(max, row.sortOrder), -1) + 1;
      let createdThemes = 0;
      for (const theme of plan.newThemes) {
        if (themeIds.has(theme.themeId)) continue;
        if (themeNames.has(theme.name)) continue;
        tx.insert(themeLibraryThemes)
          .values({
            id: theme.themeId,
            name: theme.name,
            state: 'active',
            sortOrder,
            createdAt: input.appliedAt,
            updatedAt: input.appliedAt,
            archivedAt: null,
          })
          .run();
        if (theme.sourceConcept !== null) {
          tx.insert(themeLibraryThemeSources)
            .values({
              themeId: theme.themeId,
              vendorCode: theme.sourceConcept.vendorCode,
              sectorId: theme.sourceConcept.sectorId,
              name: theme.sourceConcept.name,
              createdAt: input.appliedAt,
            })
            .run();
        }
        themeIds.add(theme.themeId);
        themeNames.add(theme.name);
        sortOrder += 1;
        createdThemes += 1;
      }

      const memberRows = tx.select().from(themeLibraryMembers).all();
      const known = new Set<string>();
      const pairKey = (themeId: string, stockId: string): string => `${themeId}\u0000${stockId}`;
      for (const row of memberRows) known.add(pairKey(row.themeId, row.stockId));
      const archived = new Set(
        themeRows.filter((row) => row.state === 'archived').map((row) => row.id),
      );
      let createdMembers = 0;
      const groups = [
        ...plan.newThemes.map((theme) => ({ themeId: theme.themeId, stocks: theme.stocks })),
        ...plan.additions.map((addition) => ({
          themeId: addition.themeId,
          stocks: addition.stocks,
        })),
      ];
      for (const group of groups) {
        if (!themeIds.has(group.themeId) || archived.has(group.themeId)) continue;
        for (const stock of group.stocks) {
          const key = pairKey(group.themeId, stock.stockId);
          // 人工删除过的关系不再加回；已在生效区间的也不重复写。
          if (known.has(key)) continue;
          tx.insert(themeLibraryMembers)
            .values({
              id: crypto.randomUUID(),
              themeId: group.themeId,
              stockId: stock.stockId,
              origin: 'auto',
              effectiveFrom: input.effectiveFrom,
              effectiveTo: null,
              createdAt: input.appliedAt,
            })
            .run();
          known.add(key);
          createdMembers += 1;
        }
      }

      tx.update(themeLibraryAutoRuns)
        .set({
          status: 'succeeded' as ThemeLibraryAutoRunStatus,
          finishedAt: input.appliedAt,
          appliedAt: input.appliedAt,
          effectiveFrom: input.effectiveFrom,
          createdThemes,
          createdMembers,
          skippedMembers: plan.suppressedCount,
          poolCount: plan.poolCount,
          pendingCount: plan.pending.length,
          plan,
          pending: plan.pending,
          skipReason: null,
          errorKind: null,
          errorMessage: null,
        })
        .where(
          and(
            eq(themeLibraryAutoRuns.id, id),
            eq(themeLibraryAutoRuns.status, 'running'),
            eq(themeLibraryAutoRuns.attempt, input.attempt),
          ),
        )
        .run();
      return read();
    });
  }

  async finishAutoRun(input: {
    readonly tradingDay: string;
    readonly source: string;
    readonly attempt: number;
    readonly status: 'failed' | 'skipped';
    readonly finishedAt: Date;
    readonly skipReason?: ThemeLibraryAutoSkipReason;
    readonly errorKind?: string;
    readonly errorMessage?: string;
    readonly poolCount?: number;
  }): Promise<ThemeLibraryAutoRun> {
    const id = autoRunId(input.tradingDay, input.source);
    return this.writes.transaction(this.db, (tx) => {
      tx.update(themeLibraryAutoRuns)
        .set({
          status: input.status,
          finishedAt: input.finishedAt,
          ...(input.poolCount === undefined ? {} : { poolCount: input.poolCount }),
          skipReason: input.skipReason ?? null,
          errorKind: input.errorKind ?? null,
          errorMessage: input.errorMessage ?? null,
        })
        .where(
          and(
            eq(themeLibraryAutoRuns.id, id),
            eq(themeLibraryAutoRuns.status, 'running'),
            eq(themeLibraryAutoRuns.attempt, input.attempt),
          ),
        )
        .run();
      const row = tx
        .select()
        .from(themeLibraryAutoRuns)
        .where(eq(themeLibraryAutoRuns.id, id))
        .get();
      if (row === undefined) throw new InvariantError(`自动维护执行记录丢失：${id}`);
      return toAutoRun(row);
    });
  }

  async findAutoRun(input: {
    readonly tradingDay: string;
    readonly source: string;
  }): Promise<ThemeLibraryAutoRun | null> {
    const row = this.db
      .select()
      .from(themeLibraryAutoRuns)
      .where(eq(themeLibraryAutoRuns.id, autoRunId(input.tradingDay, input.source)))
      .get();
    return row === undefined ? null : toAutoRun(row);
  }

  async listAutoRuns(input?: { readonly limit?: number }): Promise<readonly ThemeLibraryAutoRun[]> {
    const limit = input?.limit ?? 10;
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new InvariantError(`自动维护执行记录条数必须为正整数：${limit}`);
    }
    return this.db
      .select()
      .from(themeLibraryAutoRuns)
      .orderBy(desc(themeLibraryAutoRuns.startedAt), desc(themeLibraryAutoRuns.id))
      .limit(limit)
      .all()
      .map(toAutoRun);
  }
}
