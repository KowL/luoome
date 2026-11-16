import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type {
  ManagedPluginId,
  PluginAdmission,
  PluginPermit,
  PluginPolicyLike,
} from '@luoome/core';
import { MANAGED_PLUGIN_IDS, SOURCE_PLUGIN_IDS, TASK_PLUGIN_IDS } from '@luoome/core';
import { z } from 'zod';

export interface BuiltinPluginDefinition {
  readonly kind: 'business' | 'provider' | 'task';
  readonly label: string;
  readonly baselineEnabled: boolean;
  readonly requires: readonly ManagedPluginId[];
}
const labels: Record<ManagedPluginId, string> = {
  'business.strategy-execution': '策略执行',
  'business.analysis': '个股分析',
  'business.watch-monitoring': '盯盘监控',
  'business.report': '报告生成与投递',
  'strategy.ai-insight': '策略 AI 洞察',
  'source.eastmoney': '东方财富',
  'source.tencent': '腾讯行情',
  'source.sina': '新浪财经',
  'source.tushare': 'Tushare',
  'source.fuyao': 'Fuyao',
  'source.10jqka': '同花顺资讯',
  'task.strategy-schedules': '自动策略调度',
  'task.daily-bars-sync': '日线同步',
  'task.sync-stock-universe': '股票目录同步',
  'task.collect-market-snapshot': '盘中快照采集',
  'task.sync-quotes': '持仓报价同步',
  'task.sync-market-dump': '市场数据导入',
  'task.sync-sector-catalog': '板块目录同步',
  'task.sync-limit-up-board-history': '连板历史归档',
  'task.minute-bars-sync': '分钟行情采集',
};
export const BUILTIN_PLUGINS = Object.fromEntries(
  MANAGED_PLUGIN_IDS.map((id) => {
    const definition: BuiltinPluginDefinition = {
      kind: SOURCE_PLUGIN_IDS.includes(id as (typeof SOURCE_PLUGIN_IDS)[number])
        ? 'provider'
        : TASK_PLUGIN_IDS.includes(id as (typeof TASK_PLUGIN_IDS)[number])
          ? 'task'
          : 'business',
      label: labels[id],
      baselineEnabled: id === 'strategy.ai-insight',
      requires: id === 'task.strategy-schedules' ? ['business.strategy-execution'] : [],
    };
    return [id, definition];
  }),
) as Record<ManagedPluginId, BuiltinPluginDefinition>;
const PluginIdSchema = z.enum(MANAGED_PLUGIN_IDS);
const EntrySchema = z
  .object({ enabled: z.boolean(), epoch: z.number().int().positive().safe() })
  .strict();
export const PluginConfigSchema = z
  .object({
    version: z.literal(1),
    incarnation: z.uuid(),
    revision: z.number().int().positive().safe(),
    entries: z.partialRecord(PluginIdSchema, EntrySchema),
  })
  .strict();
export type PluginConfig = z.infer<typeof PluginConfigSchema>;
export const PluginConfigVersionSchema = PluginConfigSchema.pick({
  incarnation: true,
  revision: true,
});
export type PluginConfigVersion = z.infer<typeof PluginConfigVersionSchema>;
const MAX_CONFIG_BYTES = 65_536;

export type PluginConfigRead =
  | { readonly ok: true; readonly config: PluginConfig }
  | { readonly ok: false; readonly reason: 'missing' | 'invalid' };

export class PluginConfigError extends Error {
  constructor(readonly code: 'busy' | 'conflict' | 'invalid' | 'exists' | 'unknown_plugin') {
    super(`Plugin configuration: ${code}`);
  }
}

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

  acquire(id: ManagedPluginId): PluginAdmission {
    const current = this.read();
    if (!current.ok) return { ok: false, reason: 'dependency_not_ready' };
    const entry = current.config.entries[id];
    if (!entry?.enabled) return { ok: false, reason: 'plugin_disabled' };
    return {
      ok: true,
      permit: { id, incarnation: current.config.incarnation, epoch: entry.epoch },
    };
  }

  valid(permit: PluginPermit): boolean {
    const current = this.acquire(permit.id);
    return (
      current.ok &&
      current.permit.incarnation === permit.incarnation &&
      current.permit.epoch === permit.epoch
    );
  }

  baseline(): Readonly<
    Record<ManagedPluginId, { readonly enabled: boolean; readonly epoch: number }>
  > {
    return Object.fromEntries(
      MANAGED_PLUGIN_IDS.map((id) => [
        id,
        { enabled: BUILTIN_PLUGINS[id].baselineEnabled, epoch: 1 },
      ]),
    ) as Record<ManagedPluginId, { enabled: boolean; epoch: number }>;
  }

  initialize(): PluginConfig {
    return this.writeLocked(() => {
      const current = this.read();
      if (current.ok) throw new PluginConfigError('exists');
      if (current.reason !== 'missing') throw new PluginConfigError('invalid');
      return { version: 1, incarnation: randomUUID(), revision: 1, entries: this.baseline() };
    });
  }

  set(id: string, enabled: boolean, expected: PluginConfigVersion): PluginConfig {
    const parsed = PluginIdSchema.safeParse(id);
    if (!parsed.success) throw new PluginConfigError('unknown_plugin');
    return this.writeLocked(() => {
      const current = this.expect(expected);
      const previous = current.entries[parsed.data];
      if (previous?.enabled === enabled) return current;
      return {
        ...current,
        revision: current.revision + 1,
        entries: {
          ...current.entries,
          [parsed.data]: { enabled, epoch: (previous?.epoch ?? 0) + 1 },
        },
      };
    });
  }

  migrate(expected: PluginConfigVersion): PluginConfig {
    return this.writeLocked(() => {
      const current = this.expect(expected);
      return {
        ...current,
        revision: current.revision + 1,
        entries: {
          ...Object.fromEntries(MANAGED_PLUGIN_IDS.map((id) => [id, { enabled: false, epoch: 1 }])),
          ...current.entries,
        },
      };
    });
  }

  private expect(expected: PluginConfigVersion): PluginConfig {
    const parsed = PluginConfigVersionSchema.parse({
      incarnation: expected.incarnation,
      revision: expected.revision,
    });
    const current = this.read();
    if (!current.ok) throw new PluginConfigError('invalid');
    if (
      current.config.incarnation !== parsed.incarnation ||
      current.config.revision !== parsed.revision
    )
      throw new PluginConfigError('conflict');
    return current.config;
  }

  private writeLocked(next: () => PluginConfig): PluginConfig {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const lock = `${this.path}.lock`;
    let fd: number;
    try {
      fd = openSync(lock, 'wx', 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new PluginConfigError('busy');
      throw error;
    }
    const temp = `${this.path}.tmp-${randomUUID()}`;
    try {
      writeFileSync(fd, JSON.stringify({ pid: process.pid }));
      const config = PluginConfigSchema.parse(next());
      const body = `${JSON.stringify(config, null, 2)}\n`;
      if (Buffer.byteLength(body) > MAX_CONFIG_BYTES) throw new PluginConfigError('invalid');
      const output = openSync(temp, 'wx', 0o600);
      try {
        writeFileSync(output, body);
        fsyncSync(output);
      } finally {
        closeSync(output);
      }
      renameSync(temp, this.path);
      chmodSync(this.path, 0o600);
      return config;
    } finally {
      closeSync(fd);
      rmSync(temp, { force: true });
      rmSync(lock);
    }
  }
}
