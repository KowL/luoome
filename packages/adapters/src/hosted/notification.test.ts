import type { SMTPSentMessageInfo } from 'nodemailer';
import { describe, expect, it, vi } from 'vitest';
import {
  FixtureHostedNotificationAdapter,
  SmtpHostedNotificationAdapter,
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

const smtpOptions = {
  host: 'smtp.example.test',
  port: 587,
  secure: false,
  from: 'notification@example.test',
  auth: { user: 'smtp-user', pass: 'fixture-password' },
  publicOrigin: 'https://luoome.example.test',
};
const smtpRequest = {
  deliveryIntentId: 'intent-smtp',
  destination: 'recipient@example.test',
  subject: 'luoome 有新的事实记录',
  message: '请登录查看提醒',
  authenticatedUrl: 'https://luoome.example.test/#alerts?triggerId=trigger-1',
};
const smtpReceipt: SMTPSentMessageInfo = {
  accepted: [smtpRequest.destination],
  rejected: [],
  envelope: { from: smtpOptions.from, to: [smtpRequest.destination] },
  messageId: '<notification@example.test>',
  response: '250 2.0.0 Queued',
  envelopeTime: 1,
  messageTime: 1,
  messageSize: 100,
};

describe('SMTP hosted notifications', () => {
  it('uses an injected transport, one bound mailbox and a login link without claiming device delivery', async () => {
    const transport = { sendMail: vi.fn().mockResolvedValue(smtpReceipt) };
    const provider = new SmtpHostedNotificationAdapter(smtpOptions, { transport });
    expect(provider.providerKind).toBe('live');
    expect(provider.configured).toBe(true);
    expect(provider.idempotency).toBe('unsupported');
    expect(transport.sendMail).not.toHaveBeenCalled();
    expect(await provider.send(smtpRequest)).toEqual({
      state: 'accepted',
      providerMessageId: smtpReceipt.messageId,
    });
    expect(transport.sendMail).toHaveBeenCalledWith({
      from: { name: 'luoome', address: smtpOptions.from },
      to: [{ address: smtpRequest.destination, name: '' }],
      envelope: { from: smtpOptions.from, to: [smtpRequest.destination] },
      subject: smtpRequest.subject,
      text: expect.stringContaining(smtpRequest.authenticatedUrl),
    });
    expect(await provider.lookup()).toEqual({ state: 'unknown' });
    expect(transport.sendMail).toHaveBeenCalledTimes(1);
  });

  it.each([
    { destination: 'a@example.test,b@example.test' },
    { destination: 'a@example.test\r\nBcc: b@example.test' },
    { subject: 'subject\r\nBcc: b@example.test' },
    { authenticatedUrl: 'https://other.example.test/#alerts' },
    { authenticatedUrl: 'https://user:secret@luoome.example.test/#alerts' },
    { authenticatedUrl: 'javascript:alert(1)' },
  ])(
    'blocks injected recipients, headers and untrusted links before transport: %j',
    async (extra) => {
      const transport = { sendMail: vi.fn() };
      const provider = new SmtpHostedNotificationAdapter(smtpOptions, { transport });
      expect(await provider.send({ ...smtpRequest, ...extra })).toEqual({
        state: 'failed',
        errorKind: 'provider-rejected',
      });
      expect(transport.sendMail).not.toHaveBeenCalled();
    },
  );

  it('validates encrypted SMTP and a fixed origin even when a transport is injected', () => {
    const transport = { sendMail: vi.fn() };
    expect(
      () => new SmtpHostedNotificationAdapter({ ...smtpOptions, starttls: false }, { transport }),
    ).toThrow('TLS');
    expect(
      () =>
        new SmtpHostedNotificationAdapter(
          { ...smtpOptions, publicOrigin: 'http://example.test' },
          { transport },
        ),
    ).toThrow('HTTPS');
    expect(
      () =>
        new SmtpHostedNotificationAdapter(
          { ...smtpOptions, publicOrigin: 'https://example.test/path' },
          { transport },
        ),
    ).toThrow('origin');
    expect(
      new SmtpHostedNotificationAdapter(
        { ...smtpOptions, publicOrigin: 'http://example.test', allowInsecureHttp: true },
        { transport },
      ).configured,
    ).toBe(true);
  });

  it.each([
    { code: 'EAUTH', responseCode: 535 },
    { code: 'EDNS' },
    { code: 'ETLS' },
    { code: 'EMESSAGE', command: 'DATA', responseCode: 451 },
    { code: 'ETIMEDOUT', timeoutType: 'CONNECT_TIMEOUT' },
  ])('returns a sanitized failure for definite SMTP rejection: %j', async (error) => {
    const transport = {
      sendMail: vi
        .fn()
        .mockRejectedValue(Object.assign(new Error('private body/credential'), error)),
    };
    expect(
      await new SmtpHostedNotificationAdapter(smtpOptions, { transport }).send(smtpRequest),
    ).toEqual({ state: 'failed', errorKind: 'provider-rejected' });
    expect(transport.sendMail).toHaveBeenCalledTimes(1);
  });

  it.each([
    { code: 'ETIMEDOUT', command: 'CONN', timeoutType: 'SOCKET_TIMEOUT' },
    { code: 'ESOCKET', command: 'CONN' },
    { code: 'ECONNECTION' },
  ])('keeps ambiguous sends unknown without transport retries: %j', async (error) => {
    const transport = { sendMail: vi.fn().mockRejectedValue(error) };
    const provider = new SmtpHostedNotificationAdapter(smtpOptions, { transport });
    expect(await provider.send(smtpRequest)).toEqual({ state: 'unknown' });
    expect(await provider.lookup()).toEqual({ state: 'unknown' });
    expect(transport.sendMail).toHaveBeenCalledTimes(1);
  });

  it('requires final acceptance for the intended mailbox and keeps incomplete receipts unknown', async () => {
    const transport = {
      sendMail: vi
        .fn()
        .mockResolvedValueOnce({
          ...smtpReceipt,
          accepted: [],
          rejected: [smtpRequest.destination],
        })
        .mockResolvedValueOnce({ ...smtpReceipt, accepted: ['other@example.test'] })
        .mockResolvedValueOnce({ ...smtpReceipt, response: '' })
        .mockResolvedValueOnce({ ...smtpReceipt, messageId: '' }),
    };
    const provider = new SmtpHostedNotificationAdapter(smtpOptions, { transport });
    expect(await provider.send(smtpRequest)).toEqual({
      state: 'failed',
      errorKind: 'provider-rejected',
    });
    for (let i = 0; i < 3; i++)
      expect(await provider.send(smtpRequest)).toEqual({ state: 'unknown' });
  });
});
