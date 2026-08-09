import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

import type { ResearchRemoteDocument, ResearchRemoteImportAdapterLike } from '@luoome/core';

const DEFAULT_MAX_BYTES = 20 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_REDIRECTS = 3;
const ALLOWED_MEDIA_TYPES = new Set([
  'text/html',
  'application/xhtml+xml',
  'text/plain',
  'application/pdf',
]);
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

type LookupResult = readonly { readonly address: string; readonly family: number }[];

export interface ResearchRemoteDocumentAdapterOptions {
  readonly fetchImpl?: (input: string | Request | URL, init?: RequestInit) => Promise<Response>;
  readonly lookupImpl?: (hostname: string) => Promise<LookupResult>;
  readonly maxBytes?: number;
  readonly timeoutMs?: number;
  readonly maxRedirects?: number;
  readonly userAgent?: string;
}

const defaultLookup = async (hostname: string): Promise<LookupResult> =>
  (await lookup(hostname, { all: true, verbatim: true })) as LookupResult;

const ipv4Parts = (value: string): number[] | undefined => {
  const parts = value.split('.');
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) return undefined;
  const numbers = parts.map(Number);
  return numbers.every((part) => part >= 0 && part <= 255) ? numbers : undefined;
};

const isPrivateIpv4 = (value: string): boolean => {
  const parts = ipv4Parts(value);
  if (parts === undefined) return true;
  const a = parts[0] ?? 255;
  const b = parts[1] ?? 255;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
};

const isPrivateIpv6 = (value: string): boolean => {
  const normalized = value.toLowerCase().split('%')[0] ?? '';
  const mappedText = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (mappedText !== undefined) return isPrivateIpv4(mappedText);
  const [left, right] = normalized.split('::');
  const leftGroups = left === undefined || left === '' ? [] : left.split(':');
  const rightGroups = right === undefined || right === '' ? [] : right.split(':');
  if (leftGroups.some((group) => !/^[\da-f]{1,4}$/.test(group))) return true;
  if (rightGroups.some((group) => !/^[\da-f]{1,4}$/.test(group))) return true;
  if (normalized.includes('::') === false && leftGroups.length !== 8) return true;
  if (leftGroups.length + rightGroups.length > 8) return true;
  const groups = [
    ...leftGroups,
    ...Array.from({ length: 8 - leftGroups.length - rightGroups.length }, () => '0'),
    ...rightGroups,
  ].map((group) => Number.parseInt(group, 16));
  const bytes = groups.flatMap((group) => [group >> 8, group & 0xff]);
  if (
    bytes.every((byte) => byte === 0) ||
    (bytes.at(-1) === 1 && bytes.slice(0, -1).every((byte) => byte === 0))
  )
    return true;
  if (
    bytes[0] === 0xfc ||
    bytes[0] === 0xfd ||
    (bytes[0] === 0xfe && (bytes[1] ?? 0) >= 0x80 && (bytes[1] ?? 0) <= 0xbf)
  )
    return true;
  if (bytes.slice(0, 10).every((byte) => byte === 0) && bytes[10] === 0xff && bytes[11] === 0xff) {
    return isPrivateIpv4(`${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`);
  }
  return false;
};

const isPrivateAddress = (value: string): boolean => {
  const family = isIP(value);
  if (family === 4) return isPrivateIpv4(value);
  if (family === 6) return isPrivateIpv6(value);
  return true;
};

const safeUrl = async (
  raw: string,
  lookupImpl: (hostname: string) => Promise<LookupResult>,
): Promise<URL> => {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('URL 无效');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('仅允许 http/https URL');
  }
  if (url.username.length > 0 || url.password.length > 0) {
    throw new Error('URL 不允许携带用户凭据');
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(hostname) !== 0) {
    if (isPrivateAddress(hostname)) throw new Error('URL 指向受保护的网络地址');
    return url;
  }
  const addresses = await lookupImpl(hostname);
  if (addresses.length === 0 || addresses.some(({ address }) => isPrivateAddress(address))) {
    throw new Error('URL 解析到受保护的网络地址');
  }
  return url;
};

const readLimitedBody = async (response: Response, maxBytes: number): Promise<Uint8Array> => {
  const advertised = response.headers.get('content-length');
  if (advertised !== null && Number(advertised) > maxBytes) {
    throw new Error('远程响应超过大小限制');
  }
  if (response.body === null) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) throw new Error('远程响应超过大小限制');
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error('远程响应超过大小限制');
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
};

const mediaTypeOf = (response: Response, url: URL): string => {
  const header = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  if (header !== undefined && ALLOWED_MEDIA_TYPES.has(header)) return header;
  if (header !== undefined && header.length > 0) throw new Error(`不支持的远程媒体类型: ${header}`);
  if (url.pathname.toLowerCase().endsWith('.pdf')) return 'application/pdf';
  if (url.pathname.toLowerCase().endsWith('.txt')) return 'text/plain';
  return 'text/html';
};

export class ResearchRemoteDocumentAdapter implements ResearchRemoteImportAdapterLike {
  readonly name = 'safe-research-remote';
  private readonly fetchImpl: (
    input: string | Request | URL,
    init?: RequestInit,
  ) => Promise<Response>;
  private readonly lookupImpl: (hostname: string) => Promise<LookupResult>;
  private readonly maxBytes: number;
  private readonly timeoutMs: number;
  private readonly maxRedirects: number;
  private readonly userAgent: string;

  constructor(options: ResearchRemoteDocumentAdapterOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.lookupImpl = options.lookupImpl ?? defaultLookup;
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
    this.userAgent = options.userAgent ?? 'luoome-research-import/1';
    if (!Number.isSafeInteger(this.maxBytes) || this.maxBytes <= 0)
      throw new Error('maxBytes must be positive');
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs <= 0)
      throw new Error('timeoutMs must be positive');
    if (!Number.isSafeInteger(this.maxRedirects) || this.maxRedirects < 0)
      throw new Error('maxRedirects must be nonnegative');
  }

  async fetchDocument(input: {
    readonly url: string;
    readonly maxBytes: number;
    readonly timeoutMs: number;
    readonly maxRedirects: number;
  }): Promise<ResearchRemoteDocument> {
    const maxBytes = Math.min(input.maxBytes, this.maxBytes);
    const timeoutMs = Math.min(input.timeoutMs, this.timeoutMs);
    const maxRedirects = Math.min(input.maxRedirects, this.maxRedirects);
    let current = await safeUrl(input.url, this.lookupImpl);
    for (let redirects = 0; ; redirects += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let response: Response;
      try {
        response = await this.fetchImpl(current, {
          redirect: 'manual',
          signal: controller.signal,
          headers: {
            accept: 'text/html, application/xhtml+xml, text/plain, application/pdf',
            'user-agent': this.userAgent,
          },
        });
      } catch (error) {
        throw new Error(
          `远程资料请求失败: ${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        clearTimeout(timer);
      }
      if (REDIRECT_STATUS.has(response.status)) {
        if (redirects >= maxRedirects) throw new Error('远程资料重定向次数超过限制');
        const location = response.headers.get('location');
        if (location === null) throw new Error('远程资料重定向缺少 Location');
        current = await safeUrl(new URL(location, current).toString(), this.lookupImpl);
        continue;
      }
      if (!response.ok) throw new Error(`远程资料 HTTP ${response.status}`);
      const mediaType = mediaTypeOf(response, current);
      const content = await readLimitedBody(response, maxBytes);
      return {
        requestedUrl: input.url,
        finalUrl: current.toString(),
        mediaType,
        content,
        fetchedAt: new Date(),
      };
    }
  }
}
