import {
  type PortfolioCashFlow,
  type PortfolioCashFlowRepository,
  PortfolioCashFlowSchema,
  type PortfolioCorporateAction,
  type PortfolioCorporateActionRepository,
  PortfolioCorporateActionSchema,
} from '@luoome/core';

const inRange = (at: Date, from?: Date, to?: Date): boolean =>
  (from === undefined || at.getTime() >= from.getTime()) &&
  (to === undefined || at.getTime() <= to.getTime());

export class InMemoryPortfolioCashFlowRepository implements PortfolioCashFlowRepository {
  private readonly rows = new Map<string, PortfolioCashFlow>();

  async save(flow: PortfolioCashFlow): Promise<void> {
    const parsed = PortfolioCashFlowSchema.parse(flow);
    this.rows.set(parsed.id, parsed);
  }

  async findById(id: string): Promise<PortfolioCashFlow | null> {
    return this.rows.get(id) ?? null;
  }

  async listByAccount(accountId: string, from?: Date, to?: Date): Promise<PortfolioCashFlow[]> {
    return [...this.rows.values()]
      .filter((row) => row.accountId === accountId && inRange(row.occurredAt, from, to))
      .sort(
        (left, right) =>
          left.occurredAt.getTime() - right.occurredAt.getTime() || left.id.localeCompare(right.id),
      );
  }

  async remove(id: string): Promise<void> {
    this.rows.delete(id);
  }
}

export class InMemoryPortfolioCorporateActionRepository
  implements PortfolioCorporateActionRepository
{
  private readonly rows = new Map<string, PortfolioCorporateAction>();

  async save(action: PortfolioCorporateAction): Promise<void> {
    const parsed = PortfolioCorporateActionSchema.parse(action);
    this.rows.set(parsed.id, parsed);
  }

  async findById(id: string): Promise<PortfolioCorporateAction | null> {
    return this.rows.get(id) ?? null;
  }

  async listByAccount(
    accountId: string,
    from?: Date,
    to?: Date,
  ): Promise<PortfolioCorporateAction[]> {
    return [...this.rows.values()]
      .filter((row) => row.accountId === accountId && inRange(row.occurredAt, from, to))
      .sort(
        (left, right) =>
          left.occurredAt.getTime() - right.occurredAt.getTime() || left.id.localeCompare(right.id),
      );
  }

  async remove(id: string): Promise<void> {
    this.rows.delete(id);
  }
}
