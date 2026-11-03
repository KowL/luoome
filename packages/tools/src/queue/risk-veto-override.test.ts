import { overrideCarriesNewEvidence, RiskVetoSchema } from '@luoome/core';
import { buildTestContext } from '@luoome/tools/testing';
import { describe, expect, it, vi } from 'vitest';

import { WORKFLOW_ONLY_TOOL_NAME_SET } from '../internal/workflow-only-tools.js';
import { toolRegistry } from '../registry.js';
import { overrideRiskVetoTool } from './override-risk-veto.js';

/**
 * REQ-M5-04 第二批：**升级路径**与三条「挡住」。
 */
const ACCOUNT = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';

const setup = async () => {
  const ctx = await buildTestContext({ clock: () => new Date('2026-07-29T10:00:00Z') });
  await ctx.repos.riskVeto.save(
    RiskVetoSchema.parse({
      id: 'veto-1',
      accountId: ACCOUNT,
      subject: { kind: 'stock', id: '600519.SH' },
      reason: '趋势已破坏',
      factIds: ['fact-a'],
      contextId: 'context-1',
      createdAt: new Date('2026-07-29T08:00:00Z'),
    }),
  );
  await ctx.repos.analysis.saveContext({
    id: 'new-context',
    jobId: null,
    kind: 'advice_stock',
    accountId: ACCOUNT,
    subject: { kind: 'stock', id: '600519.SH' },
    dataAsOf: ctx.clock(),
    facts: [
      { id: 'fact-a', label: '旧事实', value: 1, evidenceIds: [] },
      { id: 'fact-b', label: '新事实', value: 2, evidenceIds: [] },
    ],
    factIds: ['fact-a', 'fact-b'],
    limitations: [],
    missingFacts: [],
    contextHash: 'a'.repeat(64),
    createdAt: ctx.clock(),
    writeUntil: new Date(ctx.clock().getTime() + 60000),
    expiresAt: new Date(ctx.clock().getTime() + 86400000),
  });
  return {
    ...ctx,
    riskVetoOverrideAuthorization: {
      userId: ctx.user.id,
      accountId: ACCOUNT,
      vetoId: 'veto-1',
    },
  };
};

describe('override_risk_veto：必须带**新**证据', () => {
  it('model self-declared user without host authorization cannot clear a veto', async () => {
    const { riskVetoOverrideAuthorization: _authorization, ...ctx } = await setup();
    const result = await overrideRiskVetoTool.execute(
      {
        accountId: ACCOUNT,
        vetoId: 'veto-1',
        overriddenBy: 'user',
        evidenceContextId: 'new-context',
        reason: 'self-declared',
        newFactIds: ['fact-b'],
      },
      ctx,
    );
    expect(result.ok).toBe(false);
    expect(
      await ctx.repos.riskVeto.findActiveBySubject({
        accountId: ACCOUNT,
        subject: { kind: 'stock', id: '600519.SH' },
      }),
    ).not.toBeNull();
  });
  it('rejects empty new evidence without clearing the veto', async () => {
    const ctx = await setup();
    const result = await overrideRiskVetoTool.execute(
      {
        accountId: ACCOUNT,
        vetoId: 'veto-1',
        overriddenBy: 'user',
        evidenceContextId: 'new-context',
        reason: 'empty',
        newFactIds: [],
      },
      ctx,
    );
    expect(result.ok).toBe(false);
    expect(
      await ctx.repos.riskVeto.findActiveBySubject({
        accountId: ACCOUNT,
        subject: { kind: 'stock', id: '600519.SH' },
      }),
    ).not.toBeNull();
  });

  it('rejects fabricated evidence even with a valid human authorization', async () => {
    const ctx = await setup();
    const result = await overrideRiskVetoTool.execute(
      {
        accountId: ACCOUNT,
        vetoId: 'veto-1',
        overriddenBy: 'user',
        evidenceContextId: 'new-context',
        reason: 'fake evidence',
        newFactIds: ['invented-fact'],
      },
      ctx,
    );
    expect(result.ok).toBe(false);
    expect(
      await ctx.repos.riskVeto.findActiveBySubject({
        accountId: ACCOUNT,
        subject: { kind: 'stock', id: '600519.SH' },
      }),
    ).not.toBeNull();
  });

  it('rejects authorization bound to another account', async () => {
    const ctx = await setup();
    const result = await overrideRiskVetoTool.execute(
      {
        accountId: ACCOUNT,
        vetoId: 'veto-1',
        overriddenBy: 'user',
        evidenceContextId: 'new-context',
        reason: 'wrong account',
        newFactIds: ['fact-b'],
      },
      {
        ...ctx,
        riskVetoOverrideAuthorization: { ...ctx.riskVetoOverrideAuthorization, accountId: 'other' },
      },
    );
    expect(result.ok).toBe(false);
  });

  it('给出新证据 → 通过', async () => {
    const ctx = await setup();
    const result = await overrideRiskVetoTool.execute(
      {
        accountId: ACCOUNT,
        vetoId: 'veto-1',
        overriddenBy: 'user',
        evidenceContextId: 'new-context',
        reason: '看到新的产量数据',
        newFactIds: ['fact-b'],
      },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.acceptedNewFactIds).toEqual(['fact-b']);
  });

  it('**复述旧证据 → 拒绝**（「我不同意」不构成推翻理由）', async () => {
    const ctx = await setup();
    const result = await overrideRiskVetoTool.execute(
      {
        accountId: ACCOUNT,
        vetoId: 'veto-1',
        overriddenBy: 'user',
        evidenceContextId: 'new-context',
        reason: '我不同意',
        // 与 veto.factIds 完全相同 —— 这不是新证据
        newFactIds: ['fact-a'],
      },
      ctx,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid_input');
    expect('message' in result.error ? result.error.message : '').toContain('必须给出新证据');
  });

  it('新旧混合 → 通过，但只把**新**的那些记为 accepted', async () => {
    const ctx = await setup();
    const saved = vi.spyOn(ctx.repos.riskVeto, 'saveOverride');
    const result = await overrideRiskVetoTool.execute(
      {
        accountId: ACCOUNT,
        vetoId: 'veto-1',
        overriddenBy: 'user',
        evidenceContextId: 'new-context',
        reason: '补充数据',
        newFactIds: ['fact-a', 'fact-b'],
      },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.acceptedNewFactIds).toEqual(['fact-b']);
    expect(saved).toHaveBeenCalledWith(
      expect.objectContaining({
        actorUserId: ctx.user.id,
        evidenceContextId: 'new-context',
        newFactIds: ['fact-b'],
      }),
    );
  });

  it('否决不存在 → not_found', async () => {
    const ctx = await setup();
    const result = await overrideRiskVetoTool.execute(
      {
        accountId: ACCOUNT,
        vetoId: 'nope',
        overriddenBy: 'user',
        evidenceContextId: 'new-context',
        reason: 'x',
        newFactIds: ['f'],
      },
      {
        ...ctx,
        riskVetoOverrideAuthorization: { ...ctx.riskVetoOverrideAuthorization, vetoId: 'nope' },
      },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('not_found');
  });
});

describe('**agent 不可达**：不在 registry，在 workflow-only 名单里', () => {
  it('`toolRegistry` 不含 `override_risk_veto`', () => {
    const names = toolRegistry.all().map((tool) => tool.name);
    // 模型的可见工具集来自 registry ⇒ registry 不收它 ⇒ agent 没有这条路径
    expect(names).not.toContain('override_risk_veto');
  });

  it('它在 `WORKFLOW_ONLY_TOOL_NAME_SET` 里（有归属，不是「漏注册」）', () => {
    expect(WORKFLOW_ONLY_TOOL_NAME_SET.has('override_risk_veto')).toBe(true);
  });

  it('`overriddenBy` 只接受字面量 `user`（枚举，不是自由字符串）', () => {
    const parsed = overrideRiskVetoTool.inputSchema.safeParse({
      vetoId: 'v',
      overriddenBy: 'agent',
      reason: 'x',
      newFactIds: ['f'],
    });
    // agent 自称身份会被 schema 直接拒掉
    expect(parsed.success).toBe(false);
  });
});

describe('纯函数：overrideCarriesNewEvidence', () => {
  it('全新的证据 → true', () => {
    expect(overrideCarriesNewEvidence({ vetoFactIds: ['a'], newFactIds: ['b'] })).toBe(true);
  });
  it('**只有旧证据 → false**', () => {
    expect(overrideCarriesNewEvidence({ vetoFactIds: ['a'], newFactIds: ['a'] })).toBe(false);
  });
  it('空 → false（`newFactIds` 至少 1 条）', () => {
    expect(overrideCarriesNewEvidence({ vetoFactIds: ['a'], newFactIds: [] })).toBe(false);
  });
});
