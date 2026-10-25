import {
  canClaimPluginOperation,
  type PluginAuthorityRepository,
  type PluginAutomationGrant,
  PluginAutomationGrantSchema,
  type PluginOperation,
  PluginOperationSchema,
  type PluginOperationScope,
  samePluginTask,
} from '@luoome/core';
import { and, eq, inArray } from 'drizzle-orm';
import type { DrizzleDatabase } from '../../database.js';
import type { Schema } from '../../schema/index.js';
import {
  pluginAutomationGrants as grants,
  pluginOperations as operations,
} from '../../schema/plugin-authority.js';

const scoped = (scope: PluginOperationScope) =>
  and(
    eq(operations.id, scope.id),
    eq(operations.userId, scope.userId),
    eq(operations.accountId, scope.accountId),
  );
const operationRow = (op: PluginOperation) => ({
  id: op.id,
  userId: op.userId,
  accountId: op.accountId,
  state: op.state,
  claimToken: op.claimToken,
  updatedAt: op.updatedAt,
  recordJson: op,
});
const grantRow = (grant: PluginAutomationGrant) => ({
  id: grant.id,
  ...grant.identity,
  version: grant.version,
  recordJson: grant,
});

export class DrizzlePluginAuthorityRepository implements PluginAuthorityRepository {
  constructor(private readonly db: DrizzleDatabase<Schema>) {}

  async insertOperation(value: PluginOperation) {
    const operation = PluginOperationSchema.parse(value);
    if (operation.state !== 'pending' || operation.resultJson !== null) return false;
    return (
      this.db
        .insert(operations)
        .values(operationRow(operation))
        .onConflictDoNothing()
        .returning()
        .get() !== undefined
    );
  }
  async findOperation(scope: PluginOperationScope) {
    const row = this.db.select().from(operations).where(scoped(scope)).get();
    return row ? PluginOperationSchema.parse(row.recordJson) : null;
  }
  async claimOperation(proof: Parameters<PluginAuthorityRepository['claimOperation']>[0]) {
    return this.db.transaction(
      (tx) => {
        const row = tx.select().from(operations).where(scoped(proof)).get();
        if (!row) return null;
        const op = PluginOperationSchema.parse(row.recordJson);
        const grant =
          op.authorization.kind === 'schedule'
            ? (tx.select().from(grants).where(eq(grants.id, op.authorization.grantId)).get()
                ?.recordJson ?? null)
            : null;
        if (!canClaimPluginOperation(op, proof, grant)) return null;
        const claimed = PluginOperationSchema.parse({
          ...op,
          state: 'executing',
          claimToken: proof.claimToken,
          updatedAt: proof.now,
        });
        const written = tx
          .update(operations)
          .set(operationRow(claimed))
          .where(and(scoped(proof), eq(operations.state, 'pending')))
          .returning()
          .get();
        return written !== undefined ? claimed : null;
      },
      { behavior: 'immediate' },
    );
  }
  async cancelOperation(proof: Parameters<PluginAuthorityRepository['cancelOperation']>[0]) {
    return this.db.transaction(
      (tx) => {
        const row = tx.select().from(operations).where(scoped(proof)).get();
        if (!row) return false;
        const op = PluginOperationSchema.parse(row.recordJson);
        const grant =
          op.authorization.kind === 'schedule'
            ? (tx.select().from(grants).where(eq(grants.id, op.authorization.grantId)).get()
                ?.recordJson ?? null)
            : null;
        if (!canClaimPluginOperation(op, proof, grant)) return false;
        const cancelled = PluginOperationSchema.parse({
          ...op,
          state: 'cancelled',
          updatedAt: proof.now,
        });
        return (
          tx
            .update(operations)
            .set(operationRow(cancelled))
            .where(and(scoped(proof), eq(operations.state, 'pending')))
            .returning()
            .get() !== undefined
        );
      },
      { behavior: 'immediate' },
    );
  }
  async settleOperation(input: Parameters<PluginAuthorityRepository['settleOperation']>[0]) {
    return this.db.transaction(
      (tx) => {
        const row = tx.select().from(operations).where(scoped(input)).get();
        if (
          !row ||
          row.claimToken !== input.claimToken ||
          !['executing', 'unknown'].includes(row.state) ||
          input.now < row.updatedAt
        )
          return false;
        const settled = PluginOperationSchema.parse({
          ...row.recordJson,
          state: input.state,
          resultJson: input.resultJson,
          updatedAt: input.now,
        });
        return (
          tx
            .update(operations)
            .set(operationRow(settled))
            .where(
              and(
                scoped(input),
                eq(operations.claimToken, input.claimToken),
                inArray(operations.state, ['executing', 'unknown']),
              ),
            )
            .returning()
            .get() !== undefined
        );
      },
      { behavior: 'immediate' },
    );
  }
  async findGrant(id: string, userId: string) {
    const row = this.db
      .select()
      .from(grants)
      .where(and(eq(grants.id, id), eq(grants.userId, userId)))
      .get();
    return row ? PluginAutomationGrantSchema.parse(row.recordJson) : null;
  }
  async saveGrant(value: PluginAutomationGrant, expectedVersion: number | null) {
    const grant = PluginAutomationGrantSchema.parse(value);
    return this.db.transaction(
      (tx) => {
        if (expectedVersion === null) {
          if (grant.version !== 1) return false;
          return (
            tx.insert(grants).values(grantRow(grant)).onConflictDoNothing().returning().get() !==
            undefined
          );
        }
        const old = tx.select().from(grants).where(eq(grants.id, grant.id)).get()?.recordJson;
        if (
          !old ||
          old.version !== expectedVersion ||
          grant.version !== expectedVersion + 1 ||
          !samePluginTask(old.identity, grant.identity) ||
          grant.createdAt !== old.createdAt ||
          grant.updatedAt < old.updatedAt
        )
          return false;
        return (
          tx
            .update(grants)
            .set(grantRow(grant))
            .where(and(eq(grants.id, grant.id), eq(grants.version, expectedVersion)))
            .returning()
            .get() !== undefined
        );
      },
      { behavior: 'immediate' },
    );
  }
}
