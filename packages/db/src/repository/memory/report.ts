import { createHash } from 'node:crypto';
import {
  assertReportDeliveryTransition,
  assertReportInvariants,
  type DecisionReviewRepository,
  type DeliveryStatus,
  InvariantError,
  type Report,
  type ReportRepository,
  ReportSchema,
  reportScopeKey,
  type TradeRepository,
  TradeSchema,
} from '@luoome/core';
import { MemoryWriteLock } from './write-lock.js';

const logicalKey = (report: Report): string =>
  [
    report.kind,
    reportScopeKey(report.scope),
    report.periodStart,
    report.periodEnd,
    report.version ?? 1,
  ].join('|');

export class InMemoryReportRepository implements ReportRepository {
  private readonly items = new Map<string, Report>();
  private readonly idsByLogicalKey = new Map<string, string>();
  private readonly deliveryAttempts = new Map<string, string>();
  private readonly refreshReceipts = new Map<string, { requestHash: string; reportId: string }>();
  private decisionReviews: DecisionReviewRepository | null = null;
  private trades: TradeRepository | null = null;
  private decisionWriteLock = new MemoryWriteLock();

  setDecisionReviewRepository(
    repository: DecisionReviewRepository,
    trades: TradeRepository,
    lock: MemoryWriteLock,
  ): void {
    this.decisionReviews = repository;
    this.trades = trades;
    this.decisionWriteLock = lock;
  }

  put(report: Report): void {
    const parsed = ReportSchema.parse(report);
    assertReportInvariants(parsed);
    const existing = this.items.get(parsed.id);
    if (existing !== undefined && logicalKey(existing) !== logicalKey(parsed))
      throw new InvariantError('report id already belongs to another version');
    this.items.set(parsed.id, parsed);
    this.idsByLogicalKey.set(logicalKey(parsed), parsed.id);
  }

  async upsertForPeriod(report: Report): Promise<Report> {
    const parsed = ReportSchema.parse(report);
    assertReportInvariants(parsed);
    if ((parsed.version ?? 1) > 1) {
      const previous = await this.findByPeriodVersion({
        kind: parsed.kind,
        scopeKey: reportScopeKey(parsed.scope),
        periodStart: parsed.periodStart,
        periodEnd: parsed.periodEnd,
        version: (parsed.version ?? 1) - 1,
      });
      if (previous?.id !== parsed.supersedesReportId)
        throw new InvariantError('report supplement predecessor mismatch');
    }
    const existingId = this.idsByLogicalKey.get(logicalKey(parsed));
    const existing = existingId === undefined ? undefined : this.items.get(existingId);
    if (existing !== undefined && (parsed.kind === 'closing' || parsed.kind === 'weekly')) {
      return existing;
    }
    const saved =
      existing === undefined
        ? parsed
        : ReportSchema.parse({
            ...parsed,
            id: existing.id,
            createdAt: existing.createdAt,
          });
    this.put(saved);
    return saved;
  }

  async findRefreshReceipt(input: Parameters<ReportRepository['findRefreshReceipt']>[0]) {
    const receipt = this.refreshReceipts.get(`${input.accountId}|${input.requestId}`);
    if (receipt === undefined) return null;
    const report = this.items.get(receipt.reportId);
    if (report === undefined) throw new InvariantError('report refresh receipt target missing');
    return { requestHash: receipt.requestHash, report };
  }

  async reuseDecisionReviewReport(
    input: Parameters<ReportRepository['reuseDecisionReviewReport']>[0],
  ) {
    return this.decisionWriteLock.run(async () => {
      const key = `${input.accountId}|${input.requestId}`;
      const receipt = this.refreshReceipts.get(key);
      if (receipt !== undefined) {
        if (receipt.requestHash !== input.requestHash)
          throw new InvariantError('report refresh request identity conflict');
        const old = this.items.get(receipt.reportId);
        if (old === undefined) throw new InvariantError('report refresh receipt target missing');
        return old;
      }
      const report = this.items.get(input.reportId);
      if (
        report === undefined ||
        report.scope.kind !== 'account' ||
        report.scope.accountId !== input.accountId ||
        this.decisionReviews === null
      )
        throw new InvariantError('report refresh scope changed');
      const latest = await this.findByPeriod({
        kind: report.kind,
        scopeKey: reportScopeKey(report.scope),
        periodStart: report.periodStart,
        periodEnd: report.periodEnd,
      });
      if (latest?.id !== report.id) throw new InvariantError('report latest version changed');
      if ((await this.decisionReviews.latestSequence(input.accountId)) !== input.throughSequence)
        throw new InvariantError('decision review facts changed before report commit');
      this.refreshReceipts.set(key, { requestHash: input.requestHash, reportId: report.id });
      return report;
    });
  }

  async appendDecisionReviewSupplement(
    input: Parameters<ReportRepository['appendDecisionReviewSupplement']>[0],
  ) {
    return this.decisionWriteLock.run(async () => {
      const parsed = ReportSchema.parse(input.report);
      assertReportInvariants(parsed);
      const snapshot = parsed.decisionReviewSnapshot;
      if (
        snapshot === undefined ||
        parsed.notificationPolicy !== 'never' ||
        parsed.scope.kind !== 'account' ||
        parsed.scope.accountId !== snapshot.accountId ||
        this.decisionReviews === null ||
        this.trades === null
      )
        throw new InvariantError(
          'decision review supplement requires account snapshot and never policy',
        );
      const receiptKey = `${snapshot.accountId}|${input.requestId}`;
      const receipt = this.refreshReceipts.get(receiptKey);
      if (receipt !== undefined) {
        if (receipt.requestHash !== input.requestHash)
          throw new InvariantError('report refresh request identity conflict');
        const report = this.items.get(receipt.reportId);
        if (report === undefined) throw new InvariantError('report refresh receipt target missing');
        return { report, created: false, replayed: true };
      }
      const latest = await this.findByPeriod({
        kind: parsed.kind,
        scopeKey: reportScopeKey(parsed.scope),
        periodStart: parsed.periodStart,
        periodEnd: parsed.periodEnd,
      });
      if (
        latest?.id !== input.expectedLatestReportId ||
        parsed.supersedesReportId !== latest.id ||
        parsed.version !== (latest.version ?? 1) + 1
      )
        throw new InvariantError('report latest version changed');
      if (
        (await this.decisionReviews.latestSequence(snapshot.accountId)) !== snapshot.throughSequence
      )
        throw new InvariantError('decision review facts changed before report commit');
      for (const [id, hash] of Object.entries(snapshot.tradeFactHashes)) {
        const trade = await this.trades.findById(id);
        const current =
          trade === null
            ? 'missing'
            : createHash('sha256')
                .update(JSON.stringify(TradeSchema.parse(trade)))
                .digest('hex');
        if (current !== hash)
          throw new InvariantError('decision review trade facts changed before report commit');
      }
      this.put(parsed);
      this.refreshReceipts.set(receiptKey, { requestHash: input.requestHash, reportId: parsed.id });
      return { report: parsed, created: true, replayed: false };
    });
  }

  async findById(id: string): Promise<Report | null> {
    return this.items.get(id) ?? null;
  }

  async findByPeriodVersion(input: {
    readonly kind: Report['kind'];
    readonly scopeKey: string;
    readonly periodStart: string;
    readonly periodEnd: string;
    readonly version: number;
  }): Promise<Report | null> {
    const id = this.idsByLogicalKey.get(
      [input.kind, input.scopeKey, input.periodStart, input.periodEnd, input.version].join('|'),
    );
    return id === undefined ? null : (this.items.get(id) ?? null);
  }

  async findByPeriod(input: {
    readonly kind: Report['kind'];
    readonly scopeKey: string;
    readonly periodStart: string;
    readonly periodEnd: string;
  }): Promise<Report | null> {
    return (
      [...this.items.values()]
        .filter(
          (report) =>
            report.kind === input.kind &&
            reportScopeKey(report.scope) === input.scopeKey &&
            report.periodStart === input.periodStart &&
            report.periodEnd === input.periodEnd,
        )
        .sort((a, b) => (b.version ?? 1) - (a.version ?? 1))[0] ?? null
    );
  }

  async list(
    input: {
      readonly kind?: Report['kind'];
      readonly scopeKey?: string;
      readonly from?: string;
      readonly to?: string;
      readonly status?: Report['status'];
      readonly limit?: number;
    } = {},
  ): Promise<readonly Report[]> {
    return [...this.items.values()]
      .filter((report) => input.kind === undefined || report.kind === input.kind)
      .filter(
        (report) => input.scopeKey === undefined || reportScopeKey(report.scope) === input.scopeKey,
      )
      .filter((report) => input.from === undefined || report.periodEnd >= input.from)
      .filter((report) => input.to === undefined || report.periodEnd <= input.to)
      .filter((report) => input.status === undefined || report.status === input.status)
      .sort(
        (a, b) =>
          b.periodEnd.localeCompare(a.periodEnd) ||
          (b.version ?? 1) - (a.version ?? 1) ||
          b.generatedAt.getTime() - a.generatedAt.getTime(),
      )
      .slice(0, input.limit ?? 30);
  }

  async setDeliveryStatus(id: string, status: DeliveryStatus): Promise<void> {
    const report = this.items.get(id);
    if (report === undefined) return;
    if (report.notificationPolicy === 'never' && status !== 'not-requested')
      throw new InvariantError('never report cannot enter delivery');
    assertReportDeliveryTransition(report.deliveryStatus, status);
    this.items.set(id, { ...report, deliveryStatus: status });
    this.deliveryAttempts.delete(id);
  }

  async claimDelivery(input: {
    readonly id: string;
    readonly attemptId: string;
    readonly now: Date;
    readonly stalePendingBefore: Date;
    readonly failedRetryBefore: Date;
  }): Promise<boolean> {
    const report = this.items.get(input.id);
    if (report === undefined || report.notificationPolicy === 'never') return false;
    const retryable =
      report.deliveryStatus === 'not-requested' ||
      ((report.deliveryStatus === 'failed' || report.deliveryStatus === 'fallback-log') &&
        report.updatedAt <= input.failedRetryBefore) ||
      (report.deliveryStatus === 'pending' && report.updatedAt <= input.stalePendingBefore);
    if (!retryable) return false;
    this.items.set(input.id, { ...report, deliveryStatus: 'pending', updatedAt: input.now });
    this.deliveryAttempts.set(input.id, input.attemptId);
    return true;
  }

  async finishDelivery(input: {
    readonly id: string;
    readonly attemptId: string;
    readonly status: 'sent' | 'fallback-log' | 'failed';
    readonly now: Date;
  }): Promise<boolean> {
    const report = this.items.get(input.id);
    if (
      report === undefined ||
      report.notificationPolicy === 'never' ||
      report.deliveryStatus !== 'pending' ||
      this.deliveryAttempts.get(input.id) !== input.attemptId
    )
      return false;
    this.items.set(input.id, { ...report, deliveryStatus: input.status, updatedAt: input.now });
    this.deliveryAttempts.delete(input.id);
    return true;
  }

  async remove(id: string): Promise<void> {
    const report = this.items.get(id);
    if (report === undefined) return;
    if ([...this.items.values()].some((item) => item.supersedesReportId === id))
      throw new InvariantError('report has supplements');
    this.items.delete(id);
    this.idsByLogicalKey.delete(logicalKey(report));
    this.deliveryAttempts.delete(id);
  }
}
