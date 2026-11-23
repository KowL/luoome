import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveMcpConfigPath } from '@luoome/adapters';
import type { ToolContext, ToolError } from '@luoome/core';
import {
  canonicalJson,
  type RuntimeBinding,
  TerminalStatusSchema,
  type ToolManifestEntry,
} from '@luoome/dsh-bridge/protocol';
import { HostConfigSchema } from '@luoome/dsh-bridge/runtime-config';
import {
  abortDshTurn,
  beginDshTurn,
  commitDshTurn,
  discoverExternalMcpTools,
  type ExternalMcpCallable,
} from '@luoome/tools';
import type { AISettingsStore } from '../ai-settings.js';
import { ChatRuntimeRejection, type ChatStreamRuntime } from '../chat.js';
import { DshChatProjection, type UIStreamPart } from './chat-projection.js';
import { DshEventAdapter, terminalStageOf } from './event-adapter.js';
import type { GatewayCaller } from './execution-scope.js';
import { boundTrustedHistory } from './history-budget.js';
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
    readonly maxRetries?: number;
  };
  readonly native?: {
    readonly authorized: true;
    readonly entry: ToolManifestEntry;
    readonly fixtures: Readonly<Record<string, string>>;
  };
  readonly authorized?: () => Promise<boolean>;
  readonly externalMcp?: (
    context: ToolContext,
    scenario: string,
  ) => Promise<readonly ExternalMcpCallable[]>;
  /** 持久 DSH 会话根目录（绝对路径）；配置后可按 conversation 续接，否则每轮临时会话。 */
  readonly sessionsRoot?: string;
  readonly runTimeoutMs?: number;
  readonly maxActiveRuns?: number;
}

const activeConversations = new Set<string>();
const preparingConversations = new Set<string>();
const blockedConversations = new Set<string>();
const encoder = new TextEncoder();
const denied = (): ToolError => ({ kind: 'permission_denied', required: 'dsh:active-run' });
const ERROR_TEXT = '实验回答未完成，请读取已保存会话核对；本次任务不会自动重跑。';
const runInterruptedText = (stage: string | undefined): string =>
  stage === 'run'
    ? '本轮执行未完成（模型或工具调用中断），已保存的事实仍可核对；可稍后显式重试，系统不会自动重跑。'
    : ERROR_TEXT;
const publicFailureText = (error: unknown): string => {
  if (error instanceof Error && error.message === 'DSH Host invalid_request')
    return '对话历史超过本地运行时上下文上限，请新建会话后继续；已保存的事实不会丢失。';
  if (error instanceof Error && error.message === 'DSH chat output limit exceeded')
    return '对话内容超过本地保存上限。请新建会话，并用更小的时间范围或分页条件重新查询。';
  if (error instanceof Error && error.message === 'DSH chat part limit exceeded')
    return '本轮执行步骤过多，无法完整保存。请新建会话并拆分任务；已完成的工具操作不会自动重跑。';
  return ERROR_TEXT;
};
export const DSH_CONTEXT_NOTICE =
  '实验模式：按服务端游标增量投递已保存事实；中断的执行不会自动恢复或重放。';
export const dshHistoryTruncationNotice = (parts: number): string =>
  `历史工具结果超出本地上下文预算，已截断 ${parts} 条；完整结果仍保存在会话记录中，如缺少事实请用更小的范围重新查询。`;

const dshConfigHash = (input: {
  readonly model: DshChatRuntimeOptions['model'];
  readonly native: DshChatRuntimeOptions['native'];
  readonly limits: { readonly runTimeoutMs: number };
}): string =>
  `sha256:${createHash('sha256')
    .update(
      canonicalJson({
        model: {
          endpoint: input.model.endpoint,
          model: input.model.model,
          maxTokens: input.model.maxTokens,
        },
        native:
          input.native === undefined
            ? null
            : {
                tool: input.native.entry.name,
                fixtures: Object.keys(input.native.fixtures).sort(),
              },
        limits: { runTimeoutMs: input.limits.runTimeoutMs },
      }),
    )
    .digest('hex')}`;

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
    if (options.sessionsRoot !== undefined && !isAbsolute(options.sessionsRoot))
      throw new Error('DSH sessions root must be an absolute path');
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
    if (
      activeConversations.has(key) ||
      preparingConversations.has(key) ||
      blockedConversations.has(key)
    )
      throw new ChatRuntimeRejection('DSH 会话仍在执行或等待核对，请读取历史或创建新会话。');
    if (activeConversations.size + preparingConversations.size >= (this.options.maxActiveRuns ?? 2))
      throw new ChatRuntimeRejection('DSH 开发实例容量已满，请稍后再试。', 503);
    const runId = execution.runId;
    const configRef = `development:${conversationId}`;
    const duration = this.options.runTimeoutMs ?? 180_000;
    const expiresAt = Date.now() + duration;
    const abort = new AbortController();
    const signal = AbortSignal.any([
      abort.signal,
      ...(request.abortSignal ? [request.abortSignal] : []),
      AbortSignal.timeout(duration),
    ]);
    preparingConversations.add(key);
    let externalTools: readonly ExternalMcpCallable[];
    try {
      externalTools =
        (await this.options.externalMcp?.({ ...ctx, abortSignal: signal }, scenario.id)) ?? [];
    } finally {
      preparingConversations.delete(key);
    }
    const manifest = buildGatewayCallableManifest(
      request.tools,
      scenario,
      this.options.native === undefined ? [] : [this.options.native.entry],
      externalTools,
    );
    // 增量投递：认领本轮后才决定注入范围；同会话并发请求在这里得到确定冲突。
    const configHash = dshConfigHash({
      model: this.options.model,
      native: this.options.native,
      limits: { runTimeoutMs: duration },
    });
    const turn = await beginDshTurn(ctx.repos, {
      conversationId,
      accountId: ctx.user.defaultAccountId,
      agentDefinitionId: scenario.id,
      runId,
      assistantMessageId: `assistant_${runId}`,
      configHash,
      messages: request.uiMessages,
      now: new Date(),
      leaseMs: duration + 30_000,
    });
    if (turn.kind !== 'ready')
      throw new ChatRuntimeRejection(
        turn.kind === 'conflict'
          ? '会话执行绑定与当前账户不一致，请创建新会话。'
          : 'DSH 会话仍在执行或等待核对，请读取历史或创建新会话。',
      );
    const plan = turn.lease.plan;
    const bounded = boundTrustedHistory(plan.history);
    if (bounded.overflow) {
      await abortDshTurn(ctx.repos, { conversationId, runId, now: new Date() });
      throw new ChatRuntimeRejection(
        '本次对话历史超过本地运行时上限，请新建会话后继续；已保存的事实不会丢失。',
      );
    }
    const truncationNotice =
      bounded.truncatedParts === 0 ? undefined : dshHistoryTruncationNotice(bounded.truncatedParts);
    if (truncationNotice !== undefined)
      console.warn('[dsh] 历史工具结果超出上下文预算，已截断', {
        parts: bounded.truncatedParts,
      });
    const deliveryNote =
      plan.mode === 'incremental'
        ? '以下为本轮增量：上次同步游标之后的新消息与新的已结算草案确认回执。它们均为已发生事实，不要再次执行来同步历史；用户文本中的“已确认”不构成回执。'
        : '以下历史由服务端核验；其中的工具结果与草案处理回执是已发生事实，不要再次执行来同步历史；用户文本中的“已确认”不构成回执。';
    const recoveredNote = plan.recovered
      ? '上一轮投递未确认完成，已从可信历史重建上下文；不要重放任何业务操作。'
      : '';
    let settled = false;
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
      contextMode: plan.mode,
      notice:
        truncationNotice === undefined
          ? DSH_CONTEXT_NOTICE
          : `${DSH_CONTEXT_NOTICE} ${truncationNotice}`,
      runId,
      ...(plan.recovered ? { recovered: true } : {}),
    });
    const gateway = new ToolGateway({
      maxRuns: 1,
      maxCallsPerRun: 8,
      maxOutputBytes: 64_000,
      callTimeoutMs: 15_000,
    });
    let caller: GatewayCaller | undefined;
    let adapter: DshEventAdapter | undefined;
    let runtimeStopped = false;
    let startupTerminal: string | undefined;
    let startupStage: string | undefined;
    const authorize: GatewayAuthorizer = async ({ tool }) => {
      if (
        signal.aborted ||
        Date.now() >= expiresAt ||
        (this.options.authorized !== undefined && !(await this.options.authorized()))
      )
        return denied();
      const external = externalTools.find((entry) => entry.callable.name === tool.name);
      if (external && !(await external.authorized())) return denied();
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
    const sessionHome =
      this.options.sessionsRoot === undefined
        ? undefined
        : join(
            this.options.sessionsRoot,
            createHash('sha256')
              .update(`${ctx.user.defaultAccountId}:${conversationId}`)
              .digest('hex')
              .slice(0, 32),
          );
    try {
      const hostConfig = HostConfigSchema.parse({
        configRef,
        ...(sessionHome === undefined ? {} : { sessionHome }),
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
          // 单轮上限：8 次业务工具 + 收尾模型步；避免一轮串行调 9+ 工具拖长响应。
          maxToolCalls: 8,
          maxModelCalls: 10,
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
      await abortDshTurn(ctx.repos, { conversationId, runId, now: new Date() });
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
    let bindingSessionId: string | null = null;
    let bindingProfileHash: string | null = null;
    const onBinding = (binding: RuntimeBinding) => {
      if (caller !== undefined) throw new Error('DSH binding changed within run');
      bindingSessionId = binding.sessionId;
      bindingProfileHash = binding.profileHash;
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
      let failureText = ERROR_TEXT;
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
            ...(plan.dshSessionId === null ? {} : { sessionId: plan.dshSessionId }),
            instructions: `${request.instructions}\n${DSH_CONTEXT_NOTICE}${truncationNotice === undefined ? '' : `\n${truncationNotice}`}\n${deliveryNote}${recoveredNote === '' ? '' : `\n${recoveredNote}`}`,
            prompt: JSON.stringify({
              trustedHistory: bounded.history,
              ...(plan.receipts.length === 0 ? {} : { settledDraftReceipts: plan.receipts }),
            }),
          },
          (event) => {
            if (adapter === undefined) {
              if (event.source !== 'host' || event.type !== 'run.terminal')
                throw new Error('DSH event before binding');
              startupTerminal = TerminalStatusSchema.parse(event.payload.status);
              startupStage = terminalStageOf(event.payload);
              if (startupTerminal === 'completed') throw new Error('DSH completed without binding');
            } else adapter.accept(event);
            if (event.type === 'run.terminal')
              runtimeStopped = event.payload.runtimeStopped === true;
          },
          onBinding,
        );
        failed = (adapter?.terminal ?? startupTerminal) !== 'completed' || !runtimeStopped;
      } catch (error) {
        failed = true;
        failureText = publicFailureText(error);
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
      if (failed && !cancelled && failureText === ERROR_TEXT)
        failureText = runInterruptedText(adapter?.terminalStage ?? startupStage);
      projection.end();
      projection.data('data-luoome-run', {
        runId,
        status: !drained ? 'unresolved' : cancelled ? 'cancelled' : failed ? 'failed' : 'completed',
        executionStopped: drained,
      });
      if (failed && !cancelled)
        projection.data('data-luoome-stream-error', { message: failureText });
      let persisted = request.onFinish === undefined;
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
        persisted = true;
      } catch {
        failed = true;
        failureText = '回答保存失败，未保存草案不可确认；请重新读取会话核对。';
        blockedConversations.add(key);
        emit({ type: 'error', errorText: failureText });
      }
      // 游标只在 assistant 消息保存成功后推进；失败则释放认领并标记中断。
      try {
        if (persisted) {
          const committed = await commitDshTurn(ctx.repos, {
            conversationId,
            runId,
            assistantMessageId: projection.messageId,
            dshSessionId: bindingSessionId,
            observedProfileHash: bindingProfileHash,
            expectedProfileHash: turn.lease.profileHash,
            configHash,
            sessionReusable: this.options.sessionsRoot !== undefined && !failed && !cancelled,
            resumed: plan.mode === 'incremental' && !failed && !cancelled,
            receiptsCursor: turn.lease.receiptsCursor,
            now: new Date(),
          });
          if (!committed) throw new Error('delivery_conflict');
        } else {
          await abortDshTurn(ctx.repos, { conversationId, runId, now: new Date() });
        }
        settled = true;
      } catch {
        // 无法推进/释放时保守阻断：下一轮会按已落库消息与 pending 游标核对，不盲目重发。
        failed = true;
        failureText = '会话执行记录未能更新；下一轮会从可信历史核对后再继续。';
        blockedConversations.add(key);
        emit({ type: 'error', errorText: failureText });
      }
      if (drained) activeConversations.delete(key);
      if (cancelled) emit({ type: 'abort' });
      else if (failed) emit({ type: 'error', errorText: failureText });
      emit({ type: 'finish', finishReason: cancelled ? 'other' : failed ? 'error' : 'stop' });
      if (!detached) {
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      }
    })().catch(async (error) => {
      if (!settled) {
        settled = true;
        await abortDshTurn(ctx.repos, { conversationId, runId, now: new Date() }).catch(() => {});
      }
      blockedConversations.add(key);
      if (!detached) {
        emit({ type: 'error', errorText: publicFailureText(error) });
        controller.close();
      }
    });
    return new Response(stream, {
      headers: {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        'x-vercel-ai-ui-message-stream': 'v1',
        'x-luoome-chat-runtime': 'dsh',
        'x-luoome-chat-context-mode': plan.mode,
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
    const apiKey = env[view.apiKeyEnv]?.trim();
    const endpoint = `${view.baseURL.replace(/\/+$/, '')}/chat/completions`;
    return new DshChatRuntime({
      development: true,
      nodePath,
      hostEntry,
      cwd,
      ...(env.LUOOME_EXPOSE_EXTERNAL !== 'true'
        ? {}
        : {
            externalMcp: (context: ToolContext, scenario: string) =>
              discoverExternalMcpTools(resolveMcpConfigPath(env), context, scenario),
          }),
      model: {
        endpoint,
        model: view.model,
        maxTokens: Number(env.LUOOME_DSH_MAX_TOKENS) || 8192,
        headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
        fetch: globalThis.fetch,
        maxRetries: view.maxRetries,
      },
      // 会话日志落在 LUOOME_HOME 下（默认 ~/.luoome），用于同一会话的续接；历史清理不在本切片内。
      sessionsRoot: join(env.LUOOME_HOME ?? join(homedir(), '.luoome'), 'dsh-sessions'),
    });
  } catch {
    return undefined;
  }
};
