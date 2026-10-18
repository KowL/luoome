import type { EmailOtpDeliveryResult, EmailOtpPort, EmailOtpRequest } from '@luoome/core';
import {
  createSmtpEmailTransport,
  type SmtpEmailOptions,
  type SmtpEmailTransport,
  sendSmtpEmail,
} from './smtp.js';

export type SmtpEmailOtpOptions = SmtpEmailOptions;

export class SmtpEmailOtpAdapter implements EmailOtpPort {
  readonly name = 'email-otp-smtp';
  readonly providerKind = 'live' as const;
  readonly configured = true;
  private readonly transport: SmtpEmailTransport;
  private readonly from: string;

  constructor(
    options: SmtpEmailOtpOptions,
    dependencies: { readonly transport?: SmtpEmailTransport } = {},
  ) {
    const smtp = createSmtpEmailTransport(options, dependencies.transport);
    this.from = smtp.from;
    this.transport = smtp.transport;
  }

  async sendChallenge(input: EmailOtpRequest): Promise<EmailOtpDeliveryResult> {
    const purpose = input.purpose === 'reauth' ? '身份确认' : '登录';
    const expiresAt = input.expiresAt.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
    const result = await sendSmtpEmail(this.transport, {
      from: this.from,
      destination: input.destination,
      subject: `luoome ${purpose}验证码`,
      text: `你的${purpose}验证码是：${input.code}\n\n请在 ${expiresAt}（北京时间）前使用。\n如非本人操作，请忽略此邮件。请勿转发验证码。`,
    });
    return result.state === 'rejected' ? { state: 'failed', reason: 'rejected' } : result;
  }
}

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
