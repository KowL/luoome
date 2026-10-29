import { dateInShanghai } from '../trading-calendar.js';

export const DEFAULT_FACT_DATE_COVERAGE_RATIO = 0.99;

export type FactDateMemberInput = {
  readonly stockId: string;
  readonly status: 'available' | 'missing' | 'failed';
  readonly latestBarDate?: Date | undefined;
};

export type FactDateResolution = {
  /** 事实日期（UTC 午夜，与 DailyBar.date 同约定）。 */
  readonly factDate: Date;
  /** 事实日期上的成员覆盖率（0~1）。 */
  readonly coverageRatio: number;
  /** 最新 bar 早于事实日期的成员数。 */
  readonly laggingCount: number;
  /** 覆盖率是否达到阈值；未达到时事实日期回落到众数日期。 */
  readonly coverageMet: boolean;
  /** 参与统计的成员数（有 bar 日期的成员）。 */
  readonly observedCount: number;
};

/**
 * 解析事实日期。没有任何成员带 bar 日期时返回 undefined（调用方保留原时点）。
 *
 * 事实日期是**交易日 key**（UTC 午夜），bar 时间戳的精度不参与判断。
 * 统计分母是「有 bar 日期的成员」——没有数据的 failed 成员由 checkpoint 的覆盖率门禁负责，
 * 但落后成员（日期更早、状态 missing）必须计入，否则覆盖率会虚高。
 *
 * @param coverageRatio 覆盖率阈值；达到阈值的最晚日期作为事实日期，
 *   没有任何日期达到阈值时回落到众数日期（成员最集中的日期）并标记 coverageMet=false。
 */
export const resolveFactDate = (
  members: readonly FactDateMemberInput[],
  coverageRatio: number = DEFAULT_FACT_DATE_COVERAGE_RATIO,
): FactDateResolution | undefined => {
  const observed = members.filter((member) => member.latestBarDate !== undefined);
  if (observed.length === 0) return undefined;
  const countByDate = new Map<string, number>();
  for (const member of observed) {
    const key = dateInShanghai(member.latestBarDate as Date);
    countByDate.set(key, (countByDate.get(key) ?? 0) + 1);
  }
  // 日期倒序：先命中的是最晚的达标日期。
  const byDateDesc = [...countByDate.entries()].sort((left, right) =>
    right[0].localeCompare(left[0]),
  );
  const total = observed.length;
  const qualified = byDateDesc.find(([, count]) => count / total >= coverageRatio);
  const fallback = byDateDesc.reduce((best, entry) => (entry[1] > best[1] ? entry : best));
  const [factKey, factCount] = qualified ?? fallback;
  return {
    factDate: new Date(`${factKey}T00:00:00.000Z`),
    coverageRatio: factCount / total,
    laggingCount: total - factCount,
    coverageMet: qualified !== undefined,
    observedCount: total,
  };
};
