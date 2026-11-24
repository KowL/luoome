import { dateInShanghai } from '@luoome/core';
import { buildTestContext } from '@luoome/tools/testing';
import { describe, expect, it } from 'vitest';

import {
  DAILY_STOCK_BRIEFS_WORKFLOW_NAME,
  dailyStockBriefsWorkflow,
} from './daily-stock-briefs.js';

const FIXED_NOW = new Date('2026-11-24T09:00:00Z');

/** 批次 P95 目标 ≤ 6 min（8 票 / 并发 2）；单测只断言 summary 形状与审计，不真实等待。 */
const okLlm = {
  name: 'workflow-llm',
  generate: async <T>(): Promise<T> =>
    ({
      decision: 'hold',
      confidence: 50,
      horizon: 'short',
      reasoning: {
        premise: '今日无新增事实，维持原判断',
        evidence: ['close=105.8'],
        counterEvidence: ['若收盘跌破 100 则本条判断作废'],
      },
      risks: ['可能回调'],
      usage: { promptTokens: 1200, completionTokens: 600, reasoningTokens: 200, costUsd: 0 },
      raw: 'raw',
    }) as T,
};

describe('daily-stock-briefs workflow', () => {
  it('生成批次并写入 workflow_runs.output_summary（coverage/budget）', async () => {
    const base = await buildTestContext({ advices: [], clock: () => FIXED_NOW });
    const ctx = {
      ...base,
      adapters: { ...base.adapters, llm: okLlm },
    };

    const result = await dailyStockBriefsWorkflow.run(
      { scope: 'stock', stockIds: ['002594.SZ'], mode: 'scheduled' },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.coverage.candidates).toBe(1);
    expect(result.data.budget.limit.maxHttpCalls).toBe(16);
    expect(result.data.workflowRunId).toBeTruthy();

    const run = await base.repos.workflowRun.findById(result.data.workflowRunId);
    expect(run?.workflowName).toBe(DAILY_STOCK_BRIEFS_WORKFLOW_NAME);
    expect(run?.mode).toBe('scheduled');
    expect(run?.status).toBe('succeeded');
    expect(run?.outputSummary).toMatchObject({
      coverage: { candidates: 1 },
      budget: { limit: { maxHttpCalls: 16, maxTokens: 90_000, maxBriefs: 8 } },
      llmHttpCalls: 1,
    });
    expect(run?.finishedAt).toBeInstanceOf(Date);

    const briefs = await base.repos.stockBrief.findByDay({
      tradingDate: dateInShanghai(FIXED_NOW),
      accountId: base.user.defaultAccountId,
    });
    expect(briefs).toHaveLength(1);
    expect(briefs[0]?.quality).toBe('ai');
  });

  it('预算耗尽批次仍落库部分结果，workflow_run 记为 partial', async () => {
    const base = await buildTestContext({ advices: [], clock: () => FIXED_NOW });
    const ctx = { ...base, adapters: { ...base.adapters, llm: okLlm } };

    const result = await dailyStockBriefsWorkflow.run(
      { scope: 'stock', stockIds: ['002594.SZ', '600519.SH'], maxTokens: 100 },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.briefs.degradation?.reason).toBe('rate_limited');
    const run = await base.repos.workflowRun.findById(result.data.workflowRunId);
    expect(run?.status).toBe('partial');
    expect(run?.outputSummary?.degradation).toBe('rate_limited');
  });
});
