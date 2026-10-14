import {
  type EmailOtpDeliveryResult,
  type EmailOtpPort,
  type EmailOtpRequest,
  LoginEmailSchema,
} from '@luoome/core';
import nodemailer, { type SMTPSentMessageInfo, type Transporter } from 'nodemailer';
import { z } from 'zod';

export interface SmtpEmailOtpOptions {
  readonly host: string;
  readonly port: number;
  readonly secure: boolean;
  readonly starttls?: boolean;
  readonly auth?: { readonly user: string; readonly pass: string };
  readonly from: string;
  readonly tlsServername?: string;
  readonly connectionTimeoutMs?: number;
  readonly socketTimeoutMs?: number;
}

const SmtpOptionsSchema = z.object({
  host: z
    .string()
    .trim()
    .min(1)
    .max(255)
    .regex(/^[a-zA-Z0-9.:-]+$/),
  port: z.number().int().min(1).max(65535),
  secure: z.boolean(),
  starttls: z.boolean().optional(),
  auth: z.object({ user: z.string().min(1), pass: z.string().min(1) }).optional(),
  from: LoginEmailSchema,
  tlsServername: z
    .string()
    .trim()
    .min(1)
    .max(255)
    .regex(/^[a-zA-Z0-9.-]+$/)
    .optional(),
  connectionTimeoutMs: z.number().int().min(1).max(60_000).default(10_000),
  socketTimeoutMs: z.number().int().min(1).max(60_000).default(20_000),
});

const rejected = (): EmailOtpDeliveryResult => ({ state: 'failed', reason: 'rejected' });

const deliveryError = (error: unknown): EmailOtpDeliveryResult => {
  if (typeof error !== 'object' || error === null) return { state: 'unknown' };
  const responseCode = 'responseCode' in error ? error.responseCode : undefined;
  if (typeof responseCode === 'number' && responseCode >= 400 && responseCode < 600)
    return rejected();
  const code = 'code' in error ? error.code : undefined;
  if (
    typeof code === 'string' &&
    [
      'EAUTH',
      'ENOAUTH',
      'EDNS',
      'ETLS',
      'EREQUIRETLS',
      'ECONFIG',
      'EENVELOPE',
      'EMAXRECIPIENTS',
    ].includes(code)
  )
    return rejected();
  const timeoutType = 'timeoutType' in error ? error.timeoutType : undefined;
  if (
    typeof timeoutType === 'string' &&
    ['CONNECT_TIMEOUT', 'GREETING_TIMEOUT', 'UPGRADE_TIMEOUT'].includes(timeoutType)
  )
    return rejected();
  // Nodemailer also labels mid-message disconnects CONN; that label cannot prove non-delivery.
  return { state: 'unknown' };
};

export class SmtpEmailOtpAdapter implements EmailOtpPort {
  readonly name = 'email-otp-smtp';
  readonly providerKind = 'live' as const;
  readonly configured = true;
  private readonly transport: Transporter<SMTPSentMessageInfo>;
  private readonly from: string;

  constructor(options: SmtpEmailOtpOptions) {
    const parsed = SmtpOptionsSchema.safeParse(options);
    if (!parsed.success) {
      throw new Error(
        `invalid SMTP configuration: ${parsed.error.issues.map((issue) => issue.path.join('.')).join(', ')}`,
      );
    }
    const config = parsed.data;
    const starttls = config.starttls ?? !config.secure;
    if (!config.secure && !starttls) throw new Error('SMTP requires TLS or mandatory STARTTLS');
    this.from = config.from;
    this.transport = nodemailer.createTransport({
      host: config.host,
      port: config.port,
      secure: config.secure,
      requireTLS: !config.secure && starttls,
      ignoreTLS: false,
      opportunisticTLS: false,
      tls: {
        rejectUnauthorized: true,
        minVersion: 'TLSv1.2',
        ...(config.tlsServername === undefined ? {} : { servername: config.tlsServername }),
      },
      ...(config.auth === undefined ? {} : { auth: config.auth }),
      connectionTimeout: config.connectionTimeoutMs,
      greetingTimeout: config.connectionTimeoutMs,
      dnsTimeout: config.connectionTimeoutMs,
      socketTimeout: config.socketTimeoutMs,
      pool: false,
      logger: false,
      debug: false,
      disableFileAccess: true,
      disableUrlAccess: true,
      maxRecipients: 1,
    });
  }

  async sendChallenge(input: EmailOtpRequest): Promise<EmailOtpDeliveryResult> {
    const destination = LoginEmailSchema.safeParse(input.destination);
    if (!destination.success) return rejected();
    try {
      const purpose = input.purpose === 'reauth' ? '身份确认' : '登录';
      const expiresAt = input.expiresAt.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
      const info = await this.transport.sendMail({
        from: { name: 'luoome', address: this.from },
        to: [{ address: destination.data, name: '' }],
        envelope: { from: this.from, to: [destination.data] },
        subject: `luoome ${purpose}验证码`,
        text: `你的${purpose}验证码是：${input.code}\n\n请在 ${expiresAt}（北京时间）前使用。\n如非本人操作，请忽略此邮件。请勿转发验证码。`,
      });
      if (
        info.accepted.some((address) => address.toLowerCase() === destination.data.toLowerCase()) &&
        /^2\d\d(?:[ -]|$)/.test(info.response) &&
        info.messageId.length > 0
      )
        return { state: 'accepted', providerMessageId: info.messageId };
      if (info.rejected.some((address) => address.toLowerCase() === destination.data.toLowerCase()))
        return rejected();
      return { state: 'unknown' };
    } catch (error) {
      return deliveryError(error);
    }
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
