import type { FinancialIngestSnapshot } from '../entity/financial-ingest-snapshot.js';

/**
 * 数据商快照的持久化（REQ-M4-05 层 3）。
 *
 * ## 刻意**不**提供的操作
 *
 * - 没有 `listForVintage` / `findLatest` 之类「按 asOf 查」的方法：
 *   这张表**不参与 PIT 判定**，给它这类查询方法就是在邀请误用。
 * - 没有 `remove`：观测记录留着才能复盘「那天到底漂移了什么」。
 *
 * `resolveVintage` 的实现里**不得出现**本接口的任何引用（有守卫钉住）。
 */
export interface FinancialIngestSnapshotRepository {
  /** 追加一条观测。同 `(stock, metric, periodEnd, ingestHash)` 重复写入只保留一条（幂等）。 */
  append(snapshot: FinancialIngestSnapshot): Promise<void>;
  /** 取某只股票某报告期的最近一条（**仅用于层 3 内部比对**，不要拿去算 PIT）。 */
  latest(input: {
    readonly stockId: string;
    readonly metricId: string;
    readonly periodEnd: Date;
  }): Promise<FinancialIngestSnapshot | null>;
}
