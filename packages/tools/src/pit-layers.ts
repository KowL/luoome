import {
  type AnnouncementDisclosure,
  type DisclosureSource,
  describeDisclosureSource,
  type FinancialIngestVerdict,
  type FinancialMissingReason,
  ingestHashOf,
  type ToolContext,
} from '@luoome/core';

/**
 * REQ-M4-05 的**三层检测**。三层分工不可合并：
 *
 * | 层 | 职责 | 是否有入库权 |
 * |---|---|---|
 * | 1 版本发现 | **因果**：公告集合出现新 id ⇒ 真的发生了修订 | ✅ 唯一有 |
 * | 2 值抽取 | **校验**：差额必须等于更正公告的累计影响金额 | 否（只否决） |
 * | 3 快照兜底 | **告警**：数据商改口径，公告没变 | **否，只告警** |
 *
 * ## 为什么层 3 绝不能入库
 *
 * 若合并，东财的 `UPDATE_DATE` 抖动 + 混合 vintage 就会被当成真实修订：
 * spike 实测 2016A「值未变但 UPDATE_DATE 变」（假阳性）、2017A「停在 v2 缺 v3」（漏报）。
 * **PIT 会退化成「数据商今天说什么就是什么」。**
 */

/** 层 2 的差值容差：**浮点不用 `===`**。 */
export const REVENUE_DELTA_TOLERANCE = 0.01;

/**
 * 层 2 校验：新版本与上一版本的差额，必须等于公告给出的累计影响金额。
 *
 * ## 为什么不用 `===`
 *
 * spike 的值带两位小数（`26,476,970,977.57`），浮点减法会得到
 * `-8898352337.509995` 这类结果。用 `===` 会**永远不相等**，
 * 然后有人为了让它过而把校验删掉——那才是真正的危险。
 * 所以用容差，并把容差**写成一个具名常量**。
 */
export const correctionDeltaMatches = (input: {
  readonly previousValue: number;
  readonly nextValue: number;
  readonly announcedDelta: number;
  readonly tolerance?: number;
}): boolean => {
  const actual = input.nextValue - input.previousValue;
  return Math.abs(actual - input.announcedDelta) < (input.tolerance ?? REVENUE_DELTA_TOLERANCE);
};

/** 层 1 的产出：某期的版本链（按公告时间升序）。 */
export interface VintagesOf {
  readonly announcements: readonly AnnouncementDisclosure[];
  /** 首个定期报告的披露日 —— `publishedAt`。 **缺则不可入库**。 */
  readonly publishedAt: Date | null;
}

/**
 * 层 1：从公告版本链推出 `publishedAt` 与版本序列。
 *
 * **`announcementTime` 缺失 ⇒ `publishedAt = null`**，调用方必须落 `missing`。
 * **绝不 fallback 到 `now()`** —— 那会得到「看起来有披露时间，实际是抓取时间」的假数据，
 * PIT 的全部价值随之消失。
 */
export const resolveVintages = (announcements: readonly AnnouncementDisclosure[]): VintagesOf => {
  const sorted = [...announcements].sort(
    (a, b) => a.announcementTime.getTime() - b.announcementTime.getTime(),
  );
  const first = sorted.find((item) => item.kind === 'periodic-report');
  return {
    announcements: sorted,
    publishedAt: first === undefined ? null : first.announcementTime,
  };
};

/** 层 3 的一次检测记录。 */
export interface IngestObservation {
  readonly verdict: FinancialIngestVerdict;
  readonly ingestHash: string;
  /** mock 源时的说明；真实源为 `null`。 */
  readonly sourceNote: string | null;
}

/**
 * 层 3：快照比对。**只记录与告警，绝不写 `financial_fact_revisions`。**
 *
 * 判据：
 * - 哈希没变 → `unchanged`
 * - 哈希变了 **且** 公告集合新增 → `revision-observed`（层 1 会处理）
 * - 哈希变了 **但** 公告集合没变 → `vendor-drift`（**数据商改口径，只告警**）
 */
export const observeIngestSnapshot = async (input: {
  readonly source: DisclosureSource;
  readonly stockId: string;
  readonly metricId: string;
  readonly periodEnd: Date;
  readonly ctx: ToolContext;
  readonly now: Date;
}): Promise<IngestObservation> => {
  const snapshot = await input.source.fetchVendorSnapshot({
    stockId: input.stockId,
    metricId: input.metricId,
    periodEnd: input.periodEnd,
  });
  if (snapshot === null) return { verdict: 'unchanged', ingestHash: '', sourceNote: null };

  const ingestHash = ingestHashOf(snapshot);
  const previous = await input.ctx.repos.financialIngestSnapshot.latest({
    stockId: input.stockId,
    metricId: input.metricId,
    periodEnd: input.periodEnd,
  });

  // 先写观测（**只写这张表**）。
  await input.ctx.repos.financialIngestSnapshot.append({
    id: `ingest:${input.stockId}:${input.metricId}:${input.periodEnd.toISOString()}:${ingestHash.slice(0, 12)}`,
    stockId: input.stockId,
    metricId: input.metricId,
    periodEnd: input.periodEnd,
    ingestHash,
    vendorUpdatedAt: snapshot.vendorUpdatedAt,
    capturedAt: input.now,
  });

  if (previous !== null && previous.ingestHash === ingestHash)
    return { verdict: 'unchanged', ingestHash, sourceNote: null };

  // 哈希变了：看公告集合有没有新增（层 1 的信号）。
  const announcements = await input.source.listAnnouncements({
    stockId: input.stockId,
    periodEnd: input.periodEnd,
  });
  const verdict: FinancialIngestVerdict =
    announcements.length > 1 ? 'revision-observed' : 'vendor-drift';
  return {
    verdict,
    ingestHash,
    sourceNote: input.source.isMock ? describeDisclosureSource(input.source) : null,
  };
};

/**
 * `missing` 的原因码与**人话说明**（REQ-M4-05 硬要求 ④）。
 *
 * PRD 原文：「这是覆盖率下降，不是前视，**必须在输出里如此表述**」。
 * 所以 `recorded-after-cutoff` 的说明必须点出「覆盖率」，不能让读者以为数据有问题。
 */
export const missingExplanation = (
  reason: FinancialMissingReason,
): { readonly reason: FinancialMissingReason; readonly text: string } => {
  if (reason === 'recorded-after-cutoff')
    return {
      reason,
      text: '该期事实的抓取时刻晚于查询时点，因此不可见——这是**覆盖率下降**（回溯数据未覆盖到历史 asOf），不是前视偏差，也不是数据缺失。',
    };
  return { reason, text: `该期事实不可用：${reason}。` };
};

/**
 * T+1 保守规则（REQ-M4-05 硬要求 ②）。
 *
 * ## 为什么放在 wrapper 而不是 core 的 `visibleAt`
 *
 * spike 明确（§5.4.2）：「不要改 core 的 `visibleAt`」。
 * `visibleAt` 表达的是「这条事实在什么时点可见」这一**领域语义**；
 * T+1 是**数据源精度不足的补偿**——巨潮 `announcementTime` 只有日粒度（全是 00:00），
 * 当天盘后披露的公告在 `asOf = 当天` 时会被误判为可见。
 *
 * 前者属于领域，后者属于「这个数据源有多准」。混在一起会让领域层背一个外部数据源的缺陷。
 *
 * ## 规则
 *
 * 若 `asOf` 落在公告日当天（`asOf < 公告日 + 1 天`），把 `asOf` 推到次日 00:00，
 * 于是「当天公告」在当天不可见。公告日之前的 `asOf` 原样返回（不制造额外的空窗）。
 *
 * **为什么必须走 wrapper**：若调用方各自记得加，将来一定会有人直接调
 * `resolveVintage` 绕过它 —— 而 T+1 失效在数据上**完全看不出来**
 * （你只会得到一份看起来正常、实际有 ≤1 交易日前视的数据）。
 */
export const strictPitAsOf = (asOf: Date, announcedAt: Date): Date => {
  const nextDay = new Date(announcedAt);
  nextDay.setUTCDate(nextDay.getUTCDate() + 1);
  // 公告日当天（含）→ 推到次日；公告日之前 → 原样。
  return asOf.getTime() < nextDay.getTime() && asOf.getTime() >= announcedAt.getTime()
    ? nextDay
    : asOf;
};
