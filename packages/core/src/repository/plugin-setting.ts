import type { PluginSetting, PluginSettingKey } from '../entity/plugin-setting.js';

/**
 * 插件设置的持久化（REQ-M4-06）。
 *
 * 刻意做成**极窄的 KV**：只按 key 读写一行，没有枚举、没有前缀扫描、没有批量事务。
 * 未来若真的需要通用设置系统，那是另一个需求；现在提前抽象只会让它变成第二个
 * `record_json`（什么都往里塞，谁都不敢删）。
 */
export interface PluginSettingRepository {
  /** 读出该 key 的当前值；不存在返回 `null`（调用方据此回退到环境变量/默认）。 */
  find(key: PluginSettingKey): Promise<PluginSetting | null>;
  /**
   * 写入（upsert）。**幂等**：同 key 同 value 重复写不新建行，只推进 `updatedAt`。
   * 返回写入后的记录，调用方据此知道「现在表里的值是什么」。
   */
  save(setting: PluginSetting): Promise<PluginSetting>;
}
