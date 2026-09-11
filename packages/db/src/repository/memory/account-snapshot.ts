import {
  type AccountSnapshot,
  type AccountSnapshotRepository,
  AccountSnapshotSchema,
  assertAccountSnapshotInvariants,
  InvariantError,
} from '@luoome/core';

export class InMemoryAccountSnapshotRepository implements AccountSnapshotRepository {
  private readonly items = new Map<string, AccountSnapshot>();

  put(snapshot: AccountSnapshot): void {
    const parsed = AccountSnapshotSchema.parse(snapshot);
    assertAccountSnapshotInvariants(parsed);
    const duplicate = [...this.items.values()].find(
      (item) =>
        item.accountId === parsed.accountId &&
        item.version === parsed.version &&
        item.id !== parsed.id,
    );
    if (duplicate !== undefined) {
      throw new InvariantError(
        `account snapshot version already exists: ${parsed.accountId}:v${parsed.version}`,
      );
    }
    this.items.set(parsed.id, parsed);
  }

  async save(snapshot: AccountSnapshot): Promise<void> {
    this.put(snapshot);
  }

  async findById(id: string): Promise<AccountSnapshot | null> {
    return this.items.get(id) ?? null;
  }

  async latestByAccount(accountId: string): Promise<AccountSnapshot | null> {
    return (
      [...this.items.values()]
        .filter((snapshot) => snapshot.accountId === accountId)
        .sort((a, b) => b.version - a.version || b.asOf.getTime() - a.asOf.getTime())
        .at(0) ?? null
    );
  }

  async listByAccount(accountId: string, limit = 100): Promise<readonly AccountSnapshot[]> {
    return [...this.items.values()]
      .filter((snapshot) => snapshot.accountId === accountId)
      .sort((a, b) => b.version - a.version || b.asOf.getTime() - a.asOf.getTime())
      .slice(0, limit);
  }

  async remove(id: string): Promise<void> {
    this.items.delete(id);
  }
}
