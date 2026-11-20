import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ManagedPluginId, PluginPolicyLike } from '@luoome/core';
import { MANAGED_PLUGIN_IDS } from '@luoome/core';
import { z } from 'zod';

/** 只读的启用清单：手写 `plugins.json`，进程启动时生效，没有管理接口。 */
const EntrySchema = z.object({ enabled: z.boolean() }).passthrough();
export const PluginConfigSchema = z
  .object({
    version: z.literal(1),
    entries: z.partialRecord(z.enum(MANAGED_PLUGIN_IDS), EntrySchema),
  })
  .passthrough();
export type PluginConfig = z.infer<typeof PluginConfigSchema>;

const MAX_CONFIG_BYTES = 65_536;

export type PluginConfigRead =
  | { readonly ok: true; readonly config: PluginConfig }
  | { readonly ok: false; readonly reason: 'missing' | 'invalid' };

export const resolvePluginConfigPath = (
  env: Readonly<Record<string, string | undefined>> = process.env,
): string => join(env.LUOOME_HOME ?? join(homedir(), '.luoome'), 'plugins.json');

export class PluginConfigStore implements PluginPolicyLike {
  constructor(readonly path: string) {}

  read(): PluginConfigRead {
    try {
      if (statSync(this.path).size > MAX_CONFIG_BYTES) return { ok: false, reason: 'invalid' };
      const raw = readFileSync(this.path);
      if (raw.byteLength > MAX_CONFIG_BYTES) return { ok: false, reason: 'invalid' };
      const parsed = PluginConfigSchema.safeParse(JSON.parse(raw.toString('utf8')));
      return parsed.success ? { ok: true, config: parsed.data } : { ok: false, reason: 'invalid' };
    } catch (error) {
      return {
        ok: false,
        reason: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'invalid',
      };
    }
  }

  isEnabled(id: ManagedPluginId): boolean {
    const current = this.read();
    return current.ok && current.config.entries[id]?.enabled === true;
  }
}
