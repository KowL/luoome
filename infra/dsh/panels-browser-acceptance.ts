// M4 三面板浏览器验收：临时 DSH Web profile + 本机 Google Chrome headless（CDP）。
//
// 覆盖（需求 §7、§9 M4、§10.4；plugin 详细设计 §4.2/§8）：
//   1. 真实 DSH Web 登录（官方 token → signed cookie），加载随包 client slots；
//   2. 五个侧栏条目 + DSH 设置内的投资设置；FUYAO 保存后下一次请求立即使用新配置；
//   3. 每块面板 DOM 展示值与宿主 /api/luoome/state 的 ToolResult、以及 SQLite 事实库
//      逐项一致（账户/持仓/建议/策略版本/运行/信心校准/决策复盘/用户反馈）；
//   4. 策略面板「AI 研究」携带 strategyId/runId，点击后导航到会话并记录请求；
//   5. 刷新后仍正确；移动端无横向溢出；
//   6. 桌面三个面板 + 移动端截图与 JSON 证据落盘到临时目录（不提交仓库）。
//
// 这是「真实浏览器验收」，不是真实模型质量验收：数据来自合成 fixture，不联网供应商、
// 不调用模型、不触碰真实个人库。Chrome 不可用时显式失败并报告具体阻塞。
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer, request as httpRequest } from 'node:http';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../..', import.meta.url));
const packageDir = join(repo, 'packages/dsh-luoome');
const fixtureScript = join(packageDir, 'src/testing/panels-fixture.ts');
const dshModules = resolve(repo, 'node_modules/.bun/node_modules');
const cli = resolve(dshModules, '@deepseek-ai/dsh/lib/bin.js');
const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  process.env.CHROME_PATH,
].filter((value): value is string => typeof value === 'string' && value.length > 0);
const PROFILE = 'luoome-panels-browser';
const OWNER = Object.freeze({
  userId: 'browser-acceptance-owner',
  accountId: 'browser-acceptance-account',
});

const chromePath = (() => {
  for (const candidate of CHROME_CANDIDATES) {
    const probe = spawnSync(candidate, ['--version'], { encoding: 'utf8' });
    if (probe.status === 0) return candidate;
  }
  throw new Error(
    `本机未找到可用的 Google Chrome；尝试过 ${CHROME_CANDIDATES.join(', ')}。浏览器验收不能跳过。`,
  );
})();

const run = (command: string, args: readonly string[], cwd = repo): string => {
  const result = spawnSync(command, [...args], {
    cwd,
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: process.env.HOME },
  });
  if (result.status !== 0)
    throw new Error(`${command} ${args.join(' ')} failed:\n${result.stderr || result.stdout}`);
  return result.stdout;
};

const runJson = <T>(command: string, args: readonly string[]): T =>
  JSON.parse(run(command, args)) as T;

interface CdpResponse {
  readonly id?: number;
  readonly result?: Record<string, unknown>;
  readonly error?: { readonly message?: string };
  readonly method?: string;
  readonly params?: Record<string, unknown>;
  readonly sessionId?: string;
}

class Cdp {
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }
  >();
  private readonly listeners: ((message: CdpResponse) => void)[] = [];

  private readonly socket: WebSocket;

  private constructor(socket: WebSocket) {
    this.socket = socket;
  }

  static async connect(url: string): Promise<Cdp> {
    const socket = new WebSocket(url);
    await new Promise<void>((resolveOpen, rejectOpen) => {
      const timer = setTimeout(
        () => rejectOpen(new Error(`CDP websocket 连接超时: ${url}`)),
        10_000,
      );
      socket.addEventListener('open', () => {
        clearTimeout(timer);
        resolveOpen();
      });
      socket.addEventListener('error', () => {
        clearTimeout(timer);
        rejectOpen(new Error(`CDP websocket 连接失败: ${url}`));
      });
    });
    const client = new Cdp(socket);
    socket.addEventListener('message', (event) => {
      const parsed = JSON.parse(String(event.data)) as CdpResponse;
      if (parsed.id !== undefined) {
        const entry = client.pending.get(parsed.id);
        if (entry !== undefined) {
          client.pending.delete(parsed.id);
          if (parsed.error !== undefined)
            entry.reject(new Error(`CDP ${String(parsed.id)}: ${parsed.error.message ?? 'error'}`));
          else entry.resolve(parsed.result ?? {});
        }
        return;
      }
      for (const listener of client.listeners) listener(parsed);
    });
    socket.addEventListener('close', () => {
      for (const entry of client.pending.values()) entry.reject(new Error('CDP websocket closed'));
      client.pending.clear();
    });
    return client;
  }

  send(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
  ): Promise<Record<string, unknown>> {
    const id = this.nextId;
    this.nextId += 1;
    const promise = new Promise<Record<string, unknown>>((resolveSend, rejectSend) => {
      this.pending.set(id, { resolve: resolveSend, reject: rejectSend });
    });
    this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return promise;
  }

  waitEvent(method: string, sessionId?: string, timeoutMs = 20_000): Promise<CdpResponse> {
    return new Promise<CdpResponse>((resolveWait, rejectWait) => {
      const listener = (message: CdpResponse) => {
        if (message.method !== method) return;
        if (sessionId !== undefined && message.sessionId !== sessionId) return;
        clearTimeout(timer);
        this.listeners.splice(this.listeners.indexOf(listener), 1);
        resolveWait(message);
      };
      const timer = setTimeout(() => {
        this.listeners.splice(this.listeners.indexOf(listener), 1);
        rejectWait(new Error(`等待 CDP 事件超时: ${method}`));
      }, timeoutMs);
      this.listeners.push(listener);
    });
  }

  close(): void {
    try {
      this.socket.close();
    } catch {
      // 已关闭。
    }
  }
}

interface PageSession {
  readonly evaluate: <T = unknown>(expression: string) => Promise<T>;
  readonly waitFor: (expression: string, label?: string, timeoutMs?: number) => Promise<void>;
  readonly navigate: (url: string) => Promise<void>;
  readonly screenshot: (path: string, fullPage?: boolean) => Promise<void>;
  readonly setViewport: (width: number, height: number, mobile: boolean) => Promise<void>;
  readonly insertText: (text: string) => Promise<void>;
  readonly pressKey: (key: string) => Promise<void>;
}

const connectPage = async (browserWebSocketUrl: string): Promise<PageSession> => {
  const cdp = await Cdp.connect(browserWebSocketUrl);
  const created = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const targetId = created.targetId;
  if (typeof targetId !== 'string') throw new Error('CDP 无法创建浏览器 target');
  const attached = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  const sessionId = attached.sessionId;
  if (typeof sessionId !== 'string') throw new Error('CDP 无法附加 target session');
  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Runtime.enable', {}, sessionId);
  await cdp.send(
    'Page.addScriptToEvaluateOnNewDocument',
    {
      source: `window.__luoomeErrors = [];
      window.__luoomeResearchReads = [];
      const originalFetch = window.fetch;
      window.fetch = function(input, init) {
        const url = new URL(typeof input === 'string' ? input : input.url, location.href);
        let tool = null;
        try { tool = init?.body ? JSON.parse(init.body).tool : null; } catch {}
        if (url.pathname.endsWith('/api/luoome/research') ||
            (url.pathname.endsWith('/api/luoome/call') && ['get_strategy', 'get_strategy_dsl_catalog'].includes(tool)))
          window.__luoomeResearchReads.push({ path: url.pathname, view: url.searchParams.get('view'), tool });
        return originalFetch.apply(this, arguments);
      };
      const reportConsoleError = console.error;
      console.error = (...args) => { window.__luoomeErrors.push(args.map(String).join(' ')); reportConsoleError(...args); };
      window.addEventListener('error', (event) => window.__luoomeErrors.push('window.error: ' + String(event.message)));
      window.addEventListener('unhandledrejection', (event) => window.__luoomeErrors.push('unhandledrejection: ' + String(event.reason)));`,
    },
    sessionId,
  );

  const evaluate = async <T>(expression: string): Promise<T> => {
    const result = await cdp.send(
      'Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise: true, userGesture: true },
      sessionId,
    );
    if (result.exceptionDetails !== undefined) {
      const details = result.exceptionDetails as {
        text?: string;
        exception?: { description?: string };
      };
      throw new Error(
        `页面执行失败: ${details.exception?.description ?? details.text ?? 'unknown'}`,
      );
    }
    return (result.result as { value?: T } | undefined)?.value as T;
  };
  const waitFor = async (expression: string, label = '页面状态', timeoutMs = 25_000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if ((await evaluate<boolean>(`Boolean(${expression})`)) === true) return;
      await new Promise((done) => setTimeout(done, 100));
    }
    const text = await evaluate<string>('document.body?.innerText?.slice(0, 800) ?? ""');
    throw new Error(`等待「${label}」超时。页面文本片段: ${text}`);
  };
  const navigate = async (url: string) => {
    const loaded = cdp.waitEvent('Page.loadEventFired', sessionId);
    await cdp.send('Page.navigate', { url }, sessionId);
    await loaded;
  };
  const screenshot = async (path: string, fullPage = false) => {
    await waitFor(
      `document.querySelector('.luo-root .luo-btn.is-loading') === null`,
      '面板读取完成',
    );
    await evaluate(
      `document.querySelectorAll('.luo-section').forEach((element) => element.getAnimations().forEach((animation) => animation.finish()))`,
    );
    const params: Record<string, unknown> = { format: 'png', captureBeyondViewport: fullPage };
    if (fullPage) {
      const metrics = await cdp.send('Page.getLayoutMetrics', {}, sessionId);
      const content = metrics.cssContentSize as { width?: number; height?: number } | undefined;
      if (content?.width !== undefined && content.height !== undefined)
        params.clip = { x: 0, y: 0, width: content.width, height: content.height, scale: 1 };
    }
    const captured = await cdp.send('Page.captureScreenshot', params, sessionId);
    const data = captured.data;
    if (typeof data !== 'string') throw new Error('截图失败');
    await writeFile(path, Buffer.from(data, 'base64'));
  };
  const setViewport = async (width: number, height: number, mobile: boolean) => {
    await cdp.send(
      'Emulation.setDeviceMetricsOverride',
      { width, height, deviceScaleFactor: 1, mobile },
      sessionId,
    );
  };
  const insertText = async (text: string) => {
    await cdp.send('Input.insertText', { text }, sessionId);
  };
  const pressKey = async (key: string) => {
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code: key }, sessionId);
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key }, sessionId);
  };
  return { evaluate, waitFor, navigate, screenshot, setViewport, insertText, pressKey };
};

const waitForChrome = async (userDataDir: string): Promise<string> => {
  const portFile = join(userDataDir, 'DevToolsActivePort');
  for (let attempt = 0; attempt < 300; attempt++) {
    try {
      const text = await readFile(portFile, 'utf8');
      const port = Number(text.split('\n')[0]);
      if (Number.isInteger(port) && port > 0) {
        const version = (await fetch(`http://127.0.0.1:${String(port)}/json/version`).then(
          (response) => response.json(),
        )) as { webSocketDebuggerUrl?: string };
        if (typeof version.webSocketDebuggerUrl === 'string') return version.webSocketDebuggerUrl;
      }
    } catch {
      // Chrome 尚未写出端口文件。
    }
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error('Chrome 未在预期时间内暴露 CDP 端口');
};

const launchDsh = (
  root: string,
  luoomeHome: string,
  workspace: string,
  port: number,
  publicBase: string,
) => {
  const child = spawn(
    process.execPath,
    [
      cli,
      '--profile',
      PROFILE,
      '--no-open',
      '--port',
      String(port),
      '--host',
      '127.0.0.1',
      '--public-url',
      publicBase,
      '--trusted-host',
      new URL(publicBase).host,
    ],
    {
      cwd: workspace,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        DSH_HOME: root,
        DSH_AGENTS_HOME: join(root, 'agents'),
        LUOOME_HOME: luoomeHome,
        LUOOME_OWNER_USER_ID: OWNER.userId,
        LUOOME_OWNER_ACCOUNT_ID: OWNER.accountId,
        LUOOME_MARKET_PROVIDER: 'real',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let output = '';
  child.stdout.on('data', (chunk) => {
    output += chunk;
  });
  child.stderr.on('data', (chunk) => {
    output += chunk;
  });
  return { child, output: () => output };
};

const waitForReady = async (fixture: { child: ReturnType<typeof spawn>; output: () => string }) => {
  for (let attempt = 0; attempt < 1500; attempt++) {
    const match = /dsh web: (\S+)/.exec(fixture.output());
    if (match?.[1] !== undefined) return match[1];
    if (fixture.child.exitCode !== null) throw new Error(`DSH web 提前退出:\n${fixture.output()}`);
    await new Promise((done) => setTimeout(done, 20));
  }
  throw new Error(`DSH web 未就绪:\n${fixture.output()}`);
};

const login = async (startup: string): Promise<{ origin: string; cookie: string }> => {
  const response = await fetch(startup, { redirect: 'manual' });
  if (response.status !== 303)
    throw new Error(`DSH 登录应返回 303，实际 ${String(response.status)}`);
  const cookie = response.headers.get('set-cookie')?.split(';')[0];
  if (cookie === undefined) throw new Error('DSH 登录未签发 signed cookie');
  return { origin: new URL('./', startup).href.replace(/\/$/, ''), cookie };
};

const fetchState = async (
  origin: string,
  cookie: string,
  panel: string,
): Promise<Record<string, unknown>> => {
  const response = await fetch(`${origin}/api/luoome/state?panel=${panel}`, {
    headers: { cookie, origin: new URL(origin).origin },
  });
  if (response.status !== 200) throw new Error(`state ${panel} 返回 ${String(response.status)}`);
  if (response.headers.get('cache-control') !== 'no-store')
    throw new Error(`state ${panel} 必须 no-store`);
  return (await response.json()) as Record<string, unknown>;
};

const toolData = (body: Record<string, unknown>, name: string): Record<string, unknown> | null => {
  const tools = Array.isArray(body.tools) ? body.tools : [];
  for (const tool of tools) {
    if (typeof tool !== 'object' || tool === null) continue;
    const entry = tool as { name?: unknown; ok?: unknown; data?: unknown };
    if (entry.name === name && entry.ok === true && typeof entry.data === 'object')
      return entry.data as Record<string, unknown>;
  }
  return null;
};

interface FixtureInfo {
  readonly stock: { readonly id: string; readonly name: string };
  readonly strategyId: string;
  readonly versionId: string;
  readonly runId: string;
  readonly adviceId: string;
  readonly decisionNote: string;
  readonly advicePremise: string;
  readonly strategyName: string;
  readonly secondStrategyId: string;
  readonly secondStrategyName: string;
  readonly research: {
    readonly strategyId: string;
    readonly strategyName: string;
    readonly baseVersionId: string;
    readonly candidateVersionId: string;
    readonly secondCandidateVersionId: string;
    readonly runId: string;
    readonly sessionId: string;
    readonly stockIds: readonly string[];
    readonly from: string;
    readonly to: string;
    readonly benchmarkStockId: string;
    readonly trialAsOf: string;
  };
}

const summary: Record<string, unknown> = {};
const root = await mkdtemp(join(tmpdir(), 'luoome-panels-browser-'));
const evidenceDir = join(root, 'evidence');
const luoomeHome = join(root, 'luoome-home');
const workspace = join(root, 'workspace');
const profileDir = join(root, 'profiles', PROFILE);
const launched: ReturnType<typeof launchDsh>[] = [];
const chromeProcesses: ReturnType<typeof spawn>[] = [];
let browser: Cdp | undefined;
let failurePage: PageSession | undefined;
let sentimentUnavailable = false;
let overviewPending = true;
let newsFailure: 'http' | 'tool' | null = null;
let sectorFailure = true;
let watchlistPagePending = false;
const releaseOverview: (() => void)[] = [];
const overviewRequests: string[] = [];
let stockQuoteFailure = false;
let stockQuotePending = false;
let stockDetailReads = 0;
let useConfiguredMarket = false;
let loseResearchConfirmation = false;
let strategyAttempt: 'failed' | 'withheld' | null = null;
const fuyaoKey = 'synthetic-browser-fuyao-key';
const fuyaoCalls: { path: string; authenticated: boolean }[] = [];
const fuyaoGateway = createServer((incoming, outgoing) => {
  const url = new URL(incoming.url ?? '/', 'http://fixture.invalid');
  fuyaoCalls.push({
    path: url.pathname,
    authenticated: incoming.headers['x-api-key'] === fuyaoKey,
  });
  outgoing.setHeader('content-type', 'application/json');
  outgoing.end(
    JSON.stringify({
      code: 0,
      data: {
        timestamp: Date.now(),
        item: (url.searchParams.get('thscodes') ?? '600519.SH').split(',').map((thscode) => ({
          thscode,
          last_price: 1632.5,
          open_price: 1600,
          high_price: 1640,
          low_price: 1590,
          prev_price: 1600,
          volume: 1800000,
        })),
      },
    }),
  );
});
const proxy = createServer();

const runAcceptance = async () => {
  await mkdir(evidenceDir, { recursive: true });
  await mkdir(workspace, { recursive: true });
  await mkdir(luoomeHome, { recursive: true });
  await mkdir(profileDir, { recursive: true });
  await new Promise<void>((done) => fuyaoGateway.listen(0, '127.0.0.1', done));
  const fuyaoAddress = fuyaoGateway.address();
  if (fuyaoAddress === null || typeof fuyaoAddress === 'string')
    throw new Error('Missing FUYAO fixture port');
  const fuyaoBaseUrl = `http://127.0.0.1:${fuyaoAddress.port}`;

  // 1) 构建并“安装”插件到临时 profile（本地目录拷贝，等价本地安装；tarball 打包验收在
  //    infra/dsh/plugin-install-acceptance.ts，避免与其并发 pack/临时目录冲突）。
  run('bun', ['--no-env-file', 'run', 'build:dsh-luoome']);
  const profileModules = join(profileDir, 'node_modules');
  await mkdir(profileModules, { recursive: true });
  for (const entry of await readdir(dshModules)) {
    if (entry.startsWith('.')) continue;
    await symlink(join(dshModules, entry), join(profileModules, entry), 'dir');
  }
  const installedDir = join(profileModules, 'dsh-luoome');
  await mkdir(installedDir, { recursive: true });
  for (const entry of ['dist', 'skills']) {
    await cp(join(packageDir, entry), join(installedDir, entry), { recursive: true });
  }
  await cp(join(packageDir, 'package.json'), join(installedDir, 'package.json'));
  await writeFile(
    join(profileDir, 'package.json'),
    `${JSON.stringify(
      {
        name: `dsh-profile-${PROFILE}`,
        private: true,
        type: 'module',
        dependencies: {},
        dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } },
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(join(profileDir, 'cordis.yml'), '[]\n');
  await writeFile(
    join(profileDir, 'cordis.patch.yml'),
    `${JSON.stringify(
      [
        { id: 'session-title-llm', disabled: true },
        { id: 'llm-deepseek', disabled: true },
        { id: 'llm-deepseek-account', disabled: true },
        { id: 'llm-pi-ai', disabled: true },
        { id: 'approval', config: { policy: 'ask' } },
        { id: 'hmr', disabled: true },
        { id: 'working-directory', config: { defaultDirectory: workspace } },
        { id: 'sandbox-policy', config: { mode: 'read-only', workspaceRoot: workspace } },
        { id: 'workspace-controller', config: { documentsDirectory: join(root, 'documents') } },
        { insert: [{ id: 'luoome-plugin', name: 'dsh-luoome' }] },
      ],
      null,
      2,
    )}\n`,
  );

  // 2) 合成事实 + 启动真实 DSH Web（官方 token 登录）。
  const fixtureInfo = runJson<FixtureInfo>('bun', [
    '--no-env-file',
    fixtureScript,
    'seed',
    luoomeHome,
    JSON.stringify(OWNER),
  ]);
  // 复现生产 Caddy 的 /dsh/ 挂载；裸 /api 不转发，防止根路径验收漏掉公网 URL 回归。
  const portProbe = createServer();
  await new Promise<void>((done) => portProbe.listen(0, '127.0.0.1', done));
  const upstreamAddress = portProbe.address();
  if (upstreamAddress === null || typeof upstreamAddress === 'string')
    throw new Error('Missing upstream port');
  const upstreamPort = upstreamAddress.port;
  await new Promise<void>((done) => portProbe.close(() => done()));
  const upstreamOptions = (incoming: import('node:http').IncomingMessage) => ({
    host: '127.0.0.1',
    port: upstreamPort,
    method: incoming.method,
    path: (incoming.url ?? '/').slice('/dsh'.length),
    headers: { ...incoming.headers, 'accept-encoding': 'identity' },
    agent: false as const,
  });
  proxy.on('request', (incoming, outgoing) => {
    if (!incoming.url?.startsWith('/dsh/')) {
      outgoing.end();
      return;
    }
    const overviewQuery = new URL(incoming.url, 'http://fixture.invalid').searchParams;
    const section = overviewQuery.get('section');
    if (incoming.url.startsWith('/dsh/api/luoome/state?panel=overview') && section) {
      overviewRequests.push(section);
      const asOf = '2026-10-25T04:00:00Z';
      const quote = (stockId: string, price: number) => ({
        stockId,
        observedAt: asOf,
        fetchedAt: asOf,
        timestampSource: 'upstream',
        ts: asOf,
        open: price,
        high: price,
        low: price,
        close: price,
        prevClose: price,
        volume: 1800000,
        amount: 123000000,
        turnoverRatePct: 2.36,
        source: 'browser-fixture',
      });
      const page = Number(overviewQuery.get('page') ?? 1);
      const fixtures: Record<string, { name: string; data: unknown }> = {
        indices: {
          name: 'fetch_index_quotes',
          data: {
            indices: ['上证指数', '深证成指', '创业板指', '科创50'].map((name, index) => ({
              code: `fixture-${index}`,
              name: sentimentUnavailable && index === 0 ? '回归验收指数' : name,
              close: index === 0 ? 3333 : 2500 + index * 100,
              change: 33,
              changePct: 1,
              ts: asOf,
              source: 'browser-fixture',
            })),
          },
        },
        sentiment: {
          name: 'get_ashare_sentiment',
          data: {
            snapshot: {
              date: '2026-10-23',
              breadth: {
                status: 'complete',
                value: { advancing: 3000, declining: 1800, unchanged: 200, total: 5000 },
              },
              limitUp: {
                status: 'complete',
                value: {
                  sealedCount: 65,
                  brokenCount: 15,
                  brokenRate: 0.1875,
                  maxLadderLevel: 5,
                  totalSealAmount: 5800000000,
                  boardDistribution: { 1: 43, 2: 15, 3: 5, 5: 2 },
                  leaders: [],
                },
              },
            },
          },
        },
        sectors: {
          name: 'fetch_sector_quotes',
          data: {
            items: ['半导体', '贵金属', '软件开发', '电力设备', '通信设备'].map((name, index) => ({
              code: `BK${index}`,
              name,
              changePct: 0.05 - index * 0.008,
              amount: 20000000000,
              leadingStockName: '合成领涨股',
            })),
            source: 'browser-fixture',
            asOf,
            warnings: [],
          },
        },
        news: {
          name: 'fetch_news',
          data: {
            items: [
              {
                id: 'n1',
                title: '验收要闻：市场成交活跃',
                source: '合成新闻源',
                publishedAt: asOf,
                url: 'https://example.com/news',
                summary: '仅用于界面验收的合成内容。',
              },
              {
                id: 'n2',
                title: '无效协议仅显示文本',
                source: '合成新闻源',
                publishedAt: asOf,
                url: 'javascript:alert(1)',
              },
            ],
            asOf,
            warnings: [],
          },
        },
        watchlist: {
          name: 'batch_quote',
          data: {
            items:
              page === 1
                ? Array.from({ length: 40 }, (_, index) => ({
                    stockId: index === 0 ? fixtureInfo.stock.id : `${600000 + index}.SH`,
                    stockName: index === 0 ? fixtureInfo.stock.name : `合成标的 ${index}`,
                    status: 'ok',
                    quote: quote(
                      index === 0 ? fixtureInfo.stock.id : `${600000 + index}.SH`,
                      index === 0 ? 1520 : 12 + index,
                    ),
                    change: 1,
                    changePct: 0.05 - index * 0.001,
                    retrieval: 'live',
                    freshness: 'fresh',
                  }))
                : [
                    {
                      stockId: '600888.SH',
                      stockName: '第二页合成标的',
                      status: 'ok',
                      quote: quote('600888.SH', 8),
                      change: null,
                      changePct: null,
                      retrieval: 'live',
                      freshness: 'fresh',
                    },
                  ],
            quotes: [],
            unresolved: [],
          },
        },
      };
      const fixture = fixtures[section];
      if (fixture) {
        const failed =
          (section === 'news' && newsFailure !== null) ||
          (section === 'sectors' && sectorFailure) ||
          (section === 'sentiment' && sentimentUnavailable);
        const body = {
          panel: 'overview',
          section,
          asOf,
          session: {
            marketSession: 'non-trading-day',
            nextSessionStart: new Date(Date.now() + 3_600_000).toISOString(),
          },
          tools: [
            failed
              ? {
                  name: fixture.name,
                  ok: false,
                  error: {
                    kind: 'adapter_error',
                    cause: 'synthetic section failure',
                    recoverable: true,
                  },
                }
              : { ...fixture, ok: true },
          ],
          ...(section === 'watchlist'
            ? { watchlistPage: { page, pageSize: 40, total: 41, incomplete: false } }
            : {}),
        };
        const send = () => {
          if (outgoing.destroyed) return;
          outgoing.writeHead(section === 'news' && newsFailure === 'http' ? 503 : 200, {
            'content-type': 'application/json',
            'cache-control': 'no-store',
          });
          outgoing.end(JSON.stringify(body));
        };
        if (
          (overviewPending && (section === 'news' || section === 'sentiment')) ||
          (watchlistPagePending && section === 'watchlist' && page === 2)
        )
          releaseOverview.push(send);
        else send();
        return;
      }
    }
    if (incoming.url.startsWith('/dsh/api/luoome/stock?') && !useConfiguredMarket) {
      stockDetailReads++;
      const stockId = new URL(incoming.url, 'http://fixture.invalid').searchParams.get('stockId');
      const quote = {
        stockId,
        observedAt: '2026-10-23T07:00:00Z',
        fetchedAt: '2026-10-25T04:00:00Z',
        timestampSource: 'upstream',
        ts: '2026-10-23T07:00:00Z',
        open: 1500,
        high: 1560,
        low: 1490,
        close: 1520,
        prevClose: 1500,
        volume: 1800000,
        source: 'browser-acceptance-fixture',
      };
      const body = {
        stockId,
        asOf: '2026-10-25T04:00:00Z',
        quote: stockQuoteFailure
          ? { name: 'fetch_quote', ok: false, error: { kind: 'adapter_error', recoverable: true } }
          : {
              name: 'fetch_quote',
              ok: true,
              data: { quote, retrieval: 'local-fallback', freshness: 'stale' },
            },
      };
      const send = () => {
        if (outgoing.destroyed) return;
        outgoing.writeHead(200, {
          'content-type': 'application/json',
          'cache-control': 'no-store',
        });
        outgoing.end(JSON.stringify(body));
      };
      if (stockQuotePending) setTimeout(send, 400);
      else send();
      return;
    }
    const forwarded = httpRequest(upstreamOptions(incoming), (response) => {
      if (
        loseResearchConfirmation &&
        /\/api\/luoome\/operations\/prepare$/.test(incoming.url ?? '') &&
        response.statusCode === 200
      ) {
        loseResearchConfirmation = false;
        response.resume();
        response.on('end', () => {
          outgoing.writeHead(200, {
            'content-type': 'application/json',
            'cache-control': 'no-store',
          });
          outgoing.end('{');
        });
        return;
      }
      const alterOverview =
        sentimentUnavailable && incoming.url?.includes('/api/luoome/state?panel=overview');
      const alterStrategy =
        strategyAttempt !== null && incoming.url?.includes('/api/luoome/state?panel=strategies');
      if ((!alterOverview && !alterStrategy) || response.statusCode !== 200) {
        outgoing.writeHead(response.statusCode ?? 502, response.headers);
        response.pipe(outgoing);
        outgoing.on('close', () => response.destroy());
        return;
      }
      const chunks: Buffer[] = [];
      response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      response.on('end', () => {
        let body = Buffer.concat(chunks);
        if (
          sentimentUnavailable &&
          incoming.url?.includes('/api/luoome/state?panel=overview') &&
          response.statusCode === 200
        ) {
          const state = JSON.parse(body.toString());
          state.tools = state.tools.map((tool: { name: string }) =>
            tool.name === 'get_ashare_sentiment'
              ? {
                  name: tool.name,
                  ok: false,
                  error: {
                    kind: 'adapter_error',
                    cause: 'synthetic sentiment timeout',
                    recoverable: true,
                  },
                }
              : tool.name === 'fetch_index_quotes'
                ? {
                    name: tool.name,
                    ok: true,
                    data: {
                      indices: [
                        {
                          code: 'fixture-index',
                          name: '回归验收指数',
                          close: 3333,
                          change: 33,
                          changePct: 0.01,
                          ts: '2026-10-23T07:00:00Z',
                          source: 'browser-fixture',
                        },
                      ],
                    },
                  }
                : tool,
          );
          body = Buffer.from(JSON.stringify(state));
        }
        if (alterStrategy) {
          const state = JSON.parse(body.toString());
          const entry = state.strategies.find(
            (item: { strategyId: string }) => item.strategyId === fixtureInfo.strategyId,
          );
          if (!entry?.workspace?.data?.currentRun) throw new Error('合成故障缺少真实已发布结果');
          const workspace = entry.workspace.data;
          workspace.latestAttempt = {
            ...workspace.currentRun,
            id: `browser-latest-${strategyAttempt}`,
            status: strategyAttempt === 'failed' ? 'failed' : 'complete',
            startedAt: new Date(Date.parse(workspace.currentRun.startedAt) + 60_000).toISOString(),
            finishedAt: new Date(
              Date.parse(workspace.currentRun.startedAt) + 120_000,
            ).toISOString(),
            publication: {
              ...workspace.currentRun.publication,
              status: 'withheld',
              reasons: ['隔离验收：最近尝试未发布'],
            },
          };
          workspace.overview.health = strategyAttempt;
          workspace.warnings = ['隔离验收：最近尝试未发布，继续展示原已发布结果'];
          body = Buffer.from(JSON.stringify(state));
        }
        const headers = { ...response.headers };
        delete headers['content-length'];
        delete headers['transfer-encoding'];
        outgoing.writeHead(response.statusCode ?? 502, headers);
        outgoing.end(body);
      });
    });
    forwarded.on('error', () => {
      outgoing.writeHead(502);
      outgoing.end();
    });
    incoming.pipe(forwarded);
  });
  proxy.on('upgrade', (incoming, socket, head) => {
    if (!incoming.url?.startsWith('/dsh/')) {
      socket.destroy();
      return;
    }
    const target = connect(upstreamPort, '127.0.0.1', () => {
      const headers = [];
      for (let index = 0; index < incoming.rawHeaders.length; index += 2)
        headers.push(`${incoming.rawHeaders[index]}: ${incoming.rawHeaders[index + 1]}`);
      target.write(
        `${incoming.method} ${upstreamOptions(incoming).path} HTTP/1.1\r\n${headers.join('\r\n')}\r\n\r\n`,
      );
      if (head.length) target.write(head);
      socket.pipe(target).pipe(socket);
    });
    target.on('error', () => socket.destroy());
    socket.on('error', () => target.destroy());
  });
  await new Promise<void>((done) => proxy.listen(0, '127.0.0.1', done));
  const proxyAddress = proxy.address();
  if (proxyAddress === null || typeof proxyAddress === 'string')
    throw new Error('Missing proxy port');
  const publicBase = `http://127.0.0.1:${proxyAddress.port}/dsh/`;
  const fixture = launchDsh(root, luoomeHome, workspace, upstreamPort, publicBase);
  launched.push(fixture);
  const startup = await waitForReady(fixture);
  const { origin, cookie } = await login(startup);

  // 3) Chrome headless + CDP。
  const chromeUserData = join(root, 'chrome');
  await mkdir(chromeUserData, { recursive: true });
  const chrome = spawn(
    chromePath,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--disable-sync',
      '--remote-debugging-port=0',
      `--user-data-dir=${chromeUserData}`,
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );
  chromeProcesses.push(chrome);
  const websocketUrl = await waitForChrome(chromeUserData);
  browser = await Cdp.connect(websocketUrl);
  await browser.send('Browser.setDownloadBehavior', {
    behavior: 'allow',
    downloadPath: evidenceDir,
  });
  const page = await connectPage(websocketUrl);
  failurePage = page;
  await page.setViewport(1320, 900, false);
  await page.navigate(startup);
  await page.evaluate<boolean>(`(() => {
    window.__luoomeErrors = [];
    const original = console.error;
    console.error = (...args) => { window.__luoomeErrors.push(args.map(String).join(' ')); original(...args); };
    window.addEventListener('error', (event) => window.__luoomeErrors.push('window.error: ' + String(event.message)));
    window.addEventListener('unhandledrejection', (event) => window.__luoomeErrors.push('unhandledrejection: ' + String(event.reason)));
    return true;
  })()`);
  await page.waitFor(
    `document.body && document.body.innerText.includes('看盘')`,
    'DSH 工作台外壳',
    30_000,
  );
  // 关闭官方预览版说明弹层，避免遮挡面板截图（只影响 UI 提示，不改变数据）。
  const dismissNotice = async () => {
    for (let attempt = 0; attempt < 30; attempt++) {
      const visible = await page.evaluate<boolean>(
        `document.body.innerText.includes('预览版说明') || document.body.innerText.includes('Preview Notice')`,
      );
      if (!visible) return;
      await page.evaluate<boolean>(`(() => {
        const dismiss = [...document.querySelectorAll('button')].find((button) => ['继续', 'Continue'].includes(button.textContent.trim()));
        if (!dismiss) return false;
        dismiss.click();
        return true;
      })()`);
      await new Promise((done) => setTimeout(done, 100));
    }
  };
  await dismissNotice();

  // 4) 侧栏三个条目 + 逐面板 DOM/API/DB 一致性。
  const sidebarLabels = await page.evaluate<string[]>(
    `[...document.querySelectorAll('button')].map((button) => button.textContent.trim()).filter((label) => ['看盘','持仓','关注','策略','复盘','投资设置'].includes(label))`,
  );
  if (sidebarLabels.length !== 5 || sidebarLabels.includes('投资设置'))
    throw new Error(
      `侧栏条目应为 5 个，投资设置应位于 DSH 设置内，实际 ${JSON.stringify(sidebarLabels)}`,
    );

  const clickButton = async (label: string) => {
    const labels = [label, ...({ 账号菜单: ['Account menu'], 设置: ['Settings'] }[label] ?? [])];
    const clicked = await page.evaluate<boolean>(
      `(() => {
        const buttons = [...document.querySelectorAll('button,[role="button"],[role="menuitem"]')];
        const labels = ${JSON.stringify(labels)};
        const target = buttons.find((element) => labels.includes(element.textContent.trim())) ?? buttons.find((element) => labels.includes(element.getAttribute('aria-label'))) ?? buttons.find((element) => element.getAttribute('role') === 'menuitem' && labels.some(label => element.textContent.trim().startsWith(label)));
        if (!target) return false;
        target.click();
        return true;
      })()`,
    );
    if (!clicked) throw new Error(`无法点击侧栏条目 ${label}`);
  };
  const closeSettings = async () => {
    await page.evaluate(`(() => {
      const dialog = document.querySelector('[data-shortcut-modal="settings"]');
      if (!dialog) return;
      const button = [...dialog.querySelectorAll('button')].find((item) => ['关闭', '关闭设置', 'Close', 'Close settings'].includes(item.textContent.trim()));
      if (!button) throw new Error('无法关闭 DSH 设置');
      button.click();
    })()`);
    await page.waitFor(
      `document.querySelector('[data-shortcut-modal="settings"]') === null`,
      '关闭 DSH 设置',
    );
  };
  const clickPanel = async (label: string) => {
    if (label === '投资设置') {
      if (
        !(await page.evaluate(
          `document.querySelector('[data-shortcut-modal="settings"]') !== null`,
        ))
      ) {
        await clickButton('账号菜单');
        await page.waitFor(`document.querySelector('[role="menu"]') !== null`, 'DSH 更多菜单');
        await clickButton('设置');
      }
      await page.waitFor(
        `document.querySelector('[data-shortcut-modal="settings"]') !== null`,
        'DSH 原生设置',
      );
      await clickButton('投资设置');
      await page.waitFor(`document.querySelector('.luo-settings') !== null`, '投资设置分区');
    } else {
      await closeSettings();
      await clickButton(label);
    }
  };

  const strategyMode = async (mode: 'overview' | 'research') => {
    await page.evaluate(`(() => {
      const button = document.querySelector('[data-strategy-mode="${mode}"]');
      if (!button) throw new Error('Missing strategy mode: ${mode}');
      button.click();
    })()`);
    await page.waitFor(
      `document.querySelector('[data-strategy-mode="${mode}"]')?.getAttribute('aria-selected') === 'true' && document.querySelector('#strategy-view-${mode}')?.hidden === false`,
      `策略模式 ${mode}`,
    );
  };
  const expandStrategyDetails = async () => {
    await page.evaluate(`(() => {
      for (const selector of ['[data-strategy-rules]', '[data-strategy-runtime]']) {
        const detail = document.querySelector(selector);
        if (!detail) throw new Error('Missing strategy disclosure: ' + selector);
        if (!detail.open) detail.querySelector('summary').click();
      }
    })()`);
  };

  const overviewState = await fetchState(origin, cookie, 'overview');
  const strategiesState = await fetchState(origin, cookie, 'strategies');
  const reviewState = await fetchState(origin, cookie, 'review');
  const database = runJson<Record<string, unknown>>('bun', [
    '--no-env-file',
    fixtureScript,
    'dump',
    luoomeHome,
    JSON.stringify(OWNER),
  ]);

  await clickPanel('看盘');
  await page.waitFor(`document.body.innerText.includes('核心指数')`, '看盘面板');
  await page.waitFor(
    `document.body.innerText.includes(${JSON.stringify(fixtureInfo.stock.name)})`,
    '持仓',
  );
  await page.waitFor(
    `document.body.innerText.includes(${JSON.stringify(fixtureInfo.advicePremise)}) && document.querySelector('[data-overview-section="account"][aria-busy="false"]')`,
    '独立账户与建议',
  );
  if (
    !(await page.evaluate<boolean>(
      `document.querySelector('[data-overview-section="news"][aria-busy="true"]') !== null && document.querySelector('[data-overview-section="sentiment"][aria-busy="true"]') !== null && document.querySelectorAll('.luo-index').length === 4 && document.querySelectorAll('[data-market-stock]').length === 40`,
    ))
  )
    throw new Error('慢新闻/情绪必须保持读取中，同时已渲染账户、指数、自选');
  await page.screenshot(join(evidenceDir, 'overview-progressive-loading.png'));
  overviewPending = false;
  for (const send of releaseOverview.splice(0)) send();
  await page.waitFor(
    `document.body.innerText.includes('验收要闻：市场成交活跃') && document.body.innerText.includes('连板分布')`,
    '慢分区独立完成',
  );
  if (
    !(await page.evaluate<boolean>(
      `document.querySelector('[data-overview-section="sectors"] .luo-err') !== null && document.querySelector('[data-overview-section="news"] a[href^="javascript:"]') === null`,
    ))
  )
    throw new Error('分区初次错误或新闻链接协议处理不正确');
  sectorFailure = false;
  await page.evaluate(`document.querySelector('[data-overview-section="sectors"] button').click()`);
  await page.waitFor(`document.body.innerText.includes('半导体')`, '行业排行独立重试');
  for (const failure of ['http', 'tool'] as const) {
    newsFailure = failure;
    await page.evaluate(`document.querySelector('[data-overview-section="news"] button').click()`);
    await page.waitFor(
      `document.querySelector('[data-overview-section="news"] .luo-region-error')?.textContent.includes('刷新失败')`,
      `${failure} 失败保留旧新闻`,
    );
    if (
      !(await page.evaluate<boolean>(
        `document.querySelector('[data-overview-section="news"]').textContent.includes('验收要闻：市场成交活跃')`,
      ))
    )
      throw new Error('新闻刷新失败不得清空成功内容');
    newsFailure = null;
    await page.evaluate(`document.querySelector('[data-overview-section="news"] button').click()`);
    await page.waitFor(
      `!document.querySelector('[data-overview-section="news"] .luo-region-error') && document.querySelector('[data-overview-section="news"][aria-busy="false"]')`,
      '新闻独立恢复',
    );
  }
  await page.evaluate(`document.querySelector('.luo-sort').click()`);
  await page.waitFor(
    `document.querySelector('[data-market-stock]')?.getAttribute('data-market-stock') === '600039.SH'`,
    '当前页涨跌幅排序',
  );
  await page.evaluate(`document.querySelector('.luo-sort').click()`);
  watchlistPagePending = true;
  await page.evaluate(
    `([...document.querySelectorAll('.luo-pagination button')].find(button => button.textContent === '下一页')).click()`,
  );
  await page.waitFor(
    `document.querySelector('[data-overview-section="watchlist"][aria-busy="true"]') && document.querySelectorAll('[data-market-stock]').length === 0`,
    '翻页清空上页数据',
  );
  watchlistPagePending = false;
  for (const send of releaseOverview.splice(0)) send();
  await page.waitFor(
    `document.querySelector('[data-market-stock="600888.SH"]') !== null`,
    '第二页独立渲染',
  );
  await page.evaluate(
    `([...document.querySelectorAll('.luo-pagination button')].find(button => button.textContent === '上一页')).click()`,
  );
  await page.waitFor(
    `document.querySelectorAll('[data-market-stock]').length === 40`,
    '返回第一页',
  );
  await page.evaluate(`document.querySelector('[data-market-stock] .luo-stock-link').click()`);
  await page.waitFor(
    `document.querySelector('dialog[open]')?.textContent.includes('自选行情')`,
    '看盘个股详情',
  );
  await page.evaluate(`document.querySelector('[aria-label="关闭个股详情"]').click()`);
  await page.evaluate(
    `([...document.querySelectorAll('.luo-market-tabs button')].find(button => button.textContent === '持仓')).click()`,
  );
  await page.waitFor(
    `document.querySelectorAll('[data-market-stock]').length === 1 && document.querySelector('[data-overview-section="holdings"]').textContent.includes('浮动盈亏')`,
    '独立持仓数据与标签切换',
  );
  await page.evaluate(
    `([...document.querySelectorAll('.luo-market-tabs button')].find(button => button.textContent === '自选')).click()`,
  );
  for (const section of [
    'indices',
    'sentiment',
    'account',
    'holdings',
    'watchlists',
    'watchlist',
    'triggers',
    'advice',
    'sectors',
    'news',
  ]) {
    if (!overviewRequests.includes(section)) throw new Error(`缺少独立分区请求 ${section}`);
  }
  const overviewText = await page.evaluate<string>('document.body.innerText');
  for (const expected of [
    fixtureInfo.stock.name,
    fixtureInfo.advicePremise,
    '持仓市值',
    '建议不等于交易',
  ])
    if (!overviewText.includes(expected)) throw new Error(`看盘 DOM 缺少「${expected}」`);
  const overviewAccounts = toolData(overviewState, 'list_accounts');
  const overviewHoldings = toolData(overviewState, 'list_holdings');
  const dbHoldings = database.holdings as { stockId: string; quantity: number }[];
  const dbAccount = database.account as {
    id: string;
    cashBalance: number;
    initialCapital: number;
  } | null;
  if (
    Number(overviewAccounts?.total) !== 1 ||
    dbAccount?.id !== OWNER.accountId ||
    (overviewHoldings?.holdings as unknown[] | undefined)?.length !== 1 ||
    dbHoldings[0]?.stockId !== fixtureInfo.stock.id
  )
    throw new Error(
      `看盘 state 与 DB 不一致: ${JSON.stringify({ accounts: overviewAccounts, holdings: overviewHoldings, dbHoldings })}`,
    );
  await dismissNotice();
  await page.screenshot(join(evidenceDir, 'overview-desktop.png'));
  sentimentUnavailable = true;
  await page.evaluate(
    `(() => { const button = [...document.querySelectorAll('.luo-root button')].find(item => item.textContent.trim() === '刷新全部'); if (!button) throw new Error('Missing refresh button'); button.click(); })()`,
  );
  await page.waitFor(
    `document.querySelector('.luo-root .luo-index')?.textContent.includes('回归验收指数')`,
    '情绪失败时仍显示独立指数结果',
  );
  if (
    !(
      await page.evaluate<string>(`document.querySelector('.luo-root .luo-index').textContent`)
    ).includes('3,333.00')
  )
    throw new Error('指数必须直接展示 fetch_index_quotes 的数值');
  await page.screenshot(join(evidenceDir, 'overview-independent-index.png'));
  sentimentUnavailable = false;

  if (process.argv.includes('--overview-only')) {
    await page.setViewport(390, 844, true);
    await page.waitFor(`document.querySelector('.luo-overview').clientWidth < 400`, '窄屏看盘');
    const overflow = await page.evaluate<number>(
      'document.documentElement.scrollWidth - window.innerWidth',
    );
    const rootOverflow = await page.evaluate<number>(
      `document.querySelector('.luo-overview').scrollWidth - document.querySelector('.luo-overview').clientWidth`,
    );
    if (overflow > 1 || rootOverflow > 1)
      throw new Error(`看盘窄屏溢出 ${overflow}/${rootOverflow}px`);
    await page.screenshot(join(evidenceDir, 'overview-mobile.png'));
    await page.evaluate(
      `document.querySelector('[data-overview-section="news"]').scrollIntoView()`,
    );
    await page.screenshot(join(evidenceDir, 'overview-mobile-news.png'));
    const errors = await page.evaluate<string[]>('window.__luoomeErrors');
    if (errors.length) throw new Error(`看盘浏览器错误：${JSON.stringify(errors)}`);
    const evidence = {
      scope: 'overview',
      independentSections: [...new Set(overviewRequests)],
      slowSectionsDoNotBlock: true,
      httpAndToolFailureRetainData: true,
      sectionRetry: true,
      pageIsolation: true,
      sortAndTabs: true,
      stockDetail: true,
      mobileOverflowPx: overflow,
      rootOverflowPx: rootOverflow,
      errors,
      screenshots: (await readdir(evidenceDir)).filter((name) => name.endsWith('.png')),
    };
    await writeFile(join(evidenceDir, 'browser-evidence.json'), JSON.stringify(evidence, null, 2));
    console.log(JSON.stringify({ root, evidenceDir, ...evidence }, null, 2));
    return;
  }

  await clickPanel('持仓');
  await page.waitFor(
    `document.body.innerText.includes('持仓与账本') && document.body.innerText.includes(${JSON.stringify(fixtureInfo.stock.name)})`,
    '持仓页事实',
  );
  const positionsState = await fetchState(origin, cookie, 'positions');
  const positionsHoldings = toolData(positionsState, 'list_holdings') as {
    holdings?: unknown[];
  } | null;
  if (positionsHoldings?.holdings?.length !== dbHoldings.length)
    throw new Error('持仓页 state 与数据库不一致');
  const positionsText = await page.evaluate<string>('document.body.innerText');
  for (const expected of ['账面现金', '最近登记的成交', '绩效快照'])
    if (!positionsText.includes(expected)) throw new Error(`持仓页缺少 ${expected}`);
  if (await page.evaluate<number>("document.querySelectorAll('.luo-root .luo-err').length"))
    throw new Error('持仓页不应误报读取失败');
  await page.screenshot(join(evidenceDir, 'positions-desktop.png'));

  await clickPanel('投资设置');
  await page.waitFor(
    `document.querySelector('input[name="account-name"]') !== null`,
    '账户设置表单',
  );
  const newAccountName = '浏览器验收：已确认改名';
  const setAccountName = () =>
    page.evaluate(`(() => {
    const input = document.querySelector('input[name="account-name"]');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, ${JSON.stringify(newAccountName)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  const clickAction = (label: string) =>
    page.evaluate(`(() => {
    const button = [...document.querySelectorAll('.luo-root button')].find((item) => item.textContent.trim() === ${JSON.stringify(label)});
    if (!button || button.disabled) throw new Error('Action unavailable');
    button.click();
  })()`);
  await setAccountName();
  await page.waitFor(
    `(() => { const button = [...document.querySelectorAll('.luo-root button')].find((item) => item.textContent.trim() === '保存修改'); return button && !button.disabled; })()`,
    '账户名称修改可保存',
  );
  await clickAction('保存修改');
  await page.waitFor(`document.body.innerText.includes('账户名称已保存')`, '直接执行的保存结果');
  const settingsState = await fetchState(origin, cookie, 'settings');
  const renamedAccount = toolData(settingsState, 'get_account') as {
    account?: { name?: string; cashBalance?: number; initialCapital?: number };
  } | null;
  if (
    renamedAccount?.account?.name !== newAccountName ||
    renamedAccount.account.cashBalance !== dbAccount?.cashBalance ||
    renamedAccount.account.initialCapital !== dbAccount?.initialCapital
  )
    throw new Error('账户改名必须只改变名称');
  const storedReference = await page.evaluate<string>(
    `sessionStorage.getItem(${JSON.stringify(`luoome-account-operation:${OWNER.accountId}`)})`,
  );
  if (!/^[a-f0-9-]{36}$/.test(storedReference)) throw new Error('浏览器恢复只应保留操作 UUID');
  if (await page.evaluate<number>("document.querySelectorAll('.luo-root .luo-err').length"))
    throw new Error('设置页不应误报读取失败');

  await page.waitFor(
    `document.querySelector('input[aria-label="FUYAO API Key"]') !== null`,
    'FUYAO 设置表单',
  );
  await page.evaluate(`(() => {
    const setInput = (label, value) => {
      const input = document.querySelector('input[aria-label="' + label + '"]');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    };
    setInput('FUYAO 服务地址', ${JSON.stringify(fuyaoBaseUrl)});
    setInput('FUYAO API Key', ${JSON.stringify(fuyaoKey)});
    for (const [index, value] of ['fuyao', '', ''].entries()) {
      const select = document.querySelector('select[aria-label="行情源优先级 ' + (index + 1) + '"]');
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(select, value);
      select.dispatchEvent(new Event('change', { bubbles: true }));
    }
  })()`);
  await clickAction('保存行情设置');
  await page.waitFor(
    `document.body.innerText.includes('行情设置已保存，立即生效')`,
    'FUYAO 保存成功',
  );
  await page.waitFor(
    `document.querySelector('input[aria-label="FUYAO API Key"]')?.value === ''`,
    'FUYAO 密钥已清空',
  );
  const marketSettingsResponse = await fetch(`${origin}/api/luoome/settings/market`, {
    headers: { cookie },
  });
  const marketSettingsText = await marketSettingsResponse.text();
  const marketSettings = JSON.parse(marketSettingsText);
  if (
    !marketSettings.ok ||
    marketSettings.data.activeOrder.join(',') !== 'fuyao' ||
    !marketSettings.data.fuyao.configured ||
    marketSettingsText.includes(fuyaoKey)
  )
    throw new Error('FUYAO 配置应保存且不回显密钥');
  useConfiguredMarket = true;
  const liveFuyaoQuote = await page.evaluate<{
    quote?: { ok?: boolean; data?: { quote?: { source?: string; close?: number } } };
  }>(
    `fetch('api/luoome/stock?stockId=600519.SH', { credentials: 'same-origin', cache: 'no-store' }).then((response) => response.json())`,
  );
  useConfiguredMarket = false;
  if (
    !liveFuyaoQuote.quote?.ok ||
    liveFuyaoQuote.quote.data?.quote?.source !== 'fuyao' ||
    liveFuyaoQuote.quote.data.quote.close !== 1632.5 ||
    !fuyaoCalls.some((call) => call.path === '/api/a-share/prices/snapshot' && call.authenticated)
  )
    throw new Error('保存后当前 DSH 进程的真实行情请求未立即使用 FUYAO 地址和密钥');
  if ((await fetch(`${origin}/api/luoome/settings/market`)).status !== 401)
    throw new Error('行情设置必须要求 DSH 登录');
  if (
    (
      await fetch(`${origin}/api/luoome/settings/market`, {
        method: 'POST',
        headers: { cookie, origin: 'https://other.test', 'content-type': 'application/json' },
        body: JSON.stringify({ sources: ['sina'], fuyao: { baseUrl: fuyaoBaseUrl } }),
      })
    ).status !== 403
  )
    throw new Error('行情设置必须拒绝跨源写入');
  await closeSettings();
  await clickPanel('投资设置');
  await page.waitFor(
    `document.querySelector('input[aria-label="FUYAO 服务地址"]')?.value === ${JSON.stringify(fuyaoBaseUrl)}`,
    '重新打开后保留 FUYAO 配置',
  );
  await page.screenshot(join(evidenceDir, 'settings-desktop.png'));

  // 看盘页新布局会读取关注成员的行情，所以这里的基准是打开关注面板那一刻的读取数。
  const watchPanelStockReads = stockDetailReads;
  await clickPanel('关注');
  await page.waitFor(`document.querySelector('.luo-watch-choice') !== null`, '关注独立菜单');
  const fillWatchField = (label: string, value: string) =>
    page.evaluate(`(() => {
    const field = document.querySelector('.luo-watchlists [aria-label="' + ${JSON.stringify(label)} + '"]');
    if (!field) throw new Error('关注表单字段不存在');
    const prototype = field.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value').set.call(field, ${JSON.stringify(value)});
    field.dispatchEvent(new Event(field.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
  })()`);
  // 个人版按明确意图直接执行：面板提交后回执直接是「已完成」，不再有等待确认的状态。
  const waitWatchDone = async () => {
    await page.waitFor(
      `document.querySelector('.luo-watch-confirm .luo-card-meta')?.textContent === '已完成'`,
      '关注操作回执完成',
    );
  };
  await clickAction('新建列表');
  await fillWatchField('列表名称', '浏览器手动关注');
  await fillWatchField('关注说明', '用于验证手动与 AI 管理');
  await clickAction('保存修改');
  await waitWatchDone();
  await page.screenshot(join(evidenceDir, 'watchlists-created-desktop.png'));
  await page.waitFor(
    `document.querySelector('.luo-watch-content .luo-card-t')?.textContent === '浏览器手动关注'`,
    '选中新建关注列表',
  );
  const watchCatalog = toolData(
    await fetchState(origin, cookie, 'watchlists'),
    'list_watchlists',
  ) as { items: { watchlist: { id: string; name: string } }[] };
  const createdWatchlist = watchCatalog.items.find(
    (item) => item.watchlist.name === '浏览器手动关注',
  )?.watchlist;
  if (!createdWatchlist) throw new Error('关注创建后未持久化');
  const readWatchMembers = () =>
    page.evaluate<{
      members: {
        stockName?: string;
        member: { stockId: string; stage: string; priority: string };
        sources: { kind: string; reason: string }[];
      }[];
    }>(`(async () => {
    const response = await fetch('api/luoome/call', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tool: 'get_watchlist', input: { watchlistId: ${JSON.stringify(createdWatchlist.id)} } }) });
    const result = await response.json(); if (!result.ok) throw new Error('无法读取关注成员'); return result.data;
  })()`);
  const prepareWatchMember = async () => {
    await clickAction('添加股票');
    await fillWatchField('股票代码', fixtureInfo.stock.id);
    await fillWatchField('关注理由', '验证持续研究理由');
    await clickAction('保存修改');
    await waitWatchDone();
  };
  await prepareWatchMember();
  await page.waitFor(
    `document.querySelector('.luo-watch-member')?.innerText.includes(${JSON.stringify(fixtureInfo.stock.name)})`,
    '成员股票名称和代码',
  );
  await clickAction('调整阶段与优先级');
  await fillWatchField('研究阶段', 'researching');
  await fillWatchField('优先级', 'important');
  await clickAction('保存修改');
  await waitWatchDone();
  const watchMembers = await readWatchMembers();
  if (
    watchMembers.members.length !== 1 ||
    watchMembers.members[0]?.member.priority !== 'important' ||
    watchMembers.members[0]?.member.stage !== 'researching'
  )
    throw new Error('关注成员修改未生效');
  await page.waitFor(
    `document.querySelector('.luo-watch-member')?.innerText.includes('研究中')`,
    '关注阶段刷新',
  );
  await clickAction('关闭回执');
  await page.screenshot(join(evidenceDir, 'watchlists-desktop.png'));
  if (stockDetailReads !== watchPanelStockReads) throw new Error('关注列表不应预取个股行情');
  await page.evaluate(`document.querySelector('.luo-watch-member .luo-stock-link').click()`);
  await page.waitFor(
    `document.querySelector('dialog[open]')?.innerText.includes('关注来源') && document.querySelector('dialog[open] .luo-stock-price') !== null`,
    '关注股票行情详情',
  );
  if (stockDetailReads !== watchPanelStockReads + 1)
    throw new Error('关注详情应只读取当前股票行情');
  await page.evaluate(`document.querySelector('dialog[open] [aria-label="关闭个股详情"]').click()`);
  await clickAction('移除手动关注');
  await waitWatchDone();
  await page.waitFor(`document.querySelectorAll('.luo-watch-member').length === 0`, '移除手动成员');
  if ((await readWatchMembers()).members.length !== 0) throw new Error('移除未持久化');
  await prepareWatchMember();
  await page.waitFor(`document.querySelector('.luo-watch-member') !== null`, '恢复关注成员');
  await clickAction('交给 AI 管理');
  await page.waitFor(
    `window.__luoomeLastWatchlistOperationRequest?.watchlistId === ${JSON.stringify(createdWatchlist.id)} && document.querySelector('[data-slot="conversation.composer"] [contenteditable="true"]')?.innerText.includes('浏览器手动关注')`,
    'AI 管理携带列表写入可编辑草稿',
  );
  await page.waitFor(
    `window.__luoomeLastWatchlistOperationRequest?.createdSession !== undefined || window.__luoomeLastWatchlistOperationRequest?.errorCode`,
    '关注 AI 草稿写入终态',
  );
  if (
    await page.evaluate<boolean>('Boolean(window.__luoomeLastWatchlistOperationRequest?.errorCode)')
  )
    throw new Error('关注 AI 草稿未能完成写入，后续导航不应继续');
  if ((await readWatchMembers()).members.length !== 1) throw new Error('打开 AI 管理不应自动写入');
  await page.screenshot(join(evidenceDir, 'watchlists-ai-draft.png'));

  await clickPanel('复盘');
  await page.waitFor(`document.body.innerText.includes('信心校准')`, '复盘面板');
  await page.waitFor(
    `document.body.innerText.includes(${JSON.stringify(fixtureInfo.decisionNote)})`,
    '复盘数据',
  );
  const reviewText = await page.evaluate<string>('document.body.innerText');
  for (const expected of ['信心校准', '逐条建议与用户反馈', fixtureInfo.decisionNote, '已跟随'])
    if (!reviewText.includes(expected))
      throw new Error(`复盘 DOM 缺少「${expected}」。DOM 片段: ${reviewText.slice(-1500)}`);
  const reviewStats = toolData(reviewState, 'get_advice_stats') as { totalAdvices?: number } | null;
  const calibration = toolData(reviewState, 'get_confidence_calibration') as {
    totalAdvices?: number;
  } | null;
  const reviewList = toolData(reviewState, 'list_decision_reviews') as {
    records?: unknown[];
  } | null;
  const dbAdvices = database.advices as { id: string }[];
  const dbReviews = database.reviews as { changeNote: string | null }[];
  if (
    reviewStats?.totalAdvices !== dbAdvices.length ||
    calibration?.totalAdvices !== dbAdvices.length ||
    (reviewList?.records?.length ?? 0) !== dbReviews.length ||
    dbReviews[0]?.changeNote !== fixtureInfo.decisionNote
  )
    throw new Error('复盘 state 与 DB 不一致');
  await dismissNotice();
  await page.evaluate<boolean>(`(() => {
    const target = [...document.querySelectorAll('section')].find((section) => section.textContent.includes('逐条建议与用户反馈'));
    target?.scrollIntoView({ block: 'start' });
    return target !== undefined;
  })()`);
  await new Promise((done) => setTimeout(done, 250));
  await page.screenshot(join(evidenceDir, 'review-desktop.png'));

  // 关注面板读过一只个股行情，策略面板的基准取打开策略面板那一刻的读取数。
  const strategyPanelStockReads = stockDetailReads;
  const researchReadsBeforeStrategy = await page.evaluate<number>(
    'window.__luoomeResearchReads.length',
  );
  await clickPanel('策略');
  await page.waitFor(
    `document.body.innerText.includes(${JSON.stringify(fixtureInfo.strategyName)})`,
    '策略面板',
  );
  await page.evaluate(
    `document.querySelector('[data-strategy-choice="${fixtureInfo.strategyId}"]').click()`,
  );
  await page.waitFor(
    `document.querySelector('.luo-strategy-content h2')?.textContent === ${JSON.stringify(fixtureInfo.strategyName)}`,
    '选择正式运行 fixture',
  );
  await page.waitFor(
    `document.querySelector('#strategy-view-overview')?.hidden === false && document.querySelector('.luo-strategy-matches')?.innerText.includes(${JSON.stringify(fixtureInfo.stock.name)})`,
    '默认展示正式结果',
  );
  const lazyResearchReads = await page.evaluate<number>('window.__luoomeResearchReads.length');
  if (
    lazyResearchReads !== researchReadsBeforeStrategy ||
    (await page.evaluate<boolean>('document.querySelector("[data-research-workbench]") !== null'))
  )
    throw new Error('进入研究前发送了研究专属请求或挂载了研究工作台');
  await page.screenshot(join(evidenceDir, 'strategies-overview-first-screen.png'));
  const globalCycleScope = await page.evaluate<boolean>(`(() => {
    const detail = document.querySelector('.luo-strategy-operations');
    detail.querySelector('summary').click();
    const correct = detail.innerText.includes('全部已发布策略') && [...detail.querySelectorAll('button')].some((button) => button.textContent.trim() === '运行日循环') && ![...document.querySelectorAll('.luo-strategy-content button')].some((button) => button.textContent.trim() === '运行日循环');
    detail.querySelector('summary').click();
    return correct;
  })()`);
  if (!globalCycleScope) throw new Error('日循环没有明确区分全局作用范围');
  await expandStrategyDetails();
  const strategiesText = await page.evaluate<string>('document.body.innerText');
  for (const expected of [
    fixtureInfo.strategyName,
    '当前定义',
    '结果使用的历史规则',
    '筛选条件',
    '匹配标的',
    fixtureInfo.stock.name,
    '入场信号',
    '退出条件',
    '风险条件',
    'AI 研究',
    '策略日程已开启 · 执行待核对',
    '30 16 * * 1-5',
    '已订阅 1 个关注列表',
    '管理运行',
  ])
    if (!strategiesText.includes(expected)) throw new Error(`策略面板 DOM 缺少「${expected}」`);
  for (const internal of [
    fixtureInfo.strategyId,
    fixtureInfo.versionId,
    fixtureInfo.runId,
    'positive-close',
    'entry-price',
    'exit-price',
    'risk-volume',
  ])
    if (strategiesText.includes(internal)) throw new Error('策略页泄露内部标识');
  const identityVersions = await page.evaluate<string[]>(
    `[...document.querySelectorAll('.luo-strategy-identity > div')].map((item) => item.textContent)`,
  );
  if (
    !identityVersions.some((text) => text.includes('当前定义') && text.includes('第 7 版')) ||
    !identityVersions.some((text) => text.includes('结果版本') && text.includes('第 6 版')) ||
    !strategiesText.includes('当前结果仍来自第 6 版')
  )
    throw new Error('当前条件与历史结果版本未明确区分');
  await page.evaluate(`(() => {
    [...document.querySelectorAll('summary')].find((item) => item.textContent === '查看匹配依据')?.click();
    [...document.querySelectorAll('summary')].find((item) => item.textContent === '评分方式')?.click();
  })()`);
  await page.waitFor(
    `document.body.innerText.includes('收盘价 1520 满足价格条件') && document.body.innerText.includes('权重 100%')`,
    '匹配依据与评分说明',
  );
  const evidenceText = await page.evaluate<string>(
    `document.querySelector('.luo-strategy-content').innerText`,
  );
  if (evidenceText.includes(fixtureInfo.runId) || evidenceText.includes('positive-close'))
    throw new Error('展开的匹配依据泄露内部标识');
  await page.evaluate(
    `document.querySelector('[data-strategy-choice="${fixtureInfo.secondStrategyId}"]').click()`,
  );
  await page.waitFor(
    `document.querySelector('.luo-strategy-content h2')?.textContent === ${JSON.stringify(fixtureInfo.secondStrategyName)}`,
    '切换所选策略',
  );
  await expandStrategyDetails();
  await page.waitFor(
    `document.querySelector('.luo-strategy-content h2')?.textContent === ${JSON.stringify(fixtureInfo.secondStrategyName)} && document.body.innerText.includes('尚无已发布的匹配结果') && document.body.innerText.includes('已发布，尚未启用持续运行') && document.querySelector('.luo-strategy-content').innerText.includes('暂停')`,
    '切换至尚未运行的策略',
  );
  if (
    await page.evaluate<boolean>(
      `document.querySelector('.luo-strategy-matches').innerText.includes(${JSON.stringify(fixtureInfo.stock.name)})`,
    )
  )
    throw new Error('切换策略后残留另一策略的匹配标的');
  await page.evaluate(
    `document.querySelector('[data-strategy-choice="${fixtureInfo.strategyId}"]').click()`,
  );
  await page.waitFor(
    `document.querySelector('.luo-strategy-content h2')?.textContent === ${JSON.stringify(fixtureInfo.strategyName)}`,
    '返回正式结果策略',
  );
  const originalMatchIdentity = await page.evaluate<string>(
    'document.querySelector(".luo-match-asof").textContent',
  );
  for (const attempt of ['failed', 'withheld'] as const) {
    strategyAttempt = attempt;
    await page.evaluate(
      `(() => { const button = [...document.querySelectorAll('.luo-head button')].find((item) => item.textContent.trim() === '刷新结果'); if (!button) throw new Error('Missing scoped refresh'); button.click(); })()`,
    );
    await page.waitFor(
      `document.querySelector('.luo-strategy-identity')?.innerText.includes(${JSON.stringify(attempt === 'failed' ? '最近运行失败' : '最近结果未发布')}) && [...document.querySelectorAll('.luo-strategy-alert')].some((item) => item.textContent.includes('仍显示') && item.textContent.includes('已发布结果'))`,
      `最近${attempt}与当前已发布结果并存`,
    );
    const preserved = await page.evaluate<{
      runId: string;
      identity: string;
      hasStock: boolean;
    }>(`({
      runId: document.querySelector('[data-strategy-id]').getAttribute('data-run-id'),
      identity: document.querySelector('.luo-match-asof').textContent,
      hasStock: document.querySelector('.luo-strategy-matches').innerText.includes(${JSON.stringify(fixtureInfo.stock.name)}),
    })`);
    if (
      preserved.runId !== fixtureInfo.runId ||
      preserved.identity !== originalMatchIdentity ||
      !preserved.hasStock
    )
      throw new Error(`最近 ${attempt} 错误替换了已发布结果身份`);
    await page.screenshot(join(evidenceDir, `strategies-current-with-latest-${attempt}.png`));
  }
  strategyAttempt = null;
  await page.evaluate(
    `(() => { const button = [...document.querySelectorAll('.luo-head button')].find((item) => item.textContent.trim() === '刷新结果'); button.click(); })()`,
  );
  await page.waitFor(
    `![...document.querySelectorAll('.luo-strategy-alert')].some((item) => item.textContent.includes('最近尝试'))`,
    '恢复真实合成策略状态',
  );
  const strategyList = toolData(strategiesState, 'list_strategies') as {
    strategies?: { id: string; name: string; currentVersionId?: string }[];
  } | null;
  const strategiesExtra = Array.isArray(strategiesState.strategies)
    ? (strategiesState.strategies as {
        strategyId: string;
        workspace: { ok: boolean; data?: unknown };
        schedule: {
          ok: boolean;
          data?: { schedule?: { cron: string; enabled: boolean } | null };
        };
        subscriptions: {
          ok: boolean;
          data?: { subscriptions?: { status: string }[] };
        };
      }[])
    : [];
  const strategyState = strategiesExtra.find((item) => item.strategyId === fixtureInfo.strategyId);
  const strategyWorkspace = strategyState?.workspace;
  const dbStrategies = database.strategies as { id: string; currentVersionId: string | null }[];
  const dbRuns = database.runs as { id: string; publication: string | null }[];
  const dbSchedule = database.schedule as { cron: string; enabled: boolean } | null;
  const dbSubscriptions = database.subscriptions as { status: string }[];
  if (
    strategyList?.strategies?.find((item) => item.id === fixtureInfo.strategyId)
      ?.currentVersionId !== fixtureInfo.versionId ||
    strategyWorkspace?.ok !== true ||
    dbStrategies.find((item) => item.id === fixtureInfo.strategyId)?.currentVersionId !==
      fixtureInfo.versionId ||
    dbRuns[0]?.publication !== 'published' ||
    strategyState?.schedule.ok !== true ||
    strategyState.schedule.data?.schedule?.cron !== dbSchedule?.cron ||
    strategyState.schedule.data?.schedule?.enabled !== dbSchedule?.enabled ||
    strategyState.subscriptions.ok !== true ||
    strategyState.subscriptions.data?.subscriptions?.[0]?.status !== dbSubscriptions[0]?.status
  )
    throw new Error('策略 state 与 DB 不一致');
  const drilldown = await page.evaluate<{ strategyId: string | null; runId: string | null }>(
    `(() => {
      const button = document.querySelector('[data-strategy-id]');
      return button === null ? { strategyId: null, runId: null } : { strategyId: button.getAttribute('data-strategy-id'), runId: button.getAttribute('data-run-id') };
    })()`,
  );
  if (drilldown.strategyId !== fixtureInfo.strategyId || drilldown.runId !== fixtureInfo.runId)
    throw new Error(`下钻入口未携带 strategyId/runId: ${JSON.stringify(drilldown)}`);
  await dismissNotice();
  await page.evaluate<boolean>(`(() => {
    const button = document.querySelector('[data-strategy-id]');
    button?.scrollIntoView({ block: 'center' });
    return button !== null;
  })()`);
  await new Promise((done) => setTimeout(done, 250));
  await page.screenshot(join(evidenceDir, 'strategies-desktop.png'));
  await page.evaluate(
    `document.querySelector('.luo-strategy-matches').scrollIntoView({block: 'center'})`,
  );
  await new Promise((done) => setTimeout(done, 150));
  await page.screenshot(join(evidenceDir, 'strategies-matches-desktop.png'));
  if (stockDetailReads !== strategyPanelStockReads) throw new Error('策略列表不应预取所有个股行情');
  stockQuoteFailure = true;
  await page.evaluate(
    `document.querySelector('[data-stock-id="${fixtureInfo.stock.id}"]').click()`,
  );
  await page.waitFor(
    `document.querySelector('dialog[open]')?.innerText.includes('行情暂时不可用')`,
    '个股详情失败状态',
  );
  const detailFailure = await page.evaluate<boolean>(
    `(() => { const dialog = document.querySelector('dialog[open]'); return dialog.innerText.includes('收盘价 1520 满足价格条件') && !dialog.querySelector('[data-analyze-stock]').disabled; })()`,
  );
  if (!detailFailure) throw new Error('行情失败时丢失策略依据或分析入口');
  stockQuoteFailure = false;
  await page.evaluate(`document.querySelector('dialog[open] .luo-card-h button').click()`);
  await page.waitFor(
    `document.querySelector('dialog[open]')?.innerText.includes('1,520.00')`,
    '个股行情重试',
  );
  const stockDetailText = await page.evaluate<string>(
    `document.querySelector('dialog[open]').innerText`,
  );
  for (const expected of [
    fixtureInfo.stock.name,
    fixtureInfo.stock.id,
    '本地快照',
    '数据已过时',
    '行情时间',
    '第 6 版',
    fixtureInfo.strategyName,
    '在对话中分析这只股票',
  ])
    if (!stockDetailText.includes(expected)) throw new Error(`个股详情缺少 ${expected}`);
  for (const internal of [
    fixtureInfo.strategyId,
    fixtureInfo.versionId,
    fixtureInfo.runId,
    'positive-close',
  ])
    if (stockDetailText.includes(internal)) throw new Error('个股详情暴露内部标识');
  await page.screenshot(join(evidenceDir, 'stock-detail-desktop.png'));
  await page.evaluate(
    `document.querySelector('dialog[open]').dispatchEvent(new Event('cancel', {cancelable:true}))`,
  );
  await page.waitFor(`document.querySelector('dialog[open]') === null`, '关闭个股详情');
  stockQuotePending = true;
  await page.evaluate(
    `document.querySelector('[data-stock-id="${fixtureInfo.stock.id}"]').click()`,
  );
  await page.waitFor(
    `document.querySelector('dialog[open] [role="status"]') !== null`,
    '个股详情加载中',
  );
  await page.evaluate(
    `document.querySelector('dialog[open] button[aria-label="关闭个股详情"]').click()`,
  );
  stockQuotePending = false;
  await page.evaluate(
    `document.querySelector('[data-stock-id="${fixtureInfo.stock.id}"]').click()`,
  );
  await page.waitFor(
    `document.querySelector('dialog[open]')?.innerText.includes('1,520.00')`,
    '关闭重开后的正确个股',
  );
  await page.evaluate(
    `document.querySelector('dialog[open] button[aria-label="关闭个股详情"]').click()`,
  );
  await page.waitFor(`document.querySelector('dialog[open]') === null`, '管理前关闭个股详情');
  // 在无模型调用的可编辑会话中验收管理草稿，避免前置模型失败使会话进入只读。
  await clickPanel('策略');
  await expandStrategyDetails();
  await page.waitFor(
    `document.querySelector('[data-strategy-operation]') !== null`,
    '运行管理入口',
  );
  await page.evaluate(`document.querySelector('[data-strategy-operation]').click()`);
  await page.waitFor(
    `window.__luoomeLastStrategyOperationRequest?.strategyId === ${JSON.stringify(fixtureInfo.strategyId)}`,
    '运行管理请求记录',
  );
  const operationRequest = await page.evaluate<{ strategyId: string; prompt: string }>(
    'window.__luoomeLastStrategyOperationRequest',
  );
  if (
    !operationRequest.prompt.includes('StrategySchedule') ||
    !operationRequest.prompt.includes('run_strategy_daily_cycle') ||
    !operationRequest.prompt.includes('不要直接调用 run_strategy') ||
    operationRequest.prompt.includes(fixtureInfo.strategyId)
  )
    throw new Error('运行管理草稿没有正确说明两层调度或泄露内部标识');
  await page.waitFor(
    `(() => {
      const editor = document.querySelector('[data-slot="conversation.composer"] [contenteditable="true"]');
      return editor !== null && editor.innerText.includes('请管理') && !editor.innerText.includes(${JSON.stringify(fixtureInfo.strategyId)});
    })()`,
    '运行管理只写入 composer，不自动提交',
  );
  await clickPanel('策略');
  await page.waitFor(
    `document.querySelector('[data-stock-id="${fixtureInfo.stock.id}"]') !== null`,
    '返回策略匹配标的',
  );
  await page.evaluate(
    `document.querySelector('[data-stock-id="${fixtureInfo.stock.id}"]').click()`,
  );
  await page.waitFor(`document.querySelector('dialog[open] [data-analyze-stock]') !== null`);
  await page.evaluate(`document.querySelector('dialog[open] [data-analyze-stock]').click()`);
  await page.waitFor(
    `['submitted','failed'].includes(window.__luoomeLastStockAnalysisRequest?.state)`,
    '个股分析提交真实 DSH 会话',
  );
  if (await page.evaluate<boolean>(`window.__luoomeLastStockAnalysisRequest?.state === 'failed'`)) {
    const code = await page.evaluate<string>('window.__luoomeLastStockAnalysisRequest.errorCode');
    throw new Error(`Official stock analysis submission failed: ${code}`);
  }
  const stockAnalysisRequest = await page.evaluate<{
    stockId: string;
    strategyId: string;
    runId: string;
    prompt: string;
    sessionId: string;
  }>('window.__luoomeLastStockAnalysisRequest');
  if (
    stockAnalysisRequest.stockId !== fixtureInfo.stock.id ||
    stockAnalysisRequest.strategyId !== fixtureInfo.strategyId ||
    stockAnalysisRequest.runId !== fixtureInfo.runId ||
    !stockAnalysisRequest.prompt.includes('第 6 版') ||
    stockAnalysisRequest.prompt.includes(fixtureInfo.strategyId) ||
    stockAnalysisRequest.prompt.includes(fixtureInfo.runId)
  )
    throw new Error('个股分析请求的标的或来源不正确');
  await page.waitFor(
    `document.querySelector('dialog[open]') === null && document.body.innerText.includes(${JSON.stringify(`请分析${fixtureInfo.stock.name}（${fixtureInfo.stock.id}）`)})`,
    '分析问题实际显示在会话中',
  );
  await page.screenshot(join(evidenceDir, 'stock-analysis-conversation.png'));
  await clickPanel('策略');
  await page.waitFor(`document.querySelector('[data-strategy-id]') !== null`, '返回策略页');
  await page.evaluate<boolean>(
    `(() => { const button = document.querySelector('[data-strategy-id]'); if (!button) return false; button.click(); return true; })()`,
  );
  await page.waitFor(
    `window.__luoomeLastResearchRequest && window.__luoomeLastResearchRequest.strategyId === ${JSON.stringify(fixtureInfo.strategyId)}`,
    '下钻请求记录',
  );
  const researchRequest = await page.evaluate<{
    strategyId: string;
    runId: string | null;
    prompt: string;
  }>('window.__luoomeLastResearchRequest');
  if (
    researchRequest.runId !== fixtureInfo.runId ||
    !researchRequest.prompt.includes(fixtureInfo.strategyName) ||
    researchRequest.prompt.includes(fixtureInfo.strategyId) ||
    researchRequest.prompt.includes(fixtureInfo.runId)
  )
    throw new Error(`下钻请求内容不正确: ${JSON.stringify(researchRequest)}`);
  // 官方 composer 是 contenteditable（不是 textarea）：草稿必须真的落到输入框里，
  // 否则用户仍要手工复制标识，「AI 研究」就只是名义上的入口。
  await page.waitFor(
    `(() => {
      const editor = document.querySelector('[data-slot="conversation.composer"] [contenteditable="true"]');
      return editor !== null && editor.innerText.includes(${JSON.stringify(fixtureInfo.strategyName)}) && !editor.innerText.includes(${JSON.stringify(fixtureInfo.strategyId)});
    })()`,
    '研究提示草稿写入官方 composer',
  );
  // 原始缺陷场景：前置模型调用失败后，当前会话只读；管理入口仍须给出可编辑草稿。
  await clickPanel('策略');
  await page.waitFor(`document.querySelector('[data-strategy-operation]') !== null`);
  await page.evaluate(`document.querySelector('[data-strategy-operation]').click()`);
  await page.waitFor(
    `(() => {
      const editor = document.querySelector('[data-slot="conversation.composer"] [contenteditable="true"]');
      return editor !== null && editor.innerText.includes('请管理') && !editor.innerText.includes(${JSON.stringify(fixtureInfo.strategyId)});
    })()`,
    '模型失败后的只读会话也能新建管理草稿',
  );
  // 5) 刷新后仍正确（cookie 持久、state 与 DOM 重新对齐）。
  await page.navigate(`${origin}/`);
  await page.waitFor(`document.body.innerText.includes('看盘')`, '刷新后的工作台');
  await clickPanel('看盘');
  await page.waitFor(
    `document.body.innerText.includes(${JSON.stringify(fixtureInfo.stock.name)})`,
    '刷新后持仓',
  );
  const refreshedOverview = await fetchState(origin, cookie, 'overview');
  const refreshedHoldings = toolData(refreshedOverview, 'list_holdings') as {
    holdings?: { holding?: { stockId?: string } }[];
  } | null;
  if (refreshedHoldings?.holdings?.[0]?.holding?.stockId !== fixtureInfo.stock.id)
    throw new Error('刷新后 state 事实不一致');
  const refreshedText = await page.evaluate<string>('document.body.innerText');
  if (!refreshedText.includes(fixtureInfo.stock.name) || !refreshedText.includes('核心指数'))
    throw new Error('刷新后 DOM 与事实不一致');

  // 6) 移动端基本可读：窄屏侧栏自动折叠为图标 rail（aria-label 仍可定位），
  //    通过 rail 按钮切换面板，主面板仍可见且无横向溢出。
  await page.setViewport(390, 844, true);
  await page.navigate(`${origin}/`);
  await page.waitFor(
    `document.querySelector('button[aria-label="看盘"]') !== null`,
    '移动端侧栏 rail',
  );
  await clickPanel('看盘');
  await page.waitFor(`document.body.innerText.includes('核心指数')`, '移动端看盘');
  await page.waitFor(
    `document.body.innerText.includes(${JSON.stringify(fixtureInfo.stock.name)})`,
    '移动端持仓数据',
  );
  const overflow = await page.evaluate<number>(
    'document.documentElement.scrollWidth - window.innerWidth',
  );
  if (overflow > 1) throw new Error(`移动端出现横向溢出 ${String(overflow)}px`);
  await dismissNotice();
  await page.screenshot(join(evidenceDir, 'overview-mobile.png'));
  // 移动端侧栏在 DOM 里排在主内容之后，按文案匹配会先命中看盘页的「持仓」标签页，
  // 所以移动端按 aria-label 点侧栏条目。
  const clickMobilePanel = async (label: string) => {
    const clicked = await page.evaluate<boolean>(
      `(() => {
        const target = [...document.querySelectorAll('button[aria-label]')].find((element) => element.getAttribute('aria-label') === ${JSON.stringify(label)});
        if (!target) return false;
        target.click();
        return true;
      })()`,
    );
    if (!clicked) throw new Error(`无法点击移动端侧栏条目 ${label}`);
  };
  for (const [label, title, file] of [
    ['持仓', '持仓与账本', 'positions-mobile.png'],
    ['投资设置', 'FUYAO（同花顺）', 'settings-mobile.png'],
  ]) {
    if (label === '投资设置') await clickPanel(label as string);
    else await clickMobilePanel(label as string);
    await page.waitFor(
      `document.body.innerText.includes(${JSON.stringify(title)})`,
      `${label}窄屏`,
    );
    if (label === '投资设置')
      await page.waitFor(
        `document.querySelector('input[aria-label="FUYAO 服务地址"]')?.value === ${JSON.stringify(fuyaoBaseUrl)} && document.querySelector('select[aria-label="行情源优先级 1"]')?.value === 'fuyao' && document.querySelector('input[aria-label="FUYAO API Key"]')?.value === ''`,
        '刷新后保留 FUYAO 配置且不回显密钥',
      );
    const width = await page.evaluate<number>(
      'document.documentElement.scrollWidth - window.innerWidth',
    );
    if (width > 1) throw new Error(`${label}窄屏横向溢出 ${width}px`);
    await page.screenshot(join(evidenceDir, file as string));
  }
  await clickAction('核对结果');
  await page.waitFor(
    `document.body.innerText.includes('账户名称已保存')`,
    '刷新后按操作 ID 核对结果',
  );
  await clickPanel('策略');
  await page.waitFor(
    `document.body.innerText.includes('匹配标的') && document.body.innerText.includes(${JSON.stringify(fixtureInfo.stock.name)})`,
    '移动端策略条件与标的',
  );
  const compactStrategy = await page.evaluate<{
    visible: boolean;
    height: number;
    listHidden: boolean;
    matchesTop: number;
    firstStockBottom: number;
  }>(`(() => {
    const select = document.querySelector('[data-strategy-switcher]');
    const nav = document.querySelector('.luo-strategy-nav');
    const root = document.querySelector('.luo-root');
    root.scrollTop = 0;
    const rect = select.getBoundingClientRect();
    const firstStock = document.querySelector('.luo-strategy-matches [data-stock-id]');
    if (!firstStock) throw new Error('合成fixture应有正式匹配标的');
    return {visible: rect.width > 0 && rect.height > 0, height: rect.height, listHidden: nav.getBoundingClientRect().height === 0, matchesTop: document.querySelector('.luo-strategy-matches').getBoundingClientRect().top, firstStockBottom: firstStock.getBoundingClientRect().bottom};
  })()`);
  if (
    !compactStrategy.visible ||
    compactStrategy.height > 52 ||
    !compactStrategy.listHidden ||
    compactStrategy.matchesTop >= 844 ||
    compactStrategy.firstStockBottom > 844
  )
    throw new Error(
      `手机策略选择器不紧凑或匹配结果未在首屏到达: ${JSON.stringify(compactStrategy)}`,
    );
  const strategyOverflow = await page.evaluate<number>(
    'Math.max(document.documentElement.scrollWidth - window.innerWidth, ...[...document.querySelectorAll(".luo-root, .luo-shell, .luo-strategy-content")].map((element) => element.scrollWidth - element.clientWidth))',
  );
  if (strategyOverflow > 1) throw new Error(`策略窄屏横向溢出 ${strategyOverflow}px`);
  await page.screenshot(join(evidenceDir, 'strategies-mobile.png'));
  for (const [id, name] of [
    [fixtureInfo.secondStrategyId, fixtureInfo.secondStrategyName],
    [fixtureInfo.strategyId, fixtureInfo.strategyName],
  ]) {
    await page.evaluate(`(() => {
      const select = document.querySelector('[data-strategy-switcher]');
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(select, ${JSON.stringify(id)});
      select.dispatchEvent(new Event('change', {bubbles:true}));
    })()`);
    await page.waitFor(
      `document.querySelector('.luo-strategy-content h2')?.textContent === ${JSON.stringify(name)}`,
      '手机选择器切换策略',
    );
  }
  await page.evaluate(
    `document.querySelector('.luo-strategy-matches').scrollIntoView({block: 'center'})`,
  );
  await page.evaluate(`document.querySelector('.luo-strategy-matches summary').click()`);
  const mobileEvidenceFits = await page.evaluate<boolean>(`(() => {
    const root = document.querySelector('.luo-root').getBoundingClientRect();
    const detail = document.querySelector('.luo-match-evidence').getBoundingClientRect();
    return detail.left >= root.left && detail.right <= root.right && document.body.innerText.includes('收盘价 1520 满足价格条件');
  })()`);
  if (!mobileEvidenceFits) throw new Error('移动端匹配依据未在可见宽度内展开');
  await page.screenshot(join(evidenceDir, 'strategies-matches-mobile.png'));
  await page.evaluate(
    `document.querySelector('[data-stock-id="${fixtureInfo.stock.id}"]').click()`,
  );
  await page.waitFor(
    `document.querySelector('dialog[open]')?.innerText.includes('1,520.00')`,
    '移动端个股详情',
  );
  const stockMobileFits = await page.evaluate<boolean>(
    `(() => { const dialog = document.querySelector('dialog[open]'); return dialog.scrollWidth <= dialog.clientWidth + 1 && dialog.getBoundingClientRect().right <= innerWidth && !dialog.querySelector('[data-analyze-stock]').disabled; })()`,
  );
  if (!stockMobileFits) throw new Error('移动端个股详情溢出或分析入口不可用');
  await page.screenshot(join(evidenceDir, 'stock-detail-mobile.png'));
  await page.evaluate(
    `document.querySelector('dialog[open] button[aria-label="关闭个股详情"]').click()`,
  );

  // 7) 研究闭环：真实路由、Operation 和 SQLite，不注入研究 HTTP 成功响应。
  const research = fixtureInfo.research;
  if (!research) throw new Error('研究 fixture 未安装，不能跳过研究闭环');
  type ResearchOperation = {
    operationId: string;
    state: string;
    tool: string;
    result: { ok: boolean; data?: Record<string, unknown>; error?: unknown } | null;
  };
  const researchApi = async <T>(path: string): Promise<T> => {
    const response = await fetch(`${origin}/api/luoome/${path}`, {
      headers: { cookie, origin: new URL(origin).origin },
    });
    const result = (await response.json()) as { ok: boolean; data?: T; error?: unknown };
    if (response.status !== 200 || !result.ok || result.data === undefined)
      throw new Error(`真实研究读取失败 ${path}: ${JSON.stringify(result)}`);
    return result.data;
  };
  const currentResearchOperation = async () => {
    const operationId = await page.evaluate<string>(
      `localStorage.getItem(${JSON.stringify(`luoome:research-operation:${OWNER.accountId}:${research.strategyId}`)})`,
    );
    if (!operationId) throw new Error('研究操作没有恢复身份');
    return researchApi<ResearchOperation>(`operations/${encodeURIComponent(operationId)}`);
  };
  const researchButton = async (label: string) => {
    await page.waitFor(
      `[...document.querySelectorAll('.luo-research-workbench button')].some((item) => item.textContent.trim() === ${JSON.stringify(label)} && !item.disabled)`,
      `研究控件可操作: ${label}`,
    );
    const clicked = await page.evaluate<boolean>(`(() => {
      const button = [...document.querySelectorAll('.luo-research-workbench button')].find((item) => item.textContent.trim() === ${JSON.stringify(label)});
      if (!button || button.disabled) return false;
      button.scrollIntoView({block:'center'});
      button.click(); return true;
    })()`);
    if (!clicked) throw new Error(`研究控件不可操作: ${label}`);
  };
  const researchTab = async (title: string) => {
    await page.evaluate(`(() => {
      const button = [...document.querySelectorAll('.luo-research-tabs button')].find((item) => item.textContent.endsWith(${JSON.stringify(title)}));
      if (!button) throw new Error('研究步骤不存在');
      button.click();
      document.querySelector('.luo-research-workbench').scrollIntoView({block:'start'});
    })()`);
    await page.waitFor(
      `[...document.querySelectorAll('.luo-research-tabs button')].some((item) => item.getAttribute('aria-current') === 'step' && item.textContent.endsWith(${JSON.stringify(title)}))`,
      `研究步骤 ${title}`,
    );
  };
  const researchFill = async (label: string, value: string) => {
    const nativeInput = await page.evaluate<boolean>(`(() => {
      const label = [...document.querySelectorAll('.luo-research-workbench label')].find((item) => item.firstElementChild?.textContent === ${JSON.stringify(label)});
      const input = label?.querySelector('input,textarea,select');
      if (!input || input.disabled) throw new Error('研究字段不可编辑: ' + ${JSON.stringify(label)});
      input.focus();
      if (input.tagName !== 'SELECT' && input.type !== 'date') { input.select(); return true; }
      const prototype = input.tagName === 'SELECT' ? HTMLSelectElement.prototype : input.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, 'value').set.call(input, ${JSON.stringify(value)});
      input.dispatchEvent(new Event('input', {bubbles:true}));
      input.dispatchEvent(new Event('change', {bubbles:true}));
      return false;
    })()`);
    if (nativeInput) await page.insertText(value);
  };
  const confirmResearch = async (prepareLabel: string, loseResponse = false) => {
    if (loseResponse) loseResearchConfirmation = true;
    await researchButton(prepareLabel);
    if (loseResponse) {
      await page.waitFor(
        `document.querySelector('.luo-research-operation')?.innerText.includes('结果待核对，请勿重复执行')`,
        '执行响应丢失保留 unknown',
      );
      await researchButton('查询原操作状态');
    }
    await page.waitFor(
      `(() => { const text = document.querySelector('.luo-research-operation')?.innerText ?? ''; return text.includes('操作已完成') || text.includes('操作失败'); })()`,
      `研究真实回执: ${prepareLabel}`,
      30_000,
    );
    if (
      await page.evaluate<boolean>(
        `[...document.querySelectorAll('.luo-research-operation button')].some((button) => /确认本次操作|执行本次操作/.test(button.textContent))`,
      )
    )
      throw new Error(`个人版不应再要求二次确认: ${prepareLabel}`);
    const operation = await currentResearchOperation();
    if (operation.state !== 'succeeded' || operation.result?.ok !== true)
      throw new Error(`研究操作未成功 ${prepareLabel}: ${JSON.stringify(operation)}`);
    return operation;
  };
  await page.setViewport(1320, 900, false);
  await clickPanel('策略');
  await page.evaluate(
    `document.querySelector('[data-strategy-choice="${research.strategyId}"]').click()`,
  );
  await page.waitFor(
    `document.querySelector('.luo-strategy-content h2')?.textContent === ${JSON.stringify(research.strategyName)}`,
    '选择合成研究策略',
  );
  await strategyMode('research');
  await page.waitFor(
    `document.querySelector('[data-research-workbench="${research.strategyId}"] textarea') !== null`,
    '恢复合成研究空间',
  );
  const beforeResearch = await researchApi<{
    state: {
      ok: boolean;
      data: { state: { revision: number; updatedAt: string; state: { question: string } } };
    };
  }>(`research?view=state&strategyId=${research.strategyId}`);
  if (!beforeResearch.state.ok || !beforeResearch.state.data.state.state.question)
    throw new Error('真实宿主没有恢复已保存研究');
  const researchDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' });
  if (
    researchDay.format(new Date(beforeResearch.state.data.state.updatedAt)) ===
    researchDay.format(new Date())
  )
    throw new Error('研究 fixture 必须来自前一日，以验证真实宿主跨日恢复');
  const question = '隔离浏览器验收：只提高价格门槛，保留全部缺失样本并核对后续观察。';
  const conclusion = '合成事实仅支持规则差异核对；历史样本不完整，暂不能判断收益或策略有效性。';
  await researchFill('这次只想验证什么', question);
  await page.evaluate(`document.querySelector('[data-strategy-mode="research"]').focus()`);
  for (const [key, mode] of [
    ['ArrowLeft', 'overview'],
    ['ArrowRight', 'research'],
    ['Home', 'overview'],
    ['End', 'research'],
  ]) {
    await page.pressKey(key);
    await page.waitFor(
      `document.querySelector('[data-strategy-mode="${mode}"]')?.getAttribute('aria-selected') === 'true' && document.activeElement?.getAttribute('data-strategy-mode') === '${mode}'`,
      `策略视图键盘 ${key}`,
    );
  }
  await strategyMode('overview');
  if (
    !(await page.evaluate<boolean>(
      `document.querySelector('#strategy-view-research')?.hidden === true && document.querySelector('[data-research-workbench="${research.strategyId}"] textarea')?.value === ${JSON.stringify(question)}`,
    ))
  )
    throw new Error('切换到结果总览丢失未保存研究问题');
  await strategyMode('research');
  await page.evaluate(
    `document.querySelector('[data-strategy-choice="${fixtureInfo.secondStrategyId}"]').click()`,
  );
  await page.waitFor(
    `document.querySelector('[aria-label="未保存研究"]') !== null`,
    '未保存研究离开保护',
  );
  if (!(await page.evaluate<boolean>(`document.activeElement?.textContent.trim() === '继续编辑'`)))
    throw new Error('未保存离开对话框未默认聚焦继续编辑');
  if (
    !(await page.evaluate<boolean>(
      `document.querySelector('.luo-strategy-content h2')?.textContent === ${JSON.stringify(research.strategyName)} && document.querySelector('[data-research-workbench="${research.strategyId}"] textarea')?.value === ${JSON.stringify(question)}`,
    ))
  )
    throw new Error('用户选择前已切换策略或丢失草稿');
  await page.screenshot(join(evidenceDir, 'research-unsaved-switch-protection.png'));
  await page.evaluate(
    `(() => { const dialog = document.querySelector('[aria-label="未保存研究"]'); [...dialog.querySelectorAll('button')].find((button) => button.textContent.trim() === '继续编辑').click(); })()`,
  );
  await page.waitFor(
    `document.querySelector('[aria-label="未保存研究"]') === null`,
    '继续编辑保留研究',
  );
  await clickPanel('看盘');
  await page.waitFor(
    `document.querySelector('[aria-label="未保存研究"]') !== null`,
    '离开面板前保护未保存研究',
  );
  if (
    !(await page.evaluate<boolean>(
      `document.querySelector('.luo-strategy-content h2')?.textContent === ${JSON.stringify(research.strategyName)}`,
    ))
  )
    throw new Error('未保存研究未阻止外部面板导航');
  await page.evaluate(
    `(() => { const dialog = document.querySelector('[aria-label="未保存研究"]'); [...dialog.querySelectorAll('button')].find((button) => button.textContent.trim() === '继续编辑').click(); })()`,
  );
  await page.waitFor(
    `document.querySelector('[aria-label="未保存研究"]') === null`,
    '取消外部导航继续编辑',
  );
  await page.evaluate(
    `document.querySelector('[data-strategy-choice="${fixtureInfo.secondStrategyId}"]').click()`,
  );
  await page.waitFor(`document.querySelector('[aria-label="未保存研究"]') !== null`);
  await page.evaluate(
    `(() => { const dialog = document.querySelector('[aria-label="未保存研究"]'); [...dialog.querySelectorAll('button')].find((button) => button.textContent.trim() === '放弃修改').click(); })()`,
  );
  await page.waitFor(
    `document.querySelector('.luo-strategy-content h2')?.textContent === ${JSON.stringify(fixtureInfo.secondStrategyName)}`,
    '放弃后切换策略',
  );
  await page.evaluate(
    `document.querySelector('[data-strategy-choice="${research.strategyId}"]').click()`,
  );
  await strategyMode('research');
  await page.waitFor(
    `document.querySelector('[data-research-workbench="${research.strategyId}"] textarea') !== null`,
    '重新恢复已保存研究',
  );
  if (
    await page.evaluate<boolean>(
      `document.querySelector('[data-research-workbench="${research.strategyId}"] textarea')?.value === ${JSON.stringify(question)}`,
    )
  )
    throw new Error('放弃修改后重新进入仍保留被放弃的草稿');
  await researchFill('这次只想验证什么', question);
  await page.evaluate(`(() => {
    const input = document.querySelector('.luo-condition-editor input[type="number"]');
    if (!input) throw new Error('catalog 结构化门槛编辑器不存在');
    input.focus(); input.select();
  })()`);
  await page.insertText('11.5');
  await researchFill('这次改动的理由', '隔离验收：只将候选价格门槛调整到 11.5');
  await strategyMode('overview');
  await strategyMode('research');
  if (
    !(await page.evaluate<boolean>(
      `document.querySelector('.luo-condition-editor input[type="number"]')?.value === '11.5' && document.querySelector('.luo-research-workbench')?.innerText.includes('页面修改未保存')`,
    ))
  )
    throw new Error('模式切换丢失未保存候选规则');
  const candidateOperation = await confirmResearch('保存候选');
  const newCandidate = candidateOperation.result?.data?.version as { id: string; version: number };
  if (!newCandidate?.id) throw new Error('候选没有真实持久化版本');
  await page.waitFor(
    `[...document.querySelectorAll('.luo-research-workbench select')].some((select) => select.value === ${JSON.stringify(newCandidate.id)})`,
    '新候选版本回读',
  );
  await confirmResearch('校验候选');
  await researchButton('检查数据资格');
  await page.waitFor(`document.body.innerText.includes('按规则字段检查覆盖')`, '字段覆盖预检');
  const preflight = await researchApi<{
    preflight: {
      ok: boolean;
      data: {
        fields: { availableSamples: number; totalSamples: number }[];
        layers: { strictBacktest: { status: string } };
      };
    };
  }>(
    `research?${new URLSearchParams({ view: 'preflight', strategyId: research.strategyId, versionId: newCandidate.id, from: research.from, to: research.to, stockIds: research.stockIds.join(','), benchmarkStockId: research.benchmarkStockId })}`,
  );
  if (
    !preflight.preflight.ok ||
    !preflight.preflight.data.fields.some((field) => field.availableSamples < field.totalSamples) ||
    preflight.preflight.data.layers.strictBacktest.status !== 'blocked'
  )
    throw new Error('预检未保留真实历史缺口与严格回测门禁');
  await page.screenshot(join(evidenceDir, 'research-question-desktop.png'));
  await researchTab('试跑与诊断');
  await researchFill('事实来源', 'replay');
  await researchFill('试跑交易日', research.to);
  const trialOperation = await confirmResearch('同快照试跑');
  const trial = trialOperation.result?.data as {
    inputIdentity: { snapshotHash: string };
    base: { run: { inputSnapshot: { dataCheckpoint: { checksum: string } } } };
    draft: { run: { inputSnapshot: { dataCheckpoint: { checksum: string } } } };
  };
  if (
    !trial?.inputIdentity?.snapshotHash ||
    trial.base.run.inputSnapshot.dataCheckpoint.checksum !== trial.inputIdentity.snapshotHash ||
    trial.draft.run.inputSnapshot.dataCheckpoint.checksum !== trial.inputIdentity.snapshotHash
  )
    throw new Error('基线/候选未使用同一实际输入快照');
  const trialView = await page.evaluate<string>(
    `document.querySelector('.luo-research-snapshot')?.textContent ?? ''`,
  );
  if (!trialView) throw new Error('同快照试跑没有可见结果');
  await strategyMode('overview');
  await strategyMode('research');
  if (
    (await page.evaluate<string>(
      `document.querySelector('.luo-research-snapshot')?.textContent ?? ''`,
    )) !== trialView ||
    (await currentResearchOperation()).operationId !== trialOperation.operationId
  )
    throw new Error('模式切换丢失内存试跑或切换了原操作身份');
  await page.screenshot(join(evidenceDir, 'research-trial-mode-preserved.png'));
  await page.evaluate(`(() => {
    const candidates = [...document.querySelectorAll('.luo-research-candidates input[type="checkbox"]')];
    if (candidates.length < 2) throw new Error('可比较候选不足');
    candidates[0].click(); candidates[1].click();
  })()`);
  const boundedOperation = await confirmResearch('候选对照');
  const bounded = boundedOperation.result?.data as {
    inputIdentity: { snapshotHash: string };
    candidates: { status: string; comparison?: { inputIdentity: { snapshotHash: string } } }[];
  };
  if (
    bounded.candidates.length !== 2 ||
    bounded.candidates.some(
      (candidate) =>
        candidate.comparison &&
        candidate.comparison.inputIdentity.snapshotHash !== bounded.inputIdentity.snapshotHash,
    )
  )
    throw new Error('有界比较丢失候选或未共享实际输入');
  await researchButton('把对照结果与失败带入结论草稿');
  await researchTab('试跑与诊断');
  const diagnosisChecks: { kind: string; total: number }[] = [];
  for (const kind of [
    'selected',
    'rule-near-miss',
    'ranking-near-miss',
    'excluded',
    'incomplete',
  ]) {
    const result = await researchApi<{
      diagnostics: { ok: boolean; data: { total: number } };
    }>(
      `research?${new URLSearchParams({ view: 'diagnostics', strategyId: research.strategyId, versionId: research.baseVersionId, runId: research.runId, kind, limit: '1' })}`,
    );
    if (!result.diagnostics.ok || result.diagnostics.data.total < 1)
      throw new Error(`缺少真实诊断分类: ${kind}`);
    diagnosisChecks.push({ kind, total: result.diagnostics.data.total });
  }
  await researchFill('诊断来源', 'current');
  await researchFill('分类', 'incomplete');
  await page.waitFor(
    `document.querySelector('.luo-research-workbench')?.innerText.includes('合成数据缺失样本')`,
    '缺失样本的规则解释',
  );
  await page.screenshot(join(evidenceDir, 'research-diagnostics-desktop.png'));
  await researchFill('分类', 'selected');
  await page.waitFor(
    `document.querySelector('.luo-diagnosis-list .luo-stock-link') !== null`,
    '诊断个股详情入口',
  );
  await page.evaluate(`document.querySelector('.luo-diagnosis-list .luo-stock-link').click()`);
  await page.waitFor(`document.querySelector('dialog[open]') !== null`, '研究个股详情');
  await page.evaluate(
    `(() => { const button = [...document.querySelectorAll('dialog[open] button')].find((item) => item.textContent.trim() === '读取历史日 K'); if (!button) throw new Error('历史读取入口未接线'); button.click(); })()`,
  );
  await page.waitFor(
    `document.querySelector('dialog[open] [data-stock-history]') !== null`,
    '真实历史 K 线',
  );
  const historyFacts = await page.evaluate<{ points: number; label: string }>(
    `(() => { const chart = document.querySelector('dialog[open] [data-stock-history]'); return {points:chart.querySelectorAll('g').length, label:chart.getAttribute('aria-label')}; })()`,
  );
  if (historyFacts.points < 2) throw new Error('历史图表没有实际日线事实');
  await page.evaluate(
    `document.querySelector('dialog[open] [data-stock-history]').scrollIntoView({block:'center'})`,
  );
  await page.screenshot(join(evidenceDir, 'research-stock-history-desktop.png'));
  await page.setViewport(390, 844, true);
  if (
    !(await page.evaluate<boolean>(
      `(() => { const dialog=document.querySelector('dialog[open]'); return dialog.scrollWidth <= dialog.clientWidth + 1; })()`,
    ))
  )
    throw new Error('390px 历史 K 线详情横向溢出');
  await page.evaluate(
    `document.querySelector('dialog[open] [data-stock-history]').scrollIntoView({block:'center'})`,
  );
  await page.screenshot(join(evidenceDir, 'research-stock-history-mobile.png'));
  await page.evaluate(
    `document.querySelector('dialog[open] button[aria-label="关闭个股详情"]').click()`,
  );
  await page.setViewport(1320, 900, false);
  await researchTab('分层验证');
  const evaluationOperation = await confirmResearch('历史选股评估');
  const newSession = evaluationOperation.result?.data?.session as { id: string };
  if (!newSession?.id) throw new Error('历史验证没有稳定任务身份');
  await page.waitFor(
    `document.querySelector('.luo-research-workbench')?.innerText.includes('历史选股评估')`,
    '历史评估状态可读',
  );
  let validationFacts: Record<string, unknown> = {};
  for (let attempt = 0; attempt < 120; attempt++) {
    validationFacts = await researchApi<Record<string, unknown>>(
      `research?view=validation&strategyId=${research.strategyId}&sessionId=${newSession.id}`,
    );
    if (validationFacts.worker === 'idle') break;
    await new Promise((done) => setTimeout(done, 100));
  }
  if (validationFacts.worker !== 'idle') throw new Error('有界历史任务未结束或无法查询进度');
  await page.waitFor(
    `document.querySelector('.luo-validation-progress')?.innerText.includes('执行结束') && document.querySelector('.luo-validation-progress')?.innerText.includes('当前无执行进程') && [...document.querySelectorAll('.luo-research-workbench select')].some((select) => select.value === ${JSON.stringify(newSession.id)} && select.selectedOptions[0]?.textContent.includes('已结束'))`,
    '页面同步历史评估终态',
  );
  const layerStatuses = await page.evaluate<string[]>(
    `[...document.querySelectorAll('.luo-evidence-layers > li')].map((item) => item.innerText)`,
  );
  if (!layerStatuses[0]?.includes('仅本次试跑') || !layerStatuses[1]?.includes('执行结束'))
    throw new Error('证据分层没有区分内存试跑与实际历史任务终态');
  await page.evaluate(
    `document.querySelector('.luo-validation-progress').scrollIntoView({block:'center'})`,
  );
  await page.screenshot(join(evidenceDir, 'research-validation-desktop.png'));
  await researchTab('结论与更新');
  await researchFill('当前结论', conclusion);
  await researchFill('判断', 'inconclusive');
  await researchFill(
    '限制与反证（每行一条）',
    '仅合成数据；保留历史缺失、PIT 与执行模型限制。\nT+1/T+3/T+5 是信号观察，不能称为组合回测。',
  );
  await researchFill('下一步', '补齐可审计历史后，在独立区间验证；不自动发布或交易。');
  const saveOperation = await confirmResearch('保存研究', true);
  const savedState = await researchApi<{
    state: {
      ok: boolean;
      data: {
        state: {
          revision: number;
          state: {
            question: string;
            candidateVersionId: string;
            validationSessionId: string;
            conclusion: { summary: string };
          };
          conclusions: unknown[];
          comparisons?: { candidates: unknown[] }[];
        };
      };
    };
  }>(`research?view=state&strategyId=${research.strategyId}`);
  if (
    savedState.state.data.state.revision !== beforeResearch.state.data.state.revision + 1 ||
    savedState.state.data.state.state.question !== question ||
    savedState.state.data.state.state.conclusion.summary !== conclusion ||
    savedState.state.data.state.state.validationSessionId !== newSession.id ||
    savedState.state.data.state.comparisons?.at(-1)?.candidates.length !== 2
  )
    throw new Error('响应丢失后持久研究结论或幂等修订不一致');
  await page.navigate(`${origin}/`);
  await clickPanel('策略');
  await page.waitFor(
    `document.querySelector('[data-strategy-mode="research"]') !== null`,
    '刷新后策略视图',
  );
  await strategyMode('research');
  await page.waitFor(
    `document.querySelector('[data-research-workbench="${research.strategyId}"] textarea')?.value === ${JSON.stringify(question)}`,
    '刷新后恢复研究问题和固定版本',
  );
  await researchTab('结论与更新');
  await page.waitFor(
    `document.querySelector('.luo-research-workbench')?.innerText.includes('持续观察')`,
    '持续观察真实状态',
  );
  const updatesFacts = await researchApi<{
    continuity: { status: string; notificationStatus: string };
  }>(`research?view=updates&strategyId=${research.strategyId}&versionId=${research.baseVersionId}`);
  if (
    updatesFacts.continuity.status === 'healthy' ||
    updatesFacts.continuity.notificationStatus !== 'not-verified'
  )
    throw new Error('未配置真实自动任务却声称持续观察正常或通知送达');
  await researchButton('导出定义');
  let exportedName: string | undefined;
  for (let attempt = 0; attempt < 100; attempt++) {
    exportedName = (await readdir(evidenceDir)).find(
      (name) => name.startsWith('strategy-research-v') && name.endsWith('.json'),
    );
    if (exportedName) break;
    await new Promise((done) => setTimeout(done, 100));
  }
  if (!exportedName) throw new Error('浏览器未实际下载研究 manifest');
  const exported = JSON.parse(await readFile(join(evidenceDir, exportedName), 'utf8')) as {
    canonicalJson?: string;
    manifestHash?: string;
    evidenceReferences?: string[];
    researchState?: unknown;
    reproducibility?: { marketDataIncluded: boolean };
  };
  if (
    !exported.canonicalJson ||
    createHash('sha256').update(exported.canonicalJson).digest('hex') !== exported.manifestHash ||
    !exported.evidenceReferences?.length ||
    !exported.researchState ||
    exported.reproducibility?.marketDataIncluded !== false
  )
    throw new Error('下载文件缺少研究证据、结论、定义 hash 或数据复现边界');
  await page.screenshot(join(evidenceDir, 'research-conclusion-desktop.png'));
  await page.setViewport(390, 844, true);
  for (const title of ['问题与规则', '试跑与诊断', '分层验证', '结论与更新']) {
    await researchTab(title);
    // 等两帧再量：切换步骤与 390px 视口都会触发重排，量到的是稳定后的布局。
    await page.evaluate(
      'new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done(null))))',
    );
    const overflow = await page.evaluate<{ excess: number; source: string }>(
      `(() => {
        const candidates = [...document.querySelectorAll('.luo-research-workbench, .luo-research-stage, .luo-research-operation')].map((element) => ({
          excess: element.scrollWidth - element.clientWidth,
          source: element.tagName.toLowerCase() + '.' + element.className,
        }));
        candidates.push({
          excess: document.documentElement.scrollWidth - innerWidth,
          source: 'document',
        });
        const worst = candidates.reduce((left, right) => (right.excess > left.excess ? right : left));
        const scrollers = [...document.querySelectorAll('.luo-root *')]
          .map((element) => ({
            excess: element.scrollWidth - element.clientWidth,
            source: element.tagName.toLowerCase() + '.' + element.className,
          }))
          .filter((item) => item.excess > 1)
          .sort((left, right) => right.excess - left.excess)
          .slice(0, 6)
          .map((item) => item.source + ' +' + item.excess);
        const culprit = scrollers.length > 0 ? ' | 自身溢出的元素: ' + scrollers.join(', ') : '';
        return { excess: worst.excess, source: worst.source + culprit };
      })()`,
    );
    if (overflow.excess > 1)
      throw new Error(
        `390px 研究步骤 ${title} 横向溢出 ${overflow.excess}px（${overflow.source}）`,
      );
    await page.screenshot(
      join(
        evidenceDir,
        `research-${{ 问题与规则: 'question', 试跑与诊断: 'diagnostics', 分层验证: 'validation', 结论与更新: 'conclusion' }[title]}-mobile.png`,
      ),
    );
  }
  await researchButton('继续研究');
  await page.waitFor(
    `document.querySelector('[data-slot="conversation.composer"] [contenteditable="true"]')?.innerText.includes(${JSON.stringify(question)})`,
    '研究上下文实际写入官方会话草稿',
  );
  const continuedResearch = await page.evaluate<{
    researchContext: {
      accountId: string;
      baseVersionId: string;
      candidateVersionId: string;
      researchRevision: number;
      validationSessionId: string;
    };
  }>('window.__luoomeLastResearchRequest');
  if (
    continuedResearch.researchContext.accountId !== OWNER.accountId ||
    continuedResearch.researchContext.baseVersionId !== research.baseVersionId ||
    continuedResearch.researchContext.candidateVersionId !== newCandidate.id ||
    continuedResearch.researchContext.researchRevision !== savedState.state.data.state.revision ||
    continuedResearch.researchContext.validationSessionId !== newSession.id
  )
    throw new Error('继续研究的会话草稿未绑定原账户、固定版本、修订与验证任务');
  const guardedQuestion = `${question} 保存并离开时使用新修订。`;
  await clickPanel('策略');
  await page.waitFor(`document.querySelector('[data-strategy-mode="research"]') !== null`);
  await strategyMode('research');
  await page.waitFor(
    `document.querySelector('.luo-research-workbench textarea')?.value === ${JSON.stringify(question)}`,
  );
  await researchFill('这次只想验证什么', guardedQuestion);
  await researchButton('继续研究');
  await page.waitFor(
    `document.querySelector('[aria-label="未保存研究"]') !== null`,
    '继续研究先处理未保存内容',
  );
  await page.evaluate(`(() => {
    const button = [...document.querySelectorAll('[aria-label="未保存研究"] button')].find((item) => item.textContent.trim() === '保存并离开');
    if (!button || button.disabled) throw new Error('保存并离开不可操作');
    button.click();
  })()`);
  await page.waitFor(
    `document.querySelector('[aria-label="未保存研究"]') === null && document.querySelector('[data-slot="conversation.composer"] [contenteditable="true"]')?.innerText.includes(${JSON.stringify(guardedQuestion)})`,
    '保存完成后继续研究',
  );
  const savedNavigation = await page.evaluate<{
    prompt: string;
    researchContext: { researchRevision: number };
  }>('window.__luoomeLastResearchRequest');
  const navigationState = await researchApi<{
    state: { data: { state: { revision: number; state: { question: string } } } };
  }>(`research?view=state&strategyId=${research.strategyId}`);
  if (
    navigationState.state.data.state.revision !== savedState.state.data.state.revision + 1 ||
    navigationState.state.data.state.state.question !== guardedQuestion ||
    savedNavigation.researchContext.researchRevision !== navigationState.state.data.state.revision
  )
    throw new Error('保存并离开使用了旧研究问题或修订');
  await page.screenshot(join(evidenceDir, 'research-save-and-continue-context.png'));
  await clickPanel('策略');
  await page.waitFor(`document.querySelector('[data-strategy-mode="research"]') !== null`);
  await strategyMode('research');
  await page.waitFor(
    `document.querySelector('.luo-research-workbench textarea')?.value === ${JSON.stringify(guardedQuestion)}`,
  );
  const discardedQuestion = '此未保存问题应被放弃，不能进入继续研究上下文。';
  await researchFill('这次只想验证什么', discardedQuestion);
  await researchButton('继续研究');
  await page.waitFor(`document.querySelector('[aria-label="未保存研究"]') !== null`);
  await page.evaluate(
    `(() => { const dialog = document.querySelector('[aria-label="未保存研究"]'); [...dialog.querySelectorAll('button')].find((button) => button.textContent.trim() === '放弃修改').click(); })()`,
  );
  await page.waitFor(
    `document.querySelector('[aria-label="未保存研究"]') === null && document.querySelector('[data-slot="conversation.composer"] [contenteditable="true"]')?.innerText.includes(${JSON.stringify(guardedQuestion)})`,
    '放弃修改后使用已保存研究继续',
  );
  const discardedNavigation = await page.evaluate<{
    prompt: string;
    researchContext: { researchRevision: number };
  }>('window.__luoomeLastResearchRequest');
  if (
    !discardedNavigation.prompt.includes(guardedQuestion) ||
    discardedNavigation.prompt.includes(discardedQuestion) ||
    discardedNavigation.researchContext.researchRevision !==
      navigationState.state.data.state.revision
  )
    throw new Error('放弃修改后仍传递了未保存问题或错误修订');
  const researchEvidence = {
    strategy: research.strategyName,
    candidateVersion: newCandidate.version,
    inputSnapshot: trial.inputIdentity.snapshotHash,
    boundedCandidatesPreserved: bounded.candidates.length,
    diagnosisChecks,
    history: historyFacts,
    evaluationSession: newSession.id,
    validation: validationFacts,
    evidenceLayerStatuses: layerStatuses,
    cancelledWithoutWrite: true,
    confirmationResponseLost: true,
    reconciledOperationId: saveOperation.operationId,
    savedRevision: savedState.state.data.state.revision,
    restoredAfterRefresh: true,
    restoredPriorDayState: true,
    phaseOne: {
      researchRequestsBeforeEntry: lazyResearchReads - researchReadsBeforeStrategy,
      questionAndCandidatePreservedAcrossModes: true,
      trialAndOperationPreservedAcrossModes: true,
      unsavedStrategySwitch: { continueEditing: true, discard: true },
      saveBeforeConversationRevision: savedNavigation.researchContext.researchRevision,
      discardBeforeConversationUsesSavedContext: true,
      latestAttemptPreservesPublishedIdentity: ['failed', 'withheld'],
      mobileSelector: compactStrategy,
      globalDailyCycleScope: globalCycleScope,
    },
    continuedConversationBinding: continuedResearch.researchContext,
    continuity: updatesFacts.continuity,
    downloadedManifest: exportedName,
    phoneWidth: 390,
  };

  const evidence = {
    mode: '真实浏览器验收（Chrome headless CDP）；合成 fixture，非真实模型质量',
    research: researchEvidence,
    chrome: chromePath,
    chromeVersion: run(chromePath, ['--version']).trim(),
    dshOrigin: origin,
    publicMount: '/dsh/',
    independentIndexOnSentimentFailure: true,
    dshProfile: PROFILE,
    startupLogin: 'official token → 303 + signed cookie',
    sidebarLabels,
    panels: {
      overview: {
        domChecks: [fixtureInfo.stock.name, fixtureInfo.advicePremise, '持仓市值'],
        stateAccountTotal: overviewAccounts?.total,
        stateHoldings: dbHoldings,
        dbAccountId: dbAccount?.id,
      },
      positions: { stateHoldings: positionsHoldings?.holdings?.length, ok: true },
      settings: {
        previewHasNoWrite: true,
        cancelledHasNoWrite: true,
        confirmedName: renamedAccount?.account?.name,
        restoredByOperationId: true,
        nativeDshSettingsSection: true,
        fuyao: {
          savedInBrowser: true,
          appliedWithoutRestart: true,
          quoteSource: liveFuyaoQuote.quote?.data?.quote?.source,
          gatewayAuthenticated: fuyaoCalls.some((call) => call.authenticated),
          restoredAfterReopenAndReload: true,
          secretNotReturned: true,
          rejectsUnauthenticatedAndCrossOrigin: true,
        },
      },
      strategies: {
        domChecks: [
          fixtureInfo.strategyName,
          '当前定义',
          '结果使用的历史规则',
          '筛选条件',
          '匹配标的',
          fixtureInfo.stock.name,
          '入场信号',
          '退出条件',
          '风险条件',
          'AI 研究',
        ],
        strategyId: fixtureInfo.strategyId,
        versionId: fixtureInfo.versionId,
        runId: fixtureInfo.runId,
        readableConditions: true,
        namedMatchesAndRuleEvidence: true,
        noVisibleInternalIds: true,
        versionDriftDisclosed: true,
        strategySwitchAndNeverRun: true,
        stockDetail: {
          failureKeepsMatchEvidence: true,
          retry: true,
          quoteProvenance: true,
          closeAndReopen: true,
          mobileFits: true,
        },
        stockAnalysis: {
          submittedToOfficialConversation: true,
          stockId: stockAnalysisRequest.stockId,
          runId: stockAnalysisRequest.runId,
          sessionId: stockAnalysisRequest.sessionId,
          promptHasNoInternalIds: true,
        },
        drilldown,
        researchRequest: {
          strategyId: researchRequest.strategyId,
          runId: researchRequest.runId,
          hasPrompt: researchRequest.prompt.length > 0,
        },
      },
      review: {
        domChecks: ['信心校准', '逐条建议与用户反馈', fixtureInfo.decisionNote, '已跟随'],
        adviceCount: reviewStats?.totalAdvices,
        calibrationTotal: calibration?.totalAdvices,
        decisionReviewCount: reviewList?.records?.length,
      },
    },
    refresh: { ok: true },
    mobile: { viewport: '390x844', horizontalOverflowPx: overflow, ok: true },
    screenshots: (await readdir(evidenceDir)).filter((name) => name.endsWith('.png')).sort(),
    database: {
      account: dbAccount,
      holdings: dbHoldings,
      adviceCount: dbAdvices.length,
      reviewChangeNote: dbReviews[0]?.changeNote ?? null,
      strategyVersion: dbStrategies[0]?.currentVersionId ?? null,
      runPublication: dbRuns[0]?.publication ?? null,
    },
  };
  await writeFile(join(evidenceDir, 'browser-evidence.json'), JSON.stringify(evidence, null, 2));
  Object.assign(summary, { root, evidenceDir, ...evidence });
  console.log(JSON.stringify(summary, null, 2));
};

try {
  await runAcceptance();
} catch (error) {
  let pageErrors: unknown = null;
  try {
    pageErrors = await failurePage?.evaluate(
      `({ errors: window.__luoomeErrors ?? null, watchlistComposer: window.__luoomeLastWatchlistOperationRequest ? {errorCode: window.__luoomeLastWatchlistOperationRequest.errorCode, createdSession: window.__luoomeLastWatchlistOperationRequest.createdSession} : null, strategyComposer: window.__luoomeLastStrategyOperationRequest ? {errorCode: window.__luoomeLastStrategyOperationRequest.errorCode, createdSession: window.__luoomeLastStrategyOperationRequest.createdSession, sessionId: window.__luoomeLastStrategyOperationRequest.sessionId} : null, researchFields: [...document.querySelectorAll('.luo-research-workbench label')].map((element) => ({label:element.firstElementChild?.textContent, value:element.querySelector('input,textarea,select')?.value})), buttons: [...document.querySelectorAll('button,[role="menuitem"]')].map((element) => ({ text: element.textContent.trim().slice(0, 100), aria: element.getAttribute('aria-label') })) })`,
    );
    await failurePage?.screenshot(join(evidenceDir, 'failure.png'));
  } catch {
    pageErrors = null;
  }
  Object.assign(summary, {
    pageErrors,
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : null,
    root,
    evidenceDir,
  });
  console.log(JSON.stringify(summary, null, 2));
  process.exitCode = 1;
} finally {
  browser?.close();
  for (const chrome of chromeProcesses) {
    if (chrome.exitCode === null && chrome.signalCode === null) chrome.kill('SIGKILL');
  }
  // 等 Chrome 真正退出后再删 profile，否则残留写入会让删除报 ENOTEMPTY。
  await Promise.all(
    chromeProcesses.map(
      (chrome) =>
        new Promise<void>((done) => {
          if (chrome.exitCode !== null || chrome.signalCode !== null) {
            done();
            return;
          }
          chrome.once('exit', () => done());
        }),
    ),
  );
  for (const fixture of launched) {
    if (fixture.child.exitCode === null && fixture.child.signalCode === null)
      fixture.child.kill('SIGKILL');
  }
  proxy.closeAllConnections();
  proxy.close();
  fuyaoGateway.closeAllConnections();
  fuyaoGateway.close();
  if (process.exitCode !== 1 && process.env.KEEP !== '1')
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
