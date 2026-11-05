import type { MarketDumpKind } from '@luoome/core';

import type { FuyaoClient } from '../fuyao/client.js';
import { dumpDownloadUrlPath, parseDumpDownloadTicket } from './download-url.js';
import type { DumpDownloadTicket } from './types.js';

/**
 * Fuyao dump download-url adapter（设计 §5.2.1，Phase 0 证据 §1）。
 *
 * 只负责「获取一次性预签名 URL」这一步，计入 Fuyao API 协调器；
 * S3 文件传输不经过本 adapter（downloader.ts 另有大小、超时与磁盘门禁）。
 * 返回的 DumpDownloadTicket 含敏感 presignedUrl：调用方只在本次下载内存中使用，
 * 不落库、不落日志、不进入 ToolResult。
 */
export class FuyaoMarketDumpAdapter {
  readonly name = 'fuyao';

  constructor(private readonly client: FuyaoClient) {}

  /** 获取指定 kind 的一次性下载票据；信封错误按 kind 原样抛出。 */
  async fetchDownloadTicket(kind: MarketDumpKind): Promise<DumpDownloadTicket> {
    const result = await this.client.getData(dumpDownloadUrlPath(kind), {});
    return parseDumpDownloadTicket(result.data, kind);
  }
}
