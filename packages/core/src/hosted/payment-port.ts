import { HostedPaymentEventSchema } from './payments.js';

export const HostedVerifiedPaymentFactSchema = HostedPaymentEventSchema.omit({
  id: true,
  receivedAt: true,
  processedAt: true,
  disposition: true,
});
export type HostedVerifiedPaymentFact = import('zod').infer<typeof HostedVerifiedPaymentFactSchema>;

export interface HostedPaymentOrderRequest {
  readonly merchantOrderId: string;
  readonly amountMinor: number;
  readonly currency: 'CNY';
  readonly expiresAt: Date;
}

export interface HostedPaymentCheckout {
  readonly providerOrderId: string;
  readonly checkoutUrl: string | null;
}

export type HostedPaymentCreateResult =
  | ({ readonly state: 'accepted' } & HostedPaymentCheckout)
  | { readonly state: 'failed'; readonly errorKind: 'provider-unconfigured' | 'provider-rejected' }
  | { readonly state: 'unknown' };

export type HostedPaymentOrderQueryResult =
  | ({ readonly state: 'pending' } & HostedPaymentCheckout)
  | { readonly state: 'confirmed'; readonly events: readonly HostedVerifiedPaymentFact[] }
  | { readonly state: 'not-found' }
  | { readonly state: 'unknown' };

export interface HostedPaymentRefundRequest {
  readonly refundId: string;
  readonly merchantOrderId: string;
  readonly providerTransactionId: string;
  readonly amountMinor: number;
  readonly currency: 'CNY';
}

export type HostedPaymentRefundResult =
  | { readonly state: 'submitted' | 'processing'; readonly providerRefundId: string }
  | { readonly state: 'failed'; readonly errorKind: 'provider-unconfigured' | 'provider-rejected' }
  | { readonly state: 'unknown' };

export type HostedPaymentRefundQueryResult =
  | { readonly state: 'processing'; readonly providerRefundId: string }
  | { readonly state: 'confirmed'; readonly event: HostedVerifiedPaymentFact }
  | { readonly state: 'not-found' }
  | { readonly state: 'unknown' };

export interface HostedPaymentWebhookEnvelope {
  readonly rawBody: string;
  readonly timestamp: string;
  readonly signature: string;
}

export type HostedPaymentWebhookVerification =
  | { readonly verified: true; readonly event: HostedVerifiedPaymentFact }
  | { readonly verified: false };

export interface HostedPaymentPort {
  readonly name: string;
  readonly merchantId: string;
  readonly providerKind: 'fixture' | 'live';
  readonly configured: boolean;
  readonly orderIdempotency: 'supported' | 'unsupported';
  readonly refundIdempotency: 'supported' | 'unsupported';
  createOrder(input: HostedPaymentOrderRequest): Promise<HostedPaymentCreateResult>;
  queryOrder(input: { readonly merchantOrderId: string }): Promise<HostedPaymentOrderQueryResult>;
  requestRefund(input: HostedPaymentRefundRequest): Promise<HostedPaymentRefundResult>;
  queryRefund(input: {
    readonly refundId: string;
    readonly merchantOrderId: string;
    readonly providerTransactionId: string;
  }): Promise<HostedPaymentRefundQueryResult>;
  verifyWebhook(
    input: HostedPaymentWebhookEnvelope,
    now: Date,
  ): Promise<HostedPaymentWebhookVerification>;
}
