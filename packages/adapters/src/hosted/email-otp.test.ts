import nodemailer, {
  type SendMailOptions,
  type SMTPSentMessageInfo,
  type Transporter,
} from 'nodemailer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  FixtureEmailOtpAdapter,
  SmtpEmailOtpAdapter,
  UnconfiguredEmailOtpAdapter,
} from './email-otp.js';

afterEach(() => vi.restoreAllMocks());

const smtpConfig = {
  host: 'smtp.example.test',
  port: 587,
  secure: false,
  auth: { user: 'smtp-user', pass: 'smtp-test-credential' },
  from: 'noreply@example.test',
};
const challenge = {
  challengeId: 'challenge-smtp',
  destination: 'recipient@example.test',
  code: '012345',
  purpose: 'login' as const,
  expiresAt: new Date('2026-10-14T01:00:00.000Z'),
};
const acceptedInfo: SMTPSentMessageInfo = {
  accepted: [challenge.destination],
  rejected: [],
  envelope: { from: smtpConfig.from, to: [challenge.destination] },
  messageId: '<smtp-message@example.test>',
  response: '250 2.0.0 Queued',
  envelopeTime: 1,
  messageTime: 1,
  messageSize: 200,
};
const mockSmtp = () => {
  const sendMail = vi.fn<(message: SendMailOptions) => Promise<SMTPSentMessageInfo>>();
  const createTransport = vi
    .spyOn(nodemailer, 'createTransport')
    .mockReturnValue({ sendMail } as unknown as Transporter<SMTPSentMessageInfo>);
  return { sendMail, createTransport };
};

describe('real SMTP OTP adapter', () => {
  it('requires encrypted SMTP and disables protocol/content logs and extra recipients', () => {
    const { createTransport, sendMail } = mockSmtp();
    const provider = new SmtpEmailOtpAdapter(smtpConfig);
    expect(provider.providerKind).toBe('live');
    expect(provider.configured).toBe(true);
    expect(sendMail).not.toHaveBeenCalled();
    expect(createTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        host: smtpConfig.host,
        port: 587,
        secure: false,
        requireTLS: true,
        ignoreTLS: false,
        opportunisticTLS: false,
        tls: { rejectUnauthorized: true, minVersion: 'TLSv1.2' },
        auth: smtpConfig.auth,
        connectionTimeout: 10_000,
        socketTimeout: 20_000,
        pool: false,
        logger: false,
        debug: false,
        disableFileAccess: true,
        disableUrlAccess: true,
        maxRecipients: 1,
      }),
    );
    expect(() => new SmtpEmailOtpAdapter({ ...smtpConfig, starttls: false })).toThrow(
      'SMTP requires TLS',
    );
    expect(createTransport).toHaveBeenCalledTimes(1);
    new SmtpEmailOtpAdapter({
      ...smtpConfig,
      port: 465,
      secure: true,
      tlsServername: 'smtp.example.test',
    });
    expect(createTransport).toHaveBeenLastCalledWith(
      expect.objectContaining({
        port: 465,
        secure: true,
        requireTLS: false,
        tls: { rejectUnauthorized: true, minVersion: 'TLSv1.2', servername: 'smtp.example.test' },
      }),
    );
  });

  it('sends only to the requested mailbox and reports acceptance only after the SMTP receipt', async () => {
    const { sendMail } = mockSmtp();
    sendMail.mockResolvedValue(acceptedInfo);
    const provider = new SmtpEmailOtpAdapter(smtpConfig);
    expect(await provider.sendChallenge(challenge)).toEqual({
      state: 'accepted',
      providerMessageId: acceptedInfo.messageId,
    });
    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(sendMail).toHaveBeenCalledWith({
      from: { name: 'luoome', address: smtpConfig.from },
      to: [{ address: challenge.destination, name: '' }],
      envelope: { from: smtpConfig.from, to: [challenge.destination] },
      subject: 'luoome 登录验证码',
      text: expect.stringContaining(challenge.code),
    });
    await provider.sendChallenge({ ...challenge, purpose: 'reauth' });
    expect(sendMail).toHaveBeenLastCalledWith(
      expect.objectContaining({ subject: 'luoome 身份确认验证码' }),
    );
  });

  it('rejects recipient-list/header injection before handing content to SMTP', async () => {
    const { sendMail } = mockSmtp();
    const provider = new SmtpEmailOtpAdapter(smtpConfig);
    for (const destination of [
      'a@example.test,b@example.test',
      'a@example.test\r\nBcc: b@example.test',
    ]) {
      expect(await provider.sendChallenge({ ...challenge, destination })).toEqual({
        state: 'failed',
        reason: 'rejected',
      });
    }
    expect(sendMail).not.toHaveBeenCalled();
    expect(
      () => new SmtpEmailOtpAdapter({ ...smtpConfig, from: 'a@example.test,b@example.test' }),
    ).toThrow('from');
  });

  it.each([
    { code: 'EAUTH', responseCode: 535 },
    { code: 'EDNS' },
    { code: 'ETLS' },
    { code: 'EENVELOPE', command: 'RCPT TO' },
    { code: 'EMESSAGE', responseCode: 550, command: 'DATA' },
    { code: 'EMESSAGE', responseCode: 451, command: 'DATA' },
    { code: 'ETIMEDOUT', timeoutType: 'CONNECT_TIMEOUT' },
  ])('marks definite non-delivery failed without returning SMTP details: %j', async (error) => {
    const { sendMail } = mockSmtp();
    sendMail.mockRejectedValue(
      Object.assign(new Error(`private ${smtpConfig.auth.pass} ${challenge.code}`), error),
    );
    expect(await new SmtpEmailOtpAdapter(smtpConfig).sendChallenge(challenge)).toEqual({
      state: 'failed',
      reason: 'rejected',
    });
    expect(sendMail).toHaveBeenCalledTimes(1);
  });

  it.each([
    { code: 'ETIMEDOUT', command: 'CONN', timeoutType: 'SOCKET_TIMEOUT' },
    { code: 'ECONNECTION', command: 'CONN' },
    { code: 'ESOCKET', command: 'CONN' },
    { code: 'ESTREAM' },
  ])(
    'does not retry or claim rejection after an ambiguous transport failure: %j',
    async (error) => {
      const { sendMail } = mockSmtp();
      const log = vi.spyOn(console, 'log');
      const warn = vi.spyOn(console, 'warn');
      const logError = vi.spyOn(console, 'error');
      sendMail.mockRejectedValue(
        Object.assign(new Error(`private ${smtpConfig.auth.pass} ${challenge.code}`), error),
      );
      expect(await new SmtpEmailOtpAdapter(smtpConfig).sendChallenge(challenge)).toEqual({
        state: 'unknown',
      });
      expect(sendMail).toHaveBeenCalledTimes(1);
      expect(log).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
      expect(logError).not.toHaveBeenCalled();
    },
  );

  it('does not turn a missing final acceptance receipt into a successful delivery', async () => {
    const { sendMail } = mockSmtp();
    const provider = new SmtpEmailOtpAdapter(smtpConfig);
    sendMail.mockResolvedValueOnce({
      ...acceptedInfo,
      accepted: [],
      rejected: [challenge.destination],
    });
    expect(await provider.sendChallenge(challenge)).toEqual({
      state: 'failed',
      reason: 'rejected',
    });
    sendMail.mockResolvedValueOnce({ ...acceptedInfo, accepted: ['other@example.test'] });
    expect(await provider.sendChallenge(challenge)).toEqual({ state: 'unknown' });
    sendMail.mockResolvedValueOnce({ ...acceptedInfo, response: '' });
    expect(await provider.sendChallenge(challenge)).toEqual({ state: 'unknown' });
  });
});

describe('email OTP ports', () => {
  it('rejects the unconfigured production provider explicitly', async () => {
    const provider = new UnconfiguredEmailOtpAdapter();
    expect(provider.configured).toBe(false);
    expect(await provider.sendChallenge()).toEqual({ state: 'failed', reason: 'unconfigured' });
  });

  it('keeps fixture delivery explicit and idempotent without writing credentials to logs', async () => {
    const provider = new FixtureEmailOtpAdapter();
    const input = {
      challengeId: 'c1',
      destination: 'a@example.test',
      code: '012345',
      purpose: 'login' as const,
      expiresAt: new Date('2026-10-10T01:00:00.000Z'),
    };
    const first = await provider.sendChallenge(input);
    expect(provider.providerKind).toBe('fixture');
    expect(await provider.sendChallenge(input)).toEqual(first);
    const message = provider.getMessage(input.challengeId);
    expect(message?.code).toBe(input.code);
    message?.expiresAt.setTime(0);
    expect(provider.getMessage(input.challengeId)?.expiresAt).toEqual(input.expiresAt);
    provider.clear();
    expect(provider.getMessage(input.challengeId)).toBeUndefined();
  });
});
