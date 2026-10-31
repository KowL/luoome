import { describe, expect, it } from 'vitest';

import { assertGateHidesScores, fundamentalGate } from './fundamental-gate.js';

describe('REQ-M3-09 §4 基本面评分闸', () => {
  // 闸位是计算值：mock 装配永远 not-ready（真实源白名单为空）。
  it('is not-ready for mock providers even with complete results', () => {
    expect(fundamentalGate({ providerKind: 'mock', status: 'complete', resultCount: 5 })).toBe(
      'not-ready',
    );
    expect(
      fundamentalGate({
        providerKind: 'mock',
        gateStatus: 'evaluation-ready',
        status: 'complete',
        resultCount: 5,
      }),
    ).toBe('not-ready');
  });

  // 换一组输入（真实 provider + 完整结果）→ ready，证明判定不是恒假。
  it('becomes evaluation-ready for a real provider with complete results', () => {
    expect(
      fundamentalGate({
        providerKind: 'real',
        gateStatus: 'evaluation-ready',
        status: 'complete',
        resultCount: 5,
      }),
    ).toBe('evaluation-ready');
    expect(
      fundamentalGate({
        providerKind: 'real',
        gateStatus: 'operational',
        status: 'complete',
        resultCount: 1,
      }),
    ).toBe('evaluation-ready');
  });

  it('stays not-ready when the gate is unmet, the run is partial, or there is no result', () => {
    const base = {
      providerKind: 'real' as const,
      gateStatus: 'evaluation-ready' as const,
      status: 'complete' as const,
      resultCount: 3,
    };
    expect(fundamentalGate({ ...base, gateStatus: 'not-ready' })).toBe('not-ready');
    expect(fundamentalGate({ ...base, status: 'partial' })).toBe('not-ready');
    expect(fundamentalGate({ ...base, status: 'unavailable' })).toBe('not-ready');
    expect(fundamentalGate({ ...base, resultCount: 0 })).toBe('not-ready');
  });

  // 零数字兜底：gate=not-ready 时任何评分数字都不得泄漏。
  it('forbids score numbers whenever the gate is not-ready', () => {
    expect(() => assertGateHidesScores('not-ready', [undefined, undefined])).not.toThrow();
    expect(() => assertGateHidesScores('not-ready', [1])).toThrow(/不得输出评分数字/);
    expect(() => assertGateHidesScores('evaluation-ready', [1])).not.toThrow();
  });
});
