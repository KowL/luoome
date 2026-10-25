// M4 三面板浏览器验收：临时 DSH Web profile + 本机 Google Chrome headless（CDP）。
//
// 覆盖（需求 §7、§9 M4、§10.4；plugin 详细设计 §4.2/§8）：
//   1. 真实 DSH Web 登录（官方 token → signed cookie），加载随包 client slots；
//   2. 三个侧栏条目（看盘 / 策略看板 / 复盘）可点击并渲染主面板；
//   3. 每块面板 DOM 展示值与宿主 /api/luoome/state 的 ToolResult、以及 SQLite 事实库
//      逐项一致（账户/持仓/建议/策略版本/运行/信心校准/决策复盘/用户反馈）；
//   4. 策略面板「在对话中研究此策略」携带 strategyId/runId，点击后导航到会话并记录请求；
//   5. 刷新后仍正确；移动端无横向溢出；
//   6. 桌面三个面板 + 移动端截图与 JSON 证据落盘到临时目录（不提交仓库）。
//
// 这是「真实浏览器验收」，不是真实模型质量验收：数据来自合成 fixture，不联网供应商、
// 不调用模型、不触碰真实个人库。Chrome 不可用时显式失败并报告具体阻塞。
import { spawn, spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const repo = resolve(import.meta.dir, '../..');
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

  private constructor(private readonly socket: WebSocket) {}

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
  readonly waitFor: (expression: string, label: string, timeoutMs?: number) => Promise<void>;
  readonly navigate: (url: string) => Promise<void>;
  readonly screenshot: (path: string, fullPage?: boolean) => Promise<void>;
  readonly setViewport: (width: number, height: number, mobile: boolean) => Promise<void>;
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
  const waitFor = async (expression: string, label: string, timeoutMs = 25_000) => {
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
  return { evaluate, waitFor, navigate, screenshot, setViewport };
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

const launchDsh = (root: string, luoomeHome: string, workspace: string) => {
  const child = spawn('node', [cli, '--profile', PROFILE, '--no-open', '--port', '0'], {
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
  });
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
  return { origin: new URL(startup).origin, cookie };
};

const fetchState = async (
  origin: string,
  cookie: string,
  panel: string,
): Promise<Record<string, unknown>> => {
  const response = await fetch(`${origin}/api/luoome/state?panel=${panel}`, {
    headers: { cookie, origin },
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
let page: PageSession | undefined;

try {
  await mkdir(evidenceDir, { recursive: true });
  await mkdir(workspace, { recursive: true });
  await mkdir(luoomeHome, { recursive: true });
  await mkdir(profileDir, { recursive: true });

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
  const fixture = launchDsh(root, luoomeHome, workspace);
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
  page = await connectPage(websocketUrl);
  await page.setViewport(1440, 900, false);
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
        `document.body.innerText.includes('预览版说明')`,
      );
      if (!visible) return;
      await page.evaluate<boolean>(`(() => {
        const dismiss = [...document.querySelectorAll('button')].find((button) => button.textContent.trim() === '继续');
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
    `[...document.querySelectorAll('button')].map((button) => button.textContent.trim()).filter((label) => ['看盘','策略看板','复盘'].includes(label))`,
  );
  if (sidebarLabels.length !== 3)
    throw new Error(`侧栏条目应为 3 个，实际 ${JSON.stringify(sidebarLabels)}`);

  const clickPanel = async (label: string) => {
    const clicked = await page.evaluate<boolean>(
      `(() => {
        const buttons = [...document.querySelectorAll('button,[role="button"]')];
        const target = buttons.find((element) => element.textContent.trim() === ${JSON.stringify(label)}) ?? buttons.find((element) => element.getAttribute('aria-label') === ${JSON.stringify(label)});
        if (!target) return false;
        target.click();
        return true;
      })()`,
    );
    if (!clicked) throw new Error(`无法点击侧栏条目 ${label}`);
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
  const dbAccount = database.account as { id: string } | null;
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

  await clickPanel('策略看板');
  await page.waitFor(
    `document.body.innerText.includes(${JSON.stringify(fixtureInfo.strategyName)})`,
    '策略面板',
  );
  const strategiesText = await page.evaluate<string>('document.body.innerText');
  for (const expected of [fixtureInfo.strategyName, '当前版本', '在对话中研究此策略'])
    if (!strategiesText.includes(expected)) throw new Error(`策略面板 DOM 缺少「${expected}」`);
  const strategyList = toolData(strategiesState, 'list_strategies') as {
    strategies?: { id: string; name: string; currentVersionId?: string }[];
  } | null;
  const strategiesExtra = Array.isArray(strategiesState.strategies)
    ? (strategiesState.strategies as {
        strategyId: string;
        workspace: { ok: boolean; data?: unknown };
      }[])
    : [];
  const strategyWorkspace = strategiesExtra.find(
    (item) => item.strategyId === fixtureInfo.strategyId,
  )?.workspace;
  const dbStrategies = database.strategies as { id: string; currentVersionId: string | null }[];
  const dbRuns = database.runs as { id: string; publication: string | null }[];
  if (
    strategyList?.strategies?.[0]?.id !== fixtureInfo.strategyId ||
    strategyList.strategies[0]?.currentVersionId !== fixtureInfo.versionId ||
    strategyWorkspace?.ok !== true ||
    dbStrategies[0]?.currentVersionId !== fixtureInfo.versionId ||
    dbRuns[0]?.publication !== 'published'
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
    !researchRequest.prompt.includes(fixtureInfo.strategyId)
  )
    throw new Error(`下钻请求内容不正确: ${JSON.stringify(researchRequest)}`);
  // 官方 composer 是 contenteditable（不是 textarea）：草稿必须真的落到输入框里，
  // 否则用户仍要手工复制标识，「在对话中研究此策略」就只是名义上的入口。
  await page.waitFor(
    `(() => {
      const editor = document.querySelector('[data-slot="conversation.composer"] [contenteditable="true"]');
      return editor !== null && editor.innerText.includes(${JSON.stringify(fixtureInfo.strategyId)});
    })()`,
    '研究提示草稿写入官方 composer',
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

  const evidence = {
    mode: '真实浏览器验收（Chrome headless CDP）；合成 fixture，非真实模型质量',
    chrome: chromePath,
    chromeVersion: run(chromePath, ['--version']).trim(),
    dshOrigin: origin,
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
      strategies: {
        domChecks: [fixtureInfo.strategyName, '当前版本', '在对话中研究此策略'],
        strategyId: fixtureInfo.strategyId,
        versionId: fixtureInfo.versionId,
        runId: fixtureInfo.runId,
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
    screenshots: [
      'overview-desktop.png',
      'strategies-desktop.png',
      'review-desktop.png',
      'overview-mobile.png',
    ],
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
} catch (error) {
  let pageErrors: unknown = null;
  try {
    pageErrors = await page?.evaluate('window.__luoomeErrors ?? null');
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
  for (const fixture of launched) {
    if (fixture.child.exitCode === null && fixture.child.signalCode === null)
      fixture.child.kill('SIGKILL');
  }
  if (process.exitCode !== 1 && process.env.KEEP !== '1')
    await rm(root, { recursive: true, force: true });
}
