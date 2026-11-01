import {
  type AutomationTierValue,
  assertSettingValue,
  automationTierOfSetting,
  type PluginSettingRepository,
  PluginSettingSchema,
} from '@luoome/core';

/**
 * 自动化档位的读取口（REQ-M4-06）。
 *
 * ## 优先级：表 > 环境变量 > 默认
 *
 * 环境变量是**启动默认值**（运维改它表示「没在设置页动过时的期望」）；
 * 一旦用户在设置页改过，表里就有记录，**以表为准**——
 * 否则「设置页改了、重启回退」会让人无法信任这个开关。
 *
 * ## 为什么要能说出「当前值来自哪」
 *
 * 运维改 `LUOOME_AUTOMATION_TIER=granted` 发现没生效会查很久；
 * 设置页必须显示 `data-tier-source`，让「来自启动配置」这件事可见。
 */
export type AutomationTierSource = 'table' | 'env' | 'default';

export interface ResolvedAutomationTier {
  readonly tier: AutomationTierValue;
  readonly source: AutomationTierSource;
}

export const createAutomationTierStore = (options: {
  readonly repository: PluginSettingRepository;
  /** 来自启动配置的默认档位（环境变量解析结果）。 */
  readonly envTier: AutomationTierValue;
  readonly envProvided: boolean;
}) => ({
  /** 当前生效档位与来源。**每次调用都重新读表**——设置页改完立刻生效。 */
  async resolve(): Promise<ResolvedAutomationTier> {
    const stored = automationTierOfSetting(await options.repository.find('automationTier'));
    if (stored !== null) return { tier: stored, source: 'table' };
    return options.envProvided
      ? { tier: options.envTier, source: 'env' }
      : { tier: options.envTier, source: 'default' };
  },

  /** 写入档位（设置页 / `set_automation_tier` 走这里）。 */
  async save(tier: AutomationTierValue, now: Date): Promise<void> {
    assertSettingValue('automationTier', tier);
    await options.repository.save(
      PluginSettingSchema.parse({ key: 'automationTier', value: tier, updatedAt: now }),
    );
  },
});

export type AutomationTierStore = ReturnType<typeof createAutomationTierStore>;
