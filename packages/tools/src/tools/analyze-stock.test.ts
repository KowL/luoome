import { STANDARD_DISCLAIMERS } from '@luoome/core';
import { describe, expect, it } from 'vitest';

import { buildMockContext } from '../context.js';
import { analyzeStockTool } from './analyze-stock.js';

describe('analyze_stock', () => {
  it('正常路径：产出结构化 Advice 并持久化', async () => {
    const ctx = await buildMockContext({ advices: [] });
    const result = await analyzeStockTool.execute({ stockId: '002594.SZ' }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const { advice, evidence } = result.data;
    expect(advice.subjectKind).toBe('stock');
    expect(advice.subjectId).toBe('002594.SZ');
    expect(advice.sourceTool).toBe('analyze_stock');
    expect(advice.confidence).toBeGreaterThanOrEqual(0);
    expect(advice.confidence).toBeLessThanOrEqual(100);
    expect(advice.validUntil.getTime()).toBeGreaterThan(advice.validFrom.getTime());
    expect(advice.reasoning.premise.length).toBeGreaterThan(0);

    // 免责声明 3 条 STANDARD_DISCLAIMERS 齐全。
    expect(advice.disclaimers.length).toBeGreaterThanOrEqual(3);
    for (const required of STANDARD_DISCLAIMERS) {
      expect(advice.disclaimers).toContain(required);
    }

    // basedOn 快照可复盘。
    expect(evidence.quotes?.['002594.SZ']?.close).toBe(105.8);
    expect(evidence.indicators?.['002594.SZ']?.ma5).toBeDefined();
    expect(evidence.llmReasoning).toBeDefined();

    // 已持久化，可 query 到。
    const persisted = await ctx.repos.advice.findById(advice.id);
    expect(persisted).not.toBeNull();
    const queried = await ctx.repos.advice.query({ subjectId: '002594.SZ' });
    expect(queried.some((a) => a.id === advice.id)).toBe(true);
  });

  it('正常路径：纯代码形式也能解析标的', async () => {
    const ctx = await buildMockContext({ advices: [] });
    const result = await analyzeStockTool.execute({ stockId: '002594' }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.advice.subjectId).toBe('002594.SZ');
  });

  it('intraday horizon 截断：validUntil 仍严格晚于 validFrom', async () => {
    // mock clock 固定在 A 股收盘时刻（2026-07-17 15:00 UTC+8）；
    // 无论 LLM 给什么 horizon，都不允许 validUntil <= validFrom。
    const ctx = await buildMockContext({ advices: [] });
    for (const stockId of ['600519.SH', '300750.SZ', '00700.HK', 'AAPL.US']) {
      const result = await analyzeStockTool.execute({ stockId }, ctx);
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      expect(result.data.advice.validUntil.getTime()).toBeGreaterThan(
        result.data.advice.validFrom.getTime(),
      );
    }
  });

  it('错误路径：标的不存在 → not_found', async () => {
    const ctx = await buildMockContext({ advices: [] });
    const result = await analyzeStockTool.execute({ stockId: '999999' }, ctx);
    expect(result).toEqual({
      ok: false,
      error: { kind: 'not_found', entity: 'Stock', id: '999999' },
    });
  });

  it('错误路径：缺 stockId / 类型错误 → invalid_input', async () => {
    const ctx = await buildMockContext({ advices: [] });
    const missing = await analyzeStockTool.execute({}, ctx);
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.kind).toBe('invalid_input');

    const wrongType = await analyzeStockTool.execute({ stockId: 123 }, ctx);
    expect(wrongType.ok).toBe(false);
    if (!wrongType.ok) expect(wrongType.error.kind).toBe('invalid_input');
  });
});
