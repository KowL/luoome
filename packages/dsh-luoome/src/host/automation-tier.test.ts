import { describe, expect, it } from 'vitest';

import {
  resolveAutomationTier,
  resolveProductionConfig,
  tierAllowsBusinessWrite,
  tierAllowsDispatch,
} from './production-config.js';

/**
 * REQ-M4-06 自动化三档。
 *
 * 档位取代了旧的 `automationsEnabled: boolean`，**不保留两个真相源**：
 * 两者同时出现时以 `automationTier` 为准。
 */
const OWNER = { userId: 'owner-user', accountId: 'owner-account' };

describe('档位解析与旧值迁移', () => {
  it('旧配置 `automationsEnabled: false` → `off`', () => {
    expect(resolveAutomationTier({ automationsEnabled: false })).toBe('off');
  });

  it('旧配置 `automationsEnabled: true` → `granted`（旧语义就是「启用授权执行」）', () => {
    expect(resolveAutomationTier({ automationsEnabled: true })).toBe('granted');
  });

  it('旧配置缺省 → `off`（不隐式开启）', () => {
    expect(resolveAutomationTier({})).toBe('off');
  });

  it('新字段优先：两者同时出现时以 `automationTier` 为准', () => {
    // **这是「不保留两个真相源」的可执行形式**：
    // 若实现改成「更严格者胜」或「旧字段覆盖新字段」，这里立刻红。
    expect(resolveAutomationTier({ automationTier: 'notify', automationsEnabled: true })).toBe(
      'notify',
    );
    expect(resolveAutomationTier({ automationTier: 'off', automationsEnabled: true })).toBe('off');
  });

  it('完整配置解析：旧字段读出来仍是正确档位', () => {
    expect(
      resolveProductionConfig({
        owner: OWNER,
        batchEnabled: true,
        automationsEnabled: true,
        env: {},
      }).automationTier,
    ).toBe('granted');
    // 旧字段 true 但缺 batchEnabled ⇒ **仍按既有 refine 拒绝**（旧行为不变，不是静默降级）。
    // 这条断言的是「迁移不改校验强度」：不能因为换了字段名就让旧配置跳过 opt-in。
    expect(() =>
      resolveProductionConfig({ owner: OWNER, automationsEnabled: true, env: {} }),
    ).toThrow(/batchEnabled opt-in/);
  });
});

describe('档位语义：派发 vs 业务写入', () => {
  it('`off` 不派发、不写', () => {
    expect(tierAllowsDispatch('off')).toBe(false);
    expect(tierAllowsBusinessWrite('off')).toBe(false);
  });

  it('`notify` **派发但不写业务数据**（REQ-M4-06 的核心边界）', () => {
    expect(tierAllowsDispatch('notify')).toBe(true);
    expect(tierAllowsBusinessWrite('notify')).toBe(false);
  });

  it('`granted` 派发且允许写入（仍需 PluginAutomationGrant）', () => {
    expect(tierAllowsDispatch('granted')).toBe(true);
    expect(tierAllowsBusinessWrite('granted')).toBe(true);
  });
});

describe('notify 档必须拦住业务写入（硬断言，不是「代码里没调用」）', () => {
  it('写入类能力在 notify 档下被判定为不允许', () => {
    // 这里断言的是**判定函数本身**：派发的执行器按它决定是否放行写工具。
    // 若有人把 `tierAllowsBusinessWrite` 改成 `tier !== 'off'`，这条立刻红。
    expect(tierAllowsBusinessWrite('notify')).toBe(false);
    expect(tierAllowsBusinessWrite('granted')).toBe(true);
  });

  it('三档里只有 granted 能写，其它都不是', () => {
    const writable = (['off', 'notify', 'granted'] as const).filter(tierAllowsBusinessWrite);
    expect(writable).toEqual(['granted']);
  });
});

describe('配置校验：档位高于 off 需要 batchEnabled opt-in', () => {
  it('notify 档缺 batchEnabled → 拒绝', () => {
    expect(() =>
      resolveProductionConfig({ owner: OWNER, automationTier: 'notify', env: {} }),
    ).toThrow(/batchEnabled opt-in/);
  });

  it('granted 档缺 batchEnabled → 拒绝（旧行为保持）', () => {
    expect(() =>
      resolveProductionConfig({ owner: OWNER, automationTier: 'granted', env: {} }),
    ).toThrow(/batchEnabled opt-in/);
  });

  it('off 档不需要 batchEnabled', () => {
    expect(
      resolveProductionConfig({ owner: OWNER, automationTier: 'off', env: {} }).automationTier,
    ).toBe('off');
  });

  it('notify + batchEnabled → 通过', () => {
    expect(
      resolveProductionConfig({
        owner: OWNER,
        batchEnabled: true,
        automationTier: 'notify',
        env: {},
      }).automationTier,
    ).toBe('notify');
  });
});
