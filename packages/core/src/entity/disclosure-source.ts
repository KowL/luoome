import { createHash } from 'node:crypto';

/**
 * 披露源契约（REQ-M4-05）。
 *
 * ## ⚠️ 当前**没有接入真实数据源**
 *
 * 巨潮（版本发现）/ 东财（快照兜底）/ PDF 表格抽取都**尚未实现**。
 * 只有 `mockDisclosureSource`——**它返回的是夹具数据，不是真实财报**。
 *
 * 为什么要在类型与命名上写死这件事：**假数据比没有数据危险得多**。
 * 用户看到「营业收入 264.77 亿」时无法分辨那是康美 2017A 的真实值还是夹具，
 * 所以每个 provider 都必须自报 `isMock`，并由调用方在输出里标明。
 */

/** 一次公告披露（来自巨潮 `hisAnnouncement/query`）。 */
export interface AnnouncementDisclosure {
  readonly announcementId: string;
  /** **日粒度**（巨潮一律 00:00，spike 已实测）。 */
  readonly announcementTime: Date;
  readonly title: string;
  /** 该期首个定期报告 vs 后续修订载体。 */
  readonly kind: 'periodic-report' | 'correction-notice';
}

/** 数据商快照（来自东财 `RPT_LICO_FN_CPD` 单行）。 */
export interface VendorSnapshot {
  readonly stockId: string;
  readonly metricId: string;
  readonly periodEnd: Date;
  /** 数据商自报的最新值（**只用于层 3 比对，永不进 PIT**）。 */
  readonly value: number;
  readonly vendorUpdatedAt: Date | null;
}

export interface DisclosureSource {
  /** provider 名。**mock 必须带 `mock` 前缀**，便于输出里标注。 */
  readonly name: string;
  /** 是否为夹具。调用方必须在结果里标明（见 `describeDisclosureSource`）。 */
  readonly isMock: boolean;
  /** 层 1：某股票某报告期的公告版本链（按时间升序）。 */
  listAnnouncements(input: {
    readonly stockId: string;
    readonly periodEnd: Date;
  }): Promise<readonly AnnouncementDisclosure[]>;
  /** 层 3：某股票某报告期的数据商快照。 */
  fetchVendorSnapshot(input: {
    readonly stockId: string;
    readonly metricId: string;
    readonly periodEnd: Date;
  }): Promise<VendorSnapshot | null>;
}

/** 输出里必须带的来源说明（`isMock` 为真时用户能一眼看出）。 */
export const describeDisclosureSource = (source: DisclosureSource): string =>
  source.isMock
    ? `数据来源：${source.name}（**夹具数据，非真实财报**）`
    : `数据来源：${source.name}`;

/**
 * 层 3 的哈希：`sha256(规范化 payload)`。
 *
 * **规范化的意义**：只保留会影响「值」的字段，剔除 `UPDATE_DATE` / `EITIME`
 * 这类会抖动的字段——否则每次抓取哈希都会变，告警变成噪音。
 * 但 `vendorUpdatedAt` **要进 payload**：数据商改口径时它往往先动，
 * 那是我们能看见的唯一信号。
 */
export const ingestHashOf = (snapshot: VendorSnapshot): string => {
  const payload = {
    stockId: snapshot.stockId,
    metricId: snapshot.metricId,
    periodEnd: snapshot.periodEnd.toISOString(),
    value: snapshot.value,
    vendorUpdatedAt: snapshot.vendorUpdatedAt?.toISOString() ?? null,
  };
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
};
