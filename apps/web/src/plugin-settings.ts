import { randomUUID } from 'node:crypto';
import {
  BUILTIN_PLUGINS,
  type PluginConfig,
  PluginConfigError,
  PluginConfigStore,
  PluginConfigVersionSchema,
  type ProviderRuntime,
  resolvePluginConfigPath,
} from '@luoome/adapters';
import { MANAGED_PLUGIN_IDS, type ManagedPluginId, type ToolContext } from '@luoome/core';
import {
  type PluginRouteInventory,
  pluginContributions,
  pluginRouteDependency,
} from '@luoome/tools';
import { z } from 'zod';
import type { PluginTasks } from './plugin-tasks.js';

const version = PluginConfigVersionSchema.strict();
export const PluginSettingsCommandSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('initialize'), expected: z.literal('absent') }),
  z.strictObject({ action: z.literal('migrate'), ...version.shape }),
  z.strictObject({
    action: z.literal('set'),
    id: z.enum(MANAGED_PLUGIN_IDS),
    enabled: z.boolean(),
    ...version.shape,
  }),
]);
type Command = z.infer<typeof PluginSettingsCommandSchema>;
type TaskHost = Pick<PluginTasks, 'status' | 'reconcile'>;
export interface PluginSettingsRuntime {
  readonly context: ToolContext;
  readonly provider?: ProviderRuntime;
  readonly tasks?: TaskHost;
  readonly exposeWrite: boolean;
  readonly exposeExternal: boolean;
}

export class PluginSettingsStore {
  private readonly store: PluginConfigStore;
  readonly hostId = randomUUID();
  constructor(private readonly env: Readonly<Record<string, string | undefined>>) {
    this.store = new PluginConfigStore(resolvePluginConfigPath(env));
  }
  private credentialReady(id: ManagedPluginId): boolean {
    return id === 'source.tushare'
      ? Boolean(this.env.TUSHARE_TOKEN?.trim())
      : id === 'source.fuyao'
        ? Boolean(this.env.FUYAO_API_KEY?.trim())
        : true;
  }
  private project(
    config: PluginConfig | undefined,
    runtime: PluginSettingsRuntime,
    projected = false,
  ) {
    const routes = runtime.provider?.describe() ?? [];
    const tasks = runtime.tasks?.status() ?? [];
    const calls = runtime.context.executionPolicy?.activity() ?? [];
    const sources = runtime.provider?.activity() ?? [];
    const enabled = (id: ManagedPluginId) => config?.entries[id]?.enabled === true;
    const routeReady = (route: PluginRouteInventory) =>
      projected
        ? route.candidates.some(
            (source) =>
              enabled(`source.${source}` as ManagedPluginId) &&
              this.credentialReady(`source.${source}` as ManagedPluginId),
          )
        : route.ready;
    const plugins = MANAGED_PLUGIN_IDS.map((id) => {
      const definition = BUILTIN_PLUGINS[id],
        entry = config?.entries[id];
      const contributions = pluginContributions(id, routes);
      const blockers: string[] = [];
      for (const required of definition.requires)
        if (!enabled(required)) blockers.push(`需要启用${BUILTIN_PLUGINS[required].label}`);
      const owned = contributions.filter((item) => item.effect === 'owned');
      const capabilities = [...new Set(owned.flatMap((item) => item.capabilities))];
      if (
        (id.startsWith('source.') ||
          id === 'strategy.ai-insight' ||
          id === 'task.strategy-schedules' ||
          capabilities.includes('external')) &&
        !runtime.exposeExternal
      )
        blockers.push('宿主未授权外部调用（external）');
      if (
        (id === 'task.strategy-schedules' || capabilities.includes('write')) &&
        !runtime.exposeWrite
      )
        blockers.push('宿主未授权写入（write）');
      if (
        (id === 'strategy.ai-insight' || id === 'business.analysis') &&
        runtime.context.adapters.llm.configurationReady === false
      )
        blockers.push(id === 'business.analysis' ? '分析模型尚未配置' : '解释模型尚未配置');
      if (!this.credentialReady(id)) blockers.push('提供者凭证尚未配置；请配置后重启宿主');
      const selected = routes.filter((route) =>
        [...route.candidates, ...route.dependencies].some((source) => id === `source.${source}`),
      );
      if (definition.kind === 'provider' && selected.length === 0)
        blockers.push('当前宿主路由未选择此来源');
      else if (
        definition.kind === 'provider' &&
        !projected &&
        !selected.some(routeReady) &&
        enabled(id) &&
        this.credentialReady(id)
      )
        blockers.push('来源尚未在当前宿主就绪');
      for (const dependency of [...new Set(owned.flatMap((item) => item.dependencies))]) {
        if (dependency === 'llm') continue;
        if (
          !routes.some(
            (route) =>
              (route.route === 'market'
                ? dependency.startsWith('market:')
                : dependency === pluginRouteDependency(route.route)) && routeReady(route),
          )
        )
          blockers.push(`供数入口未就绪：${dependency}`);
      }
      const task = tasks.find((task) => task.id === id);
      const call = calls.find((call) => call.id === id) ?? sources.find((call) => call.id === id);
      const dependents = tasks.filter((task) => BUILTIN_PLUGINS[task.id].requires.includes(id));
      const revoked = call?.revokedInFlight ?? 0;
      const draining =
        revoked > 0 ||
        task?.phase === 'draining' ||
        dependents.some((task) => task.phase === 'draining');
      const failed = task?.phase === 'failed';
      const phase = failed
        ? 'failed'
        : draining
          ? 'draining'
          : !enabled(id)
            ? 'disabled'
            : blockers.length > 0
              ? 'blocked'
              : (task?.phase ?? 'ready');
      const admission = runtime.context.executionPolicy?.acquire(id);
      const gateApplied =
        !projected &&
        config !== undefined &&
        (enabled(id)
          ? Boolean(
              admission?.ok &&
                admission.permit.incarnation === config.incarnation &&
                admission.permit.epoch === entry?.epoch,
            )
          : admission?.ok === false && admission.reason === 'plugin_disabled');
      return {
        id,
        label: definition.label,
        kind: definition.kind,
        enabled: enabled(id),
        epoch: entry?.epoch ?? null,
        requires: definition.requires.map((required) => ({
          id: required,
          label: BUILTIN_PLUGINS[required].label,
          enabled: enabled(required),
        })),
        contributions,
        blockers,
        selectedRoutes: selected.map((route) => route.route),
        runtime: {
          phase,
          gateApplied,
          inFlight: call?.inFlight ?? 0,
          revokedInFlight: revoked,
          task: task ?? null,
          dependentTasks: dependents,
          observed: !projected && runtime.context.executionPolicy !== undefined,
        },
      };
    });
    return plugins;
  }
  read(runtime: PluginSettingsRuntime) {
    const read = this.store.read();
    return {
      configuration: read.ok
        ? {
            state: 'valid' as const,
            incarnation: read.config.incarnation,
            revision: read.config.revision,
            missing: MANAGED_PLUGIN_IDS.filter((id) => read.config.entries[id] === undefined),
          }
        : { state: read.reason, incarnation: null, revision: null, missing: [] },
      canManage: runtime.exposeWrite,
      host: { id: this.hostId, scope: 'current-web' as const },
      plugins: this.project(read.ok ? read.config : undefined, runtime),
      baseline: this.store.baseline(),
    };
  }
  private proposed(command: Command): PluginConfig {
    const read = this.store.read();
    if (command.action === 'initialize') {
      if (read.ok) throw new PluginConfigError('exists');
      if (read.reason !== 'missing') throw new PluginConfigError('invalid');
      return {
        version: 1,
        incarnation: '00000000-0000-4000-8000-000000000000',
        revision: 1,
        entries: this.store.baseline(),
      };
    }
    if (!read.ok) throw new PluginConfigError('invalid');
    if (
      command.incarnation !== read.config.incarnation ||
      command.revision !== read.config.revision
    )
      throw new PluginConfigError('conflict');
    if (command.action === 'migrate')
      return {
        ...read.config,
        revision: read.config.revision + 1,
        entries: {
          ...Object.fromEntries(MANAGED_PLUGIN_IDS.map((id) => [id, { enabled: false, epoch: 1 }])),
          ...read.config.entries,
        },
      };
    const previous = read.config.entries[command.id];
    return previous?.enabled === command.enabled
      ? read.config
      : {
          ...read.config,
          revision: read.config.revision + 1,
          entries: {
            ...read.config.entries,
            [command.id]: { enabled: command.enabled, epoch: (previous?.epoch ?? 0) + 1 },
          },
        };
  }
  preview(raw: unknown, runtime: PluginSettingsRuntime) {
    const command = PluginSettingsCommandSchema.parse(raw),
      next = this.proposed(command);
    const rows = this.project(next, runtime, true);
    const id = command.action === 'set' ? command.id : undefined;
    const affected = rows.filter(
      (row) =>
        row.id === id ||
        (id !== undefined && row.requires.some((required) => required.id === id)) ||
        id === undefined,
    );
    return {
      command,
      affected,
      notes: [
        '不会自动启用依赖；不会扩大 write、external 或 Agent 场景白名单。',
        '共享数据、历史策略、已有建议和报告保留。',
        ...(id === 'strategy.ai-insight' ? ['关闭解释模型后，组合入口保留确定性事实。'] : []),
        ...(id?.startsWith('source.')
          ? ['来源关联操作属于可能影响；已授权的其它候选源仍可降级供数，实际资料门禁在调用时校验。']
          : []),
        ...(id === 'business.strategy-execution'
          ? ['自动策略定时器随依赖停用；报告截止与补投保持独立。']
          : []),
        ...(id === 'business.analysis'
          ? [
              '停用后拒绝新个股、持仓、市场及策略候选 Advice；历史建议仍可读取，既有策略运行与事实不受此开关影响。',
            ]
          : []),
        '启停在下一受控安全点生效；已开始的短事务正常结束，旧请求可能仍在排空。',
      ],
    };
  }
  save(raw: unknown, runtime: PluginSettingsRuntime) {
    const command = PluginSettingsCommandSchema.parse(raw);
    const config =
      command.action === 'initialize'
        ? this.store.initialize()
        : command.action === 'migrate'
          ? this.store.migrate(command)
          : this.store.set(command.id, command.enabled, command);
    let applicationError: string | undefined;
    try {
      runtime.tasks?.reconcile();
    } catch {
      applicationError = '配置已提交，但当前宿主未能完成资源应用；请刷新运行状态';
    }
    return {
      committed: true,
      committedVersion: { incarnation: config.incarnation, revision: config.revision },
      ...(applicationError === undefined ? {} : { applicationError }),
      view: this.read(runtime),
    };
  }
}
