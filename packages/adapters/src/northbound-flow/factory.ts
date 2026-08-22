import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { Holiday, Logger, NorthboundFlowManagerLike } from '@luoome/core';
import {
  BUILTIN_HOLIDAYS,
  mergeHolidayCalendars,
  parseEnvHolidays,
  parseHolidayObject,
} from '@luoome/core';
import { z } from 'zod';

import { EastmoneySource } from '../eastmoney/source.js';
import { type AnyBinding, SourceRegistry } from '../source-registry.js';
import { NorthboundFlowManager } from './manager.js';
import type { NorthboundFlowCapabilityMap } from './types.js';

/**
 * 北向资金历史流 manager 装配根。
 *
 * 仿 `createDragonTigerManagerFromEnv`（dragon-tiger/factory.ts）的位置与签名风格。
 * - LUOOME_NORTHBOUND_FLOW_SOURCES：逗号分隔、有序、去重；未知源启动期抛错；缺省 eastmoney
 *   （docs/ddd/source-pluggability-and-observation-design.md §4.6）
 * - 通过显式数据源配置装配；未知或重复来源在启动时失败
 * - 返回的 manager 同时满足 core `NorthboundFlowManagerLike` 接口（structural typing）
 */

export interface CreateNorthboundFlowManagerDeps {
  readonly logger: Logger;
  readonly clock?: () => Date;
  readonly fetchImpl?: typeof fetch;
  /** 组装根共享的供应商实例；注入时不再自构（§4.6）。 */
  readonly sources?: { readonly eastmoney?: EastmoneySource };
}

/** 已注册的北向资金数据源（封闭启动校验；core 端口侧是开放 SourceIdSchema）。 */
const NorthboundFlowSourcesSchema = z
  .array(z.literal('eastmoney'))
  .min(1, '至少启用一个北向资金数据源')
  .superRefine((sources, ctx) => {
    if (new Set(sources).size !== sources.length) {
      ctx.addIssue({ code: 'custom', message: '北向资金数据源不能重复' });
    }
  });

const northboundFlowSourcesFromEnv = (
  env: Readonly<Record<string, string | undefined>>,
): readonly 'eastmoney'[] => {
  const raw = env.LUOOME_NORTHBOUND_FLOW_SOURCES?.trim();
  return NorthboundFlowSourcesSchema.parse(
    raw === undefined || raw.length === 0
      ? ['eastmoney']
      : raw.split(',').map((source) => source.trim().toLowerCase()),
  );
};

export const createNorthboundFlowManagerFromEnv = (
  env: Readonly<Record<string, string | undefined>>,
  deps: CreateNorthboundFlowManagerDeps,
): NorthboundFlowManagerLike => {
  const clock = deps.clock ?? (() => new Date());
  const order = northboundFlowSourcesFromEnv(env);
  const eastmoney =
    deps.sources?.eastmoney ??
    new EastmoneySource({
      clock,
      ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
    });

  const bindings = order.flatMap((source) => {
    switch (source) {
      case 'eastmoney':
        return eastmoneyBindings(eastmoney);
      default:
        throw new Error(`不支持的数据源：${String(source satisfies never)}`);
    }
  });
  const registry = new SourceRegistry<NorthboundFlowCapabilityMap>(bindings, clock);

  return new NorthboundFlowManager({
    registry,
    logger: deps.logger,
    clock,
    holidaysProvider: async () => loadHolidaysFromEnv(env),
  });
};

/**
 * 与连板天梯 / 龙虎榜 / watch 共用同一份三层节假日历：内置 → 文件 → env。
 *
 * adapters 不能依赖 cli，因此在装配根读取配置；读取失败按日历“无新增项”处理，
 * 与 CLI 的容错口径一致。
 */
const loadHolidaysFromEnv = (
  env: Readonly<Record<string, string | undefined>>,
): ReadonlyMap<number, ReadonlySet<Holiday>> => {
  const home = env.LUOOME_HOME?.trim() || join(homedir(), '.luoome');
  const filePath = env.LUOOME_HOLIDAYS_FILE?.trim() || join(home, 'holidays.json');
  let fileCalendar: ReadonlyMap<number, ReadonlySet<Holiday>> = new Map();
  try {
    if (existsSync(filePath)) {
      fileCalendar = parseHolidayObject(JSON.parse(readFileSync(filePath, 'utf8')));
    }
  } catch {
    fileCalendar = new Map();
  }
  return mergeHolidayCalendars(
    BUILTIN_HOLIDAYS,
    fileCalendar,
    parseEnvHolidays(env.LUOOME_A_SHARE_HOLIDAYS),
  );
};

/**
 * dataAsOf = 实际 entries 最后一条交易日的收盘时刻；空序列 success 但无 dataAsOf
 * （freshness 为 unknown；不得用请求 endDate 冒充数据日期，§6.2）。
 */
const eastmoneyBindings = (source: EastmoneySource): AnyBinding<NorthboundFlowCapabilityMap>[] => [
  {
    capability: 'northbound-flow',
    source: 'eastmoney',
    coverage: ['CN_A_SHARES_SH_SZ'],
    configurationReady: true,
    execute: ({ endDate, days }) => source.fetchFlow(endDate, days),
    observationOf: (result) => {
      const last = result.entries.at(-1);
      if (last === undefined) return { outcome: 'success' };
      return { outcome: 'success', dataAsOf: new Date(`${last.date}T15:00:00+08:00`) };
    },
  },
];
