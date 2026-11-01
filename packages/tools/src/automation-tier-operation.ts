import type { ConfirmablePluginTool } from './plugin-operations.js';
import { setAutomationTierTool } from './tools/set-automation-tier.js';

/**
 * `set_automation_tier` 的精确 Operation policy（REQ-M4-06 P2）。
 *
 * ## 回执记的是「**当时的档位**」
 *
 * `receipt(raw)` 的 `raw` 是这条 Operation **冻结的输入**（`op.inputJson`），
 * 所以 `raw.tier` 就是「提交那一刻要改成的档位」——不会因为后来又改了一次而被覆盖。
 *
 * 这正是「当时的档位」与「现在的档位」的区别：KV 表只存当前值，
 * 若回执去读表，三条历史回执会全部显示最后一个值。
 *
 * ## `scheduled: false`
 *
 * 改档位是人的决定，不该由定时任务触发。
 */
export const setAutomationTierOperation: ConfirmablePluginTool = {
  tool: setAutomationTierTool,
  scheduled: false,
  async bind(raw, _principal, _operationId, _ctx) {
    return setAutomationTierTool.inputSchema.parse(raw);
  },
  async receipt(raw) {
    // 冻结输入里的档位 = 那次提交时的档位（历史不会被后续修改污染）。
    return { ok: true, data: { tier: setAutomationTierTool.inputSchema.parse(raw).tier } };
  },
};
