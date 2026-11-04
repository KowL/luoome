import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rm, statfs } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { httpStatusErrorKind, isAbortError, SourceExecutionError } from '../source-error.js';

/**
 * 预签名 artifact 安全下载器（设计 §5.2 安全约束，Phase 0 证据 §1）。
 *
 * - 请求不携带任何鉴权头：预签名 URL 自含签名，API key 只用于 download-url 端点；
 * - 不用 HEAD（签名按 GET 签发，HEAD 实测 403）：大小探测用 `Range: bytes=0-0` 读 Content-Range；
 * - 重定向手工跟随：跨 origin 跳转不转发任何自定义头，且最多 3 次；
 * - 流式写盘 + 流式 SHA-256，不整文件载入内存；
 * - 所有错误消息只含 host 与状态码，不含 URL 路径与签名参数。
 */

export interface SecureDownloaderOptions {
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  readonly maxRedirects?: number;
  readonly maxBytes?: number;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_REDIRECTS = 3;

/** 脱敏：只保留 origin，用于日志与错误消息。 */
const originOf = (url: string): string => {
  try {
    return new URL(url).origin;
  } catch {
    return 'invalid-url';
  }
};

const fetchError = (
  kind: SourceExecutionError['kind'],
  url: string,
  detail: string,
): SourceExecutionError =>
  new SourceExecutionError(kind, `market-dump download: ${detail}（host=${originOf(url)}）`);

interface FetchResponse {
  readonly status: number;
  readonly headers: Headers;
  readonly body: ReadableStream<Uint8Array> | null;
}

const fetchOnce = async (
  fetchImpl: typeof fetch,
  url: string,
  init: { readonly headers: Record<string, string>; readonly signal: AbortSignal },
): Promise<FetchResponse> => {
  // redirect: 'manual' —— 重定向由本层显式处理，避免 fetch 自动跟随时把
  // 自定义头转发到其它 origin，也避免签名 URL 在日志层扩散。
  const res = await fetchImpl(url, { method: 'GET', redirect: 'manual', ...init });
  return { status: res.status, headers: res.headers, body: res.body };
};

/** Range 探测远端大小；HEAD 被签名拒绝（403），这是唯一允许的大小探测路径。 */
export const probeRemoteSize = async (
  url: string,
  options: SecureDownloaderOptions = {},
): Promise<number> => {
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetchOnce(fetchImpl, url, {
      headers: { Range: 'bytes=0-0' },
      signal: controller.signal,
    });
    if (res.status !== 206) {
      throw fetchError(
        httpStatusErrorKind(res.status),
        url,
        `Range 探测返回 ${res.status}（期望 206）`,
      );
    }
    const contentRange = res.headers.get('content-range');
    const match = contentRange === null ? null : /^bytes 0-0\/(\d+)$/.exec(contentRange.trim());
    if (match === null) {
      throw fetchError('invalid_payload', url, 'Range 探测缺少有效 Content-Range');
    }
    // 消费/取消 body，避免连接悬挂。
    await res.body?.cancel().catch(() => undefined);
    return Number(match[1]);
  } catch (error) {
    if (error instanceof SourceExecutionError) throw error;
    throw fetchError(isAbortError(error) ? 'timeout' : 'network', url, 'Range 探测失败');
  } finally {
    clearTimeout(timer);
  }
};

/** 流式下载并计算 SHA-256；只创建新文件，失败清理本次创建的半成品。 */
export const downloadToFile = async (
  url: string,
  localPath: string,
  options: SecureDownloaderOptions = {},
): Promise<{ readonly bytes: number; readonly sha256: string }> => {
  const fetchImpl = options.fetchImpl ?? fetch;
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const maxBytes = options.maxBytes ?? 1024 ** 3;
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw fetchError('invalid_payload', url, 'maxBytes 必须为正安全整数');
  }
  const targetPath = resolve(localPath);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  let currentUrl = url;
  let res: FetchResponse | undefined;
  let created = false;
  let complete = false;
  try {
    for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount += 1) {
      // 每次跳转都重新发起裸 GET，不携带任何自定义头。
      res = await fetchOnce(fetchImpl, currentUrl, { headers: {}, signal: controller.signal });
      if (res.status < 300 || res.status >= 400) break;
      const location = res.headers.get('location');
      await res.body?.cancel();
      if (location === null) {
        throw fetchError('upstream_error', currentUrl, `重定向 ${res.status} 缺少 Location`);
      }
      currentUrl = new URL(location, currentUrl).toString();
    }
    if (res === undefined || (res.status >= 300 && res.status < 400)) {
      throw fetchError('upstream_error', url, `重定向次数超过 ${maxRedirects}`);
    }
    if (res.status !== 200) {
      throw fetchError(httpStatusErrorKind(res.status), currentUrl, `下载返回 ${res.status}`);
    }
    if (res.body === null) throw fetchError('invalid_payload', currentUrl, '下载响应缺少 body');

    const lengthHeader = res.headers.get('content-length');
    const expectedBytes = lengthHeader === null ? null : Number(lengthHeader);
    if (
      expectedBytes !== null &&
      (!/^\d+$/.test(lengthHeader ?? '') ||
        !Number.isSafeInteger(expectedBytes) ||
        expectedBytes > maxBytes)
    ) {
      throw fetchError('invalid_payload', currentUrl, 'Content-Length 无效或超过 maxBytes');
    }
    await mkdir(dirname(targetPath), { recursive: true });
    const disk = await statfs(dirname(targetPath));
    if (disk.bavail * disk.bsize < (expectedBytes ?? maxBytes)) {
      throw fetchError('network', currentUrl, '磁盘可用空间不足');
    }

    const hash = createHash('sha256');
    let bytes = 0;
    const counting = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        bytes += chunk.byteLength;
        if (bytes > maxBytes || (expectedBytes !== null && bytes > expectedBytes)) {
          callback(
            fetchError('invalid_payload', currentUrl, '实际下载大小超过上限或 Content-Length'),
          );
          return;
        }
        hash.update(chunk);
        callback(null, chunk);
      },
    });
    const output = createWriteStream(targetPath, { flags: 'wx' });
    output.once('open', () => {
      created = true;
    });
    await pipeline(
      Readable.fromWeb(res.body as unknown as import('node:stream/web').ReadableStream),
      counting,
      output,
      { signal: controller.signal },
    );
    if (expectedBytes !== null && bytes !== expectedBytes) {
      throw fetchError('invalid_payload', currentUrl, '实际下载大小与 Content-Length 不一致');
    }
    complete = true;
    return { bytes, sha256: hash.digest('hex') };
  } catch (error) {
    if (error instanceof SourceExecutionError) throw error;
    throw fetchError(
      controller.signal.aborted || isAbortError(error) ? 'timeout' : 'network',
      currentUrl,
      '下载或写盘失败',
    );
  } finally {
    clearTimeout(timer);
    if (res?.body !== null && res?.body !== undefined && !res.body.locked) {
      await res.body.cancel().catch(() => undefined);
    }
    // wx 成功打开的目标才归本次调用所有；resolve 固定清理路径，保留既有文件。
    if (!complete && created) {
      await rm(targetPath).catch(() => {
        throw fetchError('network', currentUrl, '半成品清理失败');
      });
    }
  }
};
