import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import type { MarketDumpArtifactLike, MarketDumpKind } from '@luoome/core';
import { z } from 'zod';

import { iterateDailyKDumpRows } from '../market-dump/parquet.js';
import { SourceExecutionError } from '../source-error.js';
import type { FuyaoClient } from './client.js';

/**
 * fuyao 全市场 dump 的下载链接接口。
 *
 * `GET /api/dump/market-dumps/<kind>/download-url` 返回短时有效的 S3 预签名链接
 * （默认 5 分钟），因此每次同步都要重新取，不缓存 URL。
 */
const TicketSchema = z.object({
  code: z.number(),
  message: z.string().optional(),
  data: z
    .object({
      presigned_url: z.string().url(),
      presigned_url_expires_at: z.string().optional(),
      expires_in_seconds: z.number().optional(),
    })
    .nullable(),
});

export interface FuyaoMarketDumpAdapterOptions {
  /** 本地落盘目录（通常是 $LUOOME_HOME/market-dumps）。 */
  readonly dir: string;
  readonly fetchImpl?: typeof fetch;
  readonly beforePublish?: () => void;
  readonly clock?: () => Date;
}

export interface MarketDumpTicket {
  readonly url: string;
  readonly expiresAt: Date;
  readonly dumpId: string;
}

/** 从预签名 URL 的文件名推导 dumpId（如 `a_share_daily_k_1d_none_10d_20261111`）。 */
const dumpIdFromUrl = (url: string, kind: MarketDumpKind): string => {
  const name = new URL(url).pathname.split('/').pop() ?? '';
  const id = name.endsWith('.parquet') ? name.slice(0, -'.parquet'.length) : name;
  if (id.length === 0) {
    throw new SourceExecutionError('invalid_payload', `market-dump ${kind}: 下载链接缺少文件名`);
  }
  return id;
};

export class FuyaoMarketDumpAdapter {
  readonly name = 'fuyao-market-dump';
  private readonly fetchImpl: typeof fetch;
  private readonly clock: () => Date;

  constructor(
    private readonly client: FuyaoClient,
    private readonly options: FuyaoMarketDumpAdapterOptions,
  ) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.clock = options.clock ?? (() => new Date());
  }

  private archivedTotal: { file: string; total: number } | undefined;

  async readArchivedTurnover(date: string): Promise<number | null> {
    const prefix = `a_share_daily_k_1d_none_10d_${date.replaceAll('-', '')}.`;
    const files = await readdir(this.options.dir);
    const file = files.sort().find((name) => name.startsWith(prefix) && name.endsWith('.parquet'));
    if (!file) return null;
    if (this.archivedTotal?.file === file) return this.archivedTotal.total;
    const tradingDay = Date.parse(date + 'T00:00:00+08:00');
    const ids = new Set<string>();
    let total = 0;
    for (const row of iterateDailyKDumpRows(join(this.options.dir, file))) {
      if (row.dateMs !== tradingDay || !/\.(SH|SZ)$/.test(row.stockId)) continue;
      if (ids.has(row.stockId) || !Number.isFinite(row.turnover) || row.turnover < 0) return null;
      ids.add(row.stockId);
      total += row.turnover;
    }
    if (total <= 0) return null;
    this.archivedTotal = { file, total };
    return total;
  }

  async fetchTicket(kind: MarketDumpKind): Promise<MarketDumpTicket> {
    const raw = await this.client.getRaw(`/api/dump/market-dumps/${kind}/download-url`);
    const parsed = TicketSchema.safeParse(raw);
    if (!parsed.success) {
      throw new SourceExecutionError(
        'invalid_payload',
        `market-dump ${kind}: 下载链接响应形状不符（${parsed.error.message}）`,
      );
    }
    if (parsed.data.code !== 0) {
      throw new SourceExecutionError(
        'upstream_error',
        `market-dump ${kind}: code=${parsed.data.code} ${parsed.data.message ?? ''}`.trim(),
      );
    }
    const data = parsed.data.data;
    if (data === null) {
      throw new SourceExecutionError('no_data', `market-dump ${kind}: 上游没有返回下载链接`);
    }
    const expiresAt =
      data.presigned_url_expires_at === undefined
        ? new Date(this.clock().getTime() + (data.expires_in_seconds ?? 300) * 1000)
        : new Date(data.presigned_url_expires_at);
    return { url: data.presigned_url, expiresAt, dumpId: dumpIdFromUrl(data.presigned_url, kind) };
  }

  /** 取链接并下载到本地；返回落盘路径与字节数。 */
  async download(kind: MarketDumpKind): Promise<MarketDumpArtifactLike> {
    const ticket = await this.fetchTicket(kind);
    let response: Response;
    try {
      response = await this.fetchImpl(ticket.url, { method: 'GET' });
    } catch (error) {
      throw new SourceExecutionError(
        'network',
        `market-dump ${kind}: 下载失败（${error instanceof Error ? error.message : String(error)}）`,
        error,
      );
    }
    if (!response.ok) {
      throw new SourceExecutionError(
        'upstream_error',
        `market-dump ${kind}: 下载返回 ${response.status} ${response.statusText}`,
      );
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength === 0) {
      throw new SourceExecutionError('invalid_payload', `market-dump ${kind}: 下载内容为空`);
    }
    this.options.beforePublish?.();
    mkdirSync(this.options.dir, { recursive: true });
    // 多宿主可能同时下载同名 dump；隔离文件名，避免校验后的进程切换让旧文件覆盖新文件。
    const localPath = join(this.options.dir, `${ticket.dumpId}.${randomUUID()}.parquet`);
    writeFileSync(localPath, bytes);
    return { kind, dumpId: ticket.dumpId, localPath, bytes: bytes.byteLength };
  }
}
