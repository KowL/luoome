import type {
  HostedNotificationLookupResult,
  HostedNotificationPort,
  HostedNotificationRequest,
  HostedNotificationResult,
} from '@luoome/core';
import { z } from 'zod';
import {
  createSmtpEmailTransport,
  type SmtpEmailOptions,
  type SmtpEmailTransport,
  sendSmtpEmail,
} from './smtp.js';

export type { SmtpEmailTransport } from './smtp.js';

export interface SmtpHostedNotificationOptions extends SmtpEmailOptions {
  readonly publicOrigin: string;
  readonly allowInsecureHttp?: boolean;
}

const SmtpNotificationSchema = z.object({
  subject: z
    .string()
    .min(1)
    .max(200)
    .regex(/^[^\r\n]+$/),
  message: z.string().min(1).max(5000),
  authenticatedUrl: z.url(),
});

export class SmtpHostedNotificationAdapter implements HostedNotificationPort {
  readonly name = 'hosted-email-smtp';
  readonly providerKind = 'live' as const;
  readonly configured = true;
  readonly idempotency = 'unsupported' as const;
  private readonly transport: SmtpEmailTransport;
  private readonly from: string;
  private readonly publicOrigin: string;

  constructor(
    options: SmtpHostedNotificationOptions,
    dependencies: { readonly transport?: SmtpEmailTransport } = {},
  ) {
    const origin = z.url().safeParse(options.publicOrigin);
    if (!origin.success) throw new Error('invalid notification public origin');
    const url = new URL(origin.data);
    if (
      url.origin !== options.publicOrigin ||
      url.username !== '' ||
      url.password !== '' ||
      (url.protocol !== 'https:' &&
        !(url.protocol === 'http:' && options.allowInsecureHttp === true))
    )
      throw new Error('notification requires a fixed HTTPS origin; HTTP requires explicit opt-in');
    this.publicOrigin = url.origin;
    const smtp = createSmtpEmailTransport(options, dependencies.transport);
    this.from = smtp.from;
    this.transport = smtp.transport;
  }

  async send(input: HostedNotificationRequest): Promise<HostedNotificationResult> {
    const parsed = SmtpNotificationSchema.safeParse(input);
    if (!parsed.success) return { state: 'failed', errorKind: 'provider-rejected' };
    const url = new URL(parsed.data.authenticatedUrl);
    if (url.origin !== this.publicOrigin || url.username !== '' || url.password !== '')
      return { state: 'failed', errorKind: 'provider-rejected' };
    const result = await sendSmtpEmail(this.transport, {
      from: this.from,
      destination: input.destination,
      subject: parsed.data.subject,
      text: `${parsed.data.message}\n\n查看详情（需要登录）：${url.href}\n\n请以应用内最新状态为准。本提醒不代表成交或自动下单。`,
    });
    return result.state === 'rejected'
      ? { state: 'failed', errorKind: 'provider-rejected' }
      : result;
  }

  async lookup(): Promise<HostedNotificationLookupResult> {
    // SMTP provides neither an intent lookup nor an idempotent resend contract.
    return { state: 'unknown' };
  }
}

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
