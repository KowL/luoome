import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import {
  type DataExecutionScopeLike,
  type ManagedPluginId,
  PluginExecutionDenied,
} from '@luoome/core';
import { type MarketRequestCoordinator, marketProviderOf } from '../market/request-coordinator.js';
import { SourceExecutionError } from '../source-error.js';
import type { PluginConfigStore } from './config.js';

export class RevokedDataExecution extends PluginExecutionDenied {
  constructor() {
    super('data:activation');
  }
}
export interface ProviderGuard {
  readonly key: string;
  check(): void;
}

export class ProviderRuntime implements DataExecutionScopeLike {
  private readonly scopes = new AsyncLocalStorage<{
    references: number;
    checks: Set<() => void>;
    keys: Set<string>;
    permissions: Set<(dependency?: ManagedPluginId) => void>;
  }>();
  private readonly descriptions = new Map<
    string,
    { candidates: readonly string[]; dependencies: readonly string[]; ready: () => boolean }
  >();
  describe() {
    return [...this.descriptions].map(([route, value]) => {
      let ready = false;
      try {
        ready = value.ready();
      } catch {}
      return { route, candidates: value.candidates, dependencies: value.dependencies, ready };
    });
  }
  private readonly readiness = new WeakMap<object, () => boolean>();

  ready(port: object | undefined): boolean {
    return port !== undefined && (this.readiness.get(port)?.() ?? true);
  }

  private readonly routes = new Map<string, object>();

  constructor(
    private readonly store: PluginConfigStore,
    readonly coordinator?: MarketRequestCoordinator,
    private readonly externalAllowed = true,
  ) {}

  prepare<T>(build: () => T): { value: T; activate(): void } {
    const value = build();
    return { value, activate: () => {} };
  }

  async run<T>(
    operation: (validate: () => void) => Promise<T>,
    check?: (dependency?: ManagedPluginId) => void,
    key?: string,
  ): Promise<T> {
    const scope = this.scopes.getStore() ?? {
      references: 0,
      checks: new Set<() => void>(),
      keys: new Set<string>(),
      permissions: new Set<(dependency?: ManagedPluginId) => void>(),
    };
    if (key) scope.keys.add(key);
    if (check !== undefined) scope.permissions.add(check);
    const validate = () => {
      for (const permission of scope.permissions) permission();
      for (const guard of scope.checks) guard();
    };
    scope.references++;
    try {
      return await this.scopes.run(scope, () => operation(validate));
    } finally {
      scope.references--;
    }
  }

  private track(check: () => void): void {
    this.scopes.getStore()?.checks.add(check);
  }
  private validateScope(): void {
    for (const permission of this.scopes.getStore()?.permissions ?? []) permission();
    for (const check of this.scopes.getStore()?.checks ?? []) check();
  }

  private enabledSources(candidates: readonly string[]): string[] {
    const read = this.store.read();
    if (!read.ok) return [];
    return candidates.filter(
      (source) => read.config.entries[`source.${source}` as ManagedPluginId]?.enabled === true,
    );
  }

  wrap<S extends string, T extends object>(
    route: string,
    candidates: readonly S[],
    build: (enabled: readonly S[], guard: ProviderGuard) => T | undefined,
    dependencies: readonly string[] = [],
  ): T {
    const routeToken = { id: randomUUID() };
    type Graph = { value: T | undefined; guard: ProviderGuard };
    const graphs = new Map<string, Graph>();
    const check = () => {
      if (this.routes.get(route) !== routeToken) throw new RevokedDataExecution();
    };
    const buildGraph = (enabled: readonly S[]): Graph => {
      const baseKey = createHash('sha256')
        .update(JSON.stringify([route, routeToken.id, candidates, enabled]))
        .digest('hex');
      const scopeKey = () =>
        JSON.stringify([baseKey, [...(this.scopes.getStore()?.keys ?? [])].sort()]);
      const guard: ProviderGuard = {
        get key() {
          return scopeKey();
        },
        check: () => {
          this.validateScope();
          check();
        },
      };
      return { value: enabled.length === 0 ? undefined : build(enabled, guard), guard };
    };
    const current = (): Graph => {
      const enabled = this.enabledSources(candidates) as S[];
      const key = enabled.join(',');
      const cached = graphs.get(key);
      if (cached !== undefined) return cached;
      graphs.clear();
      const graph = buildGraph(enabled);
      graphs.set(key, graph);
      return graph;
    };
    const initial = current();
    const value = initial.value;
    this.routes.set(route, routeToken);
    this.descriptions.set(route, {
      candidates,
      dependencies,
      ready: () => value !== undefined,
    });
    const proxy = new Proxy({} as T, {
      get: (_target, key) => {
        if (key === 'then') return undefined;
        if (typeof key === 'symbol') return undefined;
        if (['status', 'marketSourceStatus'].includes(String(key)))
          return (...args: unknown[]) =>
            current().value === undefined
              ? []
              : Reflect.apply(
                  Reflect.get(current().value as T, key) as (...args: unknown[]) => unknown,
                  current().value as T,
                  args,
                );
        if (key === 'name')
          return current().value === undefined
            ? 'providers-unavailable'
            : Reflect.get(current().value as T, key);
        if (key === 'sources' && current().value === undefined) return [];
        const member =
          current().value === undefined ? undefined : Reflect.get(current().value as T, key);
        if (member !== undefined && typeof member !== 'function') return member;
        return (...args: unknown[]) =>
          this.run(async (validate) => {
            const graph = current();
            graph.guard.check();
            this.track(check);
            validate();
            if (graph.value === undefined)
              throw new SourceExecutionError('no_data', 'no ready data providers');
            const result = await Reflect.apply(
              Reflect.get(graph.value, key) as (...args: unknown[]) => unknown,
              graph.value,
              args,
            );
            validate();
            return result;
          });
      },
    });
    this.readiness.set(proxy, () => current().value !== undefined);
    return proxy;
  }

  fetchFor(
    source: string,
    fetchImpl: typeof fetch = fetch,
    options: { readonly bulk?: boolean } = {},
  ): typeof fetch {
    return (async (input, init) => {
      this.validateScope();
      if (!this.externalAllowed) throw new RevokedDataExecution();
      const actual = marketProviderOf(input, source);
      for (const check of this.scopes.getStore()?.permissions ?? [])
        check(`source.${actual}` as ManagedPluginId);
      if (!this.store.isEnabled(`source.${actual}` as ManagedPluginId))
        throw new RevokedDataExecution();
      const send = ((request, requestInit) => {
        this.validateScope();
        return fetchImpl(request, requestInit);
      }) as typeof fetch;
      const transport = this.coordinator?.fetchFor(source, send, options) ?? send;
      const response = await transport(input, init);
      this.validateScope();
      return response;
    }) as typeof fetch;
  }
}
