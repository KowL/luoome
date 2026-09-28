import {
  assertReportDeliveryTransition,
  assertReportInvariants,
  type DeliveryStatus,
  InvariantError,
  type Report,
  type ReportRepository,
  ReportSchema,
  reportScopeKey,
} from '@luoome/core';

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
    if (existing !== undefined && parsed.kind === 'closing') {
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
    if (report === undefined) return false;
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
