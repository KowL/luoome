import { type Advice, STANDARD_DISCLAIMERS } from '@luoome/core';
import { describe, expect, it } from 'vitest';

import { buildTestContext } from '../testing/context.js';
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
    const ctx = await buildTestContext();
    const result = await getAdviceTool.execute({ includeExpired: true }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.total).toBe(2);
  });

  it('默认不含已过期；includeExpired=true 才返回过期 advice', async () => {
    const ctx = await buildTestContext({ advices: [futureAdvice, expiredAdvice] });

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

  it('过期过滤使用注入 clock，而不是真实时钟', async () => {
    // clock 在 validUntil 之前、真实时钟在之后：默认仍应返回（旧实现会被仓库真实时钟过滤）。
    const beforeExpiry = await buildTestContext({
      clock: () => new Date('2020-06-01T12:00:00.000Z'),
      advices: [
        {
          ...futureAdvice,
          id: 'test-advice-clock-before',
          validUntil: new Date('2020-06-02T00:00:00.000Z'),
        },
      ],
    });
    const included = await getAdviceTool.execute({}, beforeExpiry);
    expect(included.ok).toBe(true);
    if (!included.ok) return;
    expect(included.data.advices.map((advice) => advice.id)).toEqual(['test-advice-clock-before']);

    // clock 在 validUntil 之后、真实时钟在之前（2099）：默认应排除，includeExpired 才返回。
    const afterExpiry = await buildTestContext({
      clock: () => new Date('2100-01-01T00:00:00.000Z'),
      advices: [
        {
          ...futureAdvice,
          id: 'test-advice-clock-after',
          validUntil: new Date('2099-01-01T00:00:00.000Z'),
        },
      ],
    });
    const excluded = await getAdviceTool.execute({}, afterExpiry);
    expect(excluded.ok).toBe(true);
    if (!excluded.ok) return;
    expect(excluded.data.total).toBe(0);
    const withExpired = await getAdviceTool.execute({ includeExpired: true }, afterExpiry);
    expect(withExpired.ok).toBe(true);
    if (!withExpired.ok) return;
    expect(withExpired.data.advices.map((advice) => advice.id)).toEqual([
      'test-advice-clock-after',
    ]);
  });

  it('过期过滤发生在 limit 截断之前', async () => {
    const ctx = await buildTestContext({
      clock: () => new Date('2020-06-01T12:00:00.000Z'),
      advices: [
        {
          ...futureAdvice,
          id: 'test-expired-newest',
          validUntil: new Date('2020-06-01T02:00:00.000Z'),
        },
        {
          ...futureAdvice,
          id: 'test-active-oldest',
          validUntil: new Date('2020-06-03T00:00:00.000Z'),
          createdAt: new Date('2020-05-01T00:00:00.000Z'),
        },
      ],
    });
    const result = await getAdviceTool.execute({ limit: 1 }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.advices.map((advice) => advice.id)).toEqual(['test-active-oldest']);
  });

  it('filter：subjectId / decision / since', async () => {
    const ctx = await buildTestContext({ advices: [futureAdvice, expiredAdvice] });

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
    const ctx = await buildTestContext();
    const result = await getAdviceTool.execute({ since: 'not-a-date' }, ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('invalid_input');
  });

  it('错误路径：limit 越界 → invalid_input', async () => {
    const ctx = await buildTestContext();
    const result = await getAdviceTool.execute({ limit: 0 }, ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('invalid_input');
  });
});
