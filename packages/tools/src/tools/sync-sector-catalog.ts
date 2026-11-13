import {
  type SectorCatalogObservation,
  type SectorKind,
  SectorKindSchema,
  type SectorStockObservationBatch,
  type SectorSyncFailure,
  SectorSyncFailureSchema,
} from '@luoome/core';
import { z } from 'zod';

import { defineTool, errAdapterError, errInvalidInput } from '../define-tool.js';

/**
 * 盘前同步扶摇行业与概念目录及当前成分。
 *
 * - 一次同步 = 两个分类目录 + 按股批量反查；部分请求失败时照常提交其余事实，
 *   失败批次里的股票保持原状，不会被判为“退出成分”。
 * - 目录请求成功的分类才会下线未出现的旧条目；失败分类保留历史。
 * - 只写本地区事实链，外部访问由 sideEffect='external' 显式 opt-in。
 */
export const SyncSectorCatalogInput = z.object({
  dryRun: z.boolean().default(false),
});

export const SyncSectorCatalogOutput = z.object({
  syncId: z.string(),
  source: z.string(),
  status: z.enum(['succeeded', 'partial', 'dry-run']),
  observedAt: z.coerce.date(),
  kinds: z.array(SectorKindSchema),
  observedSectors: z.number().int().nonnegative(),
  observedStocks: z.number().int().nonnegative(),
  createdSectors: z.number().int().nonnegative(),
  renamedSectors: z.number().int().nonnegative(),
  retiredSectors: z.number().int().nonnegative(),
  createdMemberships: z.number().int().nonnegative(),
  removedMemberships: z.number().int().nonnegative(),
  reactivatedMemberships: z.number().int().nonnegative(),
  failures: z.array(SectorSyncFailureSchema),
});

const KINDS: readonly SectorKind[] = ['industry', 'concept'];

const failureMessage = (failures: readonly SectorSyncFailure[]): string =>
  failures.map((failure) => failure.message).join('; ');

/** 失败原因会经 tool 输出回传；去掉请求 URL，只保留可读原因。 */
const failureText = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).replace(/\surl=\S+/g, '');

export const syncSectorCatalogTool = defineTool({
  name: 'sync_sector_catalog',
  description:
    '盘前同步扶摇行业与概念目录及当前成分：目录新增/改名/下线记变更，成分多对多保存首次观测时间与来源；' +
    '部分请求失败时未观测股票保持原状，不集体退出。',
  sideEffect: 'external',
  input: SyncSectorCatalogInput,
  output: SyncSectorCatalogOutput,
  handler: async (input, ctx) => {
    const adapter = ctx.adapters.sectorCatalog;
    if (adapter === undefined) {
      return errAdapterError('sector-catalog', '行业与概念目录数据源未配置', false);
    }

    const members = await ctx.repos.stockUniverse.listCurrentMembers({
      coverage: 'CN_A_SHARES_SH_SZ',
    });
    if (members.length === 0) {
      return errInvalidInput('本地股票目录为空，请先执行 sync_stock_universe 再同步行业与概念成分');
    }

    const catalog: SectorCatalogObservation[] = [];
    const catalogKinds: SectorKind[] = [];
    const failures: SectorSyncFailure[] = [];
    for (const kind of KINDS) {
      try {
        const sectors = await adapter.fetchSectorCatalog(kind);
        // 空目录不是“全部下线”的证据；保留上一版并记为失败，避免成员集体退出。
        if (sectors.length === 0) {
          failures.push({
            scope: 'catalog',
            kind,
            message: `sector catalog empty: ${kind}`,
          });
          continue;
        }
        catalog.push(...sectors);
        catalogKinds.push(kind);
      } catch (error) {
        failures.push({ scope: 'catalog', kind, message: failureText(error) });
      }
    }

    let membershipResult: SectorStockObservationBatch = { observations: [], failures: [] };
    try {
      membershipResult = await adapter.fetchStockSectors(members.map(({ stock }) => stock.id));
      failures.push(...membershipResult.failures);
    } catch (error) {
      failures.push({ scope: 'memberships', kind: null, message: failureText(error) });
    }
    if (membershipResult.observations.length === 0 && membershipResult.failures.length === 0) {
      failures.push({ scope: 'memberships', kind: null, message: 'sector memberships empty' });
    }

    if (catalogKinds.length === 0 && membershipResult.observations.length === 0) {
      return errAdapterError(
        'sector-catalog',
        failureMessage(failures) || '目录与成分全部失败',
        true,
      );
    }

    const syncId = crypto.randomUUID();
    const observedAt = ctx.clock();
    const status = failures.length === 0 ? ('succeeded' as const) : ('partial' as const);
    const common = {
      syncId,
      source: adapter.name,
      observedAt,
      kinds: [...catalogKinds],
      failures,
    };

    if (input.dryRun) {
      return {
        ...common,
        status: 'dry-run' as const,
        observedSectors: catalog.length,
        observedStocks: membershipResult.observations.length,
        createdSectors: 0,
        renamedSectors: 0,
        retiredSectors: 0,
        createdMemberships: 0,
        removedMemberships: 0,
        reactivatedMemberships: 0,
      };
    }

    const summary = await ctx.repos.sectorCatalog.applySync({
      syncId,
      source: adapter.name,
      appliedAt: observedAt,
      status,
      catalog,
      catalogKinds,
      observations: membershipResult.observations,
      stockStatuses: members.map(({ stock, listingStatus }) => ({
        stockId: stock.id,
        status: listingStatus,
      })),
      failures,
    });

    return { ...common, status, ...summary };
  },
});
