import type { WatchTrigger } from '@luoome/core';
import { describe, expect, it } from 'vitest';

import { buildTestContext } from '../testing/context.js';
import { getIntradayDeliveryAuditTool } from './get-intraday-delivery-audit.js';

const detectedAt = new Date('2026-09-28T01:00:00.000Z');
const firstEventAt = '2026-09-28T00:59:00.000Z';

const trigger = (
  id: string,
  poolId: string,
  deliveryStatus: WatchTrigger['deliveryStatus'],
  overrides: Partial<WatchTrigger> = {},
): WatchTrigger => ({
  id,
  poolId,
  stockId: '002594.SZ',
  ruleKind: 'strategy-signal',
  ruleId: `r_${id}`,
  triggerType: 'triggered',
  direction: 'watch',
  reason: '盘中条件命中',
  evidence: ['可核验的条件证据'],
  priority: 'normal',
  deliveryStatus,
  evalSnapshot: { firstEventAt },
  notified: deliveryStatus === 'sent' || deliveryStatus === 'failed',
  createdAt: detectedAt,
  ...overrides,
});

describe('get_intraday_delivery_audit', () => {
  it('完整统计当天所有候选，包括超出列表页的失败、超时和不可核验样本', async () => {
    const ctx = await buildTestContext({ clock: () => new Date('2026-09-28T07:00:00.000Z') });
    const poolId = `trading-plan-watch:${ctx.user.defaultAccountId}`;
    const records = [
      trigger('accepted-fast', poolId, 'sent', {
        deliveryCompletedAt: new Date('2026-09-28T01:01:00.000Z'),
      }),
      trigger('accepted-late', poolId, 'sent', {
        deliveryCompletedAt: new Date('2026-09-28T01:10:00.001Z'),
      }),
      trigger('accepted-unknown', poolId, 'sent', { evalSnapshot: {} }),
      trigger('accepted-future-event', poolId, 'sent', {
        evalSnapshot: { firstEventAt: '2026-09-28T01:01:00.000Z' },
        deliveryCompletedAt: new Date('2026-09-28T01:02:00.000Z'),
      }),
      trigger('expired', poolId, 'expired'),
      trigger('failed', poolId, 'failed'),
      trigger('invalidated', poolId, 'invalidated'),
      trigger('suppressed', poolId, 'suppressed-cooldown'),
      ...Array.from({ length: 201 }, (_, index) => trigger(`pending-${index}`, poolId, 'pending')),
      trigger('another-account', 'trading-plan-watch:other-account', 'sent'),
      trigger('previous-day', poolId, 'expired', {
        createdAt: new Date('2026-09-27T15:59:59.999Z'),
      }),
    ];
    await Promise.all(records.map((record) => ctx.repos.watchTrigger.save(record)));

    const result = await getIntradayDeliveryAuditTool.execute({}, ctx);
    expect(result).toMatchObject({
      ok: true,
      data: {
        accountId: ctx.user.defaultAccountId,
        date: '2026-09-28',
        candidateCount: 209,
        deliveryStatusCounts: {
          sent: 4,
          expired: 1,
          failed: 1,
          invalidated: 1,
          'suppressed-cooldown': 1,
          pending: 201,
        },
        sourceEventTimeUnverifiable: 2,
        channelAcceptance: {
          accepted: 4,
          withinTenMinutes: 1,
          overTenMinutes: 1,
          timingUnverifiable: 2,
          notAccepted: 205,
          p50Ms: 120_000,
          p95Ms: 660_001,
          maxMs: 660_001,
        },
        deviceDeliveryVerified: false,
      },
    });
  });
});
