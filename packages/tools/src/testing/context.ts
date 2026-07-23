import {
  DEFAULT_TEST_NOW,
  FakeLLMAdapter,
  FakeMarketAdapter,
  fixedTestClock,
  TEST_ACCOUNT,
  TEST_ACCOUNTS,
  TEST_HOLDINGS,
  TEST_STOCKS,
  TEST_TRADES,
  testAdviceFor,
} from '@luoome/adapters/testing';
import type { Advice, Logger, RepositoryRegistry, ToolContext } from '@luoome/core';
import { createInMemoryRepos, seedData } from '@luoome/db/memory';

export interface BuildTestContextOptions {
  readonly clock?: () => Date;
  readonly logger?: Logger;
  readonly advices?: readonly Advice[];
}

const createSilentLogger = (): Logger => {
  const noop = (): void => {};
  return { debug: noop, info: noop, warn: noop, error: noop };
};

const defaultBusinessClock = (): Date => new Date(Math.max(DEFAULT_TEST_NOW.getTime(), Date.now()));

/** Deterministic, in-memory context for automated tests only. */
export const buildTestContext = async (
  opts: BuildTestContextOptions = {},
): Promise<ToolContext> => {
  const businessClock = opts.clock ?? defaultBusinessClock;
  const marketClock = opts.clock ?? fixedTestClock;
  const repos = createInMemoryRepos();
  await seedData(repos, {
    accounts: TEST_ACCOUNTS,
    stocks: TEST_STOCKS,
    holdings: TEST_HOLDINGS,
    trades: TEST_TRADES,
  });
  const advices = opts.advices ?? [
    testAdviceFor('002594.SZ', marketClock),
    testAdviceFor('600519.SH', marketClock),
  ];
  if (advices.length > 0) {
    await seedData(repos, { advices });
  }

  return {
    repos,
    adapters: {
      market: new FakeMarketAdapter({ clock: marketClock }),
      llm: new FakeLLMAdapter(),
    },
    notification: createTestNotificationManager(repos),
    user: { id: 'test-user', defaultAccountId: TEST_ACCOUNT.id },
    clock: businessClock,
    logger: opts.logger ?? createSilentLogger(),
  };
};

const createTestNotificationManager = (repos: RepositoryRegistry) => ({
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
    const id = `test-notif-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
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
