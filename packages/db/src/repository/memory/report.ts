import {
  assertReportDeliveryTransition,
  assertReportInvariants,
  type DeliveryStatus,
  type Report,
  type ReportRepository,
  ReportSchema,
  reportScopeKey,
} from '@luoome/core';

const logicalKey = (report: Report): string =>
  [report.kind, reportScopeKey(report.scope), report.periodStart, report.periodEnd].join('|');

export class InMemoryReportRepository implements ReportRepository {
  private readonly items = new Map<string, Report>();
  private readonly idsByLogicalKey = new Map<string, string>();

  put(report: Report): void {
    const parsed = ReportSchema.parse(report);
    assertReportInvariants(parsed);
    this.items.set(parsed.id, parsed);
    this.idsByLogicalKey.set(logicalKey(parsed), parsed.id);
  }

  async upsertForPeriod(report: Report): Promise<Report> {
    const parsed = ReportSchema.parse(report);
    assertReportInvariants(parsed);
    const existingId = this.idsByLogicalKey.get(logicalKey(parsed));
    const existing = existingId === undefined ? undefined : this.items.get(existingId);
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

  async findByPeriod(input: {
    readonly kind: Report['kind'];
    readonly scopeKey: string;
    readonly periodStart: string;
    readonly periodEnd: string;
  }): Promise<Report | null> {
    const id = this.idsByLogicalKey.get(
      [input.kind, input.scopeKey, input.periodStart, input.periodEnd].join('|'),
    );
    return id === undefined ? null : (this.items.get(id) ?? null);
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
          b.generatedAt.getTime() - a.generatedAt.getTime(),
      )
      .slice(0, input.limit ?? 30);
  }

  async setDeliveryStatus(id: string, status: DeliveryStatus): Promise<void> {
    const report = this.items.get(id);
    if (report === undefined) return;
    assertReportDeliveryTransition(report.deliveryStatus, status);
    this.items.set(id, { ...report, deliveryStatus: status });
  }

  async remove(id: string): Promise<void> {
    const report = this.items.get(id);
    if (report === undefined) return;
    this.items.delete(id);
    this.idsByLogicalKey.delete(logicalKey(report));
  }
}
