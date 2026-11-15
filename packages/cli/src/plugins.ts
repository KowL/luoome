import {
  BUILTIN_PLUGINS,
  PluginConfigError,
  PluginConfigStore,
  PluginConfigVersionSchema,
  resolvePluginConfigPath,
} from '@luoome/adapters';

export const cmdPlugins = (
  sub: string | undefined,
  rest: readonly string[],
  flags: ReadonlyMap<string, string | boolean>,
): number => {
  const store = new PluginConfigStore(resolvePluginConfigPath());
  const print = (value: unknown) => console.log(JSON.stringify(value, null, 2));
  try {
    if (flags.has('apply') && flags.get('apply') !== true) throw new Error('invalid apply flag');
    if (sub === 'status') {
      print({ configuration: store.read(), definitions: BUILTIN_PLUGINS, runtime: 'not-started' });
      return 0;
    }
    if (sub === 'init' && !flags.has('apply')) {
      print({ baseline: store.baseline(), configuration: store.read(), committed: false });
      return 0;
    }
    if (sub === 'migrate' && !flags.has('apply')) {
      print({ configuration: store.read(), definitions: BUILTIN_PLUGINS, committed: false });
      return 0;
    }
    if (!['init', 'migrate', 'set'].includes(sub ?? ''))
      throw new Error('用法: luoome plugins init|migrate|status|set');
    if (flags.has('dry-run')) throw new Error('--dry-run 不可与写入操作组合');
    if (process.env.LUOOME_EXPOSE_WRITE !== 'true') {
      print({ ok: false, error: { kind: 'permission_denied', required: 'write' } });
      return 1;
    }
    if (sub === 'init') {
      print({ config: store.initialize(), committed: true });
      return 0;
    }
    const expected = PluginConfigVersionSchema.parse({
      incarnation: flags.get('expected-incarnation'),
      revision: Number(flags.get('expected-revision')),
    });
    if (sub === 'migrate') {
      print({ config: store.migrate(expected), committed: true });
      return 0;
    }
    const id = rest[0];
    const enabled = flags.get('enabled');
    if (id === undefined || (enabled !== 'true' && enabled !== 'false')) {
      throw new Error(
        '用法: luoome plugins set <id> --enabled true|false --expected-incarnation <uuid> --expected-revision <n>',
      );
    }
    print({ config: store.set(id, enabled === 'true', expected), committed: true });
    return 0;
  } catch (error) {
    print({ ok: false, error: error instanceof PluginConfigError ? error.code : 'invalid_input' });
    return 1;
  }
};
