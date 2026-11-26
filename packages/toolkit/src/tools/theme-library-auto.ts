import {
  buildThemeLibraryAutoPlan,
  dateInShanghai,
  isHoliday,
  isWeekend,
  selectMarketRoomSectorCatalog,
  THEME_LIBRARY_AUTO_EFFECTIVE_TIME,
  THEME_LIBRARY_AUTO_SOURCE,
  type ThemeLibraryAutoConcept,
  type ThemeLibraryAutoRun,
  ThemeLibraryAutoRunSchema,
  type ToolContext,
} from '@luoome/core';
import { z } from 'zod';

import { defineTool, errAdapterError, errInvalidInput } from '../define-tool.js';

/**
 * 系统题材库自动维护：每个交易日盘后把当日封板股票的涨停原因归入已维护题材。
 *
 * - 只读上游涨停池（与 `limit_up_market` 同一 manager / 缓存），不改写原因原文；
 * - 归类、建库门槛与待核对都是 core 的纯函数，本 tool 只负责取数、校验与写库编排；
 * - 写库按「交易日 + 源」原子幂等：同日重复 / 并发不会重复写，失败与跳过允许重试，
 *   已成功为终态；自动关系记 `origin=auto`，人工删除过的不再加回；
 * - 默认只补成分、不删旧成分，也不回写历史：新增关系从当日收盘起生效，回放不回灌盘中；
 * - 访问外部涨停池并写本地库，需 external + write 同时开启。
 */

export const RunThemeLibraryAutoMaintenanceInput = z.object({
  /** 指定交易日只用于补跑漏日；缺省取当前上海日期。 */
  tradingDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
});
export type RunThemeLibraryAutoMaintenanceInputT = z.infer<
  typeof RunThemeLibraryAutoMaintenanceInput
>;

export const RunThemeLibraryAutoMaintenanceOutput = ThemeLibraryAutoRunSchema;
export type RunThemeLibraryAutoMaintenanceOutputT = ThemeLibraryAutoRun;

/** 收盘时刻（Asia/Shanghai）：当日封板与涨停原因此后为终值。 */
const CLOSE_MINUTE_OF_DAY = 15 * 60;
const RUN_LEASE_MS = 30 * 60_000;

const shanghaiMinuteOfDay = (date: Date): number => {
  const shifted = new Date(date.getTime() + 8 * 60 * 60 * 1_000);
  return shifted.getUTCHours() * 60 + shifted.getUTCMinutes();
};

const effectiveTimeOf = (tradingDay: string): Date =>
  new Date(`${tradingDay}T${THEME_LIBRARY_AUTO_EFFECTIVE_TIME}`);

export const runThemeLibraryAutoMaintenanceTool = defineTool({
  name: 'run_theme_library_auto_maintenance',
  description:
    '按交易日运行系统题材库自动维护：读取当日涨停池的涨停原因，按主催化把封板股票补进已维护题材；' +
    '未覆盖方向只有命中本地精选概念且同一方向至少两只不同涨停股独立印证时才新建题材，其余进入待核对；' +
    '已成功执行过同一交易日 + 源时直接返回原结果（同日重复 / 并发不重复写），失败或数据不完整允许重试；' +
    '只补成分不删旧成分，人工删除过的关系不加回，新增关系从当日收盘起生效、回放不回溯；' +
    '访问外部涨停池并写本地库，需要 external 与 write 同时开启。',
  sideEffect: 'external',
  requiredCapabilities: ['external', 'write'],
  input: RunThemeLibraryAutoMaintenanceInput,
  output: RunThemeLibraryAutoMaintenanceOutput,
  handler: async (input, ctx) => {
    const now = ctx.clock();
    const today = dateInShanghai(now);
    const tradingDay = input.tradingDate ?? today;
    if (tradingDay > today) {
      return errInvalidInput(`不能为未来交易日运行自动维护：${tradingDay}`);
    }
    const dayStart = new Date(`${tradingDay}T12:00:00+08:00`);
    if (isWeekend(dayStart) || isHoliday(dayStart)) {
      return errInvalidInput(`${tradingDay} 不是交易日，未运行自动维护`);
    }

    const claimed = await ctx.repos.themeLibrary.claimAutoRun({
      tradingDay,
      source: THEME_LIBRARY_AUTO_SOURCE,
      now,
      staleBefore: new Date(now.getTime() - RUN_LEASE_MS),
    });
    if (!claimed.claimed) {
      ctx.logger.info('题材库自动维护已执行或正在执行，跳过', {
        tradingDay,
        status: claimed.run.status,
        attempt: claimed.run.attempt,
      });
      return claimed.run;
    }
    const attempt = claimed.run.attempt;

    if (tradingDay === today && shanghaiMinuteOfDay(now) < CLOSE_MINUTE_OF_DAY) {
      return ctx.repos.themeLibrary.finishAutoRun({
        tradingDay,
        source: THEME_LIBRARY_AUTO_SOURCE,
        attempt,
        status: 'skipped',
        finishedAt: now,
        skipReason: 'before_close',
        errorMessage: '当日未收盘，涨停池不是终值',
      });
    }

    const manager = ctx.adapters.marketIntel?.limitUpMarket;
    if (manager === undefined || manager.sources.length === 0) {
      const message =
        '涨停池没有可用数据源：自动维护需要 fuyao（FUYAO_API_KEY + source.fuyao 启用），未配置时不写库';
      await ctx.repos.themeLibrary.finishAutoRun({
        tradingDay,
        source: THEME_LIBRARY_AUTO_SOURCE,
        attempt,
        status: 'failed',
        finishedAt: now,
        errorKind: 'adapter_error',
        errorMessage: message,
      });
      return errAdapterError('limit-up-market', message, false);
    }

    let snapshot: Awaited<ReturnType<typeof manager.fetchMarket>>;
    try {
      snapshot = await manager.fetchMarket({ date: tradingDay });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await ctx.repos.themeLibrary.finishAutoRun({
        tradingDay,
        source: THEME_LIBRARY_AUTO_SOURCE,
        attempt,
        status: 'failed',
        finishedAt: ctx.clock(),
        errorKind: 'adapter_error',
        errorMessage: message.slice(0, 400),
      });
      return errAdapterError('limit-up-market', message, true);
    }
    if (!snapshot.ok || snapshot.data === undefined) {
      const message = snapshot.error?.message ?? '涨停池读取失败';
      await ctx.repos.themeLibrary.finishAutoRun({
        tradingDay,
        source: THEME_LIBRARY_AUTO_SOURCE,
        attempt,
        status: 'failed',
        finishedAt: ctx.clock(),
        errorKind: 'adapter_error',
        errorMessage: message.slice(0, 400),
      });
      return errAdapterError('limit-up-market', message, snapshot.error?.recoverable ?? true);
    }

    const data = snapshot.data;
    const pool = data.pool;
    const skip = async (
      reason: 'pool_unavailable' | 'empty_pool' | 'incomplete_pool' | 'no_reason',
      message: string,
    ): Promise<ThemeLibraryAutoRun> =>
      ctx.repos.themeLibrary.finishAutoRun({
        tradingDay,
        source: THEME_LIBRARY_AUTO_SOURCE,
        attempt,
        status: 'skipped',
        finishedAt: ctx.clock(),
        skipReason: reason,
        errorMessage: message,
        poolCount: pool?.entries.length ?? 0,
      });

    if (pool === null) {
      return skip('pool_unavailable', `涨停池读取失败：${data.warnings.join(', ') || 'unknown'}`);
    }
    if (pool.entries.length === 0) {
      return skip('empty_pool', '当日涨停池为空（休市或上游未更新）');
    }
    if (data.date !== tradingDay || pool.total !== pool.entries.length) {
      return skip(
        'incomplete_pool',
        `涨停池不完整：date=${data.date} total=${pool.total} got=${pool.entries.length}`,
      );
    }
    if (pool.entries.every((entry) => entry.reason === null)) {
      return skip('no_reason', '涨停池没有涨停原因，无法按主催化归类');
    }

    const warnings = [...data.warnings];
    if (data.statistics !== null && data.statistics.tradeDate !== tradingDay) {
      return skip(
        'incomplete_pool',
        `涨停统计日期不符：${data.statistics.tradeDate} ≠ ${tradingDay}`,
      );
    }
    if (data.statistics !== null && data.statistics.limitUpStockCount !== pool.entries.length) {
      warnings.push(
        `pool_statistics_mismatch: pool=${pool.entries.length} statistics=${data.statistics.limitUpStockCount}`,
      );
    }
    if (data.source !== 'fuyao') warnings.push(`unexpected_source: ${data.source}`);

    const [themes, members, conceptCatalog] = await Promise.all([
      ctx.repos.themeLibrary.listThemes({ state: 'all' }),
      ctx.repos.themeLibrary.listMembers(),
      readFocusedConcepts(ctx),
    ]);

    const plan = buildThemeLibraryAutoPlan({
      tradingDate: tradingDay,
      source: THEME_LIBRARY_AUTO_SOURCE,
      pool: pool.entries.map((entry) => ({
        stockId: entry.stockId,
        name: entry.name,
        reason: entry.reason,
      })),
      themes,
      members,
      concepts: conceptCatalog,
      warnings,
    });

    try {
      return await ctx.repos.themeLibrary.applyAutoPlan({
        tradingDay,
        source: THEME_LIBRARY_AUTO_SOURCE,
        attempt,
        plan,
        effectiveFrom: effectiveTimeOf(tradingDay),
        appliedAt: ctx.clock(),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await ctx.repos.themeLibrary.finishAutoRun({
        tradingDay,
        source: THEME_LIBRARY_AUTO_SOURCE,
        attempt,
        status: 'failed',
        finishedAt: ctx.clock(),
        errorKind: 'internal',
        errorMessage: message.slice(0, 400),
      });
      throw error;
    }
  },
});

/** 本地精选概念 = 作战室口径的概念目录（排除泛标签与非题材指数），作为建库的事实依据。 */
const readFocusedConcepts = async (ctx: ToolContext): Promise<ThemeLibraryAutoConcept[]> => {
  const sectors = await ctx.repos.sectorCatalog.listSectors({
    kinds: ['concept'],
    state: 'active',
  });
  if (sectors.length === 0) return [];
  const members = await ctx.repos.sectorCatalog.listBySectors({
    sectorIds: sectors.map((sector) => sector.id),
  });
  return selectMarketRoomSectorCatalog({ sectors, members })
    .filter((sector) => sector.kind === 'concept')
    .map((sector) => ({
      sectorId: sector.id,
      vendorCode: sector.vendorCode,
      name: sector.name,
    }));
};
