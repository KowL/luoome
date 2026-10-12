import { describe, expect, it } from 'vitest';
import {
  FixtureHostedNotificationAdapter,
  UnconfiguredHostedNotificationAdapter,
} from './notification.js';

describe('hosted notification provider protocol', () => {
  it('makes fixture request identity and accepted status explicit without inferring delivered', async () => {
    const provider = new FixtureHostedNotificationAdapter();
    const request = {
      deliveryIntentId: 'i1',
      destination: 'a@example.test',
      subject: '有新的摘要',
      message: '请登录查看',
      authenticatedUrl: 'https://luoome.example/#facts',
    };
    const result = await provider.send(request);
    expect(result).toEqual({ state: 'accepted', providerMessageId: 'fixture-message:i1' });
    expect(result).not.toHaveProperty('deliveredAt');
    expect(await provider.send(request)).toEqual(result);
    expect(await provider.lookup('i1')).toEqual(result);
    expect(await provider.lookup('missing')).toEqual({ state: 'not-found' });
    expect(await provider.send({ ...request, message: 'changed' })).toEqual({
      state: 'failed',
      errorKind: 'provider-rejected',
    });
    expect(provider.getRequest('i1')?.message).toBe(request.message);
  });

  it('does not fake delivery or a lookup result for an unconfigured real provider', async () => {
    const provider = new UnconfiguredHostedNotificationAdapter();
    expect(provider.providerKind).toBe('live');
    expect(provider.configured).toBe(false);
    expect(await provider.send()).toEqual({ state: 'failed', errorKind: 'provider-unconfigured' });
    expect(await provider.lookup()).toEqual({ state: 'unknown' });
  });
});
