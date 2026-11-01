import { describe, expect, it } from 'vitest';

import { dispatchOutcome, dispatchSkipText } from './dispatch-outcome.js';

/**
 * REQ-M4-06 ⑤：非交易日 `skipped`，且要能与「档位 off」区分。
 *
 * ## 为什么要区分
 *
 * 两者都「没执行」，但原因不同：
 * - `tier-off`：用户自己关了 → 改档位就能跑
 * - `non-trading-day`：今天不开市 → 改档位也没用，要等下个交易日
 *
 * 混成一个，用户排查时只能猜。
 */
describe('派发结果分类', () => {
  it('档位不允许派发 → skipped / tier-off（优先于交易日判断）', () => {
    expect(dispatchOutcome({ tierAllowsDispatch: false, isTradingDay: true })).toEqual({
      status: 'skipped',
      reason: 'tier-off',
    });
    // 即使同时是非交易日，也报「档位关闭」——因为那是用户能立刻改的那个原因。
    expect(dispatchOutcome({ tierAllowsDispatch: false, isTradingDay: false })).toEqual({
      status: 'skipped',
      reason: 'tier-off',
    });
  });

  it('档位允许但是非交易日 → skipped / non-trading-day', () => {
    expect(dispatchOutcome({ tierAllowsDispatch: true, isTradingDay: false })).toEqual({
      status: 'skipped',
      reason: 'non-trading-day',
    });
  });

  it('档位允许且是交易日 → dispatched', () => {
    expect(dispatchOutcome({ tierAllowsDispatch: true, isTradingDay: true })).toEqual({
      status: 'dispatched',
    });
  });

  it('两种 skipped 的说明文案**不同**（用户能据此决定下一步）', () => {
    const tierOff = dispatchSkipText('tier-off');
    const nonTrading = dispatchSkipText('non-trading-day');
    expect(tierOff).not.toBe(nonTrading);
    // 档位关闭：指向「调高档位」这个可执行动作
    expect(tierOff).toMatch(/档位/);
    // 非交易日：指向「等下一个交易日」，而不是让用户去改档位
    expect(nonTrading).toMatch(/不是交易日/);
    expect(nonTrading).not.toMatch(/档位/);
  });
});
