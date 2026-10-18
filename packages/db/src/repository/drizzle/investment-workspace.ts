import {
  assertInvestmentConsensusAppend,
  assertInvestmentResearchInvariants,
  assertInvestmentTrackingClaim,
  assertInvestmentTrackingInvariants,
  InvariantError,
  type InvestmentConsensus,
  InvestmentConsensusSchema,
  type InvestmentResearch,
  InvestmentResearchSchema,
  type InvestmentTracking,
  InvestmentTrackingSchema,
  type InvestmentWorkspaceOwner,
  type InvestmentWorkspaceRepository,
} from '@luoome/core';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { DrizzleDb } from '../../client.js';
import { investmentConsensus, investmentResearch, investmentTracking } from '../../schema/index.js';

const researchOwner = (owner: InvestmentWorkspaceOwner) =>
  and(
    eq(investmentResearch.ownerUserId, owner.ownerUserId),
    eq(investmentResearch.accountId, owner.accountId),
  );
const consensusOwner = (owner: InvestmentWorkspaceOwner) =>
  and(
    eq(investmentConsensus.ownerUserId, owner.ownerUserId),
    eq(investmentConsensus.accountId, owner.accountId),
  );
const trackingOwner = (owner: InvestmentWorkspaceOwner) =>
  and(
    eq(investmentTracking.ownerUserId, owner.ownerUserId),
    eq(investmentTracking.accountId, owner.accountId),
  );

export class DrizzleInvestmentWorkspaceRepository implements InvestmentWorkspaceRepository {
  constructor(private readonly db: DrizzleDb) {}

  async createResearch(value: InvestmentResearch): Promise<InvestmentResearch> {
    assertInvestmentResearchInvariants(value);
    return this.db.transaction(
      (tx) => {
        const existing = tx
          .select()
          .from(investmentResearch)
          .where(and(researchOwner(value), eq(investmentResearch.requestId, value.requestId)))
          .get();
        if (existing !== undefined) {
          if (existing.requestHash !== value.requestHash)
            throw new InvariantError('request_id_conflict');
          return InvestmentResearchSchema.parse(JSON.parse(existing.payloadJson));
        }
        tx.insert(investmentResearch)
          .values({
            id: value.id,
            ownerUserId: value.ownerUserId,
            accountId: value.accountId,
            requestId: value.requestId,
            requestHash: value.requestHash,
            createdAt: value.createdAt,
            payloadJson: JSON.stringify(value),
          })
          .run();
        return value;
      },
      { behavior: 'immediate' },
    );
  }

  async findResearch(
    input: Parameters<InvestmentWorkspaceRepository['findResearch']>[0],
  ): Promise<InvestmentResearch | null> {
    const row = this.db
      .select()
      .from(investmentResearch)
      .where(
        and(
          researchOwner(input),
          input.id === undefined ? undefined : eq(investmentResearch.id, input.id),
          input.requestId === undefined
            ? undefined
            : eq(investmentResearch.requestId, input.requestId),
        ),
      )
      .get();
    return row === undefined ? null : InvestmentResearchSchema.parse(JSON.parse(row.payloadJson));
  }

  async listResearch(
    input: InvestmentWorkspaceOwner & { readonly limit: number },
  ): Promise<readonly InvestmentResearch[]> {
    return this.db
      .select()
      .from(investmentResearch)
      .where(researchOwner(input))
      .orderBy(desc(investmentResearch.createdAt), desc(investmentResearch.id))
      .limit(input.limit)
      .all()
      .map((row) => InvestmentResearchSchema.parse(JSON.parse(row.payloadJson)));
  }

  async listConsensus(
    input: InvestmentWorkspaceOwner & { readonly limit: number },
  ): Promise<readonly InvestmentConsensus[]> {
    return this.db
      .select()
      .from(investmentConsensus)
      .where(consensusOwner(input))
      .orderBy(desc(investmentConsensus.version))
      .limit(input.limit)
      .all()
      .map((row) => InvestmentConsensusSchema.parse(JSON.parse(row.payloadJson)));
  }

  async findConsensusReceipt(input: InvestmentWorkspaceOwner & { readonly requestId: string }) {
    const row = this.db
      .select()
      .from(investmentConsensus)
      .where(and(consensusOwner(input), eq(investmentConsensus.requestId, input.requestId)))
      .get();
    return row === undefined
      ? null
      : {
          requestHash: row.requestHash,
          consensus: InvestmentConsensusSchema.parse(JSON.parse(row.payloadJson)),
        };
  }

  async commitConsensus(input: Parameters<InvestmentWorkspaceRepository['commitConsensus']>[0]) {
    const value = input.consensus;
    return this.db.transaction(
      (tx) => {
        const receipt = tx
          .select()
          .from(investmentConsensus)
          .where(and(consensusOwner(value), eq(investmentConsensus.requestId, input.requestId)))
          .get();
        if (receipt !== undefined) {
          if (receipt.requestHash !== input.requestHash)
            throw new InvariantError('request_id_conflict');
          return {
            consensus: InvestmentConsensusSchema.parse(JSON.parse(receipt.payloadJson)),
            replayed: true,
          };
        }
        const latest = tx
          .select()
          .from(investmentConsensus)
          .where(consensusOwner(value))
          .orderBy(desc(investmentConsensus.version))
          .get();
        const starting = tx
          .select()
          .from(investmentTracking)
          .where(and(trackingOwner(value), eq(investmentTracking.status, 'starting')))
          .get();
        assertInvestmentConsensusAppend(
          latest === undefined
            ? null
            : InvestmentConsensusSchema.parse(JSON.parse(latest.payloadJson)),
          value,
          input.expectedVersion,
          starting !== undefined,
        );
        tx.insert(investmentConsensus)
          .values({
            id: value.id,
            ownerUserId: value.ownerUserId,
            accountId: value.accountId,
            version: value.version,
            requestId: input.requestId,
            requestHash: input.requestHash,
            payloadJson: JSON.stringify(value),
            createdAt: value.createdAt,
          })
          .run();
        return { consensus: value, replayed: false };
      },
      { behavior: 'immediate' },
    );
  }

  async listTracking(input: InvestmentWorkspaceOwner): Promise<readonly InvestmentTracking[]> {
    return this.db
      .select()
      .from(investmentTracking)
      .where(trackingOwner(input))
      .orderBy(desc(investmentTracking.startedAt), desc(sql`rowid`))
      .all()
      .map((row) => InvestmentTrackingSchema.parse(JSON.parse(row.payloadJson)));
  }

  async claimTracking(value: InvestmentTracking) {
    return this.db.transaction(
      (tx) => {
        const existing = tx
          .select()
          .from(investmentTracking)
          .where(and(trackingOwner(value), eq(investmentTracking.requestId, value.requestId)))
          .get();
        if (existing !== undefined) {
          if (existing.requestHash !== value.requestHash)
            throw new InvariantError('request_id_conflict');
          return {
            tracking: InvestmentTrackingSchema.parse(JSON.parse(existing.payloadJson)),
            replayed: true,
          };
        }
        const latest = tx
          .select()
          .from(investmentConsensus)
          .where(consensusOwner(value))
          .orderBy(desc(investmentConsensus.version))
          .get();
        const starting = tx
          .select()
          .from(investmentTracking)
          .where(and(trackingOwner(value), eq(investmentTracking.status, 'starting')))
          .get();
        assertInvestmentTrackingClaim(
          latest === undefined
            ? null
            : InvestmentConsensusSchema.parse(JSON.parse(latest.payloadJson)),
          value,
          starting !== undefined,
        );
        tx.insert(investmentTracking)
          .values({
            id: value.id,
            ownerUserId: value.ownerUserId,
            accountId: value.accountId,
            requestId: value.requestId,
            requestHash: value.requestHash,
            status: value.status,
            payloadJson: JSON.stringify(value),
            startedAt: value.startedAt,
          })
          .run();
        return { tracking: value, replayed: false };
      },
      { behavior: 'immediate' },
    );
  }

  async finishTracking(value: InvestmentTracking): Promise<void> {
    assertInvestmentTrackingInvariants(value);
    this.db.transaction(
      (tx) => {
        const row = tx
          .select()
          .from(investmentTracking)
          .where(and(trackingOwner(value), eq(investmentTracking.id, value.id)))
          .get();
        const current =
          row === undefined ? null : InvestmentTrackingSchema.parse(JSON.parse(row.payloadJson));
        if (
          current === null ||
          current.status !== 'starting' ||
          current.requestHash !== value.requestHash ||
          current.consensusVersion !== value.consensusVersion ||
          current.action !== value.action ||
          current.requestId !== value.requestId ||
          value.status === 'starting'
        )
          throw new InvariantError('tracking_claim_conflict');
        tx.update(investmentTracking)
          .set({ status: value.status, payloadJson: JSON.stringify(value) })
          .where(eq(investmentTracking.id, value.id))
          .run();
      },
      { behavior: 'immediate' },
    );
  }
}
