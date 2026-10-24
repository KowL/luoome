import {
  canClaimPluginOperation,
  type PluginAuthorityRepository,
  type PluginAutomationGrant,
  PluginAutomationGrantSchema,
  type PluginOperation,
  PluginOperationSchema,
  samePluginTask,
} from '@luoome/core';

export class InMemoryPluginAuthorityRepository implements PluginAuthorityRepository {
  private readonly operations = new Map<string, PluginOperation>();
  private readonly grants = new Map<string, PluginAutomationGrant>();

  async insertOperation(value: PluginOperation) {
    const operation = PluginOperationSchema.parse(value);
    if (
      operation.state !== 'pending' ||
      operation.resultJson !== null ||
      this.operations.has(operation.id)
    )
      return false;
    this.operations.set(operation.id, operation);
    return true;
  }
  async findOperation(scope: Parameters<PluginAuthorityRepository['findOperation']>[0]) {
    const op = this.operations.get(scope.id);
    return op?.userId === scope.userId && op.accountId === scope.accountId
      ? structuredClone(op)
      : null;
  }
  async claimOperation(proof: Parameters<PluginAuthorityRepository['claimOperation']>[0]) {
    const op = this.operations.get(proof.id);
    const grant =
      op?.authorization.kind === 'schedule'
        ? (this.grants.get(op.authorization.grantId) ?? null)
        : null;
    if (!op || !canClaimPluginOperation(op, proof, grant)) return null;
    const claimed = PluginOperationSchema.parse({
      ...op,
      state: 'executing',
      claimToken: proof.claimToken,
      updatedAt: proof.now,
    });
    this.operations.set(op.id, claimed);
    return structuredClone(claimed);
  }
  async cancelOperation(proof: Parameters<PluginAuthorityRepository['cancelOperation']>[0]) {
    const op = this.operations.get(proof.id);
    const grant =
      op?.authorization.kind === 'schedule'
        ? (this.grants.get(op.authorization.grantId) ?? null)
        : null;
    if (!op || !canClaimPluginOperation(op, proof, grant)) return false;
    this.operations.set(
      op.id,
      PluginOperationSchema.parse({ ...op, state: 'cancelled', updatedAt: proof.now }),
    );
    return true;
  }
  async settleOperation(input: Parameters<PluginAuthorityRepository['settleOperation']>[0]) {
    const op = this.operations.get(input.id);
    if (
      !op ||
      op.userId !== input.userId ||
      op.accountId !== input.accountId ||
      op.claimToken !== input.claimToken ||
      !['executing', 'unknown'].includes(op.state) ||
      input.now < op.updatedAt
    )
      return false;
    this.operations.set(
      op.id,
      PluginOperationSchema.parse({
        ...op,
        state: input.state,
        resultJson: input.resultJson,
        updatedAt: input.now,
      }),
    );
    return true;
  }
  async findGrant(id: string, userId: string) {
    const grant = this.grants.get(id);
    return grant?.identity.userId === userId ? structuredClone(grant) : null;
  }
  async saveGrant(value: PluginAutomationGrant, expectedVersion: number | null) {
    const grant = PluginAutomationGrantSchema.parse(value);
    const old = this.grants.get(grant.id);
    if (expectedVersion === null) {
      if (
        old ||
        grant.version !== 1 ||
        [...this.grants.values()].some((g) => samePluginTask(g.identity, grant.identity))
      )
        return false;
    } else if (
      !old ||
      old.version !== expectedVersion ||
      grant.version !== expectedVersion + 1 ||
      !samePluginTask(old.identity, grant.identity) ||
      grant.createdAt !== old.createdAt ||
      grant.updatedAt < old.updatedAt
    )
      return false;
    this.grants.set(grant.id, grant);
    return true;
  }
}
