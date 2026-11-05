import type { MarketDumpKind } from '@luoome/core';
import { ZodError, z } from 'zod';

import { invalidPayloadError } from '../source-error.js';
import type { DumpDownloadTicket } from './types.js';

/**
 * dump download-url 响应解析（Phase 0 证据 §1）。
 *
 * - 字段：presigned_url / presigned_url_expires_at / expires_in_seconds；
 *   无独立 dumpId 字段，身份从 URL 路径段 `<data_type>/releases/<date>/<dump_id>_<date>.parquet` 解析；
 * - presigned_url_expires_at 是带纳秒的 RFC3339（JS Date 只保留毫秒，解析须容忍 9 位小数秒）；
 * - 本模块只解析，不记录 URL；错误消息不得包含 URL 本体。
 */

const DownloadUrlDataSchema = z.object({
  presigned_url: z.string().min(1),
  presigned_url_expires_at: z.string().min(1),
  expires_in_seconds: z.number().positive(),
});

const KIND_TO_DATA_TYPE: Readonly<Record<MarketDumpKind, string>> = {
  'daily-k': 'daily_k',
  'daily-k-10d': 'daily_k',
  'adjustment-factors': 'adjustment_factors',
};

export const dumpDownloadUrlPath = (kind: MarketDumpKind): string =>
  `/api/dump/market-dumps/${kind}/download-url`;

/** 纳秒级 RFC3339 → Date（截断到毫秒；上游时区 +08:00 由 ISO 解析保留）。 */
export const parseNanoTimestamp = (value: string): Date => {
  // JS Date 不接受 9 位小数秒以外的精度问题不存在——它接受任意位小数并截断，
  // 但部分运行时对 >3 位小数解析不一致，这里显式截断到毫秒。
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})\.(\d{3})\d*(.*)$/.exec(value);
  const normalized = match === null ? value : `${match[1]}.${match[2]}${match[3]}`;
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) {
    throw invalidPayloadError('market-dump parse: presigned_url_expires_at 不是有效时间');
  }
  return date;
};

/**
 * 从预签名 URL 路径解析 dumpId。
 * 期望形状：.../market-dump/<data_type>/releases/<yyyymmdd>/<dump_id>_<yyyymmdd>.parquet
 * data_type 必须与 kind 匹配（防止拿错端点的 URL）。
 */
export const parseDumpIdFromUrl = (presignedUrl: string, kind: MarketDumpKind): string => {
  let url: URL;
  try {
    url = new URL(presignedUrl);
  } catch {
    throw invalidPayloadError('market-dump parse: presigned_url 不是合法 URL');
  }
  const segments = url.pathname.split('/').filter((segment) => segment.length > 0);
  const releasesIndex = segments.indexOf('releases');
  const dataType = releasesIndex > 0 ? segments[releasesIndex - 1] : undefined;
  const releaseDate = releasesIndex >= 0 ? segments[releasesIndex + 1] : undefined;
  const fileName = releasesIndex >= 0 ? segments[releasesIndex + 2] : undefined;
  if (
    dataType === undefined ||
    releaseDate === undefined ||
    fileName === undefined ||
    !/^\d{8}$/.test(releaseDate) ||
    !fileName.endsWith('.parquet')
  ) {
    throw invalidPayloadError('market-dump parse: presigned_url 路径形状不符（releases 段缺失）');
  }
  const expectedDataType = KIND_TO_DATA_TYPE[kind];
  if (dataType !== expectedDataType) {
    throw invalidPayloadError(
      `market-dump parse: data_type 不匹配（期望 ${expectedDataType}，实际 ${dataType}）`,
    );
  }
  const stem = fileName.slice(0, -'.parquet'.length);
  const suffix = `_${releaseDate}`;
  if (!stem.endsWith(suffix) || stem.length <= suffix.length) {
    throw invalidPayloadError('market-dump parse: 文件名与 release 日期不一致');
  }
  return stem.slice(0, -suffix.length);
};

export const parseDumpDownloadTicket = (
  data: unknown,
  kind: MarketDumpKind,
): DumpDownloadTicket => {
  let parsed: z.infer<typeof DownloadUrlDataSchema>;
  try {
    parsed = DownloadUrlDataSchema.parse(data);
  } catch (error) {
    if (error instanceof ZodError) {
      throw invalidPayloadError(
        `market-dump parse: download-url data 形状不符（${error.message}）`,
      );
    }
    throw error;
  }
  return {
    kind,
    dumpId: parseDumpIdFromUrl(parsed.presigned_url, kind),
    presignedUrl: parsed.presigned_url,
    expiresAt: parseNanoTimestamp(parsed.presigned_url_expires_at),
  };
};
