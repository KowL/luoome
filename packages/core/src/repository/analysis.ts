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
