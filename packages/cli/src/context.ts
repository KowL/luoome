// @luoome/cli —— 共享 ToolContext 构造（tools call / advice 子命令使用）。
//
// 组装路径（plan.md 依赖表：surface → tools → core，及 db/adapters）：
//   LUOOME_HOME（默认 ~/.luoome）/luoome.db
//   → createDrizzleRepos（bun:sqlite driver，仅 Bun 运行时可加载本模块）
//   → 空库时 seedMockData(adapters fixtures)（首次运行）
//   → 行情 adapter 经 factory + LLM 经 LLMManager（分别由 LUOOME_MARKET_PROVIDER / LUOOME_LLM_PROVIDER 路由，均默认 mock）
//   → buildContext

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import {
  createMarketAdapterFromEnv,
  LLMManager,
  MOCK_ACCOUNT,
  MOCK_ACCOUNTS,
  MOCK_HOLDINGS,
  MOCK_STOCKS,
  MOCK_TRADES,
  mockAdviceFor,
} from '@luoome/adapters';
import type { Logger, RepositoryRegistry, ToolContext } from '@luoome/core';
import { BUILTIN_TACTICS } from '@luoome/core';
import { createDrizzleRepos, seedMockData } from '@luoome/db';
import { buildContext } from '@luoome/tools';

import { luoomeHome } from './paths.js';

/** CLI 持有的 ctx 句柄：ToolContext + 底层资源释放。 */
export interface CliContextHandle {
  readonly ctx: ToolContext;
  /** SQLite 文件路径（输出提示用）。 */
  readonly dbPath: string;
  /** 关闭底层数据库连接；短生命周期子命令退出前必须调用。 */
  readonly close: () => void;
}

/** LUOOME_HOME：默认 ~/.luoome（AGENTS.md 快速接入口径）。委托 ./paths.ts 解析。 */
export { luoomeHome };

/** 默认 holdings 分组 id（holdings-watch 池引用它）。 */
const DEFAULT_HOLDINGS_GROUP_ID = 'holdings-default';

/**
 * 种默认 holdings 分组 + 引用它的 holdings-watch 池（分组化模型，docs/stock-group-design.md §5）。
 * 幂等：分组已存在则跳过（save 本身是 upsert，重复执行结果一致）。
 */
const seedDefaultHoldingsGroupAndPool = async (
  repos: RepositoryRegistry,
  timestamp: Date,
): Promise<void> => {
  await repos.stockGroup.save({
    id: DEFAULT_HOLDINGS_GROUP_ID,
    name: '全部持仓（默认）',
    description: '开箱即用的分组：默认账户的活跃持仓（活视图，无快照）',
    resolver: { kind: 'holdings', accountId: MOCK_ACCOUNT.id },
    // 活视图分组无刷新动作；refreshPolicy 占位 'manual'（永不自动刷新）
    refreshPolicy: 'manual',
    enabled: true,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  await repos.stockPool.save({
    id: 'holdings-watch',
    name: '持仓监控（默认）',
    description: '开箱即用的池：成本阈值 ±5% + 量价背离战法',
    groupId: DEFAULT_HOLDINGS_GROUP_ID,
    rules: [
      { kind: 'cost-threshold', stopLossPct: 0.05, takeProfitPct: 0.05 },
      { kind: 'tactic', tacticId: 'volume-price-divergence', minScore: 60 },
    ],
    cooldownMinutes: 30,
    enabled: true,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
};

/** warn / error 打到 stderr，避免污染 --json 的 stdout。 */
const createStderrLogger = (): Logger => {
  const write =
    (level: 'warn' | 'error') =>
    (message: string, meta?: Record<string, unknown>): void => {
      const suffix = meta === undefined ? '' : ` ${JSON.stringify(meta)}`;
      console.error(`${level}: ${message}${suffix}`);
    };
  const noop = (): void => {};
  return { debug: noop, info: noop, warn: write('warn'), error: write('error') };
};

/**
 * 构造 CLI 共享 ctx。
 *
 * v0.1 种子策略：仅当账户表为空（全新库）时灌入 adapters 的 mock fixtures
 * （1 账户 / 20 股票 / 6 持仓 / 9 交易 / 2 建议）；已有数据则原样保留，
 * 保证 analyze_* 产生的历史建议不被每次启动覆盖。
 */
export const createCliContext = async (): Promise<CliContextHandle> => {
  const home = luoomeHome();
  mkdirSync(home, { recursive: true });
  const dbPath = join(home, 'luoome.db');

  const { repos, close } = createDrizzleRepos(dbPath);
  // v0.3 起：注入 5 个内置战法（首次运行或空库）
  for (const t of BUILTIN_TACTICS) {
    if ((await repos.tactic.findById(t.id)) === null) {
      await repos.tactic.save(t);
    }
  }

  const now = (): Date => new Date();
  const timestamp = new Date(); // 种子用：捕获一次「创建时间」快照

  const accounts = await repos.account.list();
  if (accounts.length === 0) {
    await seedMockData(repos, {
      accounts: MOCK_ACCOUNTS,
      stocks: MOCK_STOCKS,
      holdings: MOCK_HOLDINGS,
      trades: MOCK_TRADES,
    });
    await seedMockData(repos, {
      // 真实时钟生成，保证 validUntil 在未来（advice list 默认过滤已过期）。
      advices: [mockAdviceFor('002594.SZ', now), mockAdviceFor('600519.SH', now)],
    });
    // 分组化起：种默认 holdings 分组 + 引用它的 holdings-watch 池（开箱即用；必须在账户 seed 之后）
    await seedDefaultHoldingsGroupAndPool(repos, timestamp);
  } else if ((await repos.stockPool.list()).length === 0) {
    // 已有账户但首次启用 stockPool（v0.5 → v0.6 升级路径）：补种默认分组 + 池
    await seedDefaultHoldingsGroupAndPool(repos, timestamp);
  }

  const logger = createStderrLogger();
  const ctx = buildContext({
    repos,
    adapters: {
      // 行情源由 LUOOME_MARKET_PROVIDER 路由（默认 mock；real = Eastmoney→Tencent→Mock）
      market: createMarketAdapterFromEnv(process.env, { clock: now, logger }),
      // LLM 由 LUOOME_LLM_PROVIDER 路由（默认 mock；real 缺 key 启动期报错）
      llm: new LLMManager({ logger }),
    },
    user: { id: 'local-user', defaultAccountId: MOCK_ACCOUNT.id },
    clock: now,
    logger,
  });

  return { ctx, dbPath, close };
};
