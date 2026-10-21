import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { isAbsolute } from 'node:path';
import {
  type CancelRequest,
  type HostCommand,
  HostMessageSchema,
  type RunRequest,
  type RuntimeBinding,
  type RuntimeEvent,
} from '@luoome/dsh-bridge/protocol';

export interface NodeHostOptions {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly startupTimeoutMs?: number;
  readonly stopTimeoutMs?: number;
}

export class DshNodeHostClient {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #exit: Promise<void>;
  readonly #ready: Promise<void>;
  readonly #stopTimeout: number;
  #exited = false;
  #drained = false;
  #closing: Promise<boolean> | undefined;
  #run:
    | {
        request: RunRequest;
        binding?: RuntimeBinding;
        onEvent: (event: RuntimeEvent) => void;
        onBinding?: (binding: RuntimeBinding) => void;
        resolve: () => void;
        reject: (error: Error) => void;
      }
    | undefined;

  constructor(options: NodeHostOptions) {
    if (!isAbsolute(options.executable) || !isAbsolute(options.cwd))
      throw new Error('DSH Host requires absolute executable and cwd');
    this.#stopTimeout = options.stopTimeoutMs ?? 3_000;
    this.#child = spawn(options.executable, [...options.args], {
      cwd: options.cwd,
      env: { ...options.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
    });
    let rejectReady!: (error: Error) => void;
    let resolveReady!: () => void;
    this.#ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    // A rejected startup must remain observed while the caller is preparing its run.
    void this.#ready.catch(() => {});
    const startupTimer = setTimeout(() => {
      rejectReady(new Error('DSH Host startup timeout'));
      void this.close();
    }, options.startupTimeoutMs ?? 15_000);
    const fail = (message: string) => {
      const error = new Error(message);
      rejectReady(error);
      this.#run?.reject(error);
      void this.close();
    };
    this.#exit = new Promise<void>((resolve) => {
      this.#child.once('error', () => {
        this.#exited = true;
        this.#drained = true;
        clearTimeout(startupTimer);
        rejectReady(new Error('DSH Host could not start'));
        this.#run?.reject(new Error('DSH Host could not start'));
        resolve();
      });
      this.#child.once('close', () => {
        this.#exited = true;
        clearTimeout(startupTimer);
        rejectReady(new Error('DSH Host exited before ready'));
        this.#run?.reject(new Error('DSH Host exited'));
        resolve();
      });
    });
    let pending = '';
    this.#child.stdout.setEncoding('utf8');
    this.#child.stdout.on('data', (chunk: string) => {
      pending += chunk;
      if (Buffer.byteLength(pending) > 1_048_576) {
        fail('DSH Host message limit exceeded');
        return;
      }
      let newline = pending.indexOf('\n');
      while (newline >= 0) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        try {
          const message = HostMessageSchema.parse(JSON.parse(line));
          if (message.type === 'ready') {
            const [major, minor] = message.nodeVersion.slice(1).split('.').map(Number);
            if (!(major !== undefined && (major >= 24 || (major === 22 && (minor ?? 0) >= 19))))
              throw new Error('Unsupported Node Host');
            clearTimeout(startupTimer);
            resolveReady();
          } else if (message.type === 'binding') {
            if (
              this.#run === undefined ||
              message.binding.runId !== this.#run.request.runId ||
              message.binding.conversationId !== this.#run.request.conversationId
            )
              throw new Error('Unbound Host event');
            this.#run.binding = message.binding;
            this.#run.onBinding?.(message.binding);
          } else if (message.type === 'event') {
            if (
              this.#run === undefined ||
              message.event.runId !== this.#run.request.runId ||
              message.event.conversationId !== this.#run.request.conversationId
            )
              throw new Error('Unbound Host event');
            this.#run.onEvent(message.event);
            if (message.event.type === 'run.terminal') this.#run.resolve();
          } else if (message.type === 'error') {
            fail(`DSH Host ${message.error.code}`);
          } else {
            this.#drained = message.stopped;
            if (!message.stopped) fail('DSH Host drain unresolved');
          }
        } catch {
          fail('DSH Host protocol failed');
          return;
        }
        newline = pending.indexOf('\n');
      }
    });
    this.#child.stderr.resume();
    this.#child.stdin.on('error', () => fail('DSH Host input closed'));
  }

  async run(
    request: RunRequest,
    onEvent: (event: RuntimeEvent) => void,
    onBinding?: (binding: RuntimeBinding) => void,
  ): Promise<void> {
    await this.#ready;
    if (this.#run !== undefined || this.#closing !== undefined || this.#exited)
      throw new Error('DSH Host unavailable');
    await new Promise<void>((resolve, reject) => {
      this.#run = {
        request,
        onEvent,
        resolve,
        reject,
        ...(onBinding === undefined ? {} : { onBinding }),
      };
      this.#write({ type: 'run', request });
    });
  }

  cancel(request: CancelRequest): void {
    if (!this.#exited && this.#run?.request.runId === request.runId)
      this.#write({ type: 'cancel', request });
  }

  close(): Promise<boolean> {
    this.#closing ??= this.#stop();
    return this.#closing;
  }

  #write(command: HostCommand): void {
    if (!this.#child.stdin.destroyed) this.#child.stdin.write(`${JSON.stringify(command)}\n`);
  }

  async #waitExit(ms: number): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      this.#exit,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, ms);
      }),
    ]).finally(() => clearTimeout(timer));
    return this.#exited;
  }

  async #stop(): Promise<boolean> {
    if (this.#exited) return this.#drained;
    this.#write({ type: 'shutdown' });
    if (await this.#waitExit(this.#stopTimeout)) return this.#drained;
    this.#child.kill('SIGTERM');
    if (await this.#waitExit(this.#stopTimeout)) return this.#drained;
    this.#child.kill('SIGKILL');
    await this.#waitExit(this.#stopTimeout);
    return this.#drained && this.#exited;
  }
}
