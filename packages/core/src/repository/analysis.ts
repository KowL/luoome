import type { Advice } from '../entity/advice.js';
import type { AnalysisContext } from '../entity/analysis-context.js';
import type { AnalysisJob, AnalysisJobStatus, AnalysisKind } from '../entity/analysis-job.js';
import type { AnalysisPublication } from '../entity/analysis-publication.js';

export interface AnalysisJobQuery {
  readonly accountId: string;
  readonly statuses?: readonly AnalysisJobStatus[];
  readonly kinds?: readonly AnalysisKind[];
  readonly since?: Date;
  readonly limit?: number;
}

export interface AnalysisClaim {
  readonly accountId: string;
  readonly jobId: string;
  readonly owner: string;
  readonly token: string;
  readonly now: Date;
  readonly leaseUntil: Date;
  readonly context: AnalysisContext;
}

export type AnalysisRecordResult =
  | { readonly ok: true; readonly advice: Advice; readonly replayed: boolean }
  | {
      readonly ok: false;
      readonly reason:
        | 'not_found'
        | 'context_expired'
        | 'context_mismatch'
        | 'lease_lost_before_commit'
        | 'duplicate_result';
    };

export interface AnalysisRecordAdvice {
  readonly accountId: string;
  readonly contextId: string;
  readonly now: Date;
  readonly resultHash: string;
  readonly advice: Advice;
  readonly claim?: { readonly jobId: string; readonly token: string };
}

export interface AnalysisRecordPublication extends Omit<AnalysisRecordAdvice, 'advice'> {
  readonly publication: AnalysisPublication;
}
export type AnalysisPublicationResult =
  | Exclude<AnalysisRecordResult, { readonly ok: true }>
  | { readonly ok: true; readonly resultRef: string; readonly replayed: boolean };

export interface AnalysisRepository {
  recordPublication(input: AnalysisRecordPublication): Promise<AnalysisPublicationResult>;
  recordAdvice(input: AnalysisRecordAdvice): Promise<AnalysisRecordResult>;
  enqueue(job: AnalysisJob): Promise<{ job: AnalysisJob; deduped: boolean }>;
  findJob(accountId: string, id: string): Promise<AnalysisJob | null>;
  listJobs(query: AnalysisJobQuery): Promise<AnalysisJob[]>;
  /** Recycle expired leases atomically before claiming; an old token cannot regain ownership. */
  claim(input: AnalysisClaim): Promise<AnalysisJob | null>;
  /**
   * 回填 `dataAsOf`（REQ-M5-01 受理/执行解耦）。
   *
   * ## 为什么需要它
   *
   * 受理阶段**不装配上下文**（装配是重活，留在受理路径会让 `≤2s` 只是碰巧），
   * 而 `dataAsOf` 是**装配的产物**。受理时只能写 `now` 占位，
   * 真实值要等 claim 装配完才知道。
   *
   * ## 为什么不是泛泛的 `updateJob`
   *
   * 只改这一个字段、只在**一个时机**调用。名字里带 `DataAsOf` 是为了让
   * 「谁能改 job、能改什么」在签名上就可读——泛化的 update 会变成后门。
   *
   * ## 调用时机约束（有守卫）
   *
   * **只在 claim 装配成功后立即调用**。受理后 / 完成后调用属于误用：
   * 那会让 `dataAsOf` 变成「随时可改」，与「直传 document」是同一类问题。
   */
  setJobDataAsOf(input: {
    readonly accountId: string;
    readonly jobId: string;
    /** 装配出的真实数据截止时间。 */
    readonly dataAsOf: Date;
    readonly now: Date;
  }): Promise<AnalysisJob | null>;
  refreshContext(input: {
    readonly accountId: string;
    readonly jobId: string;
    readonly token: string;
    readonly now: Date;
    readonly context: AnalysisContext;
  }): Promise<AnalysisJob | null>;
  fail(input: {
    accountId: string;
    jobId: string;
    token: string;
    now: Date;
    error: NonNullable<AnalysisJob['error']>;
    notBefore: Date;
  }): Promise<AnalysisJob | null>;
  cancel(accountId: string, id: string, now: Date): Promise<AnalysisJob | null>;
  requeue(accountId: string, id: string, now: Date): Promise<AnalysisJob | null>;
  saveContext(context: AnalysisContext): Promise<void>;
  findContext(accountId: string, id: string): Promise<AnalysisContext | null>;
}
