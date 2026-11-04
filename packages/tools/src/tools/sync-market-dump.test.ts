import type { ToolContext } from '@luoome/core';
import { describe, expect, it } from 'vitest';

import type { MarketDumpManagerPort } from '../internal/market-dump.js';
import { getMarketDumpStatusTool } from './get-market-dump-status.js';
import { syncMarketDumpTool } from './sync-market-dump.js';

/**
 * sync_market_dump / get_market_dump_status tool 契约测试。
 *
 * 走 Tool 契约入口 execute（input parse → handler → output parse）；
 * manager 用确定性内存替身，断言：
 * - sideEffect 与 requiredCapabilities（sync 是 external+write，status 是 read）；
 * - 未配置 manager → invalid_input；
 * - 成功/失败结果透传；错误 → adapter_error；
 * - 输出不含 presignedUrl / 本地路径。
 */

const T0 = new Date('2026-11-04T01:00:00.000Z');
const HASH = 'a'.repeat(64);

const createMockContext = (marketDump?: MarketDumpManagerPort): ToolContext =>
  ({
    repos: {} as ToolContext['repos'],
    adapters: {} as ToolContext['adapters'],
    user: { id: 'test-user', defaultAccountId: 'test-account' },
    clock: () => T0,
    logger: console,
    ...(marketDump === undefined ? {} : { marketDump }),
  }) as ToolContext;

const completeResult = {
  runId: 'run-1',
  kind: 'daily-k' as const,
  dumpId: 'a_share_daily_k_1d_none_10y',
  artifactSha256: HASH,
  status: 'complete' as const,
  resumed: false,
  processedRows: 3,
  nextRowOffset: 3,
  minDate: new Date('2026-11-03T00:00:00.000Z'),
  maxDate: new Date('2026-11-04T00:00:00.000Z'),
  recordedAt: T0,
  startedAt: T0,
  finishedAt: T0,
  errorKind: null,
  errorMessage: null,
};

const makeRun = (overrides: Record<string, unknown> = {}) => ({
  runId: 'run-1',
  kind: 'daily-k' as const,
  dumpId: 'a_share_daily_k_1d_none_10y',
  source: 'fuyao' as const,
  artifactSha256: HASH,
  status: 'complete' as const,
  recordedAt: T0,
  requestedAt: T0,
  downloadedAt: T0,
  startedAt: T0,
  finishedAt: T0,
  nextRowOffset: 3,
  processedRows: 3,
  minDate: new Date('2026-11-03T00:00:00.000Z'),
  maxDate: new Date('2026-11-04T00:00:00.000Z'),
  artifactBytes: 1024,
  errorKind: null,
  errorMessage: null,
  ...overrides,
});

describe('syncMarketDumpTool', () => {
  it('sideEffect=external 且 requiredCapabilities 含 external+write', () => {
    expect(syncMarketDumpTool.sideEffect).toBe('external');
    expect(syncMarketDumpTool.requiredCapabilities).toEqual(['external', 'write']);
  });

  it('未配置 marketDump manager → invalid_input', async () => {
    const result = await syncMarketDumpTool.execute({ kind: 'daily-k' }, createMockContext());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('invalid_input');
      if (result.error.kind === 'invalid_input') {
        expect(result.error.message).toContain('marketDump');
      }
    }
  });

  it('同步成功：透传 manager 结果，输出通过 schema 校验', async () => {
    const manager: MarketDumpManagerPort = {
      name: 'market-dump',
      sync: async () => completeResult,
      status: async () => [],
    };
    const result = await syncMarketDumpTool.execute(
      { kind: 'daily-k' },
      createMockContext(manager),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.status).toBe('complete');
      expect(result.data.processedRows).toBe(3);
      expect(result.data.artifactSha256).toBe(HASH);
      // 输出不含 URL / 路径
      const serialized = JSON.stringify(result.data);
      expect(serialized).not.toContain('http');
      expect(serialized).not.toContain('.parquet');
      expect(serialized).not.toContain('Signature');
    }
  });

  it('resumeRunId 透传给 manager', async () => {
    let captured: unknown;
    const manager: MarketDumpManagerPort = {
      name: 'market-dump',
      sync: async (input) => {
        captured = input;
        return { ...completeResult, resumed: true };
      },
      status: async () => [],
    };
    const result = await syncMarketDumpTool.execute(
      { kind: 'daily-k', resumeRunId: 'run-1' },
      createMockContext(manager),
    );
    expect(result.ok).toBe(true);
    expect(captured).toEqual({ kind: 'daily-k', resumeRunId: 'run-1' });
    if (result.ok) expect(result.data.resumed).toBe(true);
  });

  it('manager 抛错 → adapter_error（脱敏消息原样透传）', async () => {
    const manager: MarketDumpManagerPort = {
      name: 'market-dump',
      sync: async () => {
        throw new Error('market-dump download: 下载返回 403（host=[redacted]）');
      },
      status: async () => [],
    };
    const result = await syncMarketDumpTool.execute(
      { kind: 'daily-k' },
      createMockContext(manager),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('adapter_error');
      if (result.error.kind === 'adapter_error') {
        expect(result.error.adapter).toBe('market-dump');
      }
    }
  });

  it('manager 返回 failed 终态 → 正常返回（不是 error result）', async () => {
    const manager: MarketDumpManagerPort = {
      name: 'market-dump',
      sync: async () => ({
        ...completeResult,
        status: 'failed' as const,
        errorKind: 'invalid_payload',
        errorMessage: 'market-dump parquet: 行 2 adjusted=forward',
      }),
      status: async () => [],
    };
    const result = await syncMarketDumpTool.execute(
      { kind: 'daily-k' },
      createMockContext(manager),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.status).toBe('failed');
      expect(result.data.errorKind).toBe('invalid_payload');
    }
  });

  it('非法 kind → invalid_input（schema 拦截）', async () => {
    const manager: MarketDumpManagerPort = {
      name: 'market-dump',
      sync: async () => completeResult,
      status: async () => [],
    };
    const result = await syncMarketDumpTool.execute(
      { kind: 'minute-k' },
      createMockContext(manager),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('invalid_input');
  });
});

describe('getMarketDumpStatusTool', () => {
  it('sideEffect=read', () => {
    expect(getMarketDumpStatusTool.sideEffect).toBe('read');
    expect(getMarketDumpStatusTool.requiredCapabilities).toEqual(['read']);
  });

  it('未配置 marketDump manager → invalid_input', async () => {
    const result = await getMarketDumpStatusTool.execute({}, createMockContext());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('invalid_input');
  });

  it('返回 run 列表（审计字段齐全），不含 URL / 路径', async () => {
    const manager: MarketDumpManagerPort = {
      name: 'market-dump',
      sync: async () => completeResult,
      status: async () => [
        makeRun({ runId: 'run-2', kind: 'adjustment-factors' }),
        makeRun({ runId: 'run-1' }),
      ],
    };
    const result = await getMarketDumpStatusTool.execute({}, createMockContext(manager));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.runs).toHaveLength(2);
      const serialized = JSON.stringify(result.data);
      expect(serialized).not.toContain('http');
      expect(serialized).not.toContain('.parquet');
      expect(serialized).not.toContain('Signature');
      expect(result.data.runs[0]?.artifactSha256).toBe(HASH);
    }
  });

  it('按 kind 过滤 + limit 截断', async () => {
    const manager: MarketDumpManagerPort = {
      name: 'market-dump',
      sync: async () => completeResult,
      status: async () => [
        makeRun({ runId: 'run-3', kind: 'daily-k' }),
        makeRun({ runId: 'run-2', kind: 'adjustment-factors' }),
        makeRun({ runId: 'run-1', kind: 'daily-k' }),
      ],
    };
    const result = await getMarketDumpStatusTool.execute(
      { kind: 'daily-k', limit: 1 },
      createMockContext(manager),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.runs).toHaveLength(1);
      expect(result.data.runs[0]?.kind).toBe('daily-k');
    }
  });
});
