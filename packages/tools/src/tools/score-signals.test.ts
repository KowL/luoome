import { describe, expect, it } from 'vitest';
import { buildTestContext } from '../testing/context.js';
import { scoreSignalsTool } from './score-signals.js';

describe('tool/score_signals', () => {
  it('空 signals → invalid_input', async () => {
    const ctx = await buildTestContext();
    const r = await scoreSignalsTool.execute({ signals: [] }, ctx);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid_input');
  });

  it('mock LLM 输出：每个 signal 拿到 llmScore + rationale', async () => {
    const ctx = await buildTestContext();
    const r = await scoreSignalsTool.execute(
      {
        signals: [
          {
            tacticId: 'breakout-volume',
            tacticName: '放量突破',
            tacticTag: 'momentum',
            stockId: '002594.SZ',
            ts: new Date('2026-07-20T00:00:00Z'),
            score: 75,
            direction: 'bullish',
            evidence: ['e1'],
          },
        ],
      },
      ctx,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.ranked).toHaveLength(1);
    expect(typeof r.data.ranked[0]?.llmScore).toBe('number');
    expect(typeof r.data.ranked[0]?.rationale).toBe('string');
  });
});
