import type { PluginSetting, PluginSettingKey, PluginSettingRepository } from '@luoome/core';
import { eq } from 'drizzle-orm';
import type { DrizzleDatabase } from '../../database.js';
import type { Schema } from '../../schema/index.js';
import { pluginSettings } from '../../schema/plugin-setting.js';

/**
 * `plugin_settings` 的 drizzle 实现。
 *
 * 与 memory 实现共用 contract tests：两边「同 key 重复写不新增行」的语义必须一致。
 */
export class DrizzlePluginSettingRepository implements PluginSettingRepository {
  constructor(private readonly db: DrizzleDatabase<Schema>) {}

  async find(key: PluginSettingKey): Promise<PluginSetting | null> {
    const row = this.db.select().from(pluginSettings).where(eq(pluginSettings.key, key)).get();
    if (row === undefined) return null;
    return {
      key: row.key as PluginSettingKey,
      value: row.value,
      updatedAt: new Date(row.updatedAt),
    };
  }

  async save(setting: PluginSetting): Promise<PluginSetting> {
    this.db
      .insert(pluginSettings)
      .values({
        key: setting.key,
        value: setting.value,
        updatedAt: setting.updatedAt.getTime(),
      })
      .onConflictDoUpdate({
        target: pluginSettings.key,
        set: { value: setting.value, updatedAt: setting.updatedAt.getTime() },
      })
      .run();
    return setting;
  }
}
