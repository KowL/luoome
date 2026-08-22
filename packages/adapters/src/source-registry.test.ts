import { describe, expect, it } from 'vitest';

import { SourceExecutionError } from './source-error.js';
import {
  type AnyBinding,
  SourceRegistry,
  type SourceResultObservation,
} from './source-registry.js';

/** 泛型 SourceRegistry 的观测状态机（docs/ddd/source-pluggability-and-observation-design.md §4.3/§9.1）。 */

type TestCapabilityMap = {
  readonly demo: {
    readonly request: { readonly key: string };
    readonly result: { readonly value: number; readonly at?: Date };
  };
};

const successOf = (result: { readonly at?: Date }): SourceResultObservation =>
  result.at === undefined ? { outcome: 'success' } : { outcome: 'success', dataAsOf: result.at };

const demoBinding = (
  overrides: Partial<AnyBinding<TestCapabilityMap>> & {
    execute: (input: {
      readonly key: string;
    }) => Promise<{ readonly value: number; readonly at?: Date }>;
  },
): AnyBinding<TestCapabilityMap> => ({
  capability: 'demo',
  source: 'alpha',
  coverage: ['CN_A_SHARES_SH_SZ'],
  configurationReady: true,
  observationOf: successOf,
  ...overrides,
});

describe('SourceRegistry（泛型）', () => {
  it('重复绑定与 configurationReady=false 启动期抛错', () => {
    const binding = demoBinding({ execute: () => Promise.resolve({ value: 1 }) });
    expect(
      () => new SourceRegistry<TestCapabilityMap>([binding, binding], () => new Date()),
    ).toThrow(/duplicate source capability binding: alpha:demo/);
    expect(
      () =>
        new SourceRegistry<TestCapabilityMap>(
          [
            demoBinding({
              configurationReady: false,
              execute: () => Promise.resolve({ value: 1 }),
            }),
          ],
          () => new Date(),
        ),
    ).toThrow(/source configuration not ready: alpha:demo/);
  });

  it('sources() 按绑定顺序返回 handles，并暴露 source / coverage', () => {
    const registry = new SourceRegistry<TestCapabilityMap>(
      [
        demoBinding({ source: 'alpha', execute: () => Promise.resolve({ value: 1 }) }),
        demoBinding({ source: 'beta', execute: () => Promise.resolve({ value: 2 }) }),
      ],
      () => new Date(),
    );
    const handles = registry.sources('demo');
    expect(handles.map((handle) => handle.source)).toEqual(['alpha', 'beta']);
    expect(handles[0]?.coverage).toEqual(['CN_A_SHARES_SH_SZ']);
    expect(registry.sources('missing' as never)).toEqual([]);
  });

  it('success → failure → success：时间戳更新、旧 dataAsOf 保留、错误清除', async () => {
    let now = new Date('2026-08-22T01:00:00.000Z');
    const dataAt = new Date('2026-08-21T08:00:00.000Z');
    let mode: 'ok' | 'resolved-failure' | 'ok-empty' = 'ok';
    const registry = new SourceRegistry<TestCapabilityMap>(
      [
        demoBinding({
          execute: () => {
            if (mode === 'resolved-failure') return Promise.resolve({ value: 0 });
            if (mode === 'ok-empty') return Promise.resolve({ value: 2 });
            return Promise.resolve({ value: 1, at: dataAt });
          },
          observationOf: (result) =>
            mode === 'resolved-failure'
              ? { outcome: 'failure', kind: 'no_data' }
              : successOf(result),
        }),
      ],
      () => now,
    );
    const handle = registry.sources('demo')[0];

    // success：记录 lastSuccessAt 与 dataAsOf
    await handle?.execute({ key: 'k' });
    expect(registry.describe()[0]).toMatchObject({
      lastAttemptAt: now,
      lastSuccessAt: now,
      dataAsOf: dataAt,
    });
    expect(registry.describe()[0]?.lastErrorKind).toBeUndefined();

    // failure（resolved 结果显式声明）：只记 lastErrorKind，保留旧 lastSuccessAt / dataAsOf
    now = new Date('2026-08-22T02:00:00.000Z');
    mode = 'resolved-failure';
    await handle?.execute({ key: 'k' });
    expect(registry.describe()[0]).toMatchObject({
      lastAttemptAt: now,
      lastSuccessAt: new Date('2026-08-22T01:00:00.000Z'),
      dataAsOf: dataAt,
      lastErrorKind: 'no_data',
    });

    // 再次 success 且无 dataAsOf：清除错误，同时清除旧 dataAsOf
    now = new Date('2026-08-22T03:00:00.000Z');
    mode = 'ok-empty';
    await handle?.execute({ key: 'k' });
    const status = registry.describe()[0];
    expect(status).toMatchObject({ lastAttemptAt: now, lastSuccessAt: now });
    expect(status?.lastErrorKind).toBeUndefined();
    expect(status?.dataAsOf).toBeUndefined();
  });

  it('ignored：仅推进 lastAttemptAt，不动成功 / 错误 / 数据时间', async () => {
    let now = new Date('2026-08-22T01:00:00.000Z');
    const dataAt = new Date('2026-08-21T08:00:00.000Z');
    let ignored = false;
    const registry = new SourceRegistry<TestCapabilityMap>(
      [
        demoBinding({
          execute: () => Promise.resolve({ value: 1, at: dataAt }),
          observationOf: (result) => (ignored ? { outcome: 'ignored' } : successOf(result)),
        }),
      ],
      () => now,
    );
    const handle = registry.sources('demo')[0];

    await handle?.execute({ key: 'k' });
    ignored = true;
    now = new Date('2026-08-22T02:00:00.000Z');
    await handle?.execute({ key: 'k' });
    expect(registry.describe()[0]).toMatchObject({
      lastAttemptAt: now,
      lastSuccessAt: new Date('2026-08-22T01:00:00.000Z'),
      dataAsOf: dataAt,
    });
    expect(registry.describe()[0]?.lastErrorKind).toBeUndefined();
  });

  it('异常视为 failure：SourceExecutionError 取 kind，非结构化错误收口 upstream_error', async () => {
    let now = new Date('2026-08-22T01:00:00.000Z');
    let thrown: unknown = new SourceExecutionError('rate_limited', 'rate_limited: slow down');
    const registry = new SourceRegistry<TestCapabilityMap>(
      [
        demoBinding({
          execute: () => Promise.reject(thrown),
        }),
      ],
      () => now,
    );
    const handle = registry.sources('demo')[0];

    await expect(handle?.execute({ key: 'k' })).rejects.toThrow(/slow down/);
    expect(registry.describe()[0]).toMatchObject({
      lastAttemptAt: now,
      lastErrorKind: 'rate_limited',
    });
    expect(registry.describe()[0]?.lastSuccessAt).toBeUndefined();

    now = new Date('2026-08-22T02:00:00.000Z');
    thrown = new Error('socket hang up');
    await expect(handle?.execute({ key: 'k' })).rejects.toThrow(/socket hang up/);
    expect(registry.describe()[0]).toMatchObject({
      lastAttemptAt: now,
      lastErrorKind: 'upstream_error',
    });
  });

  it('describe() 输出 dataset / capabilityEnabled / configurationReady 元数据', () => {
    const registry = new SourceRegistry<TestCapabilityMap>(
      [demoBinding({ execute: () => Promise.resolve({ value: 1 }) })],
      () => new Date(),
    );
    expect(registry.describe()).toEqual([
      {
        dataset: 'demo',
        source: 'alpha',
        coverage: ['CN_A_SHARES_SH_SZ'],
        capabilityEnabled: true,
        configurationReady: true,
      },
    ]);
  });
});
