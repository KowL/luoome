import type { Account, Advice, Holding, RepositoryRegistry, Stock, Trade } from '@luoome/core';

/**
 * seedMockData 的 fixtures 参数类型。
 *
 * 刻意只依赖 core 实体类型，不 import @luoome/adapters：
 * 依赖方向只允许 db → core；fixtures 由 tools/cli 从 adapters 组装后传入。
 */
export interface MockFixtures {
  readonly accounts?: readonly Account[];
  readonly stocks?: readonly Stock[];
  readonly holdings?: readonly Holding[];
  readonly trades?: readonly Trade[];
  readonly advices?: readonly Advice[];
}

/**
 * 把 fixtures 依次写入 repos（账户 → 标的 → 持仓 → 交易 → 建议）。
 * 每条都走对应 repository 的 save，因此不变量断言自然生效。
 */
export const seedMockData = async (
  repos: RepositoryRegistry,
  fixtures: MockFixtures,
): Promise<void> => {
  for (const account of fixtures.accounts ?? []) await repos.account.save(account);
  for (const stock of fixtures.stocks ?? []) await repos.stock.save(stock);
  for (const holding of fixtures.holdings ?? []) await repos.holding.save(holding);
  for (const trade of fixtures.trades ?? []) await repos.trade.save(trade);
  for (const advice of fixtures.advices ?? []) await repos.advice.save(advice);
};
