// @luoome/mcp —— MCP server 的 ToolContext 组装（plan.md 跨包契约 + MVP-TASK §2.6）。
//
// 数据路径：LUOOME_HOME 环境变量（默认 ~/.luoome）下的 luoome.db。
// v0.1 全 mock：fixtures 种子（drizzle save 为 onConflictDoUpdate 幂等 upsert，
// mockAdviceFor 的 id 由 stockId 哈希决定，重复启动重复种子安全）；
// v0.5 起行情 adapter 经 factory（LUOOME_MARKET_PROVIDER，默认 mock）+ LLM 经 LLMManager（LUOOME_LLM_PROVIDER，默认 mock）。
//
// 运行时约束：本模块 import @luoome/db 桶导出（传递引用 bun:sqlite driver），
// 只允许在纯 Bun 运行时下加载（MCP server 正是如此）。

import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  createMarketAdapterFromEnv,
  DEFAULT_MOCK_NOW,
  defaultMockClock,
  LLMManager,
  MOCK_ACCOUNT,
  MOCK_HOLDINGS,
  MOCK_STOCKS,
  MOCK_TRADES,
  mockAdviceFor,
} from '@luoome/adapters';
import type { Logger, ToolContext } from '@luoome/core';
import { parseLlmProviderConfigFromEnv } from '@luoome/core';
import { createDrizzleRepos, ensureSchema, seedMockData } from '@luoome/db';
import { buildContext } from '@luoome/tools';

/** createServerContext 的返回句柄：ctx + close()（进程退出时关闭 SQLite）。 */
export interface ServerContextHandle {
  readonly ctx: ToolContext;
  readonly close: () => void;
}

/**
 * stderr logger：MCP stdio 传输独占 stdout（NDJSON 协议帧），
 * 任何日志都不得写 stdout，否则污染协议。
 */
const createStderrLogger = (): Logger => {
  const write =
    (level: 'debug' | 'info' | 'warn' | 'error') =>
    (message: string, meta?: Record<string, unknown>): void => {
      const suffix = meta === undefined ? '' : ` ${JSON.stringify(meta)}`;
      process.stderr.write(`[luoome-mcp][${level}] ${message}${suffix}\n`);
    };
  return { debug: write('debug'), info: write('info'), warn: write('warn'), error: write('error') };
};

/**
 * 种子建议时钟：取 max(mock 锚点 DEFAULT_MOCK_NOW, 真实时间)。
 *
 * 时钟口径（v0.1 mock 模式）：业务 ctx.clock 固定为 DEFAULT_MOCK_NOW，保证
 * fixtures / mock 行情 ts / analyze_* 产出的全链路确定性；但 advice 的过期过滤
 * 发生在 repo 层（InMemory/Drizzle 均用 Date.now() 真实时间，见 memory/advice.ts）。
 * 若种子建议也按 mock 时钟生成，真实时间越过 validUntil（short 仅 +3 天）后，
 * get_advice 默认查询会把种子建议过滤掉。种子时钟取 max 后，两个口径下种子建议
 * 均稳定可见；id 由 stockId 哈希决定，upsert 幂等，重启安全。
 */
const seedAdviceClock = (): Date => new Date(Math.max(DEFAULT_MOCK_NOW.getTime(), Date.now()));

/**
 * 组装 server 用 ToolContext：
 * createDrizzleRepos（内部已 ensureSchema，这里再显式调一次保持幂等可见）
 * → seedMockData(fixtures) → 行情 factory + LLMManager（均默认 mock）→ buildContext（from @luoome/tools）。
 */
export const createServerContext = async (
  env: NodeJS.ProcessEnv = process.env,
): Promise<ServerContextHandle> => {
  const home = env.LUOOME_HOME ?? join(homedir(), '.luoome');
  mkdirSync(home, { recursive: true });

  const handle = createDrizzleRepos(join(home, 'luoome.db'));
  // 幂等（CREATE TABLE IF NOT EXISTS）；createDrizzleRepos 内部已调一次，重复调用安全。
  ensureSchema(handle.db);

  await seedMockData(handle.repos, {
    accounts: [MOCK_ACCOUNT],
    stocks: MOCK_STOCKS,
    holdings: MOCK_HOLDINGS,
    trades: MOCK_TRADES,
    // 与 buildMockContext 对齐的 2 条种子建议，保证 get_advice 开箱有数据。
    advices: [
      mockAdviceFor('002594.SZ', seedAdviceClock),
      mockAdviceFor('600519.SH', seedAdviceClock),
    ],
  });

  const logger = createStderrLogger();
  const ctx = buildContext({
    repos: handle.repos,
    adapters: {
      // 行情源由 LUOOME_MARKET_PROVIDER 路由（默认 mock；real = Eastmoney→Tencent→Mock）
      market: createMarketAdapterFromEnv(env, { clock: defaultMockClock, logger }),
      // LLM 由 LUOOME_LLM_PROVIDER 路由（默认 mock；real 缺 key 启动期报错）
      llm: new LLMManager({ logger, config: parseLlmProviderConfigFromEnv(env) }),
    },
    user: { id: 'local-user', defaultAccountId: MOCK_ACCOUNT.id },
    // 固定 mock 时钟（2026-07-17 15:00 UTC+8），与 fixtures / 种子 advice 对齐，
    // 保证 v0.1 全链路确定性；v0.2 接真实数据源后切系统时钟。
    clock: defaultMockClock,
    logger,
  });

  return { ctx, close: handle.close };
};
