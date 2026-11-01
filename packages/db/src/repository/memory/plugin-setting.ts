import type { PluginSetting, PluginSettingKey, PluginSettingRepository } from '@luoome/core';

/**
 * `plugin_settings` 的 memory 实现。
 *
 * 与 drizzle 实现共用 contract tests：两边的**幂等语义**（同 key 同 value 重复写
 * 不新增行）必须一致，否则「设置页点两次保存」在两种部署下行为不同。
 */
export class InMemoryPluginSettingRepository implements PluginSettingRepository {
  private readonly items = new Map<PluginSettingKey, PluginSetting>();

  async find(key: PluginSettingKey): Promise<PluginSetting | null> {
    return this.items.get(key) ?? null;
  }

  async save(setting: PluginSetting): Promise<PluginSetting> {
    // 覆盖写（key 是主键）；`updatedAt` 由调用方决定，这里不改写它。
    this.items.set(setting.key, setting);
    return setting;
  }
}
