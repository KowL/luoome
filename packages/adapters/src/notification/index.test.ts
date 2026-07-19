import type { NotificationRepository, RepositoryRegistry } from '@luoome/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FeishuWebhookAdapter } from './feishu.js';
import { LogChannelAdapter } from './log-channel.js';
import { NotificationManager } from './manager.js';

// ---------- helpers ----------

class InMemNotificationRepo implements NotificationRepository {
  rows = new Map<string, Parameters<NotificationRepository['save']>[0]>();

  async save(n: Parameters<NotificationRepository['save']>[0]): Promise<void> {
    this.rows.set(n.id, n);
  }
  async findById(id: string) {
    return this.rows.get(id) ?? null;
  }
  async listByAdvice(adviceId: string) {
    return Array.from(this.rows.values())
      .filter((n) => n.adviceId === adviceId)
      .sort((a, b) => b.sentAt.getTime() - a.sentAt.getTime());
  }
  async listBySignal(signalId: string) {
    return Array.from(this.rows.values())
      .filter((n) => n.tacticSignalId === signalId)
      .sort((a, b) => b.sentAt.getTime() - a.sentAt.getTime());
  }
  async listRecent(
    filter: {
      channel?: 'feishu' | 'log';
      result?: 'success' | 'failed' | 'suppressed';
      since?: Date;
      limit?: number;
    } = {},
  ) {
    let xs = Array.from(this.rows.values());
    if (filter.channel !== undefined) xs = xs.filter((n) => n.channel === filter.channel);
    if (filter.result !== undefined) xs = xs.filter((n) => n.result === filter.result);
    const since = filter.since;
    if (since !== undefined) xs = xs.filter((n) => n.sentAt >= since);
    xs.sort((a, b) => b.sentAt.getTime() - a.sentAt.getTime());
    if (filter.limit !== undefined) xs = xs.slice(0, filter.limit);
    return xs;
  }
}

const makeRepos = (): { repos: RepositoryRegistry; notif: InMemNotificationRepo } => {
  const notif = new InMemNotificationRepo();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const repos = { notification: notif } as unknown as RepositoryRegistry;
  return { repos, notif };
};

const noopLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

// ---------- tests ----------

describe('notification/LogChannelAdapter', () => {
  it('按 level 路由到 logger.info / warn / error', async () => {
    const seen: Array<{ level: string; line: string }> = [];
    const logger = {
      info: (m: string) => seen.push({ level: 'info', line: m }),
      warn: (m: string) => seen.push({ level: 'warn', line: m }),
      error: (m: string) => seen.push({ level: 'error', line: m }),
    };
    const a = new LogChannelAdapter({ logger });
    await a.send({ title: 't', content: 'c', level: 'info' });
    await a.send({ title: 't', content: 'c', level: 'warn' });
    await a.send({ title: 't', content: 'c', level: 'error' });
    expect(seen.map((s) => s.level)).toEqual(['info', 'warn', 'error']);
    expect(seen[0]?.line).toContain('[luoome/notify]');
  });
});

describe('notification/FeishuWebhookAdapter', () => {
  let fetchCalls: Array<{ url: string; body: unknown; status: number; bodyJson?: unknown }>;

  beforeEach(() => {
    fetchCalls = [];
  });
  afterEach(() => {
    fetchCalls = [];
  });

  it('POST 200 + StatusCode=0 → ok=true', async () => {
    const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
      fetchCalls.push({ url, body: init?.body, status: 200, bodyJson: { StatusCode: 0 } });
      return new Response(JSON.stringify({ StatusCode: 0 }), { status: 200 });
    };
    const a = new FeishuWebhookAdapter({ webhookUrl: 'https://x', fetchImpl, logger: noopLogger });
    const res = await a.send({ title: 't', content: 'c', level: 'info' });
    expect(res.ok).toBe(true);
    expect(fetchCalls).toHaveLength(1);
    const body = JSON.parse((fetchCalls[0]?.body as string) ?? '{}');
    expect(body.msg_type).toBe('interactive');
    expect(body.card.header.title.content).toContain('t');
  });

  it('业务码 StatusCode != 0 → 抛 FeishuAdapterError fatal', async () => {
    const fetchImpl = async (): Promise<Response> =>
      new Response(JSON.stringify({ StatusCode: 99999, msg: 'rate limited' }), { status: 200 });
    const a = new FeishuWebhookAdapter({ webhookUrl: 'https://x', fetchImpl, logger: noopLogger });
    await expect(a.send({ title: 't', content: 'c', level: 'info' })).rejects.toMatchObject({
      name: 'FeishuAdapterError',
      recoverable: false,
    });
  });

  it('HTTP 5xx → 抛 FeishuAdapterError recoverable', async () => {
    const fetchImpl = async (): Promise<Response> => new Response('upstream', { status: 503 });
    const a = new FeishuWebhookAdapter({ webhookUrl: 'https://x', fetchImpl, logger: noopLogger });
    await expect(a.send({ title: 't', content: 'c', level: 'info' })).rejects.toMatchObject({
      name: 'FeishuAdapterError',
      recoverable: true,
    });
  });

  it('HTTP 400 → 抛 FeishuAdapterError fatal', async () => {
    const fetchImpl = async (): Promise<Response> => new Response('bad', { status: 400 });
    const a = new FeishuWebhookAdapter({ webhookUrl: 'https://x', fetchImpl, logger: noopLogger });
    await expect(a.send({ title: 't', content: 'c', level: 'info' })).rejects.toMatchObject({
      name: 'FeishuAdapterError',
      recoverable: false,
    });
  });

  it('atMobiles 透传到 body.at', async () => {
    let capturedBody: unknown;
    const fetchImpl = async (_u: string, init?: RequestInit): Promise<Response> => {
      capturedBody = init?.body;
      return new Response(JSON.stringify({ StatusCode: 0 }), { status: 200 });
    };
    const a = new FeishuWebhookAdapter({ webhookUrl: 'https://x', fetchImpl, logger: noopLogger });
    await a.send({ title: 't', content: 'c', level: 'warn', atMobiles: ['13800001111'] });
    const body = JSON.parse(capturedBody as string);
    expect(body.at).toEqual({ atMobiles: ['13800001111'] });
  });
});

describe('notification/NotificationManager', () => {
  it('feishu 成功 → result=success', async () => {
    const { repos, notif } = makeRepos();
    const fetchImpl = async (): Promise<Response> =>
      new Response(JSON.stringify({ StatusCode: 0 }), { status: 200 });
    const feishu = new FeishuWebhookAdapter({
      webhookUrl: 'https://x',
      fetchImpl,
      logger: noopLogger,
    });
    const mgr = new NotificationManager({
      repos,
      feishu,
      logger: noopLogger,
      clock: () => new Date('2026-07-20T00:00:00Z'),
      idGenerator: () => 'n-1',
    });
    const r = await mgr.send({
      channel: 'feishu',
      payload: { title: 't', content: 'c', level: 'info' },
      adviceId: 'a-1',
    });
    expect(r.notification.result).toBe('success');
    expect(notif.rows.size).toBe(1);
    expect(notif.rows.get('n-1')?.adviceId).toBe('a-1');
  });

  it('feishu 失败 → result=failed + errorMessage', async () => {
    const { repos, notif } = makeRepos();
    const fetchImpl = async (): Promise<Response> => new Response('bad', { status: 503 });
    const feishu = new FeishuWebhookAdapter({
      webhookUrl: 'https://x',
      fetchImpl,
      logger: noopLogger,
    });
    const mgr = new NotificationManager({
      repos,
      feishu,
      logger: noopLogger,
      idGenerator: () => 'n-1',
    });
    const r = await mgr.send({
      channel: 'feishu',
      payload: { title: 't', content: 'c', level: 'info' },
    });
    expect(r.notification.result).toBe('failed');
    expect(r.notification.errorMessage).toContain('503');
    expect(notif.rows.size).toBe(1);
  });

  it('feishu 未配置 → result=suppressed', async () => {
    const { repos, notif } = makeRepos();
    const mgr = new NotificationManager({ repos, logger: noopLogger, idGenerator: () => 'n-1' });
    const r = await mgr.send({
      channel: 'feishu',
      payload: { title: 't', content: 'c', level: 'info' },
    });
    expect(r.notification.result).toBe('suppressed');
    expect(notif.rows.size).toBe(1);
  });

  it('log channel 永远 success', async () => {
    const { repos, notif } = makeRepos();
    const mgr = new NotificationManager({ repos, logger: noopLogger, idGenerator: () => 'n-1' });
    const r = await mgr.sendLog({ title: 't', content: 'c', level: 'info' });
    expect(r.notification.result).toBe('success');
    expect(notif.rows.get('n-1')?.channel).toBe('log');
  });
});
