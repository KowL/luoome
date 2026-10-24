import type { z } from 'zod';
import { WatchDeliveryIntentSchema } from './entity/notification.js';
import type { Report } from './entity/report.js';

export const ReportDeliveryIntentSchema = WatchDeliveryIntentSchema;
export type ReportDeliveryIntent = z.infer<typeof ReportDeliveryIntentSchema>;
export interface ReportExecutionLease {
  owner: string;
  until: Date;
  nextTickAt: Date;
}
export interface ReportAutomationRepository {
  execution(action: 'acquire' | 'renew' | 'release', owner: string, now: Date): Promise<boolean>;
  commit(report: Report, owner: string, now: Date): Promise<Report | null>;
  prepare(input: {
    reportId: string;
    owner: string;
    tenantId: string;
    generation: number;
    now: Date;
  }): Promise<boolean>;
  claim(
    reportId: string,
    owner: string,
    attemptId: string,
    now: Date,
  ): Promise<ReportDeliveryIntent | null>;
  complete(input: {
    reportId: string;
    owner: string;
    attemptId: string;
    state: 'accepted' | 'failed' | 'unknown' | 'suppressed';
    notificationId: string;
    errorKind: string | null;
    now: Date;
  }): Promise<boolean>;
  recover(owner: string, now: Date): Promise<void>;
  suppressPending(reason: string, now: Date): Promise<number>;
  list(): Promise<readonly ReportDeliveryIntent[]>;
}
