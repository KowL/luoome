import type { Database } from 'bun:sqlite';
import type { Tenant } from '@luoome/core';

export type MaintenanceMode = 'open' | 'draining' | 'frozen';
export interface MaintenanceState {
  readonly mode: MaintenanceMode;
  readonly owner: string | null;
  readonly activities: number;
}
export interface MaintenanceLease {
  release(): void;
}
export interface HostedMaintenanceGate {
  state(): MaintenanceState;
  enter(kind: string): MaintenanceLease | null;
  enterExclusive(kind: string): MaintenanceLease | null;
  begin(owner: string): void;
  freeze(owner: string): void;
  finish(owner: string): void;
  registerTenantRuntime(input: {
    tenantId: string;
    ownerUserId: string;
    generation: number;
  }): MaintenanceLease | null;
  runtimeCount(tenantId: string): number;
  recoverStoppedWriters(input: { owner: string; writersStopped: boolean }): void;
}

const sameOwner = (state: MaintenanceState, owner: string) => {
  if (state.owner !== owner) throw new Error('maintenance_owner_conflict');
};

export const createSqliteMaintenanceGate = (sqlite: Database): HostedMaintenanceGate => {
  sqlite.exec(`CREATE TABLE IF NOT EXISTS hosted_maintenance (
    id INTEGER PRIMARY KEY CHECK (id = 1), mode TEXT NOT NULL, owner TEXT
  ); CREATE TABLE IF NOT EXISTS hosted_write_activities (
    id TEXT PRIMARY KEY, kind TEXT NOT NULL, started_at INTEGER NOT NULL
  ); INSERT OR IGNORE INTO hosted_maintenance (id, mode, owner) VALUES (1, 'open', NULL);`);
  const state = (): MaintenanceState => {
    const row = sqlite.query('SELECT mode, owner FROM hosted_maintenance WHERE id = 1').get() as {
      mode: MaintenanceMode;
      owner: string | null;
    };
    const count = sqlite
      .query(
        "SELECT COUNT(*) AS count FROM hosted_write_activities WHERE kind NOT LIKE 'open-runtime:%'",
      )
      .get() as { count: number };
    return { ...row, activities: count.count };
  };
  const transaction = <T>(run: () => T): T => sqlite.transaction(run).immediate();
  const register = (kind: string): MaintenanceLease => {
    const id = crypto.randomUUID();
    sqlite
      .query('INSERT INTO hosted_write_activities (id, kind, started_at) VALUES (?, ?, ?)')
      .run(id, kind, Date.now());
    let released = false;
    return {
      release: () => {
        if (released) return;
        sqlite.query('DELETE FROM hosted_write_activities WHERE id = ?').run(id);
        released = true;
      },
    };
  };
  return {
    state,
    enter: (kind) =>
      transaction(() => {
        if (state().mode !== 'open') return null;
        return register(kind);
      }),
    enterExclusive: (kind) =>
      transaction(() => {
        if (state().mode !== 'open') return null;
        const active = sqlite
          .query('SELECT COUNT(*) AS count FROM hosted_write_activities WHERE kind = ?')
          .get(kind) as { count: number };
        return active.count === 0 ? register(kind) : null;
      }),
    begin: (owner) =>
      transaction(() => {
        const current = state();
        if (current.mode !== 'open') sameOwner(current, owner);
        sqlite
          .query("UPDATE hosted_maintenance SET mode = 'draining', owner = ? WHERE id = 1")
          .run(owner);
      }),
    freeze: (owner) =>
      transaction(() => {
        const current = state();
        sameOwner(current, owner);
        if (current.mode !== 'draining' || current.activities !== 0)
          throw new Error('maintenance_not_drained');
        sqlite.query("UPDATE hosted_maintenance SET mode = 'frozen' WHERE id = 1").run();
      }),
    finish: (owner) =>
      transaction(() => {
        sameOwner(state(), owner);
        sqlite
          .query("UPDATE hosted_maintenance SET mode = 'open', owner = NULL WHERE id = 1")
          .run();
      }),
    registerTenantRuntime: (input) =>
      transaction(() => {
        if (state().mode !== 'open') return null;
        const row = sqlite
          .query('SELECT value_json FROM hosted_tenants WHERE id = ?')
          .get(input.tenantId) as { value_json: string } | null;
        if (row === null) return null;
        const tenant = JSON.parse(row.value_json) as Tenant;
        if (
          tenant.ownerUserId !== input.ownerUserId ||
          tenant.generation !== input.generation ||
          !['active', 'suspended', 'provisioning'].includes(tenant.status)
        )
          return null;
        return register(`open-runtime:${input.tenantId}`);
      }),
    runtimeCount: (tenantId) =>
      (
        sqlite
          .query('SELECT COUNT(*) AS count FROM hosted_write_activities WHERE kind = ?')
          .get(`open-runtime:${tenantId}`) as { count: number }
      ).count,
    recoverStoppedWriters: ({ owner, writersStopped }) =>
      transaction(() => {
        if (!writersStopped) throw new Error('maintenance_recovery_requires_stopped_writers');
        sqlite.query('DELETE FROM hosted_write_activities').run();
        sqlite
          .query("UPDATE hosted_maintenance SET mode = 'frozen', owner = ? WHERE id = 1")
          .run(owner);
      }),
  };
};

export const createMemoryMaintenanceGate = (
  tenantById?: (id: string) => Tenant | null,
): HostedMaintenanceGate => {
  let mode: MaintenanceMode = 'open';
  let owner: string | null = null;
  const activities = new Map<string, string>();
  const state = () => ({
    mode,
    owner,
    activities: [...activities.values()].filter((kind) => !kind.startsWith('open-runtime:')).length,
  });
  const register = (kind: string) => {
    const id = crypto.randomUUID();
    activities.set(id, kind);
    return {
      release: () => {
        activities.delete(id);
      },
    };
  };
  return {
    state,
    enter: (kind) => {
      if (mode !== 'open') return null;
      return register(kind);
    },
    enterExclusive: (kind) => {
      if (mode !== 'open' || [...activities.values()].includes(kind)) return null;
      return register(kind);
    },
    begin: (nextOwner) => {
      if (mode !== 'open') sameOwner(state(), nextOwner);
      owner = nextOwner;
      mode = 'draining';
    },
    freeze: (expectedOwner) => {
      sameOwner(state(), expectedOwner);
      if (mode !== 'draining' || state().activities !== 0)
        throw new Error('maintenance_not_drained');
      mode = 'frozen';
    },
    finish: (expectedOwner) => {
      sameOwner(state(), expectedOwner);
      mode = 'open';
      owner = null;
    },
    registerTenantRuntime: (input) => {
      const tenant = tenantById?.(input.tenantId);
      if (
        mode !== 'open' ||
        tenant === undefined ||
        tenant === null ||
        tenant.ownerUserId !== input.ownerUserId ||
        tenant.generation !== input.generation ||
        !['active', 'suspended', 'provisioning'].includes(tenant.status)
      )
        return null;
      return register(`open-runtime:${input.tenantId}`);
    },
    runtimeCount: (tenantId) =>
      [...activities.values()].filter((kind) => kind === `open-runtime:${tenantId}`).length,
    recoverStoppedWriters: (input) => {
      if (!input.writersStopped) throw new Error('maintenance_recovery_requires_stopped_writers');
      activities.clear();
      mode = 'frozen';
      owner = input.owner;
    },
  };
};
