import type { AnalysisSubject, RiskVeto, RiskVetoOverride, RiskVetoRepository } from '@luoome/core';
import { and, desc, eq } from 'drizzle-orm';

import type { DrizzleDatabase } from '../../database.js';
import type { Schema } from '../../schema/index.js';
import { riskVetoes, riskVetoOverrides } from '../../schema/risk-veto.js';

/** `risk_vetoes` / `risk_veto_overrides` 的 drizzle 实现（REQ-M5-04）。 */
export class DrizzleRiskVetoRepository implements RiskVetoRepository {
  constructor(private readonly db: DrizzleDatabase<Schema>) {}

  async save(veto: RiskVeto): Promise<void> {
    this.db
      .insert(riskVetoes)
      .values({
        id: veto.id,
        accountId: veto.accountId,
        subjectKind: veto.subject.kind,
        subjectId: veto.subject.id,
        reason: veto.reason,
        factIdsJson: JSON.stringify(veto.factIds),
        contextId: veto.contextId,
        createdAt: veto.createdAt,
      })
      .run();
  }

  /**
   * **同步**版本（供 `db.transaction` 的同步回调使用）。
   *
   * drizzle 的 SQLite 事务回调是同步的 —— 在同步回调里 `await` 会直接编译失败。
   * 这也正好保证「检查与写入在同一个事务、同一段同步代码里」，
   * **不存在被让出执行权的并发窗口**。
   */
  findActiveBySubjectSync(input: {
    readonly accountId: string;
    readonly subject: AnalysisSubject;
  }): { readonly veto: RiskVeto; readonly override: RiskVetoOverride | null } | null {
    const rows = this.db
      .select()
      .from(riskVetoes)
      .where(
        and(
          eq(riskVetoes.accountId, input.accountId),
          eq(riskVetoes.subjectKind, input.subject.kind),
          eq(riskVetoes.subjectId, input.subject.id),
        ),
      )
      .orderBy(desc(riskVetoes.createdAt))
      .all();
    for (const row of rows) {
      const overrideRow = this.db
        .select()
        .from(riskVetoOverrides)
        .where(eq(riskVetoOverrides.vetoId, row.id))
        .get();
      if (overrideRow === undefined)
        return {
          veto: {
            id: row.id,
            accountId: row.accountId,
            subject: { kind: row.subjectKind as AnalysisSubject['kind'], id: row.subjectId },
            reason: row.reason,
            factIds: JSON.parse(row.factIdsJson) as string[],
            contextId: row.contextId,
            createdAt: row.createdAt,
          },
          override: null,
        };
    }
    return null;
  }

  async findActiveBySubject(input: {
    readonly accountId: string;
    readonly subject: AnalysisSubject;
  }): Promise<{ readonly veto: RiskVeto; readonly override: RiskVetoOverride | null } | null> {
    const rows = this.db
      .select()
      .from(riskVetoes)
      .where(
        and(
          eq(riskVetoes.accountId, input.accountId),
          eq(riskVetoes.subjectKind, input.subject.kind),
          eq(riskVetoes.subjectId, input.subject.id),
        ),
      )
      .orderBy(desc(riskVetoes.createdAt))
      .all();
    for (const row of rows) {
      const overrideRow = this.db
        .select()
        .from(riskVetoOverrides)
        .where(eq(riskVetoOverrides.vetoId, row.id))
        .get();
      if (overrideRow === undefined)
        return {
          veto: {
            id: row.id,
            accountId: row.accountId,
            subject: { kind: row.subjectKind as AnalysisSubject['kind'], id: row.subjectId },
            reason: row.reason,
            factIds: JSON.parse(row.factIdsJson) as string[],
            contextId: row.contextId,
            createdAt: row.createdAt,
          },
          override: null,
        };
    }
    return null;
  }

  async saveOverride(override: RiskVetoOverride): Promise<void> {
    this.db
      .insert(riskVetoOverrides)
      .values({
        id: override.id,
        vetoId: override.vetoId,
        overriddenBy: override.overriddenBy,
        reason: override.reason,
        newFactIdsJson: JSON.stringify(override.newFactIds),
        overriddenAt: override.overriddenAt,
      })
      .run();
  }
}
