import { LoginEmailSchema } from '@luoome/core';
import nodemailer, { type SendMailOptions, type SMTPSentMessageInfo } from 'nodemailer';
import { z } from 'zod';

export interface SmtpEmailOptions {
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

export interface SmtpEmailTransport {
  sendMail(message: SendMailOptions): Promise<SMTPSentMessageInfo>;
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

export const createSmtpEmailTransport = (
  options: SmtpEmailOptions,
  transport?: SmtpEmailTransport,
): { readonly from: string; readonly transport: SmtpEmailTransport } => {
  const parsed = SmtpOptionsSchema.safeParse(options);
  if (!parsed.success)
    throw new Error(
      `invalid SMTP configuration: ${parsed.error.issues.map((issue) => issue.path.join('.')).join(', ')}`,
    );
  const config = parsed.data;
  const starttls = config.starttls ?? !config.secure;
  if (!config.secure && !starttls) throw new Error('SMTP requires TLS or mandatory STARTTLS');
  return {
    from: config.from,
    transport:
      transport ??
      nodemailer.createTransport({
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
      }),
  };
};

export type SmtpEmailResult =
  | { readonly state: 'accepted'; readonly providerMessageId: string }
  | { readonly state: 'rejected' }
  | { readonly state: 'unknown' };

const smtpFailure = (error: unknown): SmtpEmailResult => {
  if (typeof error !== 'object' || error === null) return { state: 'unknown' };
  const responseCode = 'responseCode' in error ? error.responseCode : undefined;
  if (typeof responseCode === 'number' && responseCode >= 400 && responseCode < 600)
    return { state: 'rejected' };
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
    return { state: 'rejected' };
  const timeoutType = 'timeoutType' in error ? error.timeoutType : undefined;
  if (
    typeof timeoutType === 'string' &&
    ['CONNECT_TIMEOUT', 'GREETING_TIMEOUT', 'UPGRADE_TIMEOUT'].includes(timeoutType)
  )
    return { state: 'rejected' };
  // CONN also labels mid-message disconnects; it cannot prove that SMTP rejected the message.
  return { state: 'unknown' };
};

export const sendSmtpEmail = async (
  transport: SmtpEmailTransport,
  input: {
    readonly from: string;
    readonly destination: string;
    readonly subject: string;
    readonly text: string;
  },
): Promise<SmtpEmailResult> => {
  const destination = LoginEmailSchema.safeParse(input.destination);
  if (!destination.success) return { state: 'rejected' };
  try {
    const info = await transport.sendMail({
      from: { name: 'luoome', address: input.from },
      to: [{ address: destination.data, name: '' }],
      envelope: { from: input.from, to: [destination.data] },
      subject: input.subject,
      text: input.text,
    });
    if (
      info.accepted.some((address) => address.toLowerCase() === destination.data.toLowerCase()) &&
      /^2\d\d(?:[ -]|$)/.test(info.response) &&
      info.messageId.length > 0 &&
      info.messageId.length <= 256
    )
      return { state: 'accepted', providerMessageId: info.messageId };
    if (info.rejected.some((address) => address.toLowerCase() === destination.data.toLowerCase()))
      return { state: 'rejected' };
    return { state: 'unknown' };
  } catch (error) {
    return smtpFailure(error);
  }
};
