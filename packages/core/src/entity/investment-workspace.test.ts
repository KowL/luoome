import { describe, expect, it } from 'vitest';
import { STANDARD_DISCLAIMERS } from './advice.js';
import {
  assertInvestmentConsensusInvariants,
  assertInvestmentResearchInvariants,
  InvestmentConsensusSchema,
  InvestmentResearchSchema,
  investmentConsensusState,
  investmentEvidenceValidUntil,
  investmentMarketEvidenceValidUntil,
  investmentResearchEnabled,
  isInvestmentEvidenceCurrent,
  isInvestmentMarketEvidenceCurrent,
} from './investment-workspace.js';

const now = new Date('2026-10-16T08:00:00Z');
const consensus = () =>
  InvestmentConsensusSchema.parse({
    id: 'confirmed-one',
    ownerUserId: 'owner',
    accountId: 'account',
    version: 1,
    supersedesId: null,
    status: 'confirmed',
    selections: [],
    constraints: [],
    recentIntent: null,
    source: { userText: '确认仅用于研究' },
    changeNote: '用户确认',
    effectScope: 'future-research-only',
    reviewAt: new Date('2026-10-22T08:00:00Z'),
    validUntil: new Date('2026-10-23T08:00:00Z'),
    createdAt: now,
  });
const research = () =>
  InvestmentResearchSchema.parse({
    id: 'research-one',
    ownerUserId: 'owner',
    accountId: 'account',
    requestId: 'request-one',
    requestHash: 'hash',
    question: '比较方向',
    status: 'complete',
    source: { userText: '比较方向' },
    createdAt: now,
    evidence: [
      {
        id: 'real-fact',
        strategyId: 'strategy-one',
        strategyVersionId: 'version-one',
        runId: 'run-one',
        dataAsOf: now,
        kind: 'coverage',
        text: '明确仅覆盖两只股票',
      },
    ],
    directions: [
      {
        id: 'direction-one',
        strategyId: 'strategy-one',
        strategyVersionId: 'version-one',
        runId: 'run-one',
        name: '研究方向',
        opportunityType: 'strategy-selection',
        coverage: {
          kind: 'explicit-subset',
          universeCount: 2,
          evaluatedCount: 2,
          selectedCount: 1,
          dataHealth: 'complete',
          description: '显式子集',
        },
        rank: 1,
        stance: 'observe',
        rationale: '先观察',
        comparisonReason: '只有覆盖事实，不支持收益排序',
        evidenceIds: ['real-fact'],
        objections: [
          {
            kind: 'missing-evidence',
            conclusion: '不支持买入',
            evidenceIds: [],
            risks: ['缺账户事实'],
            unknowns: ['账户完整性'],
            reconsiderWhen: ['补齐账户事实'],
            alternatives: ['继续观察'],
          },
        ],
        risks: ['不确定'],
        waitFor: ['补充事实'],
        abandonWhen: ['规则变化'],
        reviewWhen: ['事实更新'],
        horizon: 'short',
        accountFit: 'research-only',
        dataAsOf: now,
        validUntil: investmentEvidenceValidUntil(now),
      },
    ],
    limitations: ['不能外推全市场'],
    disclaimers: [...STANDARD_DISCLAIMERS],
  });

describe('investment workspace invariants', () => {
  it('expires intraday market observations independently of fetch time and carries closing facts only to the next open', () => {
    const intraday = new Date('2026-10-16T02:00:00Z');
    expect(investmentMarketEvidenceValidUntil(intraday)).toEqual(new Date('2026-10-16T02:20:00Z'));
    expect(isInvestmentMarketEvidenceCurrent(intraday, new Date('2026-10-16T02:19:59Z'))).toBe(
      true,
    );
    expect(isInvestmentMarketEvidenceCurrent(intraday, new Date('2026-10-16T02:20:00Z'))).toBe(
      false,
    );
    expect(investmentMarketEvidenceValidUntil(new Date('2026-10-16T06:55:00Z'))).toEqual(
      new Date('2026-10-16T07:00:00Z'),
    );
    const closing = new Date('2026-10-16T07:00:00Z');
    expect(investmentMarketEvidenceValidUntil(closing)).toEqual(new Date('2026-10-19T01:30:00Z'));
    expect(isInvestmentMarketEvidenceCurrent(closing, new Date('2026-10-19T01:30:00Z'))).toBe(
      false,
    );
  });

  it('uses the next trading day Shanghai cutoff and never treats future or holiday facts as current', () => {
    expect(investmentEvidenceValidUntil(now)).toEqual(new Date('2026-10-19T08:30:00Z'));
    expect(isInvestmentEvidenceCurrent(now, new Date('2026-10-19T08:29:59Z'))).toBe(true);
    expect(isInvestmentEvidenceCurrent(now, new Date('2026-10-19T08:30:00Z'))).toBe(false);
    expect(isInvestmentEvidenceCurrent(new Date('2026-10-19T08:00:00Z'), now)).toBe(false);
    expect(
      isInvestmentEvidenceCurrent(
        new Date('2026-10-01T08:00:00Z'),
        new Date('2026-10-02T08:00:00Z'),
      ),
    ).toBe(false);
  });

  it('requires real same-strategy references and standard disclaimers', () => {
    expect(() => assertInvestmentResearchInvariants(research())).not.toThrow();
    const fabricated = research();
    if (fabricated.directions[0] === undefined) throw new Error('fixture');
    fabricated.directions[0].evidenceIds = ['made-up'];
    expect(() => assertInvestmentResearchInvariants(fabricated)).toThrow(
      'missing or foreign evidence',
    );
    const foreign = research();
    if (foreign.evidence[0] === undefined || !('strategyId' in foreign.evidence[0]))
      throw new Error('fixture');
    foreign.evidence[0].strategyId = 'other-strategy';
    expect(() => assertInvestmentResearchInvariants(foreign)).toThrow(
      'missing or foreign evidence',
    );
    expect(() =>
      assertInvestmentResearchInvariants({ ...research(), disclaimers: ['incomplete'] }),
    ).toThrow('standard disclaimers');
  });

  it('requires facts for known risks and confirmed consensus evidence for plan conflicts', () => {
    const value = research();
    const objection = value.directions[0]?.objections[0];
    if (objection === undefined) throw new Error('fixture');
    objection.kind = 'known-risk';
    expect(() => assertInvestmentResearchInvariants(value)).toThrow('known risk requires');
    objection.evidenceIds = ['real-fact'];
    objection.kind = 'plan-conflict';
    expect(() => assertInvestmentResearchInvariants(value)).toThrow('plan conflict requires');
  });

  it('keeps expiration, review and temporary intention separate from a confirmed record', () => {
    const value = consensus();
    expect(investmentConsensusState(value, now)).toBe('confirmed');
    expect(investmentResearchEnabled(value, now)).toBe(true);
    value.recentIntent = {
      mode: 'pause-new-opportunities',
      note: '先管理持仓',
      startsAt: now,
      reviewAt: new Date('2026-10-19T08:00:00Z'),
    };
    expect(investmentResearchEnabled(value, now)).toBe(false);
    expect(investmentConsensusState(value, new Date('2026-10-19T08:00:00Z'))).toBe(
      'review-required',
    );
    expect(investmentResearchEnabled(value, new Date('2026-10-19T08:00:00Z'))).toBe(false);
    expect(investmentConsensusState(value, value.validUntil)).toBe('expired');
    expect(investmentConsensusState({ ...value, status: 'revoked' }, now)).toBe('revoked');
  });

  it('rejects invalid version chains and reversed intent/review times', () => {
    expect(() => assertInvestmentConsensusInvariants({ ...consensus(), version: 2 })).toThrow(
      'version chain',
    );
    expect(() =>
      assertInvestmentConsensusInvariants({ ...consensus(), reviewAt: new Date('2026-11-01') }),
    ).toThrow('review/expiry');
    expect(() =>
      assertInvestmentConsensusInvariants({
        ...consensus(),
        recentIntent: { mode: 'cautious', note: '谨慎', startsAt: now, reviewAt: now },
      }),
    ).toThrow('reviewAt');
  });
});
