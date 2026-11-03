import { type AnalysisContext, RiskVetoSchema } from '@luoome/core';
import { describe, expect, it } from 'vitest';

import { createInMemoryRepos } from './memory/index.js';

/** Risk-veto lookup controls; actual Advice/publication write fencing is tested in analysis.contract.test.ts. */
const ACCOUNT = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';

describe('风险否决检索判据', () => {
  it('`findActiveBySubject` 返回否决 ⇒ 调用方据此拒绝（判据本身正确）', async () => {
    const repos = createInMemoryRepos();
    await repos.riskVeto.save(
      RiskVetoSchema.parse({
        id: 'v1',
        accountId: ACCOUNT,
        subject: { kind: 'stock', id: '600519.SH' },
        reason: '趋势破坏',
        factIds: ['f1'],
        contextId: 'c1',
        createdAt: new Date('2026-07-29T08:00:00Z'),
      }),
    );
    const context = {
      accountId: ACCOUNT,
      subject: { kind: 'stock', id: '600519.SH' },
    } as AnalysisContext;
    const active = await repos.riskVeto.findActiveBySubject({
      accountId: context.accountId,
      subject: context.subject,
    });
    // 这条是写入前拒绝的**唯一判据**：非 null 即拒绝
    expect(active).not.toBeNull();
    expect(active?.veto.reason).toBe('趋势破坏');
  });

  it('override 之后判据放行（同一个 key 再查为 null）', async () => {
    const repos = createInMemoryRepos();
    await repos.riskVeto.save(
      RiskVetoSchema.parse({
        id: 'v1',
        accountId: ACCOUNT,
        subject: { kind: 'stock', id: '600519.SH' },
        reason: '趋势破坏',
        factIds: ['f1'],
        contextId: 'c1',
        createdAt: new Date('2026-07-29T08:00:00Z'),
      }),
    );
    await repos.riskVeto.saveOverride({
      id: 'o1',
      vetoId: 'v1',
      overriddenBy: 'user',
      reason: '新数据',
      newFactIds: ['f2'],
      overriddenAt: new Date('2026-07-29T09:00:00Z'),
    });
    expect(
      await repos.riskVeto.findActiveBySubject({
        accountId: ACCOUNT,
        subject: { kind: 'stock', id: '600519.SH' },
      }),
    ).toBeNull();
  });
});
