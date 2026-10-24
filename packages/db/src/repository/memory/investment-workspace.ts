import {
  assertInvestmentConsensusAppend,
  assertInvestmentResearchInvariants,
  assertInvestmentTrackingClaim,
  assertInvestmentTrackingInvariants,
  InvariantError,
  type InvestmentConsensus,
  type InvestmentResearch,
  type InvestmentTracking,
  type InvestmentWorkspaceOwner,
  type InvestmentWorkspaceRepository,
} from '@luoome/core';

const owns = (item: InvestmentWorkspaceOwner, owner: InvestmentWorkspaceOwner): boolean =>
  item.ownerUserId === owner.ownerUserId && item.accountId === owner.accountId;
const copy = <T>(value: T): T => structuredClone(value);

export class InMemoryInvestmentWorkspaceRepository implements InvestmentWorkspaceRepository {
  private readonly research = new Map<string, InvestmentResearch>();
  private readonly consensus: InvestmentConsensus[] = [];
  private readonly receipts: {
    owner: InvestmentWorkspaceOwner;
    requestId: string;
    requestHash: string;
    consensus: InvestmentConsensus;
  }[] = [];
  private readonly tracking = new Map<string, InvestmentTracking>();

  async createResearch(value: InvestmentResearch): Promise<InvestmentResearch> {
    return this.createResearchSync(value);
  }

  createResearchSync(value: InvestmentResearch): InvestmentResearch {
    assertInvestmentResearchInvariants(value);
    const existing = [...this.research.values()].find(
      (item) => owns(item, value) && item.requestId === value.requestId,
    );
    if (existing !== undefined) {
      if (existing.requestHash !== value.requestHash)
        throw new InvariantError('request_id_conflict');
      return copy(existing);
    }
    if (this.research.has(value.id)) throw new InvariantError('duplicate research id');
    this.research.set(value.id, copy(value));
    return copy(value);
  }

  async findResearch(
    input: Parameters<InvestmentWorkspaceRepository['findResearch']>[0],
  ): Promise<InvestmentResearch | null> {
    const item = [...this.research.values()].find(
      (value) =>
        owns(value, input) &&
        (input.id === undefined || value.id === input.id) &&
        (input.requestId === undefined || value.requestId === input.requestId),
    );
    return item === undefined ? null : copy(item);
  }

  async listResearch(
    input: InvestmentWorkspaceOwner & { readonly limit: number },
  ): Promise<readonly InvestmentResearch[]> {
    return [...this.research.values()]
      .filter((item) => owns(item, input))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id))
      .slice(0, input.limit)
      .map(copy);
  }

  async listConsensus(
    input: InvestmentWorkspaceOwner & { readonly limit: number },
  ): Promise<readonly InvestmentConsensus[]> {
    return this.consensus
      .filter((item) => owns(item, input))
      .sort((a, b) => b.version - a.version)
      .slice(0, input.limit)
      .map(copy);
  }

  async findConsensusReceipt(input: InvestmentWorkspaceOwner & { readonly requestId: string }) {
    const receipt = this.receipts.find(
      (item) => owns(item.owner, input) && item.requestId === input.requestId,
    );
    return receipt === undefined
      ? null
      : copy({ requestHash: receipt.requestHash, consensus: receipt.consensus });
  }

  async commitConsensus(input: Parameters<InvestmentWorkspaceRepository['commitConsensus']>[0]) {
    const owner = input.consensus;
    const receipt = this.receipts.find(
      (item) => owns(item.owner, owner) && item.requestId === input.requestId,
    );
    if (receipt !== undefined) {
      if (receipt.requestHash !== input.requestHash)
        throw new InvariantError('request_id_conflict');
      return { consensus: copy(receipt.consensus), replayed: true };
    }
    const current =
      this.consensus.filter((item) => owns(item, owner)).sort((a, b) => b.version - a.version)[0] ??
      null;
    assertInvestmentConsensusAppend(
      current,
      owner,
      input.expectedVersion,
      [...this.tracking.values()].some((item) => owns(item, owner) && item.status === 'starting'),
    );
    if (this.consensus.some((item) => item.id === owner.id))
      throw new InvariantError('duplicate consensus id');
    this.consensus.push(copy(owner));
    this.receipts.push(
      copy({ owner, requestId: input.requestId, requestHash: input.requestHash, consensus: owner }),
    );
    return { consensus: copy(owner), replayed: false };
  }

  async listTracking(input: InvestmentWorkspaceOwner): Promise<readonly InvestmentTracking[]> {
    return [...this.tracking.values()]
      .reverse()
      .filter((item) => owns(item, input))
      .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())
      .map(copy);
  }

  async claimTracking(input: InvestmentTracking) {
    const rows = [...this.tracking.values()].filter((item) => owns(item, input));
    const existing = rows.find((item) => item.requestId === input.requestId);
    if (existing !== undefined) {
      if (existing.requestHash !== input.requestHash)
        throw new InvariantError('request_id_conflict');
      return { tracking: copy(existing), replayed: true };
    }
    const current =
      this.consensus.filter((item) => owns(item, input)).sort((a, b) => b.version - a.version)[0] ??
      null;
    assertInvestmentTrackingClaim(
      current,
      input,
      rows.some((item) => item.status === 'starting'),
    );
    if (this.tracking.has(input.id)) throw new InvariantError('duplicate tracking id');
    this.tracking.set(input.id, copy(input));
    return { tracking: copy(input), replayed: false };
  }

  async finishTracking(value: InvestmentTracking): Promise<void> {
    assertInvestmentTrackingInvariants(value);
    const current = this.tracking.get(value.id);
    if (
      current === undefined ||
      !owns(current, value) ||
      current.status !== 'starting' ||
      current.requestHash !== value.requestHash ||
      current.consensusVersion !== value.consensusVersion ||
      current.action !== value.action ||
      current.requestId !== value.requestId ||
      value.status === 'starting'
    ) {
      throw new InvariantError('tracking_claim_conflict');
    }
    this.tracking.set(value.id, copy(value));
  }
}
