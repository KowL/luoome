import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MARKET_TOOL_ALLOWLIST,
  DEFAULT_READ_TOOL_ALLOWLIST,
  resolveProductionConfig,
} from './production-config.js';

/**
 * P1 裁定的 allowlist 守卫（task-40 / M4-01）。
 *
 * `resolve_hosted_watch_notification` 是**内部实现**：它带 `state`/`monitoring` 这些
 * **随时点变**的监控资格判定。模型可调面（read / market 两张默认 allowlist）一旦收它，
 * 调用方就会把「需要现算的资格」读成「已核对过的事实」——而 `state` 三档口径还有 4 项
 * 待产品裁定（task-40 报告 §4.3）。
 *
 * 守卫放在插件侧而不是 tools 侧，是因为**暴露面由这里决定**：tools 的 registry 只说明
 * 「有这个工具」，能不能被模型看到是这两张表说了算，两张都要查。
 */
const FORBIDDEN = 'resolve_hosted_watch_notification';

describe('内部 resolver 不得进入模型可调面', () => {
  it('不在默认 read allowlist', () => {
    expect(DEFAULT_READ_TOOL_ALLOWLIST).not.toContain(FORBIDDEN);
  });

  it('不在默认 market allowlist', () => {
    expect(DEFAULT_MARKET_TOOL_ALLOWLIST).not.toContain(FORBIDDEN);
  });

  it('解析后的生产配置两张表都不含它', () => {
    const config = resolveProductionConfig({
      owner: { userId: 'u1', accountId: 'a1' },
      home: '/tmp/luoome-resolver-exposure',
    });
    expect(config.read.allowlist).not.toContain(FORBIDDEN);
    expect(config.market.allowlist).not.toContain(FORBIDDEN);
  });

  it('守卫守的是「内部实现」，不是「入口」：两者都必须不在内部实现位置上', () => {
    // 入口 `resolve_watch_notification` 在 registry 里（见 tools 侧 watch.guard.test.ts）；
    // 但**当前它也不在这两张 allowlist 里**——即模型暂时调不到它。
    // 这属于暴露面决策（M4-01 尚未把通知目标接到对话面），不是本守卫的职责，
    // 决策已定（外部评审 gpt-6-astra）：入口**应当**在 read 面。
    // 理由：它的契约是「定位提醒来源」，不判断当前是否仍成立 ⇒ 与 `state` 三档口径无关。
    // 但**只读面，不进 market 面**——它不访问外部行情。
    const inRead = DEFAULT_READ_TOOL_ALLOWLIST.includes('resolve_watch_notification');
    const inMarket = DEFAULT_MARKET_TOOL_ALLOWLIST.includes('resolve_watch_notification');
    expect({ inRead, inMarket }).toEqual({ inRead: true, inMarket: false });
  });
});
