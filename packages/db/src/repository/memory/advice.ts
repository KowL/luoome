import {
  type Advice,
  type AdviceOutcome,
  type AdviceQuery,
  type AdviceRepository,
  assertAdviceInvariants,
  InvariantError,
} from '@luoome/core';

/** Advice 的 in-memory 实现。outcome 存独立 Map，语义与 advice_outcomes 表一致。 */
export class InMemoryAdviceRepository implements AdviceRepository {
  private readonly items = new Map<string, Advice>();
  private readonly outcomes = new Map<string, AdviceOutcome>();

  put(advice: Advice): void {
    assertAdviceInvariants(advice);
    this.items.set(advice.id, advice);
  }

  async save(advice: Advice): Promise<void> {
    this.put(advice);
  }

  async findById(id: string): Promise<Advice | null> {
    const advice = this.items.get(id);
    if (advice === undefined) return null;
    const outcome = await this.getOutcome(id);
    return outcome === null ? advice : { ...advice, outcome };
  }

  /** 过滤语义与 Drizzle 实现逐条对齐（见 DrizzleAdviceRepository.query 注释）。 */
  async query(filter: AdviceQuery): Promise<Advice[]> {
    const now = Date.now();
    let out = [...this.items.values()].filter((a) => {
      if (filter.subjectKind !== undefined && a.subjectKind !== filter.subjectKind) return false;
      if (filter.subjectId !== undefined && a.subjectId !== filter.subjectId) return false;
      if (filter.decision !== undefined && a.decision !== filter.decision) return false;
      if (filter.sourceTool !== undefined && a.sourceTool !== filter.sourceTool) return false;
      if (filter.since !== undefined && a.createdAt.getTime() < filter.since.getTime()) {
        return false;
      }
      if (filter.until !== undefined && a.createdAt.getTime() > filter.until.getTime()) {
        return false;
      }
      if (filter.includeExpired !== true && a.validUntil.getTime() <= now) return false;
      return true;
    });
    out = out.sort(
      (a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id),
    );
    if (filter.limit !== undefined) out = out.slice(0, filter.limit);
    return Promise.all(
      out.map(async (a) => {
        const outcome = await this.getOutcome(a.id);
        return outcome === null ? a : { ...a, outcome };
      }),
    );
  }

  async recordOutcome(adviceId: string, outcome: AdviceOutcome): Promise<void> {
    if (outcome.adviceId !== adviceId) {
      throw new InvariantError(
        `outcome.adviceId (${outcome.adviceId}) must equal adviceId (${adviceId})`,
      );
    }
    this.outcomes.set(adviceId, outcome);
  }

  /** 读取已回填的 outcome（超出 core 接口的便捷方法，与 Drizzle 实现对齐）。 */
  async getOutcome(adviceId: string): Promise<AdviceOutcome | null> {
    return this.outcomes.get(adviceId) ?? null;
  }
}
