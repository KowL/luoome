import { createHash } from 'node:crypto';
import * as fsPromises from 'node:fs/promises';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { SourceExecutionError } from '../source-error.js';
import { downloadToFile, probeRemoteSize } from './downloader.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, statfs: vi.fn(actual.statfs) };
});

/**
 * 安全下载器测试（设计 §5.2，Phase 0 证据 §1）：
 * - 请求不携带任何鉴权头（预签名 URL 自含签名，API key 不上 S3）；
 * - 不用 HEAD（签名按 GET 签发，实测 403）；大小探测只走 Range: bytes=0-0；
 * - 重定向手工跟随：跨 origin 不转发自定义头，最多 3 次；
 * - 流式写盘 + 流式 SHA-256。
 * 全部用注入 fetchImpl 的内存响应，不走真实网络。
 */

const PAYLOAD = new TextEncoder().encode('parquet-fixture-bytes');
const PAYLOAD_SHA256 = createHash('sha256').update(PAYLOAD).digest('hex');

interface RecordedRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
}

const recordingFetch = (
  handler: (request: RecordedRequest) => Response,
): { readonly fetchImpl: typeof fetch; readonly requests: RecordedRequest[] } => {
  const requests: RecordedRequest[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value;
    });
    const request: RecordedRequest = {
      url: String(url),
      method: init?.method ?? 'GET',
      headers,
    };
    requests.push(request);
    return handler(request);
  }) as typeof fetch;
  return { fetchImpl, requests };
};

const bodyResponse = (status: number, body: Uint8Array, headers: Record<string, string> = {}) =>
  new Response(body, { status, headers });

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'market-dump-download-'));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('probeRemoteSize', () => {
  it('用 GET + Range: bytes=0-0 探测大小（不用 HEAD），解析 Content-Range', async () => {
    const { fetchImpl, requests } = recordingFetch((request) => {
      expect(request.method).toBe('GET');
      expect(request.headers.range).toBe('bytes=0-0');
      return bodyResponse(206, new Uint8Array(1), {
        'content-range': 'bytes 0-0/1057663',
      });
    });
    const size = await probeRemoteSize('https://o.thsi.cn/signed', { fetchImpl });
    expect(size).toBe(1057663);
    expect(requests).toHaveLength(1);
    // 不携带任何鉴权头
    expect(requests[0]?.headers['x-api-key']).toBeUndefined();
    expect(requests[0]?.headers.authorization).toBeUndefined();
  });

  it('非 206（如 HEAD 式 403）→ 结构化错误，kind 按状态码映射', async () => {
    const { fetchImpl } = recordingFetch(() => bodyResponse(403, new Uint8Array(0)));
    await expect(probeRemoteSize('https://o.thsi.cn/signed', { fetchImpl })).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof SourceExecutionError &&
        error.kind === 'permission' &&
        /Range 探测返回 403/.test(error.message),
    );
  });

  it('缺少有效 Content-Range → invalid_payload', async () => {
    const { fetchImpl } = recordingFetch(() => bodyResponse(206, new Uint8Array(1)));
    await expect(probeRemoteSize('https://o.thsi.cn/signed', { fetchImpl })).rejects.toSatisfy(
      (error: unknown) => error instanceof SourceExecutionError && error.kind === 'invalid_payload',
    );
  });

  it('错误消息只含 host，不含 URL 路径与签名参数', async () => {
    const { fetchImpl } = recordingFetch(() => bodyResponse(500, new Uint8Array(0)));
    await expect(
      probeRemoteSize('https://o.thsi.cn/secret/path?Signature=abc123', { fetchImpl }),
    ).rejects.toSatisfy((error: unknown) => {
      const message = (error as Error).message;
      return (
        message.includes('host=https://o.thsi.cn') &&
        !message.includes('secret') &&
        !message.includes('Signature')
      );
    });
  });
});

describe('downloadToFile', () => {
  it('body 卡住仍按总超时中止，清理半成品且错误脱敏', async () => {
    const localPath = join(dir, 'timeout.parquet');
    const cancel = vi.fn();
    const { fetchImpl } = recordingFetch(
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(PAYLOAD);
            },
            cancel,
          }),
        ),
    );
    await expect(
      downloadToFile('https://o.thsi.cn/private?Signature=secret', localPath, {
        fetchImpl,
        timeoutMs: 30,
      }),
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof SourceExecutionError &&
        error.kind === 'timeout' &&
        !error.message.includes('Signature') &&
        !error.message.includes(dir),
    );
    expect(cancel).toHaveBeenCalledOnce();
    await expect(stat(localPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each([false, true])('有/无 Content-Length（%s）都执行 maxBytes 门禁', async (declared) => {
    const localPath = join(dir, `too-large-${declared}.parquet`);
    const { fetchImpl } = recordingFetch(() =>
      bodyResponse(200, PAYLOAD, declared ? { 'content-length': String(PAYLOAD.length) } : {}),
    );
    await expect(
      downloadToFile('https://o.thsi.cn/signed', localPath, {
        fetchImpl,
        maxBytes: PAYLOAD.length - 1,
      }),
    ).rejects.toMatchObject({ kind: 'invalid_payload' });
    await expect(stat(localPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('Content-Length 与实际字节数不一致失败并清理', async () => {
    const localPath = join(dir, 'wrong-length.parquet');
    const { fetchImpl } = recordingFetch(() =>
      bodyResponse(200, PAYLOAD, { 'content-length': String(PAYLOAD.length + 1) }),
    );
    await expect(
      downloadToFile('https://o.thsi.cn/signed', localPath, { fetchImpl }),
    ).rejects.toMatchObject({ kind: 'invalid_payload' });
    await expect(stat(localPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('磁盘可用空间不足时不开始写文件', async () => {
    const localPath = join(dir, 'disk-full.parquet');
    const disk = vi
      .spyOn(fsPromises, 'statfs')
      .mockResolvedValue({ bsize: 1, bavail: 1 } as Awaited<ReturnType<typeof fsPromises.statfs>>);
    const { fetchImpl } = recordingFetch(() => bodyResponse(200, PAYLOAD));
    try {
      await expect(
        downloadToFile('https://o.thsi.cn/signed', localPath, { fetchImpl }),
      ).rejects.toMatchObject({ kind: 'network', message: expect.stringContaining('磁盘') });
      await expect(stat(localPath)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      disk.mockRestore();
    }
  });

  it('失败时保留调用前已存在的文件', async () => {
    const localPath = join(dir, 'existing.parquet');
    await fsPromises.writeFile(localPath, PAYLOAD);
    const { fetchImpl } = recordingFetch(() => bodyResponse(200, new Uint8Array([1, 2, 3])));
    await expect(
      downloadToFile('https://o.thsi.cn/signed', localPath, { fetchImpl }),
    ).rejects.toMatchObject({ kind: 'network' });
    expect(new Uint8Array(await readFile(localPath))).toEqual(PAYLOAD);
  });
  it('流式写盘并计算 SHA-256；请求不带鉴权头与 Range', async () => {
    const { fetchImpl, requests } = recordingFetch((request) => {
      expect(request.method).toBe('GET');
      return bodyResponse(200, PAYLOAD, { 'content-length': String(PAYLOAD.byteLength) });
    });
    const localPath = join(dir, 'artifact.parquet');
    const result = await downloadToFile('https://o.thsi.cn/signed', localPath, { fetchImpl });
    expect(result.bytes).toBe(PAYLOAD.byteLength);
    expect(result.sha256).toBe(PAYLOAD_SHA256);
    const written = await readFile(localPath);
    expect(new Uint8Array(written)).toEqual(PAYLOAD);
    expect(requests[0]?.headers['x-api-key']).toBeUndefined();
    expect(requests[0]?.headers.range).toBeUndefined();
  });

  it('手工跟随重定向：跨 origin 跳转不转发自定义头，最终 200 落盘', async () => {
    const { fetchImpl, requests } = recordingFetch((request) => {
      if (request.url === 'https://api.example.com/signed') {
        return new Response(null, {
          status: 302,
          headers: { location: 'https://cdn.example.net/object' },
        });
      }
      return bodyResponse(200, PAYLOAD);
    });
    const localPath = join(dir, 'redirect.parquet');
    const result = await downloadToFile('https://api.example.com/signed', localPath, { fetchImpl });
    expect(result.sha256).toBe(PAYLOAD_SHA256);
    expect(requests).toHaveLength(2);
    expect(requests[1]?.url).toBe('https://cdn.example.net/object');
    expect(requests[1]?.headers['x-api-key']).toBeUndefined();
  });

  it('重定向次数超过上限（默认 3）→ upstream_error', async () => {
    const { fetchImpl, requests } = recordingFetch(
      () =>
        new Response(null, {
          status: 302,
          headers: { location: 'https://o.thsi.cn/next' },
        }),
    );
    await expect(
      downloadToFile('https://o.thsi.cn/signed', join(dir, 'loop.parquet'), { fetchImpl }),
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof SourceExecutionError &&
        error.kind === 'upstream_error' &&
        /重定向次数超过 3/.test(error.message),
    );
    expect(requests.length).toBeGreaterThan(3);
  });

  it('重定向缺少 Location → upstream_error', async () => {
    const { fetchImpl } = recordingFetch(() => new Response(null, { status: 302 }));
    await expect(
      downloadToFile('https://o.thsi.cn/signed', join(dir, 'no-location.parquet'), { fetchImpl }),
    ).rejects.toThrowError(/重定向 302 缺少 Location/);
  });

  it('非 200 终态 → 按状态码映射 kind（403 → permission）', async () => {
    const { fetchImpl } = recordingFetch(() => bodyResponse(403, new Uint8Array(0)));
    await expect(
      downloadToFile('https://o.thsi.cn/signed', join(dir, 'forbidden.parquet'), { fetchImpl }),
    ).rejects.toSatisfy(
      (error: unknown) => error instanceof SourceExecutionError && error.kind === 'permission',
    );
  });

  it('响应缺少 body → invalid_payload', async () => {
    const { fetchImpl } = recordingFetch(() => new Response(null, { status: 200 }));
    await expect(
      downloadToFile('https://o.thsi.cn/signed', join(dir, 'nobody.parquet'), { fetchImpl }),
    ).rejects.toSatisfy(
      (error: unknown) => error instanceof SourceExecutionError && error.kind === 'invalid_payload',
    );
  });
});
