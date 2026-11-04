import { describe, expect, it } from 'vitest';

import { SourceExecutionError } from '../source-error.js';
import {
  dumpDownloadUrlPath,
  parseDumpDownloadTicket,
  parseDumpIdFromUrl,
  parseNanoTimestamp,
} from './download-url.js';

/**
 * download-url 解析测试（Phase 0 证据 §1 三种真实响应形状）。
 * 预签名 URL 在测试中使用脱敏 host+路径；断言不输出 URL 本体。
 */

const URL_DAILY_K =
  'https://o.thsi.cn/bucket/market-dump/daily_k/releases/20261103/a_share_daily_k_1d_none_10y_20261103.parquet?AWSAccessKeyId=X&Expires=1&Signature=Y';
const URL_DAILY_K_10D =
  'https://o.thsi.cn/bucket/market-dump/daily_k/releases/20261103/a_share_daily_k_1d_none_10d_20261103.parquet?AWSAccessKeyId=X&Expires=1&Signature=Y';
const URL_ADJUSTMENT =
  'https://o.thsi.cn/bucket/market-dump/adjustment_factors/releases/20261103/a_share_adjustment_factors_event_none_all_20261103.parquet?AWSAccessKeyId=X&Expires=1&Signature=Y';

describe('dumpDownloadUrlPath', () => {
  it('按 kind 生成端点路径', () => {
    expect(dumpDownloadUrlPath('daily-k')).toBe('/api/dump/market-dumps/daily-k/download-url');
    expect(dumpDownloadUrlPath('daily-k-10d')).toBe(
      '/api/dump/market-dumps/daily-k-10d/download-url',
    );
    expect(dumpDownloadUrlPath('adjustment-factors')).toBe(
      '/api/dump/market-dumps/adjustment-factors/download-url',
    );
  });
});

describe('parseNanoTimestamp', () => {
  it('容忍 9 位小数秒（纳秒），截断到毫秒并保留 +08:00 时区', () => {
    const date = parseNanoTimestamp('2026-11-03T23:26:10.979815767+08:00');
    expect(date.toISOString()).toBe('2026-11-03T15:26:10.979Z');
  });

  it('无小数秒与 3 位小数秒同样可解析', () => {
    expect(parseNanoTimestamp('2026-11-03T23:26:10+08:00').getTime()).toBe(
      Date.parse('2026-11-03T23:26:10+08:00'),
    );
    expect(parseNanoTimestamp('2026-11-03T23:26:10.979+08:00').toISOString()).toBe(
      '2026-11-03T15:26:10.979Z',
    );
  });

  it('非法时间 → invalid_payload', () => {
    expect(() => parseNanoTimestamp('not-a-date')).toThrowError(SourceExecutionError);
    expect(() => parseNanoTimestamp('not-a-date')).toThrowError(/presigned_url_expires_at/);
  });
});

describe('parseDumpIdFromUrl', () => {
  it('从路径段解析 dumpId（三种 kind）', () => {
    expect(parseDumpIdFromUrl(URL_DAILY_K, 'daily-k')).toBe('a_share_daily_k_1d_none_10y');
    expect(parseDumpIdFromUrl(URL_DAILY_K_10D, 'daily-k-10d')).toBe('a_share_daily_k_1d_none_10d');
    expect(parseDumpIdFromUrl(URL_ADJUSTMENT, 'adjustment-factors')).toBe(
      'a_share_adjustment_factors_event_none_all',
    );
  });

  it('daily-k 与 daily-k-10d 共用 data_type=daily_k', () => {
    // 10d URL 用 daily-k kind 解析也通过（同一 data_type）；身份差异在 dumpId。
    expect(parseDumpIdFromUrl(URL_DAILY_K_10D, 'daily-k')).toBe('a_share_daily_k_1d_none_10d');
  });

  it('data_type 与 kind 不匹配 → invalid_payload（防止拿错端点的 URL）', () => {
    expect(() => parseDumpIdFromUrl(URL_ADJUSTMENT, 'daily-k')).toThrowError(/data_type 不匹配/);
    expect(() => parseDumpIdFromUrl(URL_DAILY_K, 'adjustment-factors')).toThrowError(
      /data_type 不匹配/,
    );
  });

  it('非法 URL / 路径形状不符 → invalid_payload', () => {
    expect(() => parseDumpIdFromUrl('not a url', 'daily-k')).toThrowError(/不是合法 URL/);
    expect(() =>
      parseDumpIdFromUrl('https://o.thsi.cn/bucket/other/path.parquet', 'daily-k'),
    ).toThrowError(/路径形状不符/);
    expect(() =>
      parseDumpIdFromUrl(
        'https://o.thsi.cn/bucket/market-dump/daily_k/releases/2026-11-03/x_20261103.parquet',
        'daily-k',
      ),
    ).toThrowError(/路径形状不符/);
  });

  it('文件名日期与 releases 段不一致 → invalid_payload', () => {
    expect(() =>
      parseDumpIdFromUrl(
        'https://o.thsi.cn/bucket/market-dump/daily_k/releases/20261103/a_share_daily_k_1d_none_10y_20261104.parquet',
        'daily-k',
      ),
    ).toThrowError(/文件名与 release 日期不一致/);
  });
});

describe('parseDumpDownloadTicket', () => {
  const dataOf = (presignedUrl: string): Record<string, unknown> => ({
    presigned_url: presignedUrl,
    presigned_url_expires_at: '2026-11-03T23:26:10.913597234+08:00',
    expires_in_seconds: 300,
  });

  it('解析完整 ticket（kind/dumpId/expiresAt）', () => {
    const ticket = parseDumpDownloadTicket(dataOf(URL_DAILY_K), 'daily-k');
    expect(ticket.kind).toBe('daily-k');
    expect(ticket.dumpId).toBe('a_share_daily_k_1d_none_10y');
    expect(ticket.presignedUrl).toBe(URL_DAILY_K);
    expect(ticket.expiresAt.toISOString()).toBe('2026-11-03T15:26:10.913Z');
  });

  it('adjustment-factors ticket', () => {
    const ticket = parseDumpDownloadTicket(dataOf(URL_ADJUSTMENT), 'adjustment-factors');
    expect(ticket.dumpId).toBe('a_share_adjustment_factors_event_none_all');
  });

  it('data 形状不符 → invalid_payload（Zod 错误包装）', () => {
    expect(() => parseDumpDownloadTicket({ presigned_url: URL_DAILY_K }, 'daily-k')).toThrowError(
      /download-url data 形状不符/,
    );
    expect(() =>
      parseDumpDownloadTicket(
        { ...dataOf(URL_DAILY_K), expires_in_seconds: -1 } as Record<string, unknown>,
        'daily-k',
      ),
    ).toThrowError(/download-url data 形状不符/);
  });

  it('错误消息不含 URL 本体（脱敏约束）', () => {
    try {
      parseDumpDownloadTicket(dataOf('https://o.thsi.cn/secret/path'), 'daily-k');
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(SourceExecutionError);
      const message = (error as Error).message;
      expect(message).not.toContain('secret');
      expect(message).not.toContain('o.thsi.cn');
    }
  });
});
