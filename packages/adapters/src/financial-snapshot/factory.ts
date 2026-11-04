import type { FinancialSnapshotManagerLike, Logger } from '@luoome/core';
import { z } from 'zod';

import { FuyaoClient, fuyaoConfigFromEnv } from '../fuyao/client.js';
import { FuyaoFinancialSnapshotAdapter } from './fuyao.js';
import { FinancialSnapshotManager } from './manager.js';

/**
 * 财务当前快照 manager 装配根。
 *
 * 设计：docs/ddd/fuyao-data-expansion-and-tushare-retirement-design.md §11.1
 *
 * - LUOOME_FINANCIAL_SNAPSHOT_SOURCES：逗号分隔、有序、去重；未知源启动期抛错；缺省不装配
 * - 显式启用 fuyao 且缺 FUYAO_API_KEY，启动期快速失败
 * - 返回的 manager 满足 core `FinancialSnapshotManagerLike` 接口（structural typing）
 */

export interface CreateFinancialSnapshotManagerDeps {
  readonly logger: Logger;
  readonly clock?: () => Date;
  readonly fetchImpl?: typeof fetch;
  /** 共享 FuyaoClient；注入时不再自构（进程级共享协调器）。 */
  readonly fuyaoClient?: FuyaoClient;
}

/** 已注册的财务快照数据源（封闭启动校验）。 */
const FinancialSnapshotSourcesSchema = z
  .array(z.literal('fuyao'))
  .min(1, '至少启用一个财务快照数据源')
  .superRefine((sources, ctx) => {
    if (new Set(sources).size !== sources.length) {
      ctx.addIssue({ code: 'custom', message: '财务快照数据源不能重复' });
    }
  });

const financialSnapshotSourcesFromEnv = (
  env: Readonly<Record<string, string | undefined>>,
): readonly 'fuyao'[] => {
  const raw = env.LUOOME_FINANCIAL_SNAPSHOT_SOURCES?.trim();
  if (raw === undefined || raw.length === 0) {
    return [];
  }
  return FinancialSnapshotSourcesSchema.parse(
    raw.split(',').map((source) => source.trim().toLowerCase()),
  );
};

export const createFinancialSnapshotManagerFromEnv = (
  env: Readonly<Record<string, string | undefined>>,
  deps: CreateFinancialSnapshotManagerDeps,
): FinancialSnapshotManagerLike | undefined => {
  const order = financialSnapshotSourcesFromEnv(env);
  if (order.length === 0) {
    return undefined;
  }

  const clock = deps.clock ?? (() => new Date());
  const adapters: FuyaoFinancialSnapshotAdapter[] = [];

  for (const source of order) {
    switch (source) {
      case 'fuyao': {
        const client =
          deps.fuyaoClient ??
          new FuyaoClient(fuyaoConfigFromEnv(env), {
            ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
          });
        adapters.push(new FuyaoFinancialSnapshotAdapter({ client, clock }));
        break;
      }
      default:
        throw new Error(`不支持的数据源：${String(source satisfies never)}`);
    }
  }

  return new FinancialSnapshotManager({
    adapters,
    logger: deps.logger,
    clock,
  });
};
