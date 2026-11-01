import {
  AutomationTierSchema,
  type AutomationTierValue,
  assertSettingValue,
  PluginSettingSchema,
} from '@luoome/core';
import { z } from 'zod';

import { defineTool, errAdapterError } from '../define-tool.js';

/**
 * 设置自动化档位（REQ-M4-06）。
 *
 * ## 为什么这个工具**不受档位闸门约束**
 *
 * 与 `configure_plugin_automation` 同理：若 `notify` 档连「改成 granted」都拦住，
 * 用户就永远升不上去——**死锁**。档位闸门只在真正派发业务工具时生效。
 *
 * ## 为什么不写环境变量
 *
 * 环境变量是**只读的启动默认值**。运行时改它只会造成
 * 「看起来改了、进程内不生效」的困惑——那比改不了更糟。
 */
export const SetAutomationTierInput = z
  .object({
    tier: AutomationTierSchema,
  })
  .strict();

export const SetAutomationTierOutput = z.object({
  tier: AutomationTierSchema,
  /** 写入后**回读**的值（证明真的落库，而不是只回显入参）。 */
  persistedTier: AutomationTierSchema,
  /** 当前生效值来自哪：表 / 环境变量 / 默认。 */
  source: z.enum(['table', 'env', 'default']),
});

export const setAutomationTierTool = defineTool({
  name: 'set_automation_tier',
  description:
    '设置自动化档位（关闭 / 仅提醒 / 授权执行）。只写本地设置表，不改启动配置，不影响既有授权。',
  sideEffect: 'write',
  input: SetAutomationTierInput,
  output: SetAutomationTierOutput,
  handler: async (input, ctx) => {
    const store = ctx.automationTierStore;
    if (store === undefined)
      return errAdapterError('automation-tier', 'automation tier store is not configured', false);
    assertSettingValue('automationTier', input.tier);
    await store.save(input.tier as AutomationTierValue, ctx.clock());
    // **回读**：证明写入真的落库（只回显入参证明不了任何事）。
    const resolved = await store.resolve();
    return {
      tier: input.tier,
      persistedTier: resolved.tier,
      source: resolved.source as 'table' | 'env' | 'default',
    };
  },
});

void PluginSettingSchema;
