import { timingSafeEqual } from 'node:crypto';
import {
  assertHostedExportMetadata,
  assertHostedJobInvariants,
  assertProviderAttemptInvariants,
  assertSubscriptionPeriodInvariants,
  assertTenantTransition,
  assertUsageReservationInvariants,
  type DeliveryIntent,
  defaultNotificationPreferences,
  type FencedJobInput,
  type HostedDeletion,
  type HostedEntitlement,
  type HostedExportMetadata,
  type HostedJob,
  type HostedSession,
  InvariantError,
  isHostedJobTerminal,
  type NotificationPreferences,
  PlatformAccessDeniedError,
  PlatformLeaseLostError,
  type PlatformRepositoryRegistry,
  type Tenant,
  type TenantTombstone,
  type UsageReservation,
} from '@luoome/core';
import { createPlatformPayments } from './platform-payments.js';
import type { PlatformStore } from './platform-store.js';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const digestEquals = (left: string, right: string): boolean => {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
};
const sameValue = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

export const createPlatformRepositories = (store: PlatformStore): PlatformRepositoryRegistry => {
  const tenantFor = (id: string, generation?: number): Tenant => {
    const tenant = store.get('tenants', id);
    if (tenant === null) throw new InvariantError('tenant not found');
    if (generation !== undefined && generation !== tenant.generation) {
      throw new InvariantError('tenant generation changed');
    }
    return tenant;
  };
  const revokeUser = (userId: string, now: Date): void => {
    for (const session of store.list('sessions', { userId })) {
      if (session.revokedAt === null) store.put('sessions', { ...session, revokedAt: now });
    }
  };
  const reservationFor = (operationId: string): UsageReservation | null =>
    store.list('reservations', { operationId })[0] ?? null;
  const pendingPeriodAuthorized = (job: HostedJob, now: Date): boolean => {
    if (job.kind === 'provision-tenant') return true;
    const reservation = reservationFor(job.operationId);
    const period = reservation === null ? null : store.get('periods', reservation.periodId);
    return (
      reservation?.state === 'held' &&
      period !== null &&
      ['trial', 'paid'].includes(period.status) &&
      period.startsAt <= now &&
      period.endsAt > now
    );
  };
  const release = (operationId: string, now: Date): UsageReservation | null => {
    const reservation = reservationFor(operationId);
    if (reservation?.state !== 'held') return reservation;
    const next: UsageReservation = { ...reservation, state: 'released', settledAt: now };
    assertUsageReservationInvariants(next);
    store.put('reservations', next);
    return next;
  };
  const entitlement = (tenantId: string, now: Date): HostedEntitlement | null => {
    const periods = store
      .list('periods', { tenantId })
      .filter(
        (period) =>
          ['paid', 'trial'].includes(period.status) &&
          period.startsAt <= now &&
          period.endsAt > now,
      )
      .sort((a, b) => b.startsAt.getTime() - a.startsAt.getTime());
    const period = periods[0];
    if (period === undefined) return null;
    const plan = store.get('plans', period.planVersionId);
    if (plan === null) throw new InvariantError('subscription plan is missing');
    const capturedUnits = store
      .list('usage', { periodId: period.id })
      .reduce((sum, entry) => sum + entry.delta, 0);
    const heldUnits = store
      .list('reservations', { periodId: period.id })
      .filter((item) => item.state === 'held')
      .reduce((sum, item) => sum + item.units, 0);
    return {
      period,
      plan,
      capturedUnits,
      heldUnits,
      availableUnits: plan.limits.researchUnits - capturedUnits - heldUnits,
    };
  };
  const validateFence = (input: FencedJobInput): HostedJob => {
    const job = store.get('jobs', input.id);
    if (
      job === null ||
      job.state !== 'running' ||
      job.fence !== input.fence ||
      job.attemptId !== input.attemptId ||
      job.leaseExpiresAt === null ||
      job.leaseExpiresAt <= input.now
    ) {
      throw new PlatformLeaseLostError('job lease lost before commit');
    }
    tenantFor(job.tenantId, job.generation);
    return job;
  };
  const clearLease = (job: HostedJob): HostedJob => ({
    ...job,
    leaseOwner: null,
    leaseExpiresAt: null,
  });
  const cancelPending = (job: HostedJob, now: Date, reason: string): HostedJob => {
    if (!['preparing', 'queued'].includes(job.state)) return job;
    if (job.attempt > 0 && reservationFor(job.operationId)?.state === 'held') {
      const next: HostedJob = {
        ...clearLease(job),
        cancellationRequestedAt: now,
        errorKind: 'receipt-reconciliation',
        updatedAt: now,
      };
      store.put('jobs', next);
      return next;
    }
    const next = {
      ...clearLease(job),
      state: 'cancelled' as const,
      errorKind: reason,
      updatedAt: now,
    };
    release(job.operationId, now);
    store.put('jobs', next);
    return next;
  };
  const suppressTenantDeliveries = (tenantId: string, now: Date): void => {
    for (const delivery of store.list('deliveries', { tenantId })) {
      if (['pending', 'failed'].includes(delivery.state)) {
        store.put('deliveries', {
          ...delivery,
          state: 'suppressed',
          updatedAt: now,
          errorKind: 'tenant-unavailable',
        });
      }
    }
  };

  const beginTenantDeletion = (current: Tenant, now: Date): Tenant => {
    if (current.status === 'deleting') return current;
    assertTenantTransition(current.status, 'deleting');
    const tenant: Tenant = {
      ...current,
      status: 'deleting',
      generation: current.generation + 1,
      updatedAt: now,
    };
    store.put('tenants', tenant);
    revokeUser(tenant.ownerUserId, now);
    for (const job of store.list('jobs', { tenantId: tenant.id })) {
      if (job.state === 'running')
        store.put('jobs', { ...job, cancellationRequestedAt: now, updatedAt: now });
      else cancelPending(job, now, 'tenant-deleting');
    }
    for (const metadata of store.list('exports', { tenantId: tenant.id }))
      store.put('exports', {
        ...metadata,
        state: 'expired',
        artifactRef: null,
        errorKind: 'tenant-deleting',
      });
    suppressTenantDeliveries(tenant.id, now);
    return tenant;
  };

  const eraseTenantControlData = (current: Tenant, tombstone: TenantTombstone, now: Date): void => {
    const user = store.get('users', current.ownerUserId);
    if (user !== null) {
      for (const challenge of store.list('challenges', { emailKey: user.emailKey }))
        store.remove('challenges', challenge.id);
      for (const session of store.list('sessions', { userId: user.id }))
        store.remove('sessions', session.id);
      store.put('users', {
        ...user,
        email: null,
        emailKey: `deleted:${user.id}`,
        status: 'deleted',
        updatedAt: now,
      });
    }
    for (const job of store.list('jobs', { tenantId: current.id })) {
      release(job.operationId, now);
      store.put('jobs', {
        ...clearLease(job),
        state: 'cancelled',
        fence: job.fence + 1,
        attemptId: null,
        payloadRef: null,
        resultRef: null,
        resultHash: null,
        errorKind: 'tenant-deleted',
        updatedAt: now,
      });
    }
    for (const delivery of store.list('deliveries', { tenantId: current.id }))
      store.remove('deliveries', delivery.id);
    store.remove('preferences', current.id);
    for (const event of store.list('inbox', { tenantId: current.id }))
      store.remove('inbox', event.id);
    for (const metadata of store.list('exports', { tenantId: current.id }))
      store.remove('exports', metadata.id);
    for (const deletion of store.list('deletions', { tenantId: current.id }))
      store.put('deletions', {
        ...deletion,
        state: 'completed',
        generation: tombstone.generation,
        completedAt: tombstone.deletedAt,
        errorKind: null,
      });
    store.put('tombstones', tombstone);
    store.put('tenants', {
      ...current,
      status: 'deleted',
      generation: tombstone.generation,
      provisioningErrorKind: null,
      deletedAt: tombstone.deletedAt,
      updatedAt: now,
    });
  };

  const completeTenantDeletion = (current: Tenant, now: Date): TenantTombstone => {
    if (current.status === 'deleted') {
      const tombstone = store.get('tombstones', current.id);
      if (tombstone === null) throw new InvariantError('deleted tenant has no tombstone');
      return tombstone;
    }
    assertTenantTransition(current.status, 'deleted');
    if (
      store.list('jobs', { tenantId: current.id }).some((job) => job.state === 'running') ||
      store
        .list('deliveries', { tenantId: current.id })
        .some((delivery) => delivery.state === 'sending')
    )
      throw new InvariantError('tenant execution is not drained');
    const tombstone = { id: current.id, generation: current.generation, deletedAt: now };
    eraseTenantControlData(current, tombstone, now);
    return tombstone;
  };

  const registry: PlatformRepositoryRegistry = {
    privacy: {
      async requestExport({ metadata, userId, now }) {
        return store.transaction(() => {
          const tenant = tenantFor(metadata.tenantId, metadata.generation);
          if (
            tenant.ownerUserId !== userId ||
            store.get('users', userId)?.status !== 'active' ||
            !['active', 'suspended'].includes(tenant.status)
          )
            throw new PlatformAccessDeniedError('privacy:tenant-owner');
          assertHostedExportMetadata(metadata);
          const existing = store.list('exports', {
            tenantId: tenant.id,
            requestId: metadata.requestId,
          })[0];
          if (existing !== undefined) {
            if (
              existing.inputHash !== metadata.inputHash ||
              existing.generation !== metadata.generation
            )
              throw new InvariantError('export request id reused with different content');
            return { export: existing, replayed: true };
          }
          if (
            metadata.state !== 'requested' ||
            metadata.createdAt.getTime() !== now.getTime() ||
            metadata.artifactRef !== null ||
            metadata.resultHash !== null ||
            metadata.byteLength !== null ||
            metadata.completedAt !== null ||
            metadata.errorKind !== null
          )
            throw new InvariantError('export initial metadata is invalid');
          if (
            store.get('exports', metadata.id) !== null ||
            store.list('exports', { operationId: metadata.operationId }).length > 0
          )
            throw new InvariantError('export identity already exists');
          store.put('exports', metadata);
          return { export: metadata, replayed: false };
        });
      },
      async findExport({ id, tenantId, generation, now }) {
        const tenant = store.get('tenants', tenantId);
        const metadata = store.get('exports', id);
        if (
          metadata === null ||
          metadata.tenantId !== tenantId ||
          metadata.generation !== generation ||
          tenant?.generation !== generation ||
          !['active', 'suspended'].includes(tenant.status)
        )
          return null;
        return metadata.expiresAt <= now
          ? { ...metadata, state: 'expired', artifactRef: null }
          : metadata;
      },
      async listExports({ tenantId, states }) {
        return store
          .list('exports', tenantId === undefined ? {} : { tenantId })
          .filter((metadata) => states === undefined || states.includes(metadata.state))
          .sort(
            (a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id),
          );
      },
      async completeExport({ id, generation, resultHash, byteLength, now }) {
        return store.transaction(() => {
          const metadata = store.get('exports', id);
          if (metadata === null) throw new InvariantError('export not found');
          const tenant = tenantFor(metadata.tenantId, generation);
          if (
            metadata.generation !== generation ||
            !['active', 'suspended'].includes(tenant.status)
          )
            throw new PlatformAccessDeniedError('privacy:tenant-owner');
          if (metadata.expiresAt <= now || metadata.state === 'expired')
            throw new InvariantError('export has expired');
          if (metadata.state === 'ready') {
            if (metadata.resultHash !== resultHash || metadata.byteLength !== byteLength)
              throw new InvariantError('export artifact receipt is immutable');
            return metadata;
          }
          const next: HostedExportMetadata = {
            ...metadata,
            state: 'ready',
            artifactRef: metadata.id,
            resultHash,
            byteLength,
            completedAt: now,
            errorKind: null,
          };
          assertHostedExportMetadata(next);
          store.put('exports', next);
          return next;
        });
      },
      async failExport({ id, errorKind, now }) {
        return store.transaction(() => {
          const metadata = store.get('exports', id);
          if (metadata === null) throw new InvariantError('export not found');
          if (metadata.state !== 'requested') return metadata;
          const next: HostedExportMetadata = {
            ...metadata,
            state: metadata.expiresAt <= now ? 'expired' : 'failed',
            artifactRef: null,
            errorKind,
          };
          store.put('exports', next);
          return next;
        });
      },
      async expireExports(now) {
        return store.transaction(() =>
          store
            .list('exports')
            .filter((metadata) => metadata.expiresAt <= now)
            .map((metadata) => {
              const next: HostedExportMetadata = {
                ...metadata,
                state: 'expired',
                artifactRef: null,
              };
              if (metadata.state !== 'expired') store.put('exports', next);
              return next;
            }),
        );
      },
      async requestDeletion(input) {
        return store.transaction(() => {
          const existing = store.list('deletions', { tenantId: input.tenantId })[0];
          const current = tenantFor(input.tenantId);
          if (current.ownerUserId !== input.userId || input.confirmationTenantId !== current.id)
            throw new PlatformAccessDeniedError('privacy:tenant-confirmation');
          if (existing !== undefined) {
            if (existing.requestId !== input.requestId || existing.userId !== input.userId)
              throw new InvariantError('tenant deletion request already exists');
            return { deletion: existing, tenant: current, replayed: true };
          }
          const session = store.get('sessions', input.sessionId);
          if (
            store.get('users', input.userId)?.status !== 'active' ||
            session === null ||
            session.userId !== input.userId ||
            session.tenantId !== current.id ||
            session.revokedAt !== null ||
            session.idleExpiresAt <= input.now ||
            session.absoluteExpiresAt <= input.now ||
            session.createdAt > input.now ||
            input.now.getTime() - session.createdAt.getTime() > 10 * 60_000
          )
            throw new PlatformAccessDeniedError('auth:recent-verification');
          if (current.generation !== input.generation)
            throw new InvariantError('tenant generation changed');
          if (store.get('deletions', input.id) !== null)
            throw new InvariantError('deletion identity already exists');
          const tenant = beginTenantDeletion(current, input.now);
          const deletion: HostedDeletion = {
            id: input.id,
            tenantId: tenant.id,
            userId: input.userId,
            generation: tenant.generation,
            requestId: input.requestId,
            state: 'draining',
            createdAt: input.now,
            completedAt: null,
            errorKind: null,
          };
          store.put('deletions', deletion);
          return { deletion, tenant, replayed: false };
        });
      },
      async listDeletions({ states }) {
        return store
          .list('deletions')
          .filter((deletion) => states === undefined || states.includes(deletion.state));
      },
      async markDeletionNeedsReview({ id, errorKind, now }) {
        return store.transaction(() => {
          const deletion = store.get('deletions', id);
          if (deletion === null) throw new InvariantError('deletion not found');
          if (deletion.state === 'completed') return deletion;
          if (now < deletion.createdAt)
            throw new InvariantError('deletion review predates request');
          const next: HostedDeletion = { ...deletion, state: 'needs-review', errorKind };
          store.put('deletions', next);
          return next;
        });
      },
      async completeDeletion({ id, generation, now }) {
        return store.transaction(() => {
          const deletion = store.get('deletions', id);
          if (deletion === null || deletion.generation !== generation)
            throw new InvariantError('deletion identity or generation mismatch');
          const tombstone = completeTenantDeletion(tenantFor(deletion.tenantId, generation), now);
          return { deletion: store.get('deletions', id)!, tombstone };
        });
      },
    },
    recovery: {
      async prepareRestore({ now, tombstones }) {
        return store.transaction(() => {
          const result = {
            revokedSessions: 0,
            invalidatedChallenges: 0,
            fencedJobs: 0,
            suppressedDeliveries: 0,
            unknownDeliveries: 0,
            appliedTombstones: 0,
          };
          for (const session of store.list('sessions')) {
            if (session.revokedAt !== null) continue;
            store.put('sessions', { ...session, revokedAt: now });
            result.revokedSessions++;
          }
          for (const challenge of store.list('challenges')) {
            if (challenge.invalidatedAt !== null) continue;
            store.put('challenges', { ...challenge, invalidatedAt: now });
            result.invalidatedChallenges++;
          }
          for (const job of store.list('jobs')) {
            if (
              ['preparing', 'queued'].includes(job.state) &&
              job.attempt === 0 &&
              job.kind !== 'provision-tenant'
            ) {
              cancelPending(job, now, 'restored-cancelled-before-execution');
              continue;
            }
            if (
              job.kind === 'provision-tenant' &&
              !isHostedJobTerminal(job.state) &&
              job.state !== 'needs-review'
            ) {
              store.put('jobs', {
                ...clearLease(job),
                state: 'needs-review',
                fence: job.fence + 1,
                attemptId: null,
                errorKind: 'restored-reconciliation',
                updatedAt: now,
              });
              result.fencedJobs++;
              continue;
            }
            if (job.state !== 'running' && !(job.state === 'queued' && job.attempt > 0)) continue;
            store.put('jobs', {
              ...clearLease(job),
              state: 'needs-review',
              fence: job.fence + 1,
              attemptId: null,
              errorKind: 'restored-reconciliation',
              updatedAt: now,
            });
            result.fencedJobs++;
          }
          for (const delivery of store.list('deliveries')) {
            if (['pending', 'failed'].includes(delivery.state)) {
              store.put('deliveries', {
                ...delivery,
                state: 'suppressed',
                errorKind: 'restored-reconciliation',
                updatedAt: now,
              });
              result.suppressedDeliveries++;
            } else if (delivery.state === 'sending') {
              store.put('deliveries', {
                ...delivery,
                state: 'unknown',
                errorKind: 'restored-reconciliation',
                updatedAt: now,
              });
              result.unknownDeliveries++;
            }
          }
          for (const metadata of store.list('exports')) {
            if (metadata.state !== 'expired')
              store.put('exports', {
                ...metadata,
                state: 'expired',
                artifactRef: null,
                errorKind: 'restored-reconciliation',
              });
          }
          for (const incoming of tombstones) {
            const current = store.get('tenants', incoming.id);
            const previous = store.get('tombstones', incoming.id);
            const tombstone: TenantTombstone = {
              ...incoming,
              generation: Math.max(
                incoming.generation,
                current?.generation ?? 1,
                previous?.generation ?? 1,
              ),
              deletedAt:
                previous !== null && previous.deletedAt < incoming.deletedAt
                  ? previous.deletedAt
                  : incoming.deletedAt,
            };
            if (current === null) store.put('tombstones', tombstone);
            else eraseTenantControlData(current, tombstone, now);
            result.appliedTombstones++;
          }
          return result;
        });
      },
    },
    notifications: {
      async findPreferences(tenantId) {
        return store.get('preferences', tenantId);
      },
      async savePreferences({
        tenantId,
        userId,
        expectedRevision,
        emailEnabled,
        detail,
        quietHours,
        now,
      }) {
        return store.transaction(() => {
          const tenant = tenantFor(tenantId);
          const user = store.get('users', userId);
          if (
            tenant.ownerUserId !== userId ||
            user?.status !== 'active' ||
            ['deleting', 'deleted'].includes(tenant.status)
          )
            throw new PlatformAccessDeniedError('tenant:owner');
          if (emailEnabled && (user.email === null || user.verifiedAt > now))
            throw new PlatformAccessDeniedError('notification:verified-email');
          const current = store.get('preferences', tenantId);
          if ((current?.revision ?? 0) !== expectedRevision)
            throw new InvariantError('notification preferences revision changed');
          const base = current ?? defaultNotificationPreferences(tenantId, userId, now);
          const next: NotificationPreferences = {
            ...base,
            emailEnabled,
            detail,
            quietHours,
            revision: base.revision + 1,
            bindingVersion: current === null ? 1 : base.bindingVersion + 1,
            updatedAt: now,
          };
          store.put('preferences', next);
          return next;
        });
      },
    },
    payments: createPlatformPayments(store, (periodId, now) => {
      for (const reservation of store.list('reservations', { periodId })) {
        const job = store.list('jobs', { operationId: reservation.operationId })[0];
        if (job !== undefined) cancelPending(job, now, 'subscription-revoked');
      }
    }),
    auth: {
      async findUserById(id) {
        return store.get('users', id);
      },
      async createChallenge({ challenge, now, limits }) {
        return store.transaction(() => {
          if (
            challenge.createdAt.getTime() !== now.getTime() ||
            challenge.expiresAt <= now ||
            challenge.expiresAt.getTime() - now.getTime() > 5 * 60 * 1000 ||
            challenge.attempts !== 0 ||
            challenge.consumedAt !== null ||
            challenge.invalidatedAt !== null
          ) {
            throw new InvariantError('challenge lifetime or initial state is invalid');
          }
          if (store.get('challenges', challenge.id) !== null)
            throw new InvariantError('challenge id already exists');
          const all = store.list('challenges');
          const email = all.filter((item) => item.emailKey === challenge.emailKey);
          const recent = (items: typeof all, milliseconds: number) =>
            items.filter((item) => item.createdAt.getTime() > now.getTime() - milliseconds).length;
          if (
            recent(email, limits.cooldownSeconds * 1000) > 0 ||
            recent(email, HOUR) >= limits.emailHourly ||
            recent(email, DAY) >= limits.emailDaily ||
            recent(
              all.filter((item) => item.ipHash === challenge.ipHash),
              HOUR,
            ) >= limits.ipHourly ||
            recent(all, HOUR) >= limits.globalHourly
          ) {
            return { accepted: false };
          }
          for (const old of email) {
            if (
              old.purpose === challenge.purpose &&
              old.consumedAt === null &&
              old.invalidatedAt === null
            ) {
              store.put('challenges', { ...old, invalidatedAt: now });
            }
          }
          store.put('challenges', challenge);
          return { accepted: true };
        });
      },
      async findChallenge(id) {
        return store.get('challenges', id);
      },
      async setChallengeDelivery({ id, state, providerMessageId, now }) {
        store.transaction(() => {
          const challenge = store.get('challenges', id);
          if (challenge === null) throw new InvariantError('challenge not found');
          if (challenge.deliveryState === 'accepted' && state !== 'accepted')
            throw new InvariantError('accepted challenge delivery cannot regress');
          store.put('challenges', {
            ...challenge,
            deliveryState: state,
            providerMessageId: providerMessageId ?? challenge.providerMessageId,
            invalidatedAt: state === 'failed' ? now : challenge.invalidatedAt,
          });
        });
      },
      async consumeChallengeAndCreateSession(input) {
        return store.transaction(() => {
          const { now } = input;
          const challenge = store.get('challenges', input.challengeId);
          if (
            challenge === null ||
            challenge.expiresAt <= now ||
            challenge.consumedAt !== null ||
            challenge.invalidatedAt !== null ||
            challenge.attempts >= 5 ||
            challenge.deliveryState === 'failed'
          )
            return { authenticated: false as const };
          const attempted = { ...challenge, attempts: challenge.attempts + 1 };
          store.put('challenges', attempted);
          if (!digestEquals(challenge.digest, input.digest))
            return { authenticated: false as const };
          let user = store.list('users', { emailKey: challenge.emailKey })[0];
          let tenant =
            user === undefined ? undefined : store.list('tenants', { ownerUserId: user.id })[0];
          if (
            user !== undefined &&
            (user.status !== 'active' ||
              tenant === undefined ||
              ['deleting', 'deleted'].includes(tenant.status))
          )
            return { authenticated: false as const };
          if (
            user === undefined &&
            (challenge.purpose === 'reauth' ||
              !input.registration.enabled ||
              store.list('users').filter((item) => item.status !== 'deleted').length >=
                input.registration.maxUsers)
          )
            return { authenticated: false as const };
          const tokenConflict = store.list('sessions', { tokenHash: input.session.tokenHash })[0];
          if (tokenConflict !== undefined || store.get('sessions', input.session.id) !== null)
            throw new InvariantError('session token or id already exists');
          if (
            input.session.createdAt.getTime() !== now.getTime() ||
            input.session.lastSeenAt.getTime() !== now.getTime() ||
            input.session.revokedAt !== null ||
            input.session.idleExpiresAt <= now ||
            input.session.idleExpiresAt.getTime() - now.getTime() > 7 * DAY ||
            input.session.absoluteExpiresAt <= now ||
            input.session.absoluteExpiresAt.getTime() - now.getTime() > 30 * DAY ||
            input.session.idleExpiresAt > input.session.absoluteExpiresAt
          ) {
            throw new InvariantError('session lifetime or initial state is invalid');
          }
          let provisioningJob: HostedJob | null = null;
          if (user === undefined) {
            if (
              store.get('users', input.userId) !== null ||
              store.get('tenants', input.tenantId) !== null ||
              store.get('tombstones', input.tenantId) !== null ||
              store.get('jobs', input.provisioningJobId) !== null
            )
              throw new InvariantError('new identity id already exists');
            user = {
              id: input.userId,
              email: challenge.email,
              emailKey: challenge.emailKey,
              verifiedAt: now,
              status: 'active',
              createdAt: now,
              updatedAt: now,
            };
            tenant = {
              id: input.tenantId,
              ownerUserId: user.id,
              status: 'provisioning',
              generation: 1,
              schemaVersion: 0,
              provisioningErrorKind: null,
              createdAt: now,
              updatedAt: now,
              deletedAt: null,
            };
            provisioningJob = {
              id: input.provisioningJobId,
              tenantId: tenant.id,
              generation: 1,
              operationId: input.provisioningJobId,
              requestId: `provision:${tenant.id}`,
              kind: 'provision-tenant',
              version: 1,
              payloadRef: null,
              inputHash: input.tenantId,
              state: 'queued',
              priority: 100,
              attempt: 0,
              availableAt: now,
              deadlineAt: new Date(now.getTime() + DAY),
              fence: 0,
              attemptId: null,
              leaseOwner: null,
              leaseExpiresAt: null,
              cancellationRequestedAt: null,
              resultRef: null,
              resultHash: null,
              errorKind: null,
              createdAt: now,
              updatedAt: now,
            };
            assertHostedJobInvariants(provisioningJob);
            store.put('users', user);
            store.put('tenants', tenant);
            store.put('jobs', provisioningJob);
          }
          if (tenant === undefined) throw new InvariantError('authenticated user has no tenant');
          if (input.rotateSessionId !== undefined) {
            const old = store.get('sessions', input.rotateSessionId);
            if (old !== null && old.userId === user.id && old.revokedAt === null)
              store.put('sessions', { ...old, revokedAt: now });
          }
          const session: HostedSession = { ...input.session, userId: user.id, tenantId: tenant.id };
          store.put('sessions', session);
          store.put('challenges', { ...attempted, consumedAt: now });
          return { authenticated: true as const, user, tenant, session, provisioningJob };
        });
      },
      async resolveSession({ tokenHash, now, touch = false, idleTtlMs = 7 * DAY }) {
        const resolve = () => {
          const session = store.list('sessions', { tokenHash })[0];
          if (
            session === undefined ||
            session.revokedAt !== null ||
            session.idleExpiresAt <= now ||
            session.absoluteExpiresAt <= now
          )
            return null;
          const user = store.get('users', session.userId);
          const tenant = store.get('tenants', session.tenantId);
          if (
            user?.status !== 'active' ||
            tenant === null ||
            tenant.ownerUserId !== user.id ||
            ['deleting', 'deleted'].includes(tenant.status)
          )
            return null;
          const next: HostedSession = touch
            ? {
                ...session,
                lastSeenAt: now,
                idleExpiresAt: new Date(
                  Math.min(
                    now.getTime() + Math.min(idleTtlMs, 7 * DAY),
                    session.absoluteExpiresAt.getTime(),
                  ),
                ),
              }
            : session;
          if (touch) store.put('sessions', next);
          return { user, tenant, session: next };
        };
        return touch ? store.transaction(resolve) : resolve();
      },
      async revokeSession({ id, now }) {
        store.transaction(() => {
          const session = store.get('sessions', id);
          if (session !== null && session.revokedAt === null)
            store.put('sessions', { ...session, revokedAt: now });
        });
      },
      async revokeUserSessions({ userId, now }) {
        store.transaction(() => revokeUser(userId, now));
      },
      async revokeAllCredentials(now) {
        store.transaction(() => {
          for (const session of store.list('sessions'))
            store.put('sessions', { ...session, revokedAt: now });
          for (const challenge of store.list('challenges'))
            store.put('challenges', { ...challenge, invalidatedAt: now });
        });
      },
    },
    tenants: {
      async findById(id) {
        return store.get('tenants', id);
      },
      async findByOwner(userId) {
        return store.list('tenants', { ownerUserId: userId })[0] ?? null;
      },
      async list() {
        return store.list('tenants');
      },
      async suspend({ id, generation, now }) {
        return store.transaction(() => {
          const current = tenantFor(id, generation);
          assertTenantTransition(current.status, 'suspended');
          const tenant: Tenant = { ...current, status: 'suspended', updatedAt: now };
          store.put('tenants', tenant);
          for (const job of store.list('jobs', { tenantId: id }))
            cancelPending(job, now, 'tenant-suspended');
          suppressTenantDeliveries(id, now);
          return tenant;
        });
      },
      async resume({ id, generation, now }) {
        return store.transaction(() => {
          const current = tenantFor(id, generation);
          assertTenantTransition(current.status, 'active');
          const tenant: Tenant = { ...current, status: 'active', updatedAt: now };
          store.put('tenants', tenant);
          return tenant;
        });
      },
      async beginDeletion({ id, generation, now }) {
        return store.transaction(() => {
          return beginTenantDeletion(tenantFor(id, generation), now);
        });
      },
      async completeDeletion({ id, generation, now }) {
        return store.transaction(() => completeTenantDeletion(tenantFor(id, generation), now));
      },
      async listTombstones() {
        return store.list('tombstones');
      },
    },
    subscriptions: {
      async publishPlan(plan) {
        store.transaction(() => {
          const existing = store.get('plans', plan.id);
          if (existing !== null && !sameValue(existing, plan))
            throw new InvariantError('published plan version is immutable');
          store.put('plans', plan);
        });
      },
      async findPlan(id) {
        return store.get('plans', id);
      },
      async listPlans() {
        return store.list('plans');
      },
      async grantTrial({ period, now }) {
        return store.transaction(() => {
          assertSubscriptionPeriodInvariants(period);
          if (
            period.status !== 'trial' ||
            period.sourceOrderId !== null ||
            period.createdAt.getTime() !== now.getTime()
          )
            throw new InvariantError('trial initial state is invalid');
          const tenant = tenantFor(period.tenantId);
          if (!['active', 'provisioning'].includes(tenant.status))
            throw new InvariantError('tenant cannot receive a trial');
          if (store.get('plans', period.planVersionId) === null)
            throw new InvariantError('trial plan not found');
          const existing = store
            .list('periods', { tenantId: tenant.id })
            .find((item) => item.sourceOrderId === null);
          if (existing !== undefined) {
            if (existing.id !== period.id || !sameValue(existing, period))
              throw new InvariantError('trial already granted');
            return existing;
          }
          if (store.get('periods', period.id) !== null)
            throw new InvariantError('period id already exists');
          store.put('periods', period);
          return period;
        });
      },
      async currentEntitlement({ tenantId, now }) {
        return entitlement(tenantId, now);
      },
      async listPeriods(tenantId) {
        return store
          .list('periods', { tenantId })
          .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
      },
    },
    jobs: {
      async findById(id) {
        return store.get('jobs', id);
      },
      async findByOperation(operationId) {
        return store.list('jobs', { operationId })[0] ?? null;
      },
      async findByRequest({ tenantId, requestId }) {
        return store.list('jobs', { tenantId, requestId })[0] ?? null;
      },
      async list({ tenantId, states }) {
        return store
          .list('jobs', tenantId === undefined ? {} : { tenantId })
          .filter((job) => states === undefined || states.includes(job.state));
      },
      async prepareReservedJob({ job, reservation, now }) {
        return store.transaction(() => {
          assertHostedJobInvariants(job);
          assertUsageReservationInvariants(reservation);
          const existing =
            store.list('jobs', { tenantId: job.tenantId, requestId: job.requestId })[0] ??
            store.list('jobs', { operationId: job.operationId })[0];
          if (existing !== undefined) {
            if (
              existing.tenantId !== job.tenantId ||
              existing.inputHash !== job.inputHash ||
              existing.payloadRef !== job.payloadRef ||
              existing.kind !== job.kind ||
              existing.version !== job.version ||
              existing.requestId !== job.requestId
            )
              throw new InvariantError('job request reused with different content');
            const saved = reservationFor(existing.operationId);
            if (
              saved === null ||
              saved.units !== reservation.units ||
              saved.budgetMicro !== reservation.budgetMicro
            )
              throw new InvariantError('job reservation differs on replay');
            return { job: existing, reservation: saved, replayed: true };
          }
          const tenant = tenantFor(job.tenantId, job.generation);
          if (
            tenant.status !== 'active' ||
            store.get('users', tenant.ownerUserId)?.status !== 'active'
          )
            throw new PlatformAccessDeniedError('tenant:active');
          const authorized = entitlement(tenant.id, now);
          if (authorized === null || authorized.period.id !== reservation.periodId)
            throw new PlatformAccessDeniedError('entitlement:current');
          if (
            job.state !== 'preparing' ||
            job.kind === 'provision-tenant' ||
            job.payloadRef === null ||
            job.createdAt.getTime() !== now.getTime() ||
            job.attempt !== 0 ||
            job.fence !== 0 ||
            reservation.state !== 'held' ||
            reservation.operationId !== job.operationId ||
            reservation.tenantId !== tenant.id ||
            reservation.createdAt.getTime() !== now.getTime()
          )
            throw new InvariantError('prepared job or reservation initial state is invalid');
          if (reservation.units > authorized.availableUnits)
            throw new PlatformAccessDeniedError('quota:research-units');
          const jobs = store.list('jobs', { tenantId: tenant.id });
          if (
            jobs.filter((item) => ['queued', 'preparing'].includes(item.state)).length >=
            authorized.plan.limits.queuedJobs
          )
            throw new PlatformAccessDeniedError('quota:queued-jobs');
          const shanghaiDate = (date: Date) =>
            new Date(date.getTime() + 8 * HOUR).toISOString().slice(0, 10);
          if (
            jobs.filter(
              (item) =>
                item.kind !== 'provision-tenant' &&
                shanghaiDate(item.createdAt) === shanghaiDate(now),
            ).length >= authorized.plan.limits.dailyJobs
          )
            throw new PlatformAccessDeniedError('quota:daily-jobs');
          if (
            store.get('jobs', job.id) !== null ||
            store.get('reservations', reservation.id) !== null ||
            reservationFor(job.operationId) !== null
          )
            throw new InvariantError('job or reservation identity already exists');
          store.put('jobs', job);
          store.put('reservations', reservation);
          return { job, reservation, replayed: false };
        });
      },
      async activatePreparedJob({ id, inputHash, now }) {
        return store.transaction(() => {
          const job = store.get('jobs', id);
          if (job === null || job.inputHash !== inputHash)
            throw new InvariantError('prepared job input mismatch');
          const tenant = tenantFor(job.tenantId, job.generation);
          if (job.state !== 'preparing') return job;
          if (
            tenant.status !== 'active' ||
            job.deadlineAt <= now ||
            !pendingPeriodAuthorized(job, now)
          )
            return cancelPending(job, now, 'authorization-expired');
          const next = { ...job, state: 'queued' as const, updatedAt: now };
          store.put('jobs', next);
          return next;
        });
      },
      async claimJob({
        workerId,
        attemptId,
        now,
        leaseMs,
        maxGlobalRunning = 4,
        maxTenantRunning = 1,
      }) {
        return store.transaction(() => {
          if (leaseMs <= 0) throw new InvariantError('lease duration must be positive');
          const all = store.list('jobs');
          for (const job of all) {
            if (!['preparing', 'queued'].includes(job.state)) continue;
            const tenant = store.get('tenants', job.tenantId);
            const unavailable =
              tenant === null ||
              tenant.generation !== job.generation ||
              store.get('users', tenant.ownerUserId)?.status !== 'active' ||
              (job.kind === 'provision-tenant'
                ? tenant.status !== 'provisioning'
                : tenant.status !== 'active');
            if (unavailable || job.deadlineAt <= now || !pendingPeriodAuthorized(job, now)) {
              if (job.attempt === 0)
                cancelPending(
                  job,
                  now,
                  unavailable ? 'tenant-unavailable' : 'authorization-expired',
                );
              else if (unavailable)
                store.put('jobs', {
                  ...clearLease(job),
                  state: 'needs-review',
                  errorKind: 'receipt-reconciliation',
                  updatedAt: now,
                });
            }
          }
          const currentJobs = store.list('jobs');
          const running = currentJobs.filter(
            (job) =>
              job.state === 'running' && job.leaseExpiresAt !== null && job.leaseExpiresAt > now,
          );
          if (running.length >= maxGlobalRunning) return null;
          const candidates = currentJobs.filter((job) => {
            const tenant = store.get('tenants', job.tenantId);
            const eligibleState =
              job.state === 'queued' ||
              (job.state === 'running' && job.leaseExpiresAt !== null && job.leaseExpiresAt <= now);
            if (
              !eligibleState ||
              job.availableAt > now ||
              tenant === null ||
              tenant.generation !== job.generation ||
              store.get('users', tenant.ownerUserId)?.status !== 'active' ||
              (job.kind === 'provision-tenant'
                ? tenant.status !== 'provisioning'
                : tenant.status !== 'active')
            )
              return false;
            if (
              job.state === 'queued' &&
              job.attempt === 0 &&
              (job.deadlineAt <= now || !pendingPeriodAuthorized(job, now))
            )
              return false;
            const activeLimit =
              entitlement(job.tenantId, now)?.plan.limits.concurrentJobs ?? maxTenantRunning;
            return (
              running.filter((item) => item.tenantId === job.tenantId).length <
              Math.min(maxTenantRunning, activeLimit)
            );
          });
          if (candidates.length === 0) return null;
          const tenantIds = [...new Set(candidates.map((job) => job.tenantId))].sort();
          const cursor = store.get('cursors', 'job-fairness')?.tenantId;
          const selectedTenant =
            (cursor === undefined ? undefined : tenantIds.find((id) => id > cursor)) ??
            tenantIds[0];
          const jobs = candidates
            .filter((job) => job.tenantId === selectedTenant)
            .sort((a, b) => {
              const agedPriority = (item: HostedJob) =>
                item.priority +
                Math.floor((now.getTime() - item.createdAt.getTime()) / (5 * 60 * 1000));
              return (
                agedPriority(b) - agedPriority(a) ||
                a.availableAt.getTime() - b.availableAt.getTime() ||
                a.id.localeCompare(b.id)
              );
            });
          const job = jobs[0];
          if (job === undefined) return null;
          const reconciliationOnly =
            job.attempt > 0 &&
            (job.deadlineAt <= now ||
              !pendingPeriodAuthorized(job, now) ||
              job.errorKind === 'receipt-reconciliation');
          const next: HostedJob = {
            ...job,
            state: 'running',
            attempt: job.attempt + 1,
            fence: job.fence + 1,
            attemptId,
            leaseOwner: workerId,
            leaseExpiresAt: new Date(now.getTime() + leaseMs),
            updatedAt: now,
            errorKind: reconciliationOnly ? 'receipt-reconciliation' : job.errorKind,
          };
          assertHostedJobInvariants(next);
          store.put('jobs', next);
          store.put('cursors', { id: 'job-fairness', tenantId: next.tenantId });
          return next;
        });
      },
      async claimJobForReconciliation({ id, workerId, attemptId, now, leaseMs }) {
        return store.transaction(() => {
          const job = store.get('jobs', id);
          if (
            job === null ||
            job.kind === 'provision-tenant' ||
            job.attempt === 0 ||
            reservationFor(job.operationId)?.state !== 'held' ||
            !['queued', 'running', 'needs-review'].includes(job.state)
          )
            return null;
          const tenant = tenantFor(job.tenantId, job.generation);
          if (
            ['deleting', 'deleted'].includes(tenant.status) ||
            (job.state === 'running' && job.leaseExpiresAt !== null && job.leaseExpiresAt > now)
          )
            return null;
          if (leaseMs <= 0) throw new InvariantError('lease duration must be positive');
          const next: HostedJob = {
            ...job,
            state: 'running',
            attempt: job.attempt + 1,
            fence: job.fence + 1,
            attemptId,
            leaseOwner: workerId,
            leaseExpiresAt: new Date(now.getTime() + leaseMs),
            errorKind:
              job.errorKind === 'restored-reconciliation'
                ? job.errorKind
                : 'receipt-reconciliation',
            updatedAt: now,
          };
          assertHostedJobInvariants(next);
          store.put('jobs', next);
          return next;
        });
      },
      async renewJobLease(input) {
        return store.transaction(() => {
          try {
            const job = validateFence(input);
            if (input.leaseMs <= 0) throw new InvariantError('lease duration must be positive');
            const tenant = tenantFor(job.tenantId, job.generation);
            if (['deleting', 'deleted', 'suspended'].includes(tenant.status)) return false;
            store.put('jobs', {
              ...job,
              leaseExpiresAt: new Date(input.now.getTime() + input.leaseMs),
              updatedAt: input.now,
            });
            return true;
          } catch (error) {
            if (error instanceof InvariantError || error instanceof PlatformLeaseLostError)
              return false;
            throw error;
          }
        });
      },
      async completeProvisioning(input) {
        return store.transaction(() => {
          const job = validateFence(input);
          const tenant = tenantFor(job.tenantId, job.generation);
          if (
            job.kind !== 'provision-tenant' ||
            tenant.status !== 'provisioning' ||
            input.schemaVersion < 1
          )
            throw new InvariantError('tenant cannot complete provisioning');
          const active: Tenant = {
            ...tenant,
            status: 'active',
            schemaVersion: input.schemaVersion,
            provisioningErrorKind: null,
            updatedAt: input.now,
          };
          store.put('tenants', active);
          store.put('jobs', { ...clearLease(job), state: 'succeeded', updatedAt: input.now });
          return active;
        });
      },
      async finishJobAndSettle(input) {
        return store.transaction(() => {
          const replay = store.get('inbox', input.event.eventId);
          const current = store.get('jobs', input.id);
          if (replay !== null) {
            const { id: _id, processedAt: _processedAt, ...saved } = replay;
            if (
              !sameValue(saved, input.event) ||
              current === null ||
              current.operationId !== replay.operationId
            )
              throw new InvariantError('result event id reused with different content');
            return {
              job: current,
              reservation: reservationFor(current.operationId),
              replayed: true,
            };
          }
          if (current === null) throw new InvariantError('job not found');
          const event = input.event;
          if (
            current.operationId !== event.operationId ||
            current.tenantId !== event.tenantId ||
            current.generation !== event.generation ||
            current.inputHash !== event.inputHash ||
            current.kind === 'provision-tenant'
          )
            throw new InvariantError('result event does not match job');
          const terminalResult = ['succeeded', 'partial'].includes(current.state);
          const released = reservationFor(current.operationId)?.state === 'released';
          if (!terminalResult && !released) validateFence(input);
          if (
            terminalResult &&
            (current.resultRef !== event.resultRef ||
              current.resultHash !== event.resultHash ||
              current.state !== event.status)
          )
            throw new InvariantError('job result is immutable');
          const tenant = tenantFor(current.tenantId);
          if (
            tenant.generation !== current.generation ||
            ['deleting', 'deleted'].includes(tenant.status)
          )
            throw new InvariantError('tenant generation changed before settlement');
          let reservation = reservationFor(current.operationId);
          if (reservation === null) throw new InvariantError('job reservation missing');
          if (
            input.captureUnits < 0 ||
            !Number.isSafeInteger(input.captureUnits) ||
            input.captureUnits > reservation.units
          )
            throw new InvariantError('capture exceeds reserved units');
          if (reservation.state === 'held') {
            reservation = {
              ...reservation,
              state: 'captured',
              capturedUnits: input.captureUnits,
              settledAt: input.now,
            };
            assertUsageReservationInvariants(reservation);
            store.put('reservations', reservation);
            store.put('usage', {
              id: `capture:${reservation.id}`,
              operationId: current.operationId,
              tenantId: current.tenantId,
              periodId: reservation.periodId,
              metric: 'research-units',
              delta: input.captureUnits,
              reason: 'capture',
              revision: 1,
              createdAt: input.now,
            });
          }
          const job: HostedJob = {
            ...clearLease(current),
            state: event.status,
            resultRef: event.resultRef,
            resultHash: event.resultHash,
            errorKind: null,
            updatedAt: input.now,
          };
          assertHostedJobInvariants(job);
          store.put('jobs', job);
          store.put('inbox', { ...event, id: event.eventId, processedAt: input.now });
          const intents = [
            ...(input.deliveries ?? []),
            ...(input.delivery === undefined ? [] : [input.delivery]),
          ];
          const targets = event.deliveries ?? [
            {
              businessKey: event.businessKey,
              resultRef: event.resultRef,
              notificationPolicy: event.notificationPolicy,
            },
          ];
          for (const delivery of intents) {
            if (
              delivery.tenantId !== job.tenantId ||
              delivery.generation !== job.generation ||
              !targets.some(
                (target) =>
                  target.notificationPolicy === 'eligible' &&
                  target.businessKey === delivery.businessKey &&
                  target.resultRef === delivery.resultRef,
              ) ||
              delivery.state !== 'pending' ||
              delivery.attempt !== 0
            )
              throw new InvariantError('delivery intent does not match result');
            if (delivery.channel === 'email') {
              const preferences = store.get('preferences', delivery.tenantId);
              const owner = store.get('users', tenant.ownerUserId);
              if (
                preferences?.emailEnabled !== true ||
                preferences.bindingVersion !== delivery.bindingVersion ||
                owner?.status !== 'active' ||
                owner.email === null
              )
                continue;
            }
            const existing = store.list('deliveries', {
              tenantId: delivery.tenantId,
              businessKey: delivery.businessKey,
              channel: delivery.channel,
            })[0];
            if (existing !== undefined && existing.resultRef !== delivery.resultRef)
              throw new InvariantError('delivery business key reused with different result');
            if (existing === undefined) {
              if (store.get('deliveries', delivery.id) !== null)
                throw new InvariantError('delivery id already exists');
              store.put('deliveries', delivery);
            }
          }
          return { job, reservation, replayed: false };
        });
      },
      async retryJob(input) {
        return store.transaction(() => {
          const job = validateFence(input);
          if (
            store
              .list('providerAttempts', { operationId: job.operationId })
              .some((attempt) => attempt.usageState === 'unknown')
          ) {
            throw new InvariantError(
              'unknown provider outcome requires reconciliation before retry',
            );
          }
          if (input.availableAt >= job.deadlineAt || job.cancellationRequestedAt !== null)
            throw new InvariantError('job cannot be retried after deadline or cancellation');
          const next: HostedJob = {
            ...clearLease(job),
            state: 'queued',
            availableAt: input.availableAt,
            errorKind: input.errorKind,
            updatedAt: input.now,
          };
          store.put('jobs', next);
          if (job.kind === 'provision-tenant') {
            const tenant = tenantFor(job.tenantId, job.generation);
            store.put('tenants', {
              ...tenant,
              provisioningErrorKind: input.errorKind,
              updatedAt: input.now,
            });
          }
          return next;
        });
      },
      async stopJob(input) {
        return store.transaction(() => {
          const job = store.get('jobs', input.id);
          if (job === null) throw new InvariantError('job not found');
          if (isHostedJobTerminal(job.state)) return job;
          if (
            job.state !== 'running' ||
            job.fence !== input.fence ||
            job.attemptId !== input.attemptId
          )
            throw new PlatformLeaseLostError('job lease lost before stop');
          if (input.state !== 'needs-review' && !input.executionStopped)
            throw new InvariantError('execution must stop before releasing reservation');
          if (input.executionStopped) release(job.operationId, input.now);
          const next: HostedJob = {
            ...clearLease(job),
            state: input.state,
            errorKind: input.errorKind,
            updatedAt: input.now,
          };
          store.put('jobs', next);
          if (job.kind === 'provision-tenant') {
            const tenant = tenantFor(job.tenantId);
            if (tenant.status === 'provisioning')
              store.put('tenants', {
                ...tenant,
                provisioningErrorKind: input.errorKind,
                updatedAt: input.now,
              });
          }
          return next;
        });
      },
      async cancelPendingJob({ id, now, reason }) {
        return store.transaction(() => {
          const job = store.get('jobs', id);
          if (job === null) throw new InvariantError('job not found');
          if (!['preparing', 'queued'].includes(job.state))
            throw new InvariantError('only pending job can be cancelled without a fence');
          return cancelPending(job, now, reason);
        });
      },
      async requestCancellation({ id, tenantId, now }) {
        return store.transaction(() => {
          const job = store.get('jobs', id);
          if (job === null || job.tenantId !== tenantId) throw new InvariantError('job not found');
          if (isHostedJobTerminal(job.state)) return job;
          if (['preparing', 'queued'].includes(job.state))
            return cancelPending(job, now, 'user-cancelled');
          const next = { ...job, cancellationRequestedAt: now, updatedAt: now };
          store.put('jobs', next);
          return next;
        });
      },
      async findReservation(operationId) {
        return reservationFor(operationId);
      },
      async listUsage({ tenantId, periodId }) {
        return store.list('usage', { tenantId, ...(periodId === undefined ? {} : { periodId }) });
      },
      async correctUsage({ entry }) {
        store.transaction(() => {
          if (entry.reason !== 'correction')
            throw new InvariantError('usage corrections require correction reason');
          const previous = store.list('usage', { operationId: entry.operationId });
          const replay = store.get('usage', entry.id);
          if (replay !== null) {
            if (!sameValue(replay, entry))
              throw new InvariantError('usage correction id reused with different content');
            return;
          }
          const first = previous.find((item) => item.reason === 'capture');
          if (
            first === undefined ||
            entry.tenantId !== first.tenantId ||
            entry.periodId !== first.periodId ||
            entry.revision !== Math.max(...previous.map((item) => item.revision)) + 1 ||
            entry.delta >= 0 ||
            previous.reduce((sum, item) => sum + item.delta, 0) + entry.delta < 0
          )
            throw new InvariantError(
              'usage correction must reverse captured units without exceeding them',
            );
          store.put('usage', entry);
        });
      },
      async saveProviderAttempt(attempt) {
        store.transaction(() => {
          assertProviderAttemptInvariants(attempt);
          const existing = store.get('providerAttempts', attempt.id);
          const sameAttempt = store.list('providerAttempts', {
            operationId: attempt.operationId,
            step: attempt.step,
            attempt: attempt.attempt,
          })[0];
          if (sameAttempt !== undefined && sameAttempt.id !== attempt.id)
            throw new InvariantError('provider attempt identity already exists');
          if (
            existing !== null &&
            (existing.operationId !== attempt.operationId ||
              existing.step !== attempt.step ||
              existing.attempt !== attempt.attempt ||
              existing.provider !== attempt.provider ||
              existing.model !== attempt.model ||
              existing.pricingVersion !== attempt.pricingVersion ||
              (existing.usageState === 'confirmed' && !sameValue(existing, attempt)))
          )
            throw new InvariantError('provider attempt identity or confirmed cost is immutable');
          store.put('providerAttempts', attempt);
        });
      },
      async listProviderAttempts(operationId) {
        return store.list('providerAttempts', { operationId });
      },
    },
    deliveries: {
      async findById(id) {
        return store.get('deliveries', id);
      },
      async list(tenantId) {
        return store.list('deliveries', { tenantId });
      },
      async listPending({ states = ['pending', 'failed'], now, limit = 50 }) {
        return store
          .list('deliveries')
          .filter(
            (intent) =>
              states.includes(intent.state) && (now === undefined || intent.availableAt <= now),
          )
          .sort(
            (a, b) => a.availableAt.getTime() - b.availableAt.getTime() || a.id.localeCompare(b.id),
          )
          .slice(0, limit);
      },
      async defer({ id, availableAt, now }) {
        return store.transaction(() => {
          const current = store.get('deliveries', id);
          if (current === null || !['pending', 'failed'].includes(current.state))
            throw new InvariantError('only pending delivery can be deferred');
          const next: DeliveryIntent = {
            ...current,
            availableAt,
            updatedAt: now,
            state: availableAt >= current.expiresAt ? 'suppressed' : current.state,
          };
          store.put('deliveries', next);
          return next;
        });
      },
      async markUnknown({ id, attemptId, now }) {
        return store.transaction(() => {
          const current = store.get('deliveries', id);
          if (
            current === null ||
            current.attemptId !== attemptId ||
            !['sending', 'unknown'].includes(current.state)
          )
            throw new InvariantError('delivery attempt lost before marking unknown');
          const next: DeliveryIntent = { ...current, state: 'unknown', updatedAt: now };
          store.put('deliveries', next);
          return next;
        });
      },
      async resolveUnknown({ id, attemptId, state, providerMessageId, now }) {
        return store.transaction(() => {
          const current = store.get('deliveries', id);
          if (current === null || current.attemptId !== attemptId || current.state !== 'unknown')
            throw new InvariantError('delivery is not an unknown attempt');
          if (state === 'accepted' && providerMessageId === undefined)
            throw new InvariantError('accepted delivery requires provider reference');
          const next: DeliveryIntent = {
            ...current,
            state,
            providerMessageId: providerMessageId ?? current.providerMessageId,
            errorKind: state === 'failed' ? 'provider-not-found' : null,
            availableAt:
              state === 'failed'
                ? new Date(now.getTime() + (current.attempt === 1 ? 60_000 : 300_000))
                : current.availableAt,
            updatedAt: now,
          };
          store.put('deliveries', next);
          return next;
        });
      },
      async claim({ id, generation, bindingVersion, attemptId, now }) {
        return store.transaction(() => {
          const current = store.get('deliveries', id);
          if (
            current === null ||
            !['pending', 'failed'].includes(current.state) ||
            current.availableAt > now
          )
            return null;
          const tenant = store.get('tenants', current.tenantId);
          const preferences = store.get('preferences', current.tenantId);
          const emailEligible =
            current.channel !== 'email' ||
            (preferences?.emailEnabled === true && preferences.bindingVersion === bindingVersion);
          if (
            tenant?.status !== 'active' ||
            tenant.generation !== generation ||
            current.generation !== generation ||
            current.bindingVersion !== bindingVersion ||
            !emailEligible ||
            current.expiresAt <= now ||
            current.attempt >= 3 ||
            entitlement(current.tenantId, now) === null
          ) {
            store.put('deliveries', {
              ...current,
              state: 'suppressed',
              errorKind: 'delivery-ineligible',
              updatedAt: now,
            });
            return null;
          }
          const next: DeliveryIntent = {
            ...current,
            state: 'sending',
            attempt: current.attempt + 1,
            attemptId,
            updatedAt: now,
          };
          store.put('deliveries', next);
          return next;
        });
      },
      async complete({ id, attemptId, state, now, providerMessageId, errorKind, retryAt }) {
        return store.transaction(() => {
          const current = store.get('deliveries', id);
          if (current === null) throw new InvariantError('delivery not found');
          if (current.attemptId !== attemptId || current.state !== 'sending') {
            if (
              current.attemptId === attemptId &&
              current.state === state &&
              (providerMessageId === undefined || current.providerMessageId === providerMessageId)
            )
              return current;
            throw new InvariantError('delivery attempt lost or result changed');
          }
          if (state === 'accepted' && providerMessageId === undefined)
            throw new InvariantError('accepted delivery requires provider reference');
          const next: DeliveryIntent = {
            ...current,
            state,
            providerMessageId: providerMessageId ?? current.providerMessageId,
            errorKind: errorKind ?? null,
            availableAt:
              state === 'failed'
                ? (retryAt ?? new Date(now.getTime() + (current.attempt === 1 ? 60_000 : 300_000)))
                : current.availableAt,
            updatedAt: now,
          };
          store.put('deliveries', next);
          return next;
        });
      },
      async markDelivered({ id, providerMessageId, deliveredAt }) {
        store.transaction(() => {
          const current = store.get('deliveries', id);
          if (
            current === null ||
            current.state !== 'accepted' ||
            current.providerMessageId !== providerMessageId
          )
            throw new InvariantError('delivery receipt does not match accepted message');
          if (current.deliveredAt === null)
            store.put('deliveries', { ...current, deliveredAt, updatedAt: deliveredAt });
        });
      },
    },
  };
  return registry;
};
