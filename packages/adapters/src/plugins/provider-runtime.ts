import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import {
  type DataExecutionScopeLike,
  type ManagedPluginId,
  PluginExecutionDenied,
  type PluginPermit,
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

interface SourceActivity {
  permit: PluginPermit;
  valid(): boolean;
}

export class ProviderRuntime implements DataExecutionScopeLike {
  private readonly scopes = new AsyncLocalStorage<{
    references: number;
    sources: Map<ManagedPluginId, SourceActivity>;
    checks: Set<() => void>;
    keys: Set<string>;
    permissions: Set<(dependency?: ManagedPluginId) => void>;
  }>();
  private readonly activeSources = new Map<ManagedPluginId, Set<SourceActivity>>();
  private readonly descriptions = new Map<
    string,
    { candidates: readonly string[]; dependencies: readonly string[]; ready: () => boolean }
  >();
  activity() {
    return [...this.activeSources].map(([id, permits]) => ({
      id,
      inFlight: permits.size,
      revokedInFlight: [...permits].filter((permit) => !permit.valid()).length,
    }));
  }
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
  private staged: Array<{ check(): void; publish(): void }> | undefined;

  constructor(
    private readonly store: PluginConfigStore,
    readonly coordinator?: MarketRequestCoordinator,
    private readonly externalAllowed = true,
  ) {}

  prepare<T>(build: () => T): { value: T; activate(): void } {
    const pending: Array<{ check(): void; publish(): void }> = [];
    this.staged = pending;
    try {
      const value = build();
      return {
        value,
        activate: () => {
          for (const item of pending) item.check();
          for (const item of pending) item.publish();
        },
      };
    } finally {
      this.staged = undefined;
    }
  }

  async run<T>(
    operation: (validate: () => void) => Promise<T>,
    check?: (dependency?: ManagedPluginId) => void,
    key?: string,
  ): Promise<T> {
    const scope = this.scopes.getStore() ?? {
      references: 0,
      sources: new Map<ManagedPluginId, SourceActivity>(),
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
      if (scope.references === 0)
        for (const [id, permit] of scope.sources) {
          const active = this.activeSources.get(id);
          active?.delete(permit);
          if (active?.size === 0) this.activeSources.delete(id);
        }
    }
  }

  private track(check: () => void): void {
    this.scopes.getStore()?.checks.add(check);
  }
  private validateScope(): void {
    for (const permission of this.scopes.getStore()?.permissions ?? []) permission();
    for (const check of this.scopes.getStore()?.checks ?? []) check();
  }

  private stamp(ids: readonly string[]): string {
    const read = this.store.read();
    return JSON.stringify(
      read.ok
        ? [
            read.config.incarnation,
            ids.map((source) => [
              source,
              read.config.entries[`source.${source}` as ManagedPluginId] ?? null,
            ]),
          ]
        : ['unavailable', read.reason],
    );
  }

  wrap<S extends string, T extends object>(
    route: string,
    candidates: readonly S[],
    build: (enabled: readonly S[], guard: ProviderGuard) => T | undefined,
    dependencies: readonly string[] = [],
  ): T {
    const observed = [...new Set([...candidates, ...dependencies])];
    const routeToken = { id: randomUUID() };
    type Graph = {
      stamp: string;
      sourceStamp: string;
      value: T | undefined;
      guard: ProviderGuard;
      check: () => void;
    };
    let active: Graph | undefined;
    const graphs = new Map<string, Graph>();
    const current = () => {
      const sourceStamp = this.stamp(observed);
      const stamp = JSON.stringify([sourceStamp, [...(this.scopes.getStore()?.keys ?? [])].sort()]);
      const cached = graphs.get(stamp);
      if (cached !== undefined) {
        active = cached;
        return cached;
      }
      for (const [key, graph] of graphs) if (graph.sourceStamp !== sourceStamp) graphs.delete(key);
      const check = () => {
        if (this.routes.get(route) !== routeToken || this.stamp(observed) !== sourceStamp)
          throw new RevokedDataExecution();
      };
      const baseKey = createHash('sha256')
        .update(JSON.stringify([route, routeToken.id, candidates, stamp]))
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
      const enabled = candidates.filter(
        (source) => this.store.acquire(`source.${source}` as ManagedPluginId).ok,
      );
      active = {
        stamp,
        sourceStamp,
        guard,
        check,
        value: enabled.length === 0 ? undefined : build(enabled, guard),
      };
      graphs.set(stamp, active);
      if (graphs.size > 16) {
        const oldest = graphs.keys().next().value;
        if (oldest !== undefined) graphs.delete(oldest);
      }
      return active;
    };
    const prepared = current();
    const publication = {
      check: () => {
        if (this.stamp(observed) !== prepared.sourceStamp) throw new RevokedDataExecution();
      },
      publish: () => {
        this.routes.set(route, routeToken);
        this.descriptions.set(route, {
          candidates,
          dependencies,
          ready: () =>
            (active?.sourceStamp === this.stamp(observed) ? active : current()).value !== undefined,
        });
      },
    };
    if (this.staged === undefined) publication.publish();
    else this.staged.push(publication);
    const proxy = new Proxy({} as T, {
      get: (_target, key) => {
        if (key === 'then') return undefined;
        if (typeof key === 'symbol') return undefined;
        if (['status', 'marketSourceStatus'].includes(String(key)))
          return (...args: unknown[]) => {
            const graph = active?.sourceStamp === this.stamp(observed) ? active : current();
            return graph.value === undefined
              ? []
              : Reflect.apply(
                  Reflect.get(graph.value, key) as (...args: unknown[]) => unknown,
                  graph.value,
                  args,
                );
          };
        const graph = current();
        if (key === 'name')
          return graph.value === undefined
            ? 'providers-unavailable'
            : Reflect.get(graph.value, key);
        if (key === 'sources' && graph.value === undefined) return [];
        const value = graph.value === undefined ? undefined : Reflect.get(graph.value, key);
        if (value !== undefined && typeof value !== 'function') return value;
        return (...args: unknown[]) =>
          this.run(async (validate) => {
            graph.guard.check();
            this.track(graph.check);
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
    this.readiness.set(
      proxy,
      () => (active?.sourceStamp === this.stamp(observed) ? active : current()).value !== undefined,
    );
    return proxy;
  }

  fetchFor(source: string, fetchImpl: typeof fetch = fetch): typeof fetch {
    return (async (input, init) => {
      this.validateScope();
      if (!this.externalAllowed) throw new RevokedDataExecution();
      const actual = marketProviderOf(input, source);
      for (const check of this.scopes.getStore()?.permissions ?? [])
        check(`source.${actual}` as ManagedPluginId);
      const admission = this.store.acquire(`source.${actual}` as ManagedPluginId);
      if (!admission.ok) throw new RevokedDataExecution();
      const check = () => {
        if (!this.store.valid(admission.permit)) throw new RevokedDataExecution();
      };
      check();
      const scope = this.scopes.getStore();
      if (scope !== undefined && !scope.sources.has(admission.permit.id)) {
        const permit = { ...admission.permit };
        const record: SourceActivity = {
          permit,
          valid: () => {
            try {
              for (const permission of scope.permissions) permission();
              for (const guard of scope.checks) guard();
              return this.store.valid(permit);
            } catch {
              return false;
            }
          },
        };
        scope.sources.set(permit.id, record);
        const active = this.activeSources.get(permit.id) ?? new Set<SourceActivity>();
        active.add(record);
        this.activeSources.set(permit.id, active);
      }
      this.track(check);
      const send = ((request, requestInit) => {
        this.validateScope();
        check();
        return fetchImpl(request, requestInit);
      }) as typeof fetch;
      const transport = this.coordinator?.fetchFor(source, send) ?? send;
      const response = await transport(input, init);
      this.validateScope();
      check();
      return response;
    }) as typeof fetch;
  }
}
