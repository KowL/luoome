import {
  defaultMockClock,
  MOCK_ACCOUNT,
  MOCK_HOLDINGS,
  MOCK_STOCKS,
  MOCK_TRADES,
  MockLLMAdapter,
  MockMarketAdapter,
  mockAdviceFor,
} from '@luoome/adapters';
import type {
  Advice,
  LLMAdapterLike,
  Logger,
  MarketDataAdapterLike,
  RepositoryRegistry,
  ToolContext,
} from '@luoome/core';
// DRIVER-ISOLATION: '@luoome/db' 桶导出传递引用 client.ts（bun:sqlite driver），
// node 运行的 vitest 无法解析。buildMockContext 只需要 driver-free 的
// createInMemoryRepos / seedMockData，因此走 db 的 './memory' 子路径导出
// （packages/db/src/memory.ts，不引用 driver，node/vitest 可正常解析）。
import { createInMemoryRepos, seedMockData } from '@luoome/db/memory';

export interface BuildMockContextOptions {
  /** 固定时钟；默认 adapters 的 defaultMockClock（2026-07-17 15:00 UTC+8）。 */
  readonly clock?: () => Date;
  /** 默认静音 logger（丢弃全部输出）。 */
  readonly logger?: Logger;
  /**
   * 额外灌入的 advice 种子；默认 2 条 mockAdviceFor（002594.SZ / 600519.SH），
   * 传 [] 可关闭（advice tool 的持久化断言需要干净环境时）。
   */
  readonly advices?: readonly Advice[];
}

const createSilentLogger = (): Logger => {
  const noop = (): void => {};
  return { debug: noop, info: noop, warn: noop, error: noop };
};

/**
 * 测试 / Demo 用全 mock ToolContext：
 * in-memory repos + adapters fixtures 种子 + MockMarket/MockLLM + 固定 clock +
 * 静音 logger；user.defaultAccountId = MOCK_ACCOUNT.id。
 */
export const buildMockContext = async (
  opts: BuildMockContextOptions = {},
): Promise<ToolContext> => {
  const clock = opts.clock ?? defaultMockClock;
  const repos = createInMemoryRepos();
  await seedMockData(repos, {
    accounts: [MOCK_ACCOUNT],
    stocks: MOCK_STOCKS,
    holdings: MOCK_HOLDINGS,
    trades: MOCK_TRADES,
  });
  const advices = opts.advices ?? [
    mockAdviceFor('002594.SZ', clock),
    mockAdviceFor('600519.SH', clock),
  ];
  if (advices.length > 0) {
    await seedMockData(repos, { advices });
  }

  return {
    repos,
    adapters: {
      market: new MockMarketAdapter({ clock }),
      llm: new MockLLMAdapter(),
    },
    notification: createMockNotificationManager(repos),
    user: { id: 'mock-user', defaultAccountId: MOCK_ACCOUNT.id },
    clock,
    logger: opts.logger ?? createSilentLogger(),
  };
};

/** 测试用 mock NotificationManager（v0.3 起 send_notification tool 依赖）。 */
const createMockNotificationManager = (repos: RepositoryRegistry) => ({
  async send(input: {
    channel: 'feishu' | 'log';
    payload: {
      title: string;
      content: string;
      level: 'info' | 'warn' | 'error' | 'success';
      atMobiles?: string[];
    };
    adviceId?: string;
    tacticSignalId?: string;
  }): Promise<{ notification: unknown }> {
    const id = `mock-notif-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const notification = {
      id,
      channel: input.channel,
      payload: input.payload,
      result: 'success' as const,
      ...(input.adviceId !== undefined ? { adviceId: input.adviceId } : {}),
      ...(input.tacticSignalId !== undefined ? { tacticSignalId: input.tacticSignalId } : {}),
      sentAt: new Date(),
    };
    await repos.notification.save(notification);
    return { notification };
  },
});

export interface BuildContextInput {
  readonly repos: RepositoryRegistry;
  readonly adapters: {
    readonly market: MarketDataAdapterLike;
    readonly llm: LLMAdapterLike;
  };
  /** 缺省为系统时间。 */
  readonly clock?: () => Date;
  /** 缺省为 console。 */
  readonly logger?: Logger;
  /** 缺省为占位 local-user；CLI/TUI/Web/MCP 应显式传入真实用户与默认账户。 */
  readonly user?: {
    readonly id: string;
    readonly defaultAccountId: string;
  };
}

/**
 * 生产组装入口：CLI/TUI/Web/MCP 用真实 drizzle repos + 真实/mock adapters 组装 ctx。
 * buildContext 本身不 import db 的 driver 部分，repos 由调用方构造后注入。
 */
export const buildContext = (input: BuildContextInput): ToolContext => ({
  repos: input.repos,
  adapters: input.adapters,
  user: input.user ?? { id: 'local-user', defaultAccountId: '' },
  clock: input.clock ?? (() => new Date()),
  logger: input.logger ?? console,
});
