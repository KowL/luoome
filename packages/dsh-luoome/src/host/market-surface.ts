// dsh-luoome native market external surface（需求文档 §4.2，M2a）。
//
// 与 read surface 独立：只暴露受信任配置精确点名的 external 工具，用于对话主动刷新
// 市场事实。绝不因为「能访问外部数据」获得写权限：写/队列/trade 能力在装配期拒绝，
// 未点名的工具即使能访问外部网络也不注册、不可按名调用。

import type { ToolRuntime } from '@deepseek-ai/dsh-tools';
import type { ToolContext, ToolResult } from '@luoome/core';
import { createRegistry, privateResearchTools, selectExposedTools, type Tool } from '@luoome/tools';
import { z } from 'zod';
import { toolResultJsonSchema } from './tools.js';

/** 默认外部工具超时；调用方必须有界返回，不能阻塞普通只读请求。 */
export const DEFAULT_MARKET_TIMEOUT_MS = 30_000;
export const MAX_MARKET_TIMEOUT_MS = 300_000;

const ToolNameSchema = z.string().trim().min(1).max(120);

const MarketConfigSchema = z
  .object({
    allowlist: z.array(ToolNameSchema),
    denylist: z.array(ToolNameSchema).default([]),
    timeoutMs: z
      .number()
      .int()
      .positive()
      .max(MAX_MARKET_TIMEOUT_MS)
      .default(DEFAULT_MARKET_TIMEOUT_MS),
    exposeResearch: z.literal(false).default(false),
  })
  .strict();

export interface MarketSurfaceConfig {
  readonly allowlist: readonly string[];
  readonly denylist: readonly string[];
  readonly timeoutMs: number;
  readonly exposeResearch: false;
}

export interface MarketSurface {
  descriptors(): ReturnType<ReturnType<typeof createRegistry>['toMCP']>;
  invoke(name: string, input: unknown, signal: AbortSignal): Promise<ToolResult<unknown>>;
  dispose(): void;
}

const denied = (required: string): ToolResult<never> => ({
  ok: false,
  error: { kind: 'permission_denied', required },
});

const inactiveRequest = (signal: AbortSignal): ToolResult<never> =>
  signal.reason instanceof Error && signal.reason.name === 'TimeoutError'
    ? {
        ok: false,
        error: {
          kind: 'adapter_error',
          adapter: 'market-surface',
          cause: 'Market request deadline exceeded',
          recoverable: true,
        },
      }
    : denied('active request');

/** 装配期 fail-closed：未知名字、非 external 或带写能力的工具直接拒绝，而不是静默过滤。 */
export const assertExternalMarketAllowlist = (
  allowlist: readonly string[],
  tools: readonly Tool[],
): void => {
  const registry = createRegistry(tools);
  for (const name of allowlist) {
    const tool = registry.get(name);
    if (tool === undefined) throw new Error(`Unknown configured market tool: ${name}`);
    if (tool.sideEffect !== 'external')
      throw new Error(`Configured market tool is not external: ${name}`);
    if (tool.requiredCapabilities.some((capability) => capability !== 'external'))
      throw new Error(`Configured market tool requires unsupported capabilities: ${name}`);
  }
};

/**
 * 创建 market external surface。
 *
 * 配置在创建时解析成冻结快照，注册与执行共用同一份名单；执行保留原 ToolResult，
 * 外部失败按原错误返回，绝不包装成空数据成功。`timeoutMs` 只约束调用方等待时间：
 * 领域 tool 不接收 AbortSignal，超时后本 surface 立即返回明确错误并停止等待。
 */
export const createMarketSurface = (options: {
  readonly config: unknown;
  readonly tools: readonly Tool[];
  readonly context: () => ToolContext | Promise<ToolContext>;
  readonly accountId?: string;
}): MarketSurface => {
  if (process.env.LUOOME_EXPOSE_TRADE === 'true')
    throw new Error('LUOOME_EXPOSE_TRADE=true is not allowed in the DSH plugin');
  const parsed = MarketConfigSchema.parse(options.config);
  const config: MarketSurfaceConfig = Object.freeze({
    allowlist: Object.freeze([...parsed.allowlist]),
    denylist: Object.freeze([...parsed.denylist]),
    timeoutMs: parsed.timeoutMs,
    exposeResearch: false as const,
  });
  assertExternalMarketAllowlist(config.allowlist, options.tools);
  const selected = createRegistry(
    selectExposedTools(options.tools, new Set(['external']), {
      allowlist: new Set(config.allowlist),
      denylist: new Set([
        ...config.denylist,
        ...(config.exposeResearch ? [] : privateResearchTools),
      ]),
    }),
  );
  let disposed = false;
  return {
    descriptors: () => (disposed ? [] : selected.toMCP()),
    async invoke(name, input, signal) {
      const tool = selected.get(name);
      if (disposed || tool === undefined) return denied('market tool allowlist');
      if (signal.aborted) return inactiveRequest(signal);
      let context: ToolContext;
      try {
        context = await options.context();
      } catch {
        return { ok: false, error: { kind: 'internal', cause: 'Market execution unavailable' } };
      }
      if (disposed) return denied('market tool allowlist');
      if (signal.aborted) return inactiveRequest(signal);
      if (
        options.accountId !== undefined &&
        input !== null &&
        typeof input === 'object' &&
        !Array.isArray(input)
      ) {
        const raw = input as Record<string, unknown>;
        if (raw.accountId !== undefined && raw.accountId !== options.accountId)
          return denied('current owner account');
      }

      // The domain tool API has no signal parameter; AbortSignal bounds this surface's
      // wait, while the shared controller marks the call as abandoned for bookkeeping.
      const controller = new AbortController();
      const lifetime = AbortSignal.any([signal, controller.signal]);
      const execution = tool.execute(input, {
        ...context,
        abortSignal:
          context.abortSignal === undefined
            ? lifetime
            : AbortSignal.any([lifetime, context.abortSignal]),
      });
      const aborted = new Promise<never>((_resolve, reject) => {
        const abort = (): void => reject(new Error('aborted'));
        if (lifetime.aborted) abort();
        else lifetime.addEventListener('abort', abort, { once: true });
      });
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timedOut = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error('timeout'));
        }, config.timeoutMs);
      });
      try {
        const result = await Promise.race([execution, aborted, timedOut]);
        // DSH canonical values must be JSON; the domain still returns Date instances.
        return JSON.parse(JSON.stringify(result)) as ToolResult<unknown>;
      } catch {
        // An external failure stays a domain failure; never fabricate an empty success.
        if (signal.aborted) return inactiveRequest(signal);
        if (controller.signal.aborted)
          return {
            ok: false,
            error: {
              kind: 'adapter_error',
              adapter: 'market-surface',
              cause: `timeout after ${config.timeoutMs}ms`,
              recoverable: true,
            },
          };
        return { ok: false, error: { kind: 'internal', cause: 'Market execution unavailable' } };
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    },
    dispose() {
      disposed = true;
    },
  };
};

/**
 * 把 market surface 注册进 DSH ToolRuntime；与 read surface 分开注册/撤销。
 * 撤销时同时 dispose surface，dispose 后的旧闭包返回 permission_denied。
 */
export const registerMarketTools = (
  runtime: Pick<ToolRuntime, 'register'>,
  surface: MarketSurface,
): (() => void) => {
  const unregister: (() => void)[] = [];
  try {
    const definitions = surface.descriptors().map((descriptor) => {
      const parameters = JSON.parse(JSON.stringify(descriptor.inputSchema));
      return {
        name: descriptor.name,
        description: descriptor.description,
        parameters: { ...parameters },
        output: {
          schema: toolResultJsonSchema,
          render: (_args: unknown, value: unknown) => [
            { type: 'text' as const, text: JSON.stringify(value) },
          ],
        },
        execute: (input: unknown, exec: { signal: AbortSignal }) =>
          surface.invoke(descriptor.name, input, exec.signal),
      };
    });
    for (const definition of definitions) unregister.push(runtime.register(definition));
  } catch (error) {
    for (const remove of unregister.reverse()) remove();
    surface.dispose();
    throw error;
  }
  return () => {
    for (const remove of unregister.splice(0).reverse()) remove();
    surface.dispose();
  };
};
