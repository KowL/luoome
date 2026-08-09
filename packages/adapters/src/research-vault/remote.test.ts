import { describe, expect, it } from 'vitest';

import { ResearchRemoteDocumentAdapter } from './remote.js';

const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }] as const;

describe('ResearchRemoteDocumentAdapter', () => {
  it('拒绝 loopback、私网和非 http(s) URL', async () => {
    const adapter = new ResearchRemoteDocumentAdapter({ lookupImpl: publicLookup });
    await expect(
      adapter.fetchDocument({
        url: 'http://127.0.0.1/a',
        maxBytes: 100,
        timeoutMs: 1000,
        maxRedirects: 0,
      }),
    ).rejects.toThrow('受保护');
    await expect(
      adapter.fetchDocument({
        url: 'file:///tmp/a',
        maxBytes: 100,
        timeoutMs: 1000,
        maxRedirects: 0,
      }),
    ).rejects.toThrow('http/https');
    const privateDns = new ResearchRemoteDocumentAdapter({
      lookupImpl: async () => [{ address: '10.0.0.1', family: 4 }],
    });
    await expect(
      privateDns.fetchDocument({
        url: 'https://example.test/a',
        maxBytes: 100,
        timeoutMs: 1000,
        maxRedirects: 0,
      }),
    ).rejects.toThrow('受保护');
  });

  it('在每次重定向时重新校验目标并限制次数', async () => {
    let calls = 0;
    const adapter = new ResearchRemoteDocumentAdapter({
      lookupImpl: publicLookup,
      fetchImpl: async (input) => {
        calls += 1;
        if (calls === 1) return new Response(null, { status: 302, headers: { location: '/next' } });
        expect(String(input)).toBe('https://example.test/next');
        return new Response('<title>资料</title><p>正文</p>', {
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8' },
        });
      },
    });
    const result = await adapter.fetchDocument({
      url: 'https://example.test/start',
      maxBytes: 1000,
      timeoutMs: 1000,
      maxRedirects: 1,
    });
    expect(result.finalUrl).toBe('https://example.test/next');
    expect(new TextDecoder().decode(result.content)).toContain('正文');
    const limited = new ResearchRemoteDocumentAdapter({
      lookupImpl: publicLookup,
      fetchImpl: async () => new Response(null, { status: 302, headers: { location: '/again' } }),
    });
    await expect(
      limited.fetchDocument({
        url: 'https://example.test/start',
        maxBytes: 1000,
        timeoutMs: 1000,
        maxRedirects: 0,
      }),
    ).rejects.toThrow('重定向');
  });

  it('限制媒体类型和响应大小，并支持纯文本', async () => {
    const unsupported = new ResearchRemoteDocumentAdapter({
      lookupImpl: publicLookup,
      fetchImpl: async () =>
        new Response('x', { status: 200, headers: { 'content-type': 'image/png' } }),
    });
    await expect(
      unsupported.fetchDocument({
        url: 'https://example.test/a',
        maxBytes: 100,
        timeoutMs: 1000,
        maxRedirects: 0,
      }),
    ).rejects.toThrow('媒体类型');
    const tooLarge = new ResearchRemoteDocumentAdapter({
      lookupImpl: publicLookup,
      fetchImpl: async () =>
        new Response('12345', { status: 200, headers: { 'content-length': '5' } }),
    });
    await expect(
      tooLarge.fetchDocument({
        url: 'https://example.test/a',
        maxBytes: 4,
        timeoutMs: 1000,
        maxRedirects: 0,
      }),
    ).rejects.toThrow('大小');
    const text = new ResearchRemoteDocumentAdapter({
      lookupImpl: publicLookup,
      fetchImpl: async () =>
        new Response('研究正文', { status: 200, headers: { 'content-type': 'text/plain' } }),
    });
    const result = await text.fetchDocument({
      url: 'https://example.test/a.txt',
      maxBytes: 100,
      timeoutMs: 1000,
      maxRedirects: 0,
    });
    expect(result.mediaType).toBe('text/plain');
  });
});
