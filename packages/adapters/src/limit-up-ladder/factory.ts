import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { LimitUpLadderManagerLike, Logger } from '@luoome/core';
import {
  BUILTIN_HOLIDAYS,
  mergeHolidayCalendars,
  parseEnvHolidays,
  parseHolidayObject,
} from '@luoome/core';
import { z } from 'zod';

import { EastmoneySource } from '../eastmoney/source.js';
import { FuyaoClient, fuyaoConfigFromEnv } from '../fuyao/client.js';
import { type AnyBinding, SourceRegistry } from '../source-registry.js';
import { FuyaoLimitUpLadderSource } from './fuyao.js';
import { LimitUpLadderManager } from './manager.js';
import type { LimitUpLadderCapabilityMap } from './types.js';

/**
 * 连板天梯 manager 装配根（docs/ddd/limit-up-ladder-detailed-design.md §5）。
 *
 * 仿 `createMarketAdapterFromEnv`（market/factory.ts）的位置与签名风格。
 * - LUOOME_LIMIT_UP_LADDER_SOURCES：逗号分隔、有序、去重；未知源启动期抛错；缺省 eastmoney
 *   （docs/ddd/source-pluggability-and-observation-design.md §4.6）
 * - 通过显式数据源配置装配；未知或重复来源在启动时失败
 * - fuyao 显式排入路由时要求 FUYAO_API_KEY 完整（§4.3），缺省启动期快速失败
 * - 返回的 manager 同时满足 core `LimitUpLadderManagerLike` 接口（structural typing）
 */

export interface CreateLimitUpLadderManagerDeps {
  readonly logger: Logger;
  readonly clock?: () => Date;
  readonly fetchImpl?: typeof fetch;
  /**
   * 组装根共享的供应商实例；注入时不再自构（§4.6）。
   * fuyao 是进程级共享 FuyaoClient（设计 §4.1：所有 Fuyao REST 请求共享同一协调器，
   * 禁止 factory 为同一进程隐式创建绕过协调器的客户端）。
   */
  readonly sources?: {
    readonly eastmoney?: EastmoneySource;
    readonly fuyao?: FuyaoClient;
  };
}

/** 已注册的连板天梯数据源（封闭启动校验；core 端口侧是开放 SourceIdSchema）。 */
const LimitUpLadderSourcesSchema = z
  .array(z.enum(['eastmoney', 'fuyao']))
  .min(1, '至少启用一个连板天梯数据源')
  .superRefine((sources, ctx) => {
    if (new Set(sources).size !== sources.length) {
      ctx.addIssue({ code: 'custom', message: '连板天梯数据源不能重复' });
    }
  });

const limitUpLadderSourcesFromEnv = (
  env: Readonly<Record<string, string | undefined>>,
): readonly ('eastmoney' | 'fuyao')[] => {
  const raw = env.LUOOME_LIMIT_UP_LADDER_SOURCES?.trim();
  return LimitUpLadderSourcesSchema.parse(
    raw === undefined || raw.length === 0
      ? ['eastmoney']
      : raw.split(',').map((source) => source.trim().toLowerCase()),
  );
};

export const createLimitUpLadderManagerFromEnv = (
  env: Readonly<Record<string, string | undefined>>,
  deps: CreateLimitUpLadderManagerDeps,
): LimitUpLadderManagerLike => {
  const clock = deps.clock ?? (() => new Date());
  const order = limitUpLadderSourcesFromEnv(env);
  const eastmoney = deps.sources?.eastmoney ?? new EastmoneySource({ clock, ...fetchOpt(deps) });

  const bindings = order.flatMap((source) => {
    switch (source) {
      case 'eastmoney':
        return eastmoneyBindings(eastmoney);
      case 'fuyao':
        return fuyaoBindings(buildFuyao(env, deps, clock));
      default:
        throw new Error(`不支持的数据源：${String(source satisfies never)}`);
    }
  });
  const registry = new SourceRegistry<LimitUpLadderCapabilityMap>(bindings, clock);

  return new LimitUpLadderManager({
    registry,
    logger: deps.logger,
    clock,
    holidaysProvider: async () => loadHolidaysFromEnv(env),
  });
};

const fetchOpt = (deps: CreateLimitUpLadderManagerDeps) =>
  deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl };

/**
 * fuyao 显式排入路由时要求配置完整（§4.3）：缺 FUYAO_API_KEY 启动期快速失败，
 * 避免 UI 显示已启用但运行时静默跳过。优先复用组装根共享的 FuyaoClient；
 * 未注入时按 env 自构（测试便利；生产 composition root 只创建一个共享实例）。
 */
const buildFuyao = (
  env: Readonly<Record<string, string | undefined>>,
  deps: CreateLimitUpLadderManagerDeps,
  clock: () => Date,
): FuyaoLimitUpLadderSource => {
  if (deps.sources?.fuyao !== undefined) {
    return new FuyaoLimitUpLadderSource({ client: deps.sources.fuyao, clock });
  }
  const apiKey = env.FUYAO_API_KEY;
  if (apiKey === undefined || apiKey.trim().length === 0) {
    throw new Error('fuyao 已启用，但 FUYAO_API_KEY 未配置');
  }
  const config = fuyaoConfigFromEnv(env);
  return new FuyaoLimitUpLadderSource({
    client: new FuyaoClient(config, fetchOpt(deps)),
    clock,
  });
};

/**
 * 连板天梯与 watch 共用同一份三层节假日历：内置 → 文件 → env。
 *
 * adapters 不能依赖 cli，因此在装配根读取配置；读取失败按日历“无新增项”处理，
 * 与 CLI 的容错口径一致。生产路径不会因为节假日配置文件损坏而伪造行情结果。
 */
const loadHolidaysFromEnv = (
  env: Readonly<Record<string, string | undefined>>,
): ReadonlyMap<number, ReadonlySet<string>> => {
  const home = env.LUOOME_HOME?.trim() || join(homedir(), '.luoome');
  const filePath = env.LUOOME_HOLIDAYS_FILE?.trim() || join(home, 'holidays.json');
  let fileCalendar: ReadonlyMap<number, ReadonlySet<string>> = new Map();
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

/** dataAsOf = source 返回的 observedAt；合法空池也是 success（§6.2）。 */
const eastmoneyBindings = (source: EastmoneySource): AnyBinding<LimitUpLadderCapabilityMap>[] => [
  {
    capability: 'limit-up-ladder',
    source: 'eastmoney',
    coverage: ['CN_A_SHARES_SH_SZ'],
    configurationReady: true,
    execute: ({ date, days }) => source.fetchLadder(date, { days }),
    observationOf: (result) => ({ outcome: 'success', dataAsOf: result.observedAt }),
  },
];

/**
 * fuyao 绑定（§7.1）：dataAsOf = observedAt；合法空池也是 success（§6.2）。
 * 权限错误（2003 → permission）只将本 (source, capability) 标为不可用并走 fallback（§4.3），
 * 不影响其它已授权 Fuyao 能力。
 */
const fuyaoBindings = (
  source: FuyaoLimitUpLadderSource,
): AnyBinding<LimitUpLadderCapabilityMap>[] => [
  {
    capability: 'limit-up-ladder',
    source: 'fuyao',
    coverage: ['CN_A_SHARES_SH_SZ'],
    configurationReady: true,
    execute: ({ date, days }) => source.fetchLadder(date, { days }),
    observationOf: (result) => ({ outcome: 'success', dataAsOf: result.observedAt }),
  },
];
