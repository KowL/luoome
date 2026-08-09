import { lookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import { Readable } from 'node:stream';

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
type ResolvedAddress = { readonly address: string; readonly family: 4 | 6 };
type RemoteFetch = (
  input: string | Request | URL,
  init: RequestInit | undefined,
  resolvedAddress: ResolvedAddress,
) => Promise<Response>;

export interface ResearchRemoteDocumentAdapterOptions {
  readonly fetchImpl?: RemoteFetch;
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

const safeTarget = async (
  raw: string,
  lookupImpl: (hostname: string) => Promise<LookupResult>,
): Promise<{ readonly url: URL; readonly resolvedAddress: ResolvedAddress }> => {
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
  const literalFamily = isIP(hostname);
  if (literalFamily === 4 || literalFamily === 6) {
    if (isPrivateAddress(hostname)) throw new Error('URL 指向受保护的网络地址');
    return { url, resolvedAddress: { address: hostname, family: literalFamily } };
  }
  const addresses = await lookupImpl(hostname);
  if (addresses.length === 0 || addresses.some(({ address }) => isPrivateAddress(address))) {
    throw new Error('URL 解析到受保护的网络地址');
  }
  const selected = addresses[0];
  if (selected === undefined) throw new Error('URL 未解析到可用地址');
  const family = isIP(selected.address);
  if (family !== 4 && family !== 6) throw new Error('URL 未解析到有效 IP 地址');
  return { url, resolvedAddress: { address: selected.address, family } };
};

const abortReason = (signal: AbortSignal): Error =>
  signal.reason instanceof Error ? signal.reason : new Error('远程资料请求超时');

const withAbort = async <T>(promise: Promise<T>, signal: AbortSignal): Promise<T> => {
  if (signal.aborted) throw abortReason(signal);
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(abortReason(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
};

const readLimitedBody = async (
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
): Promise<Uint8Array> => {
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
      const next = await withAbort(reader.read(), signal);
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error('远程响应超过大小限制');
      }
      chunks.push(next.value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
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

const responseHeaders = (headers: NodeJS.Dict<string | string[]>): Headers => {
  const result = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    if (Array.isArray(value)) {
      for (const item of value) result.append(name, item);
    } else if (value !== undefined) {
      result.set(name, value);
    }
  }
  return result;
};

/** 使用预检得到的公网地址连接，同时保留原 hostname 供 Host/SNI/证书校验使用。 */
const pinnedFetch: RemoteFetch = async (input, init, resolvedAddress) => {
  const url = input instanceof Request ? new URL(input.url) : new URL(input.toString());
  // Bun 的 https.request 会传 options.all=true 并期待地址数组；Node 的 LookupFunction
  // 类型只表达单地址回调。两种路径都固定返回同一个已通过预检的地址。
  const pinnedLookup = ((
    _hostname: string,
    options: { readonly all?: boolean },
    callback: (
      error: Error | null,
      address: string | readonly ResolvedAddress[],
      family?: number,
    ) => void,
  ): void => {
    if (options.all === true) {
      callback(null, [resolvedAddress]);
      return;
    }
    callback(null, resolvedAddress.address, resolvedAddress.family);
  }) as LookupFunction;
  return new Promise<Response>((resolve, reject) => {
    const request = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const nodeRequest = request(
      url,
      {
        method: init?.method ?? 'GET',
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
        lookup: pinnedLookup,
        ...(init?.signal === undefined || init.signal === null ? {} : { signal: init.signal }),
      },
      (incoming) => {
        const status = incoming.statusCode ?? 500;
        resolve(
          new Response(Readable.toWeb(incoming) as ReadableStream<Uint8Array>, {
            status,
            ...(incoming.statusMessage === undefined ? {} : { statusText: incoming.statusMessage }),
            headers: responseHeaders(incoming.headers),
          }),
        );
      },
    );
    nodeRequest.on('error', reject);
    nodeRequest.end();
  });
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
  private readonly fetchImpl: RemoteFetch;
  private readonly lookupImpl: (hostname: string) => Promise<LookupResult>;
  private readonly maxBytes: number;
  private readonly timeoutMs: number;
  private readonly maxRedirects: number;
  private readonly userAgent: string;

  constructor(options: ResearchRemoteDocumentAdapterOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? pinnedFetch;
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
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new Error(`远程资料请求超时（${timeoutMs}ms）`)),
      timeoutMs,
    );
    try {
      let current = await withAbort(safeTarget(input.url, this.lookupImpl), controller.signal);
      for (let redirects = 0; ; redirects += 1) {
        let response: Response;
        try {
          response = await this.fetchImpl(
            current.url,
            {
              redirect: 'manual',
              signal: controller.signal,
              headers: {
                accept: 'text/html, application/xhtml+xml, text/plain, application/pdf',
                'user-agent': this.userAgent,
              },
            },
            current.resolvedAddress,
          );
        } catch (error) {
          throw new Error(
            `远程资料请求失败: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        if (REDIRECT_STATUS.has(response.status)) {
          await response.body?.cancel().catch(() => undefined);
          if (redirects >= maxRedirects) throw new Error('远程资料重定向次数超过限制');
          const location = response.headers.get('location');
          if (location === null) throw new Error('远程资料重定向缺少 Location');
          current = await withAbort(
            safeTarget(new URL(location, current.url).toString(), this.lookupImpl),
            controller.signal,
          );
          continue;
        }
        if (!response.ok) {
          await response.body?.cancel().catch(() => undefined);
          throw new Error(`远程资料 HTTP ${response.status}`);
        }
        const mediaType = mediaTypeOf(response, current.url);
        const content = await readLimitedBody(response, maxBytes, controller.signal);
        return {
          requestedUrl: input.url,
          finalUrl: current.url.toString(),
          mediaType,
          content,
          fetchedAt: new Date(),
        };
      }
    } finally {
      clearTimeout(timer);
    }
  }
}
