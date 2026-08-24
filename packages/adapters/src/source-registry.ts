import type { SourceErrorKind, SourceId, SourceStatus } from '@luoome/core';

import { sourceErrorKindOf } from './source-error.js';

/**
 * 泛型 SourceRegistry（docs/ddd/source-pluggability-and-observation-design.md §4.1/§6.1）。
 *
 * 职责与领域无关：绑定校验（重复 / 配置未就绪启动期抛错）、按 capability 有序路由、
 * 执行包装与内存态观测。capability 枚举与 request/result 类型由各域的 CapabilityMap 注入；
 * 观测状态机严格按 §4.3：
 * - 任何执行先记 lastAttemptAt；
 * - success：记 lastSuccessAt、清除 lastErrorKind；dataAsOf 有则更新、无则清除；
 * - failure：只记 lastErrorKind，保留旧 lastSuccessAt / dataAsOf 供诊断；
 * - ignored：仅保留 lastAttemptAt（调用方输入限制或源明确不支持的窗口）；
 * - 异常视为 failure，kind 取 SourceExecutionError.kind，非结构化错误收口 upstream_error。
 */

export type CapabilityMap = Record<string, { readonly request: unknown; readonly result: unknown }>;

export type SourceResultObservation =
  | { readonly outcome: 'success'; readonly dataAsOf?: Date }
  | { readonly outcome: 'failure'; readonly kind: SourceErrorKind }
  | { readonly outcome: 'ignored' };

export interface SourceBinding<M extends CapabilityMap, C extends keyof M & string> {
  readonly capability: C;
  readonly source: SourceId;
  readonly coverage: readonly string[];
  readonly configurationReady: boolean;
  execute(input: M[C]['request']): Promise<M[C]['result']>;
  /** 每个 binding 必须显式声明 resolved result 如何影响观测。 */
  observationOf(result: M[C]['result']): SourceResultObservation;
}

export type AnyBinding<M extends CapabilityMap> = {
  [C in keyof M & string]: SourceBinding<M, C>;
}[keyof M & string];

export interface SourceHandle<M extends CapabilityMap, C extends keyof M & string> {
  readonly capability: C;
  readonly source: SourceId;
  readonly coverage: readonly string[];
  execute(input: M[C]['request']): Promise<M[C]['result']>;
}

interface MutableObservation {
  lastAttemptAt?: Date;
  lastSuccessAt?: Date;
  dataAsOf?: Date;
  lastErrorKind?: SourceErrorKind;
}

export class SourceRegistry<M extends CapabilityMap> {
  private readonly observations = new Map<string, MutableObservation>();

  constructor(
    private readonly bindings: readonly AnyBinding<M>[],
    private readonly clock: () => Date,
  ) {
    const keys = new Set<string>();
    for (const binding of bindings) {
      const key = keyOf(binding.source, binding.capability);
      if (keys.has(key)) {
        throw new Error(`duplicate source capability binding: ${key}`);
      }
      if (!binding.configurationReady) {
        throw new Error(`source configuration not ready: ${key}`);
      }
      keys.add(key);
    }
  }

  /** 按绑定顺序返回该 capability 的 handles；领域层负责自己的 fallback / coverage 过滤。 */
  sources<C extends keyof M & string>(capability: C): readonly SourceHandle<M, C>[] {
    return this.bindings.flatMap((binding) => {
      if (binding.capability !== capability) return [];
      const typed = binding as SourceBinding<M, C>;
      return [
        {
          capability,
          source: typed.source,
          coverage: typed.coverage,
          execute: async (input: M[C]['request']): Promise<M[C]['result']> => {
            const key = keyOf(typed.source, capability);
            const observation = this.observations.get(key) ?? {};
            observation.lastAttemptAt = this.clock();
            this.observations.set(key, observation);
            try {
              const result = await typed.execute(input);
              const observed = typed.observationOf(result);
              if (observed.outcome === 'success') {
                observation.lastSuccessAt = this.clock();
                delete observation.lastErrorKind;
                if (observed.dataAsOf === undefined) delete observation.dataAsOf;
                else observation.dataAsOf = observed.dataAsOf;
              } else if (observed.outcome === 'failure') {
                observation.lastErrorKind = observed.kind;
              }
              // ignored：仅保留 lastAttemptAt，不动成功 / 错误 / 数据时间
              return result;
            } catch (error) {
              observation.lastErrorKind = sourceErrorKindOf(error);
              throw error;
            }
          },
        },
      ];
    });
  }

  describe(): readonly SourceStatus[] {
    return this.bindings.map((binding) => {
      const observation = this.observations.get(keyOf(binding.source, binding.capability));
      return {
        dataset: binding.capability,
        source: binding.source,
        coverage: binding.coverage,
        capabilityEnabled: true,
        configurationReady: binding.configurationReady,
        ...(observation?.lastAttemptAt === undefined
          ? {}
          : { lastAttemptAt: observation.lastAttemptAt }),
        ...(observation?.lastSuccessAt === undefined
          ? {}
          : { lastSuccessAt: observation.lastSuccessAt }),
        ...(observation?.dataAsOf === undefined ? {} : { dataAsOf: observation.dataAsOf }),
        ...(observation?.lastErrorKind === undefined
          ? {}
          : { lastErrorKind: observation.lastErrorKind }),
      };
    });
  }
}

const keyOf = (source: string, capability: string): string => `${source}:${capability}`;
