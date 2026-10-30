import {
  type StrictBacktestMarketFact,
  strictBacktestHash,
  type ToolContext,
  TRADABILITY_RULE_VERSION,
  tradabilityLimitPct,
  tradabilityLimitPrices,
} from '@luoome/core';

export type BacktestMarketFactSkipReason =
  | 'not-in-pit-universe'
  | 'listing-status-unknown'
  | 'st-status-unknown'
  | 'missing-daily-bar'
  | 'missing-prev-close';

export interface BacktestMarketFactSyncInput {
  readonly stockIds: readonly string[];
  readonly days: readonly {
    readonly dataAsOf: Date;
    readonly universeSyncId?: string | undefined;
    readonly revisionCutoff?: Date | undefined;
  }[];
}

export interface BacktestMarketFactSyncReport {
  readonly written: number;
  readonly skipped: readonly {
    readonly stockId: string;
    readonly date: string;
    readonly reason: BacktestMarketFactSkipReason;
  }[];
}

const factHash = (fact: Omit<StrictBacktestMarketFact, 'contentHash'>): string =>
  strictBacktestHash(fact);

/**
 * T22：按 evaluation day 的 revisionCutoff 生成 PIT 可交易性事实。
 *
 * - 只读 `daily_bar_revisions`（cutoff 之前的版本），不读当前日线缓存；
 * - 涨跌停价由「前收盘 × 板块幅度」确定性计算，幅度表版本记录在 source；
 * - ST 状态取自 PIT 快照（旧行 unknown → 该日不写事实，门禁如实 partial，不猜）；
 * - 公司行动无数据源：`corporateActionsStatus='unavailable'`，不填推断值；
 * - 写入口是幂等 upsert，重跑不会重复或半写。
 */
export const syncBacktestMarketFacts = async (
  input: BacktestMarketFactSyncInput,
  ctx: ToolContext,
): Promise<BacktestMarketFactSyncReport> => {
  const skipped: BacktestMarketFactSyncReport['skipped'][number][] = [];
  let written = 0;
  for (const day of input.days) {
    if (day.universeSyncId === undefined || day.revisionCutoff === undefined) continue;
    const members = await ctx.repos.stockUniverse.listSnapshotMemberFacts(day.universeSyncId);
    const memberById = new Map(members.map((member) => [member.stockId, member]));
    const facts: StrictBacktestMarketFact[] = [];
    for (const stockId of input.stockIds) {
      const skip = (reason: BacktestMarketFactSkipReason): void => {
        skipped.push({ stockId, date: day.dataAsOf.toISOString(), reason });
      };
      const member = memberById.get(stockId);
      if (member === undefined) {
        skip('not-in-pit-universe');
        continue;
      }
      if (member.listingStatus === 'unknown') {
        skip('listing-status-unknown');
        continue;
      }
      const revisions = await ctx.repos.dailyBar.listRevisions({
        stockId,
        to: day.dataAsOf,
        recordedAt: day.revisionCutoff,
      });
      const revision = revisions
        .filter((item) => item.date.getTime() === day.dataAsOf.getTime())
        .at(-1);
      if (revision === undefined) {
        skip('missing-daily-bar');
        continue;
      }
      const sessionStatus =
        member.listingStatus === 'delisted'
          ? ('delisted' as const)
          : member.listingStatus === 'suspended'
            ? ('suspended' as const)
            : ('open' as const);
      let buyRestriction: StrictBacktestMarketFact['buyRestriction'] = 'none';
      let sellRestriction: StrictBacktestMarketFact['sellRestriction'] = 'none';
      if (sessionStatus === 'open') {
        const pct = tradabilityLimitPct({ stockId, stStatus: member.stStatus });
        if (pct === null) {
          skip('st-status-unknown');
          continue;
        }
        const prior = revisions
          .filter((item) => item.date.getTime() < day.dataAsOf.getTime())
          .at(-1);
        if (prior === undefined) {
          skip('missing-prev-close');
          continue;
        }
        const limits = tradabilityLimitPrices(prior.close, pct);
        if (revision.open >= limits.up - 1e-9) buyRestriction = 'limit-up';
        if (revision.open <= limits.down + 1e-9) sellRestriction = 'limit-down';
      } else {
        buyRestriction = sessionStatus === 'delisted' ? 'delisted' : 'suspended';
        sellRestriction = buyRestriction;
      }
      const factWithoutHash = {
        stockId,
        date: revision.date,
        rawOpen: revision.open,
        rawHigh: revision.high,
        rawLow: revision.low,
        rawClose: revision.close,
        sessionStatus,
        buyAllowed: buyRestriction === 'none',
        sellAllowed: sellRestriction === 'none',
        buyRestriction,
        sellRestriction,
        corporateActionsStatus: 'unavailable' as const,
        corporateActions: [],
        source: `daily_bar_revisions:${TRADABILITY_RULE_VERSION}`,
        recordedAt: revision.recordedAt,
      };
      facts.push({ ...factWithoutHash, contentHash: factHash(factWithoutHash) });
    }
    if (facts.length > 0) {
      await ctx.repos.strategyBacktest.saveMarketFacts(facts);
      written += facts.length;
    }
  }
  return { written, skipped };
};

/** 门禁披露用：把跳过原因翻译成用户可读的一句话。 */
export const describeBacktestFactSkips = (
  report: BacktestMarketFactSyncReport | undefined,
): string | null => {
  if (report === undefined || report.skipped.length === 0) return null;
  const counts = new Map<BacktestMarketFactSkipReason, number>();
  for (const item of report.skipped) {
    counts.set(item.reason, (counts.get(item.reason) ?? 0) + 1);
  }
  const labels: Record<BacktestMarketFactSkipReason, string> = {
    'not-in-pit-universe': '不在 PIT 股票池',
    'listing-status-unknown': '缺上市状态',
    'st-status-unknown': '缺 ST 状态（PIT 快照属性 unknown）',
    'missing-daily-bar': '缺当日 revision',
    'missing-prev-close': '缺前收盘价',
  };
  return [...counts.entries()].map(([reason, count]) => `${labels[reason]} ${count} 条`).join('、');
};
