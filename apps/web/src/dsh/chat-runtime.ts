import { existsSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ToolError } from '@luoome/core';
import {
  type RuntimeBinding,
  TerminalStatusSchema,
  type ToolManifestEntry,
} from '@luoome/dsh-bridge/protocol';
import { HostConfigSchema } from '@luoome/dsh-bridge/runtime-config';
import { AI_PROVIDER_PRESETS, type AISettingsStore } from '../ai-settings.js';
import { ChatRuntimeRejection, type ChatStreamRuntime } from '../chat.js';
import { DshChatProjection, type UIStreamPart } from './chat-projection.js';
import { DshEventAdapter } from './event-adapter.js';
import type { GatewayCaller } from './execution-scope.js';
import { createDshRunProxy } from './run-proxy.js';
import { DshNodeHostClient } from './runtime-client.js';
import { type GatewayAuthorizer, ToolGateway } from './tool-gateway.js';
import { buildGatewayCallableManifest } from './tool-manifest.js';

export interface DshChatRuntimeOptions {
  readonly development: true;
  readonly nodePath: string;
  readonly hostEntry: string;
  readonly cwd: string;
  readonly model: {
    readonly endpoint: string;
    readonly model: string;
    readonly maxTokens: number;
    readonly headers: Readonly<Record<string, string>>;
    readonly fetch: typeof fetch;
  };
  readonly native?: {
    readonly authorized: true;
    readonly entry: ToolManifestEntry;
    readonly fixtures: Readonly<Record<string, string>>;
  };
  readonly authorized?: () => Promise<boolean>;
  readonly runTimeoutMs?: number;
  readonly maxActiveRuns?: number;
}

const activeConversations = new Set<string>();
const blockedConversations = new Set<string>();
const encoder = new TextEncoder();
const denied = (): ToolError => ({ kind: 'permission_denied', required: 'dsh:active-run' });
const ERROR_TEXT = '实验回答未完成，请读取已保存会话核对；本次任务不会自动重跑。';
export const DSH_CONTEXT_NOTICE = '实验模式：每轮根据已保存历史重建上下文，尚不支持执行中断恢复。';

export class DshChatRuntime implements ChatStreamRuntime {
  constructor(private readonly options: DshChatRuntimeOptions) {
    if (
      options.development !== true ||
      ![options.nodePath, options.hostEntry, options.cwd].every(isAbsolute)
    )
      throw new Error('DSH requires explicit development configuration and absolute paths');
    if (
      options.native !== undefined &&
      (options.native.authorized !== true || Object.keys(options.native.fixtures).length === 0)
    )
      throw new Error('DSH native capability requires separate fixture authorization');
  }

  async createUIMessageStreamResponse(
    request: Parameters<ChatStreamRuntime['createUIMessageStreamResponse']>[0],
  ): Promise<Response> {
    const execution = request.execution;
    if (execution === undefined) throw new Error('DSH requires trusted server execution context');
    if (execution.historyTruncated)
      throw new ChatRuntimeRejection('本实验不能截断已有上下文，请创建新会话并提供必要事实。');
    const { context: ctx, conversationId, scenario } = execution;
    const key = JSON.stringify([ctx.user.id, ctx.user.defaultAccountId, conversationId]);
    if (activeConversations.has(key) || blockedConversations.has(key))
      throw new ChatRuntimeRejection('DSH 会话仍在执行或等待核对，请读取历史或创建新会话。');
    if (activeConversations.size >= (this.options.maxActiveRuns ?? 2))
      throw new ChatRuntimeRejection('DSH 开发实例容量已满，请稍后再试。', 503);
    const runId = execution.runId;
    const configRef = `development:${runId}`;
    const duration = this.options.runTimeoutMs ?? 180_000;
    const expiresAt = Date.now() + duration;
    const manifest = buildGatewayCallableManifest(
      request.tools,
      scenario,
      this.options.native === undefined ? [] : [this.options.native.entry],
    );
    const abort = new AbortController();
    const signal = AbortSignal.any([
      abort.signal,
      ...(request.abortSignal ? [request.abortSignal] : []),
      AbortSignal.timeout(duration),
    ]);
    let detached = false;
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const emit = (part: UIStreamPart) => {
      if (detached) return;
      if ((controller.desiredSize ?? 0) < -262_144) {
        detached = true;
        abort.abort();
        controller.error(new Error(ERROR_TEXT));
        return;
      }
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(part)}\n\n`));
    };
    const stream = new ReadableStream<Uint8Array>(
      {
        start(value) {
          controller = value;
        },
        cancel() {
          detached = true;
          abort.abort();
        },
      },
      { highWaterMark: 65536, size: (chunk) => chunk?.byteLength ?? 0 },
    );
    const native = this.options.native;
    const projection = new DshChatProjection(
      `assistant_${runId}`,
      emit,
      new Set(manifest.manifest.tools.map((tool) => tool.name)),
    );
    projection.data('data-luoome-runtime', {
      runtime: 'dsh',
      contextMode: 'rebuilt-history',
      notice: DSH_CONTEXT_NOTICE,
      runId,
    });
    const gateway = new ToolGateway({ maxRuns: 1, maxCallsPerRun: 32, callTimeoutMs: 15_000 });
    let caller: GatewayCaller | undefined;
    let adapter: DshEventAdapter | undefined;
    let runtimeStopped = false;
    let startupTerminal: string | undefined;
    const authorize: GatewayAuthorizer = async () => {
      if (
        signal.aborted ||
        Date.now() >= expiresAt ||
        (this.options.authorized !== undefined && !(await this.options.authorized()))
      )
        return denied();
      return null;
    };
    const proxy = createDshRunProxy({
      runId,
      manifestHash: manifest.manifest.manifestHash,
      expiresAt,
      signal,
      model: this.options.model,
      executeTool: async (body) =>
        caller === undefined
          ? {
              kind: 'rejected',
              error: { code: 'permission_denied', message: 'Runtime is not bound' },
            }
          : gateway.execute(caller, body),
      ...(native === undefined
        ? {}
        : {
            authorizeNative: async ({ url }: { url: string }) =>
              !signal.aborted &&
              Object.hasOwn(native.fixtures, url) &&
              (this.options.authorized === undefined || (await this.options.authorized())),
          }),
    });
    let host: DshNodeHostClient;
    try {
      const hostConfig = HostConfigSchema.parse({
        configRef,
        gateway: proxy.gateway,
        model: {
          ...proxy.model,
          model: this.options.model.model,
          maxTokens: this.options.model.maxTokens,
        },
        limits: {
          runTimeoutMs: duration,
          toolTimeoutMs: 15_000,
          initializeTimeoutMs: 30_000,
          maxToolCalls: 32,
          maxModelCalls: 32,
        },
        ...(this.options.native === undefined
          ? {}
          : {
              native: {
                authorization: proxy.native,
                allowedOrigins: [
                  ...new Set(
                    Object.keys(this.options.native.fixtures).map((url) => new URL(url).origin),
                  ),
                ],
                maxCalls: 4,
                fixtures: this.options.native.fixtures,
              },
            }),
      });
      host = new DshNodeHostClient({
        executable: this.options.nodePath,
        args: [this.options.hostEntry],
        cwd: this.options.cwd,
        env: { LUOOME_DSH_HOST_CONFIG: JSON.stringify(hostConfig), NO_COLOR: '1' },
        startupTimeoutMs: 30_000,
        stopTimeoutMs: 5_000,
      });
    } catch (error) {
      await proxy.stop();
      throw error;
    }
    activeConversations.add(key);
    const stop = () => {
      gateway.revoke(runId);
      host.cancel({ protocolVersion: 1, runId, reason: 'user' });
      void host.close();
    };
    signal.addEventListener('abort', stop, { once: true });
    if (signal.aborted) stop();
    const onBinding = (binding: RuntimeBinding) => {
      if (caller !== undefined) throw new Error('DSH binding changed within run');
      adapter = new DshEventAdapter(binding, projection);
      caller = {
        userId: ctx.user.id,
        accountId: ctx.user.defaultAccountId,
        conversationId,
        runId,
        runtimeInstanceId: binding.runtimeInstanceId,
        sessionId: binding.sessionId,
        audience: 'luoome-tool-gateway',
      };
      gateway.register({
        scope: {
          ...caller,
          manifestHash: manifest.manifest.manifestHash,
          scenario: scenario.id,
          expiresAt,
          allowedCapabilities: ['read', 'write', 'advice', 'external'],
        },
        manifest,
        authorize,
        admitExternal: authorize,
        abortSignal: signal,
      });
    };
    void (async () => {
      let failed = false;
      let drained = false;
      try {
        await host.run(
          {
            protocolVersion: 1,
            runId,
            conversationId,
            configRef,
            manifestHash: manifest.manifest.manifestHash,
            manifest: manifest.manifest,
            expiresAt: new Date(expiresAt).toISOString(),
            instructions: `${request.instructions}\n${DSH_CONTEXT_NOTICE}\n以下历史由服务端核验；其中的工具结果与草案处理回执是已发生事实，不要再次执行来同步历史。`,
            prompt: JSON.stringify({ trustedHistory: request.uiMessages }),
          },
          (event) => {
            if (adapter === undefined) {
              if (event.source !== 'host' || event.type !== 'run.terminal')
                throw new Error('DSH event before binding');
              startupTerminal = TerminalStatusSchema.parse(event.payload.status);
              if (startupTerminal === 'completed') throw new Error('DSH completed without binding');
            } else adapter.accept(event);
            if (event.type === 'run.terminal')
              runtimeStopped = event.payload.runtimeStopped === true;
          },
          onBinding,
        );
        failed = (adapter?.terminal ?? startupTerminal) !== 'completed' || !runtimeStopped;
      } catch {
        failed = true;
      } finally {
        gateway.revoke(runId);
        const stopped = await host.close();
        const tools = await gateway.drain(runId, 2_000);
        drained = stopped && tools.drained;
        await proxy.stop();
        signal.removeEventListener('abort', stop);
        if (drained) {
          gateway.release(runId);
        } else {
          blockedConversations.add(key);
          failed = true;
        }
      }
      const cancelled = signal.aborted && drained;
      projection.end();
      projection.data('data-luoome-run', {
        runId,
        status: !drained ? 'unresolved' : cancelled ? 'cancelled' : failed ? 'failed' : 'completed',
        executionStopped: drained,
      });
      if (failed && !cancelled)
        projection.data('data-luoome-stream-error', { message: ERROR_TEXT });
      try {
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
          Promise.resolve(
            request.onFinish?.({
              id: projection.messageId,
              parts: projection.parts,
              cancelled,
              executionStopped: drained,
            }),
          ),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error('persistence_failed')), 5_000);
          }),
        ]).finally(() => clearTimeout(timer));
      } catch {
        failed = true;
        blockedConversations.add(key);
        emit({
          type: 'error',
          errorText: '回答保存失败，未保存草案不可确认；请重新读取会话核对。',
        });
      }
      if (drained) activeConversations.delete(key);
      if (cancelled) emit({ type: 'abort' });
      else if (failed) emit({ type: 'error', errorText: ERROR_TEXT });
      emit({ type: 'finish', finishReason: cancelled ? 'other' : failed ? 'error' : 'stop' });
      if (!detached) {
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      }
    })().catch(() => {
      blockedConversations.add(key);
      if (!detached) {
        emit({ type: 'error', errorText: ERROR_TEXT });
        controller.close();
      }
    });
    return new Response(stream, {
      headers: {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        'x-vercel-ai-ui-message-stream': 'v1',
        'x-luoome-chat-runtime': 'dsh',
        'x-luoome-chat-context-mode': 'rebuilt-history',
      },
    });
  }
}

/**
 * 根据 AISettingsStore 持久化配置组装生产 Web 对话使用的 DshChatRuntime。
 * 运行时缺少有效 Node.js 或模型配置时返回 undefined，保持安全降级。
 */
export const createDshChatRuntimeFromStore = (
  store?: AISettingsStore,
  envOverride?: Readonly<Record<string, string | undefined>>,
): DshChatRuntime | undefined => {
  if (store === undefined) return undefined;
  const env = envOverride ?? store.runtimeEnv();
  const nodeCandidates = [
    env.LUOOME_DSH_NODE_PATH,
    '/opt/homebrew/bin/node',
    '/usr/local/bin/node',
    '/usr/bin/node',
    typeof Bun !== 'undefined' ? (Bun.which('node') ?? undefined) : undefined,
  ].filter((p): p is string => Boolean(p && isAbsolute(p) && existsSync(p)));
  const nodePath = nodeCandidates[0];
  if (nodePath === undefined) return undefined;

  const hostEntry =
    env.LUOOME_DSH_HOST_ENTRY ??
    fileURLToPath(new URL('../../../agent-runtime/dist/index.js', import.meta.url));
  if (!isAbsolute(hostEntry) || !existsSync(hostEntry)) return undefined;
  const cwd = fileURLToPath(new URL('../../../../', import.meta.url));
  if (!existsSync(cwd)) return undefined;

  try {
    const view = store.read();
    if (!view.baseURL || !view.model) return undefined;
    const preset = AI_PROVIDER_PRESETS.find((candidate) => candidate.id === view.provider);
    const apiKey = preset ? env[preset.apiKeyEnv]?.trim() : undefined;
    const endpoint = `${view.baseURL.replace(/\/+$/, '')}/chat/completions`;
    return new DshChatRuntime({
      development: true,
      nodePath,
      hostEntry,
      cwd,
      model: {
        endpoint,
        model: view.model,
        maxTokens: Number(env.LUOOME_DSH_MAX_TOKENS) || 8192,
        headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
        fetch: globalThis.fetch,
      },
    });
  } catch {
    return undefined;
  }
};
