import type {
  HostedNotificationLookupResult,
  HostedNotificationPort,
  HostedNotificationRequest,
  HostedNotificationResult,
} from '@luoome/core';

export class UnconfiguredHostedNotificationAdapter implements HostedNotificationPort {
  readonly name = 'hosted-email-unconfigured';
  readonly providerKind = 'live' as const;
  readonly configured = false;
  readonly idempotency = 'unsupported' as const;

  async send(): Promise<HostedNotificationResult> {
    return { state: 'failed', errorKind: 'provider-unconfigured' };
  }

  async lookup(): Promise<HostedNotificationLookupResult> {
    return { state: 'unknown' };
  }
}

export class FixtureHostedNotificationAdapter implements HostedNotificationPort {
  readonly name = 'hosted-email-fixture';
  readonly providerKind = 'fixture' as const;
  readonly configured = true;
  readonly idempotency = 'supported' as const;
  private readonly deliveries = new Map<string, HostedNotificationRequest>();

  async send(input: HostedNotificationRequest): Promise<HostedNotificationResult> {
    const previous = this.deliveries.get(input.deliveryIntentId);
    if (previous !== undefined && JSON.stringify(previous) !== JSON.stringify(input)) {
      return { state: 'failed', errorKind: 'provider-rejected' };
    }
    this.deliveries.set(input.deliveryIntentId, { ...input });
    return { state: 'accepted', providerMessageId: `fixture-message:${input.deliveryIntentId}` };
  }

  async lookup(deliveryIntentId: string): Promise<HostedNotificationLookupResult> {
    return this.deliveries.has(deliveryIntentId)
      ? { state: 'accepted', providerMessageId: `fixture-message:${deliveryIntentId}` }
      : { state: 'not-found' };
  }

  getRequest(deliveryIntentId: string): HostedNotificationRequest | undefined {
    const request = this.deliveries.get(deliveryIntentId);
    return request === undefined ? undefined : { ...request };
  }

  clear(): void {
    this.deliveries.clear();
  }
}
