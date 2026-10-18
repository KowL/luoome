import type {
  InvestmentConsensus,
  InvestmentResearch,
  InvestmentTracking,
} from '../entity/investment-workspace.js';

export interface InvestmentWorkspaceOwner {
  readonly ownerUserId: string;
  readonly accountId: string;
}

export interface InvestmentWorkspaceRepository {
  createResearch(research: InvestmentResearch): Promise<InvestmentResearch>;
  findResearch(
    input: InvestmentWorkspaceOwner & { readonly id?: string; readonly requestId?: string },
  ): Promise<InvestmentResearch | null>;
  listResearch(
    input: InvestmentWorkspaceOwner & { readonly limit: number },
  ): Promise<readonly InvestmentResearch[]>;
  listConsensus(
    input: InvestmentWorkspaceOwner & { readonly limit: number },
  ): Promise<readonly InvestmentConsensus[]>;
  findConsensusReceipt(
    input: InvestmentWorkspaceOwner & { readonly requestId: string },
  ): Promise<{ readonly requestHash: string; readonly consensus: InvestmentConsensus } | null>;
  commitConsensus(input: {
    readonly consensus: InvestmentConsensus;
    readonly expectedVersion: number;
    readonly requestId: string;
    readonly requestHash: string;
  }): Promise<{ readonly consensus: InvestmentConsensus; readonly replayed: boolean }>;
  listTracking(input: InvestmentWorkspaceOwner): Promise<readonly InvestmentTracking[]>;
  claimTracking(
    input: InvestmentTracking,
  ): Promise<{ readonly tracking: InvestmentTracking; readonly replayed: boolean }>;
  finishTracking(tracking: InvestmentTracking): Promise<void>;
}
