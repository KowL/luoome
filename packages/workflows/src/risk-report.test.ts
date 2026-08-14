import { buildTestContext } from '@luoome/tools/testing';
import { describe, expect, it } from 'vitest';

import { historicalVaR95, riskReportWorkflow } from './risk-report.js';

describe('workflow/risk-report', () => {
  it('uses the historical lower-tail quantile, not a fixed percentage of value', () => {
    expect(historicalVaR95(100_000, [-1, -2, 0, 1, -4])).toBeCloseTo(3_600, 8);
    expect(historicalVaR95(100_000, [])).toBeNull();
    expect(historicalVaR95(0, [-5])).toBeNull();
  });

  it('returns a real-history VaR metric or an explicit unavailable value', async () => {
    const ctx = await buildTestContext({
      clock: () => new Date('2026-08-14T08:00:00.000Z'),
    });
    const result = await riskReportWorkflow.run({}, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const metric = result.data.metrics.find((item) => item.name === 'var95_30d');
    expect(metric).toBeDefined();
    expect(metric?.note).not.toContain('2%');
    expect(metric?.level).toMatch(/^(low|mid|high|unavailable)$/);
    if (metric?.value !== null && metric !== undefined) {
      expect(metric.value).toBeGreaterThanOrEqual(0);
      expect(metric.value).not.toBeCloseTo(result.data.totalValue * 0.02, 8);
    }
  });
});
