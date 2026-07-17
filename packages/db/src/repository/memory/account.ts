import { type Account, type AccountRepository, assertAccountInvariants } from '@luoome/core';

/** Account 的 in-memory 实现（Map 存储，供测试与 tools 单测使用）。 */
export class InMemoryAccountRepository implements AccountRepository {
  private readonly items = new Map<string, Account>();

  /** 同步写入（含不变量断言），供 save 与 createInMemoryRepos 的种子数据复用。 */
  put(account: Account): void {
    assertAccountInvariants(account);
    this.items.set(account.id, account);
  }

  async save(account: Account): Promise<void> {
    this.put(account);
  }

  async findById(id: string): Promise<Account | null> {
    return this.items.get(id) ?? null;
  }

  async list(): Promise<Account[]> {
    return [...this.items.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  async remove(id: string): Promise<void> {
    this.items.delete(id);
  }
}
