import type { RepositoryRegistry } from '@luoome/core';

export const DEFAULT_HOLDINGS_GROUP_ID = 'holdings-default';
export const DEFAULT_HOLDINGS_POOL_ID = 'holdings-watch';

/** 开箱即用的持仓分组 + 盯盘池；由 CLI/Web 首次启动共同调用。 */
export const seedDefaultWatch = async (
  repos: RepositoryRegistry,
  accountId: string,
  timestamp: Date,
): Promise<void> => {
  await repos.stockGroup.save({
    id: DEFAULT_HOLDINGS_GROUP_ID,
    name: '全部持仓（默认）',
    description: '开箱即用的分组：默认账户的活跃持仓（活视图，无快照）',
    resolver: { kind: 'holdings', accountId },
    refreshPolicy: 'manual',
    enabled: true,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  await repos.stockPool.save({
    id: DEFAULT_HOLDINGS_POOL_ID,
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
