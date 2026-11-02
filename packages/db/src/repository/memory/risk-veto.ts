import type { AnalysisSubject, RiskVeto, RiskVetoOverride, RiskVetoRepository } from '@luoome/core';

/** `risk_vetoes` / `risk_veto_overrides` 的 memory 实现（REQ-M5-04）。 */
export class InMemoryRiskVetoRepository implements RiskVetoRepository {
  private readonly vetoes = new Map<string, RiskVeto>();
  private readonly overrides = new Map<string, RiskVetoOverride>();

  async save(veto: RiskVeto): Promise<void> {
    this.vetoes.set(veto.id, veto);
  }

  async findActiveBySubject(input: {
    readonly accountId: string;
    readonly subject: AnalysisSubject;
  }): Promise<{ readonly veto: RiskVeto; readonly override: RiskVetoOverride | null } | null> {
    // 取**最新一条**未推翻的否决：绑定键是 accountId + subject
    const matching = [...this.vetoes.values()]
      .filter(
        (veto) =>
          veto.accountId === input.accountId &&
          veto.subject.kind === input.subject.kind &&
          veto.subject.id === input.subject.id,
      )
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    for (const veto of matching) {
      const override = this.overrides.get(veto.id) ?? null;
      if (override === null) return { veto, override: null };
    }
    return null;
  }

  async saveOverride(override: RiskVetoOverride): Promise<void> {
    this.overrides.set(override.vetoId, override);
  }
}
