import type { EmailOtpDeliveryResult, EmailOtpPort, EmailOtpRequest } from '@luoome/core';

export class UnconfiguredEmailOtpAdapter implements EmailOtpPort {
  readonly name = 'email-otp-unconfigured';
  readonly providerKind = 'live' as const;
  readonly configured = false;

  async sendChallenge(): Promise<EmailOtpDeliveryResult> {
    return { state: 'failed', reason: 'unconfigured' };
  }
}

export class FixtureEmailOtpAdapter implements EmailOtpPort {
  readonly name = 'email-otp-fixture';
  readonly providerKind = 'fixture' as const;
  readonly configured = true;
  private readonly messages = new Map<string, EmailOtpRequest>();

  async sendChallenge(input: EmailOtpRequest): Promise<EmailOtpDeliveryResult> {
    const existing = this.messages.get(input.challengeId);
    if (existing !== undefined) {
      return { state: 'accepted', providerMessageId: `fixture-${input.challengeId}` };
    }
    this.messages.set(input.challengeId, { ...input, expiresAt: new Date(input.expiresAt) });
    return { state: 'accepted', providerMessageId: `fixture-${input.challengeId}` };
  }

  getMessage(challengeId: string): EmailOtpRequest | undefined {
    const message = this.messages.get(challengeId);
    return message === undefined
      ? undefined
      : { ...message, expiresAt: new Date(message.expiresAt) };
  }

  clear(): void {
    this.messages.clear();
  }
}
