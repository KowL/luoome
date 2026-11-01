import { z } from 'zod';

/**
 * 插件设置键（REQ-M4-06）。
 *
 * **只列真正需要的键**：不为「以后可能会有」预留空位。
 * 每加一个键都要问「它是不是真的需要持久化」——
 * 否则这张表会变成第二个 `record_json`，什么状态都往里塞。
 */
export const PLUGIN_SETTING_KEYS = ['automationTier'] as const;
export const PluginSettingKeySchema = z.enum(PLUGIN_SETTING_KEYS);
export type PluginSettingKey = z.infer<typeof PluginSettingKeySchema>;

/**
 * 自动化档位（与 `dsh-luoome` 的 `AutomationTier` 同一取值）。
 *
 * 定义在 core 是因为**读侧**（工具、面板）和**写侧**（设置页）都要用它；
 * 放在 host 里会让 tools 反向依赖 surface。
 */
export const AutomationTierSchema = z.enum(['off', 'notify', 'granted']);
export type AutomationTierValue = z.infer<typeof AutomationTierSchema>;

/** `value` 一律存字符串；语义在这里校验，不在 db 层做类型解析。 */
export const PluginSettingSchema = z
  .object({
    key: PluginSettingKeySchema,
    value: z.string().min(1).max(200),
    updatedAt: z.coerce.date(),
  })
  .strict();
export type PluginSetting = z.infer<typeof PluginSettingSchema>;

/** 按 key 校验 `value` 的语义；不认识的值直接拒绝，不做静默归一。 */
export const assertSettingValue = (key: PluginSettingKey, value: string): void => {
  if (key === 'automationTier') {
    const parsed = AutomationTierSchema.safeParse(value);
    if (!parsed.success)
      throw new Error(
        `automationTier 只能是 off / notify / granted，实际收到 ${JSON.stringify(value)}`,
      );
  }
};

/** 读出档位设置（已校验）；表里没有该键时返回 `null`。 */
export const automationTierOfSetting = (
  setting: Pick<PluginSetting, 'key' | 'value'> | null | undefined,
): AutomationTierValue | null => {
  if (setting === null || setting === undefined || setting.key !== 'automationTier') return null;
  const parsed = AutomationTierSchema.safeParse(setting.value);
  return parsed.success ? parsed.data : null;
};
