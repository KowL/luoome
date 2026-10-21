import { isAbsolute } from 'node:path';
import type { ToolError } from '@luoome/core';
import {
  type RuntimeBinding,
  TerminalStatusSchema,
  type ToolManifestEntry,
} from '@luoome/dsh-bridge/protocol';
import { HostConfigSchema } from '@luoome/dsh-bridge/runtime-config';
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
    if (
      ctx.identity?.mode === 'hosted' &&
      (ctx.hostedAuthorization === undefined || this.options.authorized === undefined)
    )
      throw new Error('DSH hosted authorization and metered transport are required');
    const tenant =
      ctx.identity?.mode === 'hosted'
        ? `${ctx.identity.tenantId}:${ctx.identity.tenantGeneration}`
        : `local:${ctx.user.id}`;
    const key = JSON.stringify([tenant, ctx.user.defaultAccountId, conversationId]);
    if (activeConversations.has(key) || blockedConversations.has(key))
      throw new ChatRuntimeRejection('DSH 会话仍在执行或等待核对，请读取历史或创建新会话。');
    if (activeConversations.size >= (this.options.maxActiveRuns ?? 2))
      throw new ChatRuntimeRejection('DSH 开发实例容量已满，请稍后再试。', 503);
    const runId = execution.runId;
    const configRef = `development:${runId}`;
    const duration = this.options.runTimeoutMs ?? 120_000;
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
    const authorize: GatewayAuthorizer = async ({ call, tool }) => {
      if (
        signal.aborted ||
        Date.now() >= expiresAt ||
        (this.options.authorized !== undefined && !(await this.options.authorized()))
      )
        return denied();
      const result = await ctx.hostedAuthorization?.(
        call.toolName,
        call.input,
        tool.requiredCapabilities as ('read' | 'write' | 'external' | 'advice')[],
      );
      return result !== undefined && result !== null && !result.ok ? result.error : null;
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
          maxModelCalls: 8,
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
        tenantId: ctx.identity?.mode === 'hosted' ? ctx.identity.tenantId : tenant,
        tenantGeneration: ctx.identity?.mode === 'hosted' ? ctx.identity.tenantGeneration : 1,
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
