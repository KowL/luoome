import { type Advice, STANDARD_DISCLAIMERS } from '@luoome/core';
import { describe, expect, it } from 'vitest';

import { buildMockContext } from '../context.js';
import { getAdviceTool } from './get-advice.js';

/** 永不过期的 advice（validUntil 2099，与真实时钟无关）。 */
const futureAdvice: Advice = {
  id: 'test-advice-future',
  subjectKind: 'stock',
  subjectId: '002594.SZ',
  decision: 'buy',
  confidence: 80,
  horizon: 'long',
  reasoning: { premise: '长期看多', evidence: ['e1'], counterEvidence: ['c1'] },
  risks: ['r1'],
  disclaimers: [...STANDARD_DISCLAIMERS],
  sourceTool: 'analyze_stock',
  basedOn: { dataAsOf: new Date('2020-06-01T00:00:00.000Z') },
  validFrom: new Date('2020-06-01T00:00:00.000Z'),
  validUntil: new Date('2099-01-01T00:00:00.000Z'),
  createdAt: new Date('2020-06-01T00:00:00.000Z'),
};

/** 早已过期的 advice（validUntil 2020，与真实时钟无关）。 */
const expiredAdvice: Advice = {
  ...futureAdvice,
  id: 'test-advice-expired',
  validFrom: new Date('2020-01-01T00:00:00.000Z'),
  validUntil: new Date('2020-01-02T00:00:00.000Z'),
  createdAt: new Date('2020-01-01T00:00:00.000Z'),
};

describe('get_advice', () => {
  it('正常路径：默认种子 2 条（includeExpired 显式开启，与真实时钟无关）', async () => {
    const ctx = await buildMockContext();
    const result = await getAdviceTool.execute({ includeExpired: true }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.total).toBe(2);
  });

  it('默认不含已过期；includeExpired=true 才返回过期 advice', async () => {
    const ctx = await buildMockContext({ advices: [futureAdvice, expiredAdvice] });

    const activeOnly = await getAdviceTool.execute({}, ctx);
    expect(activeOnly.ok).toBe(true);
    if (!activeOnly.ok) return;
    expect(activeOnly.data.total).toBe(1);
    expect(activeOnly.data.advices[0]?.id).toBe('test-advice-future');

    const withExpired = await getAdviceTool.execute({ includeExpired: true }, ctx);
    expect(withExpired.ok).toBe(true);
    if (!withExpired.ok) return;
    expect(withExpired.data.total).toBe(2);
  });

  it('filter：subjectId / decision / since', async () => {
    const ctx = await buildMockContext({ advices: [futureAdvice, expiredAdvice] });

    const bySubject = await getAdviceTool.execute(
      { subjectId: '600519.SH', includeExpired: true },
      ctx,
    );
    expect(bySubject.ok).toBe(true);
    if (!bySubject.ok) return;
    expect(bySubject.data.total).toBe(0);

    const byDecision = await getAdviceTool.execute({ decision: 'buy', includeExpired: true }, ctx);
    expect(byDecision.ok).toBe(true);
    if (!byDecision.ok) return;
    expect(byDecision.data.total).toBe(2);

    // since 作用于 createdAt：只保留 2020-06-01 的 future advice。
    const bySince = await getAdviceTool.execute(
      { since: '2020-05-01T00:00:00.000Z', includeExpired: true },
      ctx,
    );
    expect(bySince.ok).toBe(true);
    if (!bySince.ok) return;
    expect(bySince.data.total).toBe(1);
    expect(bySince.data.advices[0]?.id).toBe('test-advice-future');
  });

  it('错误路径：非法日期 → invalid_input', async () => {
    const ctx = await buildMockContext();
    const result = await getAdviceTool.execute({ since: 'not-a-date' }, ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('invalid_input');
  });

  it('错误路径：limit 越界 → invalid_input', async () => {
    const ctx = await buildMockContext();
    const result = await getAdviceTool.execute({ limit: 0 }, ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('invalid_input');
  });
});
