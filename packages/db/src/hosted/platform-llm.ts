import {
  type HostedEntitlement,
  HostedLLMError,
  hostedLLMCost,
  InvariantError,
  type PlatformLLMRepository,
  type ProviderAttempt,
  type Tenant,
  type UsageReservation,
} from '@luoome/core';
import type { PlatformStore } from './platform-store.js';

export const createPlatformLLMRepository = (
  store: PlatformStore,
  entitlement: (tenantId: string, now: Date) => HostedEntitlement | null,
  tenantFor: (id: string, generation?: number) => Tenant,
): PlatformLLMRepository => {
  const reservation = (operationId: string): UsageReservation => {
    const value = store.get('reservations', `llm:${operationId}`);
    if (!value?.llm) throw new InvariantError('llm_reservation_missing');
    return value;
  };
  const attempts = (operationId: string) => store.list('providerAttempts', { operationId });
  return {
    async execution(input) {
      return store.transaction(() => {
        const held = store.get('reservations', `llm:${input.operationId}`);
        if (!held || held.state !== 'held') return true;
        if (!held.llm) throw new InvariantError('llm_reservation_missing');
        if (
          input.action === 'acquire'
            ? held.llm.owner !== input.owner && held.llm.leaseUntil > input.now
            : held.llm.owner !== input.owner || held.llm.leaseUntil <= input.now
        )
          return false;
        store.put('reservations', {
          ...held,
          llm: {
            ...held.llm,
            owner: input.owner,
            leaseUntil: input.action === 'release' ? input.now : input.leaseUntil,
          },
        });
        return true;
      });
    },
    async authorized(tenantId, generation, now) {
      const tenant = store.get('tenants', tenantId);
      return (
        tenant !== null &&
        tenant.generation === generation &&
        tenant.status === 'active' &&
        store.get('users', tenant.ownerUserId)?.status === 'active' &&
        entitlement(tenant.id, now) !== null
      );
    },
    async reserve(input) {
      return store.transaction(() => {
        const tenant = tenantFor(input.tenantId, input.generation);
        if (
          tenant.status !== 'active' ||
          store.get('users', tenant.ownerUserId)?.status !== 'active'
        )
          throw new HostedLLMError('operation_closed');
        const existing = store.get('reservations', `llm:${input.operationId}`);
        if (existing) {
          if (
            existing.tenantId !== input.tenantId ||
            existing.llm?.inputHash !== input.inputHash ||
            existing.llm.generation !== input.generation ||
            existing.llm.pricing.model !== input.pricing.model
          )
            throw new InvariantError('llm_operation_identity_changed');
          if (
            existing.state === 'held' &&
            (existing.llm.owner !== input.owner || existing.llm.leaseUntil <= input.now)
          )
            throw new HostedLLMError('lease_lost');
          return existing;
        }
        const current = entitlement(input.tenantId, input.now);
        if (!current) throw new HostedLLMError('operation_closed');
        if (current.availableUnits < 1) throw new HostedLLMError('quota_exhausted');
        const held = store
          .list('reservations', { periodId: current.period.id })
          .filter((row) => row.llm && row.state === 'held');
        const all = store
          .list('reservations', { periodId: current.period.id })
          .filter((row) => row.llm);
        const spent = all
          .filter((row) => row.state !== 'held')
          .flatMap((row) => attempts(row.operationId))
          .reduce((sum, row) => sum + (row.confirmedCostMicro ?? row.reservedCostMicro), 0);
        const heldCost = held.reduce(
          (sum, row) =>
            sum +
            Math.max(
              row.budgetMicro,
              attempts(row.operationId).reduce(
                (total, attempt) =>
                  total + (attempt.confirmedCostMicro ?? attempt.reservedCostMicro),
                0,
              ),
            ),
          0,
        );
        if (spent + heldCost + input.budgetMicro > input.periodBudgetMicro)
          throw new HostedLLMError('budget_exhausted');
        const value: UsageReservation = {
          id: `llm:${input.operationId}`,
          operationId: input.operationId,
          tenantId: input.tenantId,
          periodId: current.period.id,
          units: 1,
          budgetMicro: input.budgetMicro,
          state: 'held',
          capturedUnits: null,
          createdAt: input.now,
          settledAt: null,
          llm: {
            owner: input.owner,
            leaseUntil: input.leaseUntil,
            inputHash: input.inputHash,
            generation: input.generation,
            pricing: input.pricing,
            periodBudgetMicro: input.periodBudgetMicro,
          },
        };
        store.put('reservations', value);
        return value;
      });
    },
    async find(operationId) {
      return store.get('reservations', `llm:${operationId}`);
    },
    async attempts(operationId) {
      return attempts(operationId);
    },
    async begin(input) {
      return store.transaction(() => {
        const held = reservation(input.operationId);
        if (held.state !== 'held') throw new HostedLLMError('operation_closed');
        const tenant = tenantFor(held.tenantId, held.llm!.generation);
        if (tenant.status !== 'active' || !entitlement(tenant.id, input.now))
          throw new HostedLLMError('operation_closed');
        if (held.llm!.owner !== input.owner || held.llm!.leaseUntil <= input.now)
          throw new HostedLLMError('lease_lost');
        const previous = store.get('providerAttempts', input.id);
        if (previous) {
          if (
            previous.operationId !== input.operationId ||
            previous.requestHash !== input.requestHash
          )
            throw new InvariantError('llm_attempt_identity_changed');
          return previous;
        }
        const rows = attempts(input.operationId);
        if (rows.some((row) => row.usageState !== 'confirmed'))
          throw new HostedLLMError('usage_unknown');
        if (
          rows.reduce((sum, row) => sum + (row.confirmedCostMicro ?? row.reservedCostMicro), 0) +
            input.reservedCostMicro >
          held.budgetMicro
        )
          throw new HostedLLMError('budget_exhausted');
        const row: ProviderAttempt = {
          id: input.id,
          operationId: input.operationId,
          step: 'llm-http',
          attempt: rows.length + 1,
          provider: input.pricing.provider,
          model: input.pricing.model,
          pricing: input.pricing,
          usageState: 'unknown',
          reservedCostMicro: input.reservedCostMicro,
          estimatedCostMicro: null,
          confirmedCostMicro: null,
          pricingVersion: input.pricing.version,
          requestHash: input.requestHash,
          createdAt: input.now,
          updatedAt: input.now,
        };
        store.put('providerAttempts', row);
        return row;
      });
    },
    async complete(input) {
      return store.transaction(() => {
        const row = store.get('providerAttempts', input.id);
        if (!row || row.operationId !== input.operationId || !row.pricing)
          throw new InvariantError('llm_attempt_missing');
        const cost = hostedLLMCost(input.tokens, row.pricing);
        if (row.usageState === 'confirmed') {
          if (
            cost !== row.confirmedCostMicro ||
            JSON.stringify(row.tokens) !== JSON.stringify(input.tokens) ||
            row.receiptId !== input.receiptId
          )
            throw new InvariantError('llm_confirmed_usage_immutable');
          return row;
        }
        const next: ProviderAttempt = {
          ...row,
          usageState: 'confirmed',
          tokens: input.tokens,
          receiptId: input.receiptId,
          confirmedCostMicro: cost,
          updatedAt: input.now,
        };
        store.put('providerAttempts', next);
        return next;
      });
    },
    async settle(input) {
      return store.transaction(() => {
        const held = reservation(input.operationId);
        if (held.state !== 'held') return held;
        if (
          input.executionStopped !== true &&
          (held.llm!.owner !== input.owner || held.llm!.leaseUntil <= input.now)
        )
          throw new HostedLLMError('lease_lost');
        if (attempts(input.operationId).some((row) => row.usageState !== 'confirmed'))
          throw new HostedLLMError('usage_unknown');
        const next: UsageReservation = {
          ...held,
          state: input.capture ? 'captured' : 'released',
          capturedUnits: input.capture ? held.units : null,
          settledAt: input.now,
        };
        if (input.capture)
          store.put('usage', {
            id: `llm-usage:${input.operationId}`,
            operationId: input.operationId,
            tenantId: held.tenantId,
            periodId: held.periodId,
            metric: 'research-units',
            delta: held.units,
            reason: 'capture',
            revision: 1,
            createdAt: input.now,
          });
        store.put('reservations', next);
        return next;
      });
    },
    async costs(input = {}) {
      const rows = new Map<
        string,
        {
          tenantId: string;
          confirmedMicro: number;
          reservedMicro: number;
          unknownAttempts: number;
          confirmedAttempts: number;
          inputTokens: number;
          cachedInputTokens: number;
          outputTokens: number;
        }
      >();
      for (const held of store.list('reservations').filter((row) => row.llm)) {
        const matching = attempts(held.operationId).filter(
          (row) =>
            (!input.since || row.createdAt >= input.since) &&
            (!input.until || row.createdAt <= input.until),
        );
        if (matching.length === 0) continue;
        const row = rows.get(held.tenantId) ?? {
          tenantId: held.tenantId,
          confirmedMicro: 0,
          reservedMicro: 0,
          unknownAttempts: 0,
          confirmedAttempts: 0,
          inputTokens: 0,
          cachedInputTokens: 0,
          outputTokens: 0,
        };
        for (const attempt of matching) {
          if (attempt.usageState !== 'confirmed') {
            row.unknownAttempts++;
            row.reservedMicro += attempt.reservedCostMicro;
          } else {
            row.confirmedAttempts++;
            row.confirmedMicro += attempt.confirmedCostMicro!;
            row.inputTokens += attempt.tokens?.input ?? 0;
            row.cachedInputTokens += attempt.tokens?.cachedInput ?? 0;
            row.outputTokens += attempt.tokens?.output ?? 0;
          }
        }
        rows.set(held.tenantId, row);
      }
      return [...rows.values()].sort((a, b) => a.tenantId.localeCompare(b.tenantId));
    },
  };
};
