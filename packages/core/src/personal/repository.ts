import type { Report } from '../entity/report.js';
import type { WatchTrigger } from '../entity/watch-trigger.js';
import type {
  PersonalAlertEvaluation,
  PersonalAlertEvaluationDraft,
  PersonalAlertPlan,
  PersonalAlertPlanMutation,
  PersonalAlertPlanRemoval,
  PersonalAlertRequest,
} from './alert.js';
import type { PersonalOperationReceipt } from './receipt.js';
import type { PersonalWatchFeedback } from './watch.js';
import type {
  WatchlistImportPreview,
  WatchlistImportResult,
  WatchlistImportSelection,
  WatchlistRemovalResult,
} from './watchlist.js';

/**
 * 个人域仓储接口（单机版）。
 * 只覆盖个人自选、个人提醒与个人交付；托管执行租约、回执查询与 outbox 已随托管层移除。
 */
export interface PersonalRepository {
  preparePersonalDelivery(input: {
    triggerId: string;
    channel: 'email' | 'in-app';
    emailAttempt: number;
    maxDailyNotifications: number;
    now: Date;
  }): Promise<{ eligible: boolean; trigger: WatchTrigger | null }>;
  syncPersonalDelivery(input: {
    triggerId: string;
    channel: 'email' | 'in-app';
    attempts: number;
    state: 'pending' | 'sending' | 'accepted' | 'failed' | 'unknown' | 'suppressed';
    notificationId: string;
    now: Date;
  }): Promise<WatchTrigger | null>;
  putImportPreview(preview: WatchlistImportPreview): Promise<void>;
  getImportPreview(id: string): Promise<WatchlistImportPreview | null>;
  getWatchlistRevision(watchlistId: string): Promise<string>;
  commitWatchlistImport(input: {
    previewId: string;
    inputHash: string;
    requestId: string;
    ownerUserId: string;
    selections: readonly WatchlistImportSelection[];
    excludedRows: readonly number[];
    acknowledgeExtraColumns: boolean;
    maxDistinctStocks: number;
    now: Date;
  }): Promise<WatchlistImportResult>;
  removePersonalMembers(input: {
    watchlistId: string;
    stockIds: readonly string[];
    ownerUserId: string;
    requestId: string;
    now: Date;
  }): Promise<WatchlistRemovalResult>;
  savePersonalAlertPlan(input: {
    plan: PersonalAlertPlan;
    expectedPlanRevision: string | null;
    requestId: string;
    enableConfirmed: boolean;
    maxEnabledRules: number;
    maxDailyNotifications: number;
    minCooldownMinutes: number;
    now: Date;
  }): Promise<PersonalAlertPlanMutation>;
  removePersonalAlertPlan(input: {
    alertPlanId: string;
    expectedPlanRevision: string;
    requestId: string;
    now: Date;
  }): Promise<PersonalAlertPlanRemoval>;
  getPersonalAlertEvaluation(resultRef: string): Promise<PersonalAlertEvaluation | null>;
  commitPersonalAlertEvaluation(input: {
    operationId: string;
    inputHash: string;
    /** 个人提醒评估的执行身份；与 draft.domainLeaseOwner 共同确定评估租约归属。 */
    attemptId: string;
    fence: number;
    now: Date;
    /** 冻结请求快照：提交前据此校验自选与条件指纹是否已变化。 */
    request: PersonalAlertRequest;
    draft?: PersonalAlertEvaluationDraft;
  }): Promise<{
    evaluation: PersonalAlertEvaluation;
    receipt: PersonalOperationReceipt;
    replayed: boolean;
  }>;
  commitFactsReport(input: {
    operationId: string;
    inputHash: string;
    notificationPolicy: 'eligible' | 'never';
    now: Date;
    report: Report;
  }): Promise<{
    report: Report;
    receipt: PersonalOperationReceipt;
    replayed: boolean;
  }>;
  recordPersonalFeedback(input: {
    triggerId: string;
    expectedRevision: number;
    rating: PersonalWatchFeedback['rating'];
    note: string;
    requestId: string;
    inputHash: string;
    now: Date;
  }): Promise<PersonalWatchFeedback>;
  listPersonalFeedback(triggerId: string): Promise<readonly PersonalWatchFeedback[]>;
  listAllPersonalFeedback(): Promise<readonly PersonalWatchFeedback[]>;
}
