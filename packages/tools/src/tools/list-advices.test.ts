import { type Advice, STANDARD_DISCLAIMERS } from '@luoome/core';
import { buildTestContext } from '@luoome/tools/testing';
import { describe, expect, it } from 'vitest';

import { listAdvicesTool } from './list-advices.js';

const now = new Date('2026-07-29T00:45:00.000Z');

const advice = (overrides: Partial<Advice> = {}): Advice => ({
  id: 'advice-1',
  subjectKind: 'portfolio',
  subjectId: 'account-a',
  decision: 'hold',
  confidence: 60,
  horizon: 'short',
  reasoning: { premise: 'p', evidence: ['e'], counterEvidence: ['c'] },
  risks: ['r'],
  disclaimers: [...STANDARD_DISCLAIMERS],
  basedOn: { dataAsOf: now },
  validFrom: now,
  validUntil: new Date('2026-08-05T00:00:00.000Z'),
  createdAt: now,
  ...overrides,
});

describe('list_advices', () => {
  it('lists only the current account’s advice and keeps validity plus counter-evidence', async () => {
    const base = await buildTestContext({ clock: () => now, advices: [] });
    const accountId = base.user.defaultAccountId;
    const mine = advice({ id: 'mine', subjectId: accountId });
    const other = advice({ id: 'other', subjectId: 'account-b' });
    const scoped = await buildTestContext({ clock: () => now, advices: [mine, other] });
    const result = await listAdvicesTool.execute({}, scoped);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.advices.map((item) => item.id)).toEqual(['mine']);
    expect(result.data.advices[0]?.validUntil.toISOString()).toBe('2026-08-05T00:00:00.000Z');
    expect(result.data.advices[0]?.counterEvidence).toEqual(['c']);
    expect(result.data.missingCounterEvidenceIds).toEqual([]);
  });

  it('口径诚实化：description 明写按账户归属过滤，输出 scope 恒为 account', async () => {
    expect(listAdvicesTool.description).toContain('按账户归属过滤');
    expect(listAdvicesTool.description).toContain('get_advice');

    const ctx = await buildTestContext({ clock: () => now, advices: [] });
    const result = await listAdvicesTool.execute({}, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.scope).toBe('account');
  });

  it('flags advice without counter-evidence instead of inventing one', async () => {
    const base = await buildTestContext({ clock: () => now, advices: [] });
    const accountId = base.user.defaultAccountId;
    const ctx = await buildTestContext({
      clock: () => now,
      advices: [
        advice({
          id: 'no-counter',
          subjectId: accountId,
          reasoning: { premise: 'p', evidence: ['e'], counterEvidence: [] },
        }),
      ],
    });
    const result = await listAdvicesTool.execute({}, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.advices[0]?.counterEvidence).toEqual([]);
    expect(result.data.advices[0]?.counterEvidenceMissing).toBe(true);
    expect(result.data.missingCounterEvidenceIds).toEqual(['no-counter']);
  });

  it('drops expired advice by default and keeps it with includeExpired', async () => {
    const base = await buildTestContext({ clock: () => now, advices: [] });
    const accountId = base.user.defaultAccountId;
    const ctx = await buildTestContext({
      clock: () => now,
      advices: [
        advice({
          id: 'expired',
          subjectId: accountId,
          validFrom: new Date('2026-06-01T00:00:00.000Z'),
          validUntil: new Date('2026-07-01T00:00:00.000Z'),
        }),
      ],
    });
    const hidden = await listAdvicesTool.execute({}, ctx);
    expect(hidden.ok && hidden.data.advices).toEqual([]);
    const shown = await listAdvicesTool.execute({ includeExpired: true }, ctx);
    expect(shown.ok && shown.data.advices.map((item) => item.id)).toEqual(['expired']);
  });

  it('returns not_found for an unknown account', async () => {
    const ctx = await buildTestContext({ clock: () => now });
    const result = await listAdvicesTool.execute({ accountId: 'missing-account' }, ctx);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('not_found');
  });
});
