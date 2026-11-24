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
import { DeepSeekHarness, TransportClosedError } from '@deepseek-ai/dsh-sdk-client';
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
      // 根 Agent idle 不代表 Run 完成：仍活跃的后代必须排空。取消仍按既有取消路径结案；
      // 到位后尚未结算的后代按 abandoned 收尾，不把整个 Run 判失败。
      if (!active.cancel) {
        const descendants = await awaitDescendants(active.tree, {
          deadline: Date.parse(run.expiresAt),
          cancelled: () => active.cancel === true,
        });
        if (descendants === 'cancelled') throw new Error('Descendant Agents remained active');
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
