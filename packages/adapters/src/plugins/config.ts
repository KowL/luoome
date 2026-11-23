import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ManagedPluginId, PluginConfigSnapshot, PluginPolicyLike } from '@luoome/core';
import { MANAGED_PLUGIN_IDS } from '@luoome/core';
import { z } from 'zod';

/** 只读的启用清单：手写 `plugins.json`，进程启动时生效，没有管理接口。 */
const EntrySchema = z.object({ enabled: z.boolean() }).passthrough();
// 手写文件的常见腐化是残留已下线插件的 key；zod 的 partialRecord 会把未知 key 判成
// 整份 invalid，于是一个旧条目就让所有行情源一起失效。这里先按当前清单过滤，再校验。
const knownEntries = (raw: unknown): unknown => {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const known = new Set<string>(MANAGED_PLUGIN_IDS);
  return Object.fromEntries(Object.entries(raw).filter(([id]) => known.has(id)));
};
export const PluginConfigSchema = z
  .object({
    version: z.literal(1),
    entries: z.preprocess(knownEntries, z.partialRecord(z.enum(MANAGED_PLUGIN_IDS), EntrySchema)),
  })
  .passthrough();
export type PluginConfig = z.infer<typeof PluginConfigSchema>;

const MAX_CONFIG_BYTES = 65_536;

export type PluginConfigRead =
  | { readonly ok: true; readonly config: PluginConfig }
  | { readonly ok: false; readonly reason: 'missing' | 'invalid' };

export type PluginConfigInspection = PluginConfigRead & {
  /** 手写文件里不属于当前 `MANAGED_PLUGIN_IDS` 的 key；只读诊断，不进入实际启用表。 */
  readonly unknownIds?: readonly string[];
};

export const resolvePluginConfigPath = (
  env: Readonly<Record<string, string | undefined>> = process.env,
): string => join(env.LUOOME_HOME ?? join(homedir(), '.luoome'), 'plugins.json');

export class PluginConfigStore implements PluginPolicyLike {
  constructor(readonly path: string) {}

  /** 只读诊断：保留未知 id 供设置页 / CLI 报告，不改变 `isEnabled` 的口径。 */
  inspect(): PluginConfigInspection {
    try {
      if (statSync(this.path).size > MAX_CONFIG_BYTES) return { ok: false, reason: 'invalid' };
      const raw = readFileSync(this.path);
      if (raw.byteLength > MAX_CONFIG_BYTES) return { ok: false, reason: 'invalid' };
      const decoded: unknown = JSON.parse(raw.toString('utf8'));
      const parsed = PluginConfigSchema.safeParse(decoded);
      if (!parsed.success) return { ok: false, reason: 'invalid' };
      const entries =
        typeof decoded === 'object' && decoded !== null && !Array.isArray(decoded)
          ? (decoded as { entries?: unknown }).entries
          : undefined;
      const known = new Set<string>(MANAGED_PLUGIN_IDS);
      const unknownIds =
        typeof entries === 'object' && entries !== null && !Array.isArray(entries)
          ? Object.keys(entries).filter((id) => !known.has(id))
          : [];
      return { ok: true, config: parsed.data, unknownIds };
    } catch (error) {
      return {
        ok: false,
        reason: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'invalid',
      };
    }
  }

  read(): PluginConfigRead {
    const inspected = this.inspect();
    return inspected.ok
      ? { ok: true, config: inspected.config }
      : { ok: false, reason: inspected.reason };
  }

  isEnabled(id: ManagedPluginId): boolean {
    const current = this.read();
    return current.ok && current.config.entries[id]?.enabled === true;
  }

  snapshot(): PluginConfigSnapshot {
    const inspected = this.inspect();
    if (!inspected.ok) {
      return { file: inspected.reason, configured: [], unknown: [] };
    }
    return {
      file: 'ok',
      configured: MANAGED_PLUGIN_IDS.filter((id) => inspected.config.entries[id] !== undefined),
      unknown: inspected.unknownIds ?? [],
    };
  }
}
