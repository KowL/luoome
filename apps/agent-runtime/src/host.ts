import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import {
  DeepSeekHarness,
  type HarnessNotification,
  type NotificationSubscription,
  TransportClosedError,
  validatedSessionEvent,
} from '@deepseek-ai/dsh-sdk-client';
import {
  type CancelRequest,
  type HostMessage,
  type JsonObject,
  JsonObjectSchema,
  type RunRequest,
  RunRequestSchema,
  type RuntimeEvent,
  RuntimeEventSchema,
  type TerminalStatus,
} from '@luoome/dsh-bridge/protocol';
import {
  type HostConfig,
  HostConfigSchema,
} from '../../../packages/dsh-bridge/src/runtime-config.js';
import { awaitDescendants, RunAgentTree, recordAgentDiagnostic } from './agent-tree.js';
import { awaitParentFollowUps, type FollowUpSignal } from './parent-followup.js';
import { hashJson, installedDshBin, PROFILE_NAME, prepareProfile } from './profile.js';

const execFileAsync = promisify(execFile);
const { load: loadYaml } = createRequire(import.meta.url)('js-yaml') as {
  load(source: string): unknown;
};
type Delivery = (message: HostMessage) => Promise<void>;
interface ActiveRuntime {
  run: RunRequest;
  sessionId: string;
  /** 根 Agent 与派生后代的父子关系；完成判定不能只看根 idle。 */
  tree: RunAgentTree;
  harness?: DeepSeekHarness;
  task?: Promise<void>;
  cancel?: boolean;
  cancelReason?: CancelRequest['reason'];
  timer?: ReturnType<typeof setTimeout>;
  root?: string;
  runtimePid?: number;
  server?: Server;
  stopped: boolean;
}

/** 只投影追问阶段关心的官方会话树通知；根 Agent 的非法 turn 结束也算一种信号。 */
const followUpSignal = (
  notification: HarnessNotification,
  sessionId: string,
): FollowUpSignal | undefined => {
  const { params } = notification;
  if (notification.method === 'session.status') {
    if (params.sessionId !== sessionId) return undefined;
    if (params.status === 'running') return { type: 'root-running' };
    return params.status === 'idle' ? { type: 'root-idle' } : undefined;
  }
  if (notification.method === 'subagent.finished')
    return typeof params.agentId === 'string' ? { type: 'child-finished' } : undefined;
  if (notification.method !== 'session.event' || params.sessionId !== sessionId) return undefined;
  const event = validatedSessionEvent(params.event);
  if (event.type !== 'turn/end') return undefined;
  const kind = event.data.reason.kind;
  return kind === 'completed' || kind === 'max-tokens'
    ? undefined
    : { type: 'root-turn-aborted', reason: kind };
};

/** 消费到根 Agent 首次 idle：之前属于首次 prompt 的活动区间。 */
const drainToRootIdle = async (
  notifications: NotificationSubscription,
  sessionId: string,
): Promise<void> => {
  for (;;) {
    if (followUpSignal(await notifications.next(), sessionId)?.type === 'root-idle') return;
  }
};

/** 取出一条已送达的追问信号；队列里没有时返回 `undefined`。 */
const drainQueuedSignal = (
  notifications: NotificationSubscription,
  sessionId: string,
): FollowUpSignal | undefined => {
  for (
    let notification = notifications.tryNext();
    notification !== undefined;
    notification = notifications.tryNext()
  ) {
    const signal = followUpSignal(notification, sessionId);
    if (signal !== undefined) return signal;
  }
  return undefined;
};

const nextFollowUpSignal = async (
  notifications: NotificationSubscription,
  sessionId: string,
): Promise<FollowUpSignal | undefined> => {
  for (;;) {
    const signal = followUpSignal(await notifications.next(), sessionId);
    if (signal !== undefined) return signal;
  }
};

export class NodeRuntimeHost {
  readonly runtimeInstanceId = randomUUID();
  readonly config: HostConfig;
  private active: ActiveRuntime | undefined;
  private closed = false;
  private unresolved = false;
  private sequence = 0;
  private readonly acceptedRuns = new Set<string>();

  constructor(
    config: unknown,
    private readonly deliver: Delivery,
  ) {
    if (process.versions.bun) throw new Error('DSH Host must run under Node');
    const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
    if (!(major >= 24 || (major === 22 && minor >= 19)))
      throw new Error('Unsupported Node version');
    this.config = HostConfigSchema.parse(config);
  }

  private event(run: RunRequest, agentId: string, type: RuntimeEvent['type'], payload: JsonObject) {
    const sequence = this.sequence++;
    return this.deliver({
      type: 'event',
      event: {
        protocolVersion: 1,
        runId: run.runId,
        conversationId: run.conversationId,
        agentId,
        source: 'host',
        sourceEventId: `${this.runtimeInstanceId}:${sequence}`,
        sequence,
        timestamp: new Date().toISOString(),
        type,
        payload,
      },
    });
  }

  async run(run: RunRequest): Promise<void> {
    run = RunRequestSchema.parse(run);
    if (this.closed || this.unresolved || this.active)
      throw new Error('Host cannot accept this run');
    if (run.configRef !== this.config.configRef || Date.parse(run.expiresAt) <= Date.now())
      throw new Error('Run configuration or authorization is invalid');
    if (this.acceptedRuns.has(run.runId) || this.acceptedRuns.size >= 128)
      throw new Error('Duplicate run or Host run limit exceeded');
    this.acceptedRuns.add(run.runId);
    const sessionId = run.sessionId ?? randomUUID();
    const active: ActiveRuntime = {
      run,
      sessionId,
      tree: new RunAgentTree(sessionId),
      stopped: false,
    };
    this.active = active;
    active.timer = setTimeout(
      () => {
        void this.cancel(run.runId, 'timeout').catch(() => {
          this.unresolved = true;
        });
      },
      Math.min(this.config.limits.runTimeoutMs, Date.parse(run.expiresAt) - Date.now()),
    );
    active.task = this.execute(active);
    await active.task;
  }

  private async execute(active: ActiveRuntime): Promise<void> {
    const { run, sessionId } = active;
    let status: TerminalStatus = 'failed';
    let failed = false;
    let stage = 'profile';
    try {
      active.root = await (async () => {
        if (this.config.sessionHome === undefined)
          return mkdtemp(join(tmpdir(), 'luoome-dsh-run-'));
        await mkdir(this.config.sessionHome, { recursive: true, mode: 0o700 });
        return this.config.sessionHome;
      })();
      const profile = await prepareProfile(active.root, this.config, run);
      const token = randomBytes(32).toString('hex');
      const seen = new Set<string>();
      let lastSequence = -1;
      const server = createServer(async (request, response) => {
        try {
          if (
            request.method !== 'POST' ||
            request.url !== '/events' ||
            request.headers.authorization !== `Bearer ${token}`
          ) {
            response.writeHead(403).end();
            return;
          }
          let bytes = 0;
          const chunks: Buffer[] = [];
          for await (const chunk of request) {
            const buffer = Buffer.from(chunk);
            bytes += buffer.byteLength;
            if (bytes > 1_000_000) throw new Error('Event limit exceeded');
            chunks.push(buffer);
          }
          const event = RuntimeEventSchema.parse(
            JSON.parse(Buffer.concat(chunks).toString('utf8')),
          );
          if (
            event.runId !== run.runId ||
            event.conversationId !== run.conversationId ||
            event.agentId !== sessionId ||
            event.source !== 'plugin'
          )
            throw new Error('Unbound event');
          if (!seen.has(event.sourceEventId)) {
            if (event.sequence <= lastSequence || seen.size >= 20000)
              throw new Error('Event sequence or count invalid');
            lastSequence = event.sequence;
            seen.add(event.sourceEventId);
            if (event.type === 'diagnostic' && event.payload.code === 'inventory') {
              if (typeof event.payload.pid === 'number') active.runtimePid = event.payload.pid;
            }
            if (event.type === 'diagnostic') recordAgentDiagnostic(active.tree, event.payload);
            await this.deliver({ type: 'event', event });
          }
          response.writeHead(200, { 'content-type': 'application/json' }).end('{}');
        } catch {
          response.writeHead(400).end();
        }
      });
      active.server = server;
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Event endpoint unavailable');
      const configPath = join(active.root, 'bridge.json');
      await writeFile(
        configPath,
        JSON.stringify({
          host: this.config,
          run,
          sessionId,
          eventSink: { endpoint: `http://127.0.0.1:${address.port}/events`, token },
        }),
        { mode: 0o600 },
      );
      const env = {
        DSH_HOME: profile.home,
        LUOOME_DSH_BRIDGE_CONFIG: configPath,
        NO_COLOR: '1',
        DO_NOT_TRACK: '1',
        OTEL_SDK_DISABLED: 'true',
      };
      const bin = installedDshBin();
      stage = 'profile-dump';
      const dumped = await execFileAsync(
        process.execPath,
        [bin, '--profile', PROFILE_NAME, '--dump-config'],
        {
          cwd: profile.workspace,
          env,
          timeout: this.config.limits.initializeTimeoutMs,
          maxBuffer: 1000000,
        },
      );
      // Dumping and running use the same private Profile with no user/home layers.
      const dump = dumped.stdout;
      const actualPlugins = JsonObjectSchema.array()
        .parse(loadYaml(dump))
        .map((entry) => {
          if (typeof entry.name !== 'string') throw new Error('Profile entry has no plugin name');
          return entry.name;
        })
        .sort();
      const expectedPlugins = profile.entries
        .map((entry) => {
          const name = (entry as JsonObject).name as string;
          return isAbsolute(name) ? pathToFileURL(name).href : name;
        })
        .sort();
      if (JSON.stringify(actualPlugins) !== JSON.stringify(expectedPlugins)) {
        throw new Error('Composed Profile failed restricted-inventory inspection');
      }
      await this.deliver({
        type: 'binding',
        binding: {
          runtimeInstanceId: this.runtimeInstanceId,
          sessionId,
          profileHash: profile.profileHash,
          configHash: hashJson({
            // 只包含语义配置；gateway/model endpoint 是每轮临时传输端口，不计入快照。
            model: {
              model: this.config.model.model,
              maxTokens: this.config.model.maxTokens,
              contextWindow: this.config.model.contextWindow,
              temperature: this.config.model.temperature ?? null,
              reasoningEffort: this.config.model.reasoningEffort,
            },
            native: this.config.native
              ? {
                  allowedOrigins: this.config.native.allowedOrigins,
                  maxCalls: this.config.native.maxCalls,
                  fixtures: this.config.native.fixtures ?? null,
                }
              : null,
            limits: this.config.limits,
          }),
          runId: run.runId,
          conversationId: run.conversationId,
        },
      });
      const harness = new DeepSeekHarness({
        profile: PROFILE_NAME,
        dshHome: profile.home,
        processCwd: profile.workspace,
        cwd: profile.workspace,
        provider: 'luoome-metered',
        model: this.config.model.model,
        maxTokens: this.config.model.maxTokens,
        env,
        initializeTimeoutMs: this.config.limits.initializeTimeoutMs,
        shutdownTimeoutMs: 500,
        disposeEofGraceMs: 1000,
        disposeGraceMs: 1000,
      });
      active.harness = harness;
      if (active.cancel) throw new Error('Run cancelled before startup');
      stage = 'initialize';
      await harness.start();
      await this.event(run, sessionId, 'diagnostic', {
        code: 'profile-inventory',
        plugins: actualPlugins,
      });
      await this.event(run, sessionId, 'run.started', {
        status: 'running',
        runtimeInstanceId: this.runtimeInstanceId,
      });
      if (active.cancel) throw new Error('Run cancelled during startup');
      stage = 'run';
      // 首次 idle 之后到达的子 Agent 结算通知会唤醒父级再跑一轮，订阅必须早于首次 prompt。
      const notifications = harness.client.subscribeSessionTree(sessionId);
      try {
        // 持久会话目录存在时才 resume；否则新 Session 仍持有给定身份，但不声称恢复了历史。
        const result =
          run.sessionId !== undefined && this.config.sessionHome !== undefined
            ? await (await harness.resumeSession(run.sessionId)).run(run.prompt)
            : await harness.run(run.prompt, { sessionId });
        let completedTurn = false;
        for (const event of result.events) {
          if (event.type !== 'turn/end') continue;
          await this.event(run, sessionId, 'diagnostic', {
            code: 'sdk-turn-end',
            reason: event.data.reason.kind,
          });
          if (event.data.reason.kind !== 'completed' && event.data.reason.kind !== 'max-tokens') {
            throw new Error('DSH turn did not complete');
          }
          completedTurn = true;
        }
        if (!completedTurn) throw new Error('DSH returned idle without a committed completed turn');
        // 根 Agent idle 不代表 Run 完成：父级在 idle 之后仍会收到子 Agent 完成/放弃通知并再跑一轮。
        if (!active.cancel) await this.settleAfterIdle(active, notifications);
      } finally {
        notifications.close();
      }
      status = active.cancel
        ? active.cancelReason === 'timeout'
          ? 'failed'
          : 'cancelled'
        : 'completed';
    } catch (error) {
      failed = true;
      console.error('run failed', {
        stage,
        message: error instanceof Error ? error.message : String(error),
      });
      status = active.cancel
        ? active.cancelReason === 'timeout'
          ? 'failed'
          : 'cancelled'
        : error instanceof TransportClosedError && stage === 'run'
          ? 'interrupted'
          : 'failed';
    } finally {
      if (active.timer) clearTimeout(active.timer);
      try {
        await active.harness?.close();
        active.stopped = true;
      } catch {
        status = 'unresolved';
        this.unresolved = true;
      }
      if (active.server) {
        active.server.closeAllConnections();
        await new Promise<void>((resolve) => active.server?.close(() => resolve()));
      }
      if (active.stopped && active.root && this.config.sessionHome === undefined) {
        try {
          await rm(active.root, { recursive: true, force: true });
        } catch {
          status = 'failed';
          failed = true;
          stage = 'cleanup';
        }
      }
      // 取消/关闭进程时后代随 Host 一起终止；在此之后再定稿，审计不会残留活跃后代。
      active.tree.terminateDescendants();
      const descendants = active.tree
        .snapshot()
        .filter((node) => node.parentAgentId !== null)
        .map((node) => ({
          agentId: node.agentId,
          parentAgentId: node.parentAgentId,
          depth: node.depth,
          status: node.status,
        }));
      await this.event(run, sessionId, 'run.terminal', {
        status,
        runtimeStopped: active.stopped,
        ...(active.runtimePid ? { runtimePid: active.runtimePid } : {}),
        ...(descendants.length === 0 ? {} : { agents: descendants }),
        ...(failed
          ? {
              error: {
                code: active.cancel
                  ? active.cancelReason === 'timeout'
                    ? 'timeout'
                    : 'cancelled'
                  : 'runtime_failed',
                message: 'DSH run did not complete',
                stage,
              },
            }
          : {}),
      });
      if (active.stopped) this.active = undefined;
    }
  }

  /**
   * 根 Agent 首次 idle 后收尾：先等后代终态，再让官方 `session/wait` 确认根确实静默。
   * 父级为消费子 Agent 结算通知再开的每轮追问都受截止时间、共享预算、轮次上限和取消约束；
   * 到期、上限耗尽或追问无法开始时只把仍活跃后代标 abandoned，不把整个 Run 判失败。
   */
  private async settleAfterIdle(
    active: ActiveRuntime,
    notifications: NotificationSubscription,
  ): Promise<void> {
    const { run, sessionId } = active;
    const harness = active.harness;
    if (harness === undefined) throw new Error('Run has no Harness');
    const deadline = Date.parse(run.expiresAt);
    const cancelled = () => active.cancel === true;
    const limit = this.config.limits.parentFollowUpTurns;
    await drainToRootIdle(notifications, sessionId);
    const outcome = await awaitParentFollowUps({
      maxTurns: limit,
      deadline,
      cancelled,
      waitForDescendants: () => awaitDescendants(active.tree, { deadline, cancelled }),
      settle: async () => {
        await harness.client.request('session/wait', { sessionId });
      },
      next: () => nextFollowUpSignal(notifications, sessionId),
      drain: () => drainQueuedSignal(notifications, sessionId),
      onTurn: (turn, consumed) =>
        this.event(run, sessionId, 'diagnostic', {
          code: 'parent.followup',
          turn,
          consumed,
          limit,
        }),
    });
    if (outcome.kind === 'settled') return;
    if (outcome.kind === 'cancelled') throw new Error('Descendant Agents remained active');
    if (outcome.kind === 'failed') {
      // 运行时已断开时沿用既有 interrupted 判定；其它原因（预算耗尽、通知不可用）只做收尾。
      if (outcome.error instanceof TransportClosedError) throw outcome.error;
      active.tree.abandonDescendants();
      await this.event(run, sessionId, 'diagnostic', {
        code: 'parent.followup_failed',
        turns: outcome.turns,
        pending: outcome.pending,
        limit,
        reason: outcome.error instanceof Error ? outcome.error.message : String(outcome.error),
      });
      return;
    }
    active.tree.abandonDescendants();
    await this.event(run, sessionId, 'diagnostic', {
      code: outcome.kind === 'exhausted' ? 'parent.followup_exhausted' : 'parent.followup_expired',
      turns: outcome.turns,
      pending: outcome.pending,
      limit,
    });
  }

  async cancel(runId: string, reason: CancelRequest['reason'] = 'user'): Promise<void> {
    const active = this.active;
    if (!active || active.run.runId !== runId || active.cancel) return;
    active.cancel = true;
    active.cancelReason = reason;
    await Promise.all([
      this.event(active.run, active.sessionId, 'run.status', { status: 'stopping', reason }),
      active.harness?.close(),
    ]);
  }

  async close(): Promise<boolean> {
    this.closed = true;
    const active = this.active;
    if (active) {
      try {
        await this.cancel(active.run.runId);
      } catch {
        this.unresolved = true;
      }
      await active.task;
    }
    return !this.unresolved;
  }
}
