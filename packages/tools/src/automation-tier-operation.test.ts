import { describe, expect, it } from 'vitest';

import { setAutomationTierOperation } from './automation-tier-operation.js';
import { buildTestContext } from './testing/context.js';

/**
 * REQ-M4-06 P2：「关→开→关」3 条回执可查，且**每条记录当时的档位**。
 *
 * ## 为什么回执不能读 KV 表
 *
 * KV 表只存**当前值**。若回执去读表，三条历史回执会全部显示最后一个值——
 * 「当时的档位」就丢了。所以回执从**这条 Operation 冻结的输入**里取。
 *
 * 下面的用例直接验证这个性质：三次提交后，回执分别是 off / granted / off，
 * 而不是三个 `off`。
 */
describe('set_automation_tier 回执记录当时的档位', () => {
  const setup = async () => {
    const ctx = await buildTestContext({ clock: () => new Date('2026-05-01T00:00:00Z') });
    return { ctx };
  };

  it('三次切换的回执各自保留当时的档位（不被后续覆盖）', async () => {
    const { ctx } = await setup();
    // 模拟三次提交的**冻结输入**（这正是 Operation 存下来的那份）。
    const receipts = await Promise.all(
      ['off', 'granted', 'off'].map(async (tier) => {
        const bound = await setAutomationTierOperation.bind({ tier }, {} as never, 'op', ctx);
        const receipt = await setAutomationTierOperation.receipt(bound, ctx);
        return (receipt as { ok: true; data: { tier: string } }).data.tier;
      }),
    );
    // **关键**：不是三个 'off'，而是提交时的三个值。
    expect(receipts).toEqual(['off', 'granted', 'off']);
  });

  it('非法档位在 bind 阶段就被拒（不会走到回执）', async () => {
    const { ctx } = await setup();
    await expect(
      setAutomationTierOperation.bind({ tier: 'bogus' }, {} as never, 'op', ctx),
    ).rejects.toThrow();
  });

  it('改档位是人的决定，不由定时任务触发', () => {
    expect(setAutomationTierOperation.scheduled).toBe(false);
  });
});
