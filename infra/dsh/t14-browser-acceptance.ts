// T14（REQ-M2-04）浏览器验收：真实 DSH Web profile + 本机 Google Chrome（CDP）。
//
// 覆盖三项里的两项（第三项 tools:list 由 packages/tools/src/registry-list.test.ts 断言）：
//   1. 诊断 → settings 面板内的 section=diagnostics（不新增顶层面板）：
//      三类坏数据（缺行情 / 迁移未完成 / 连接失败）各渲染 ≥1 条结论，且结论含表名/字段名 + 日期；
//   2. 手动补跑批处理 → 策略面板：点一次产 1 条 Operation 回执，
//      且 get_closing_batch_audit 能查到该批次。
//
// 运行：npm exec --yes --package=tsx@4 --package=node@24 -- tsx infra/dsh/t14-browser-acceptance.ts
import { spawn, spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../..', import.meta.url));
const packageDir = join(repo, 'packages/dsh-luoome');
const dshModules = resolve(repo, 'node_modules/.bun/node_modules');
const cli = resolve(dshModules, '@deepseek-ai/dsh/lib/bin.js');
const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  process.env.CHROME_PATH,
].filter((value): value is string => typeof value === 'string' && value.length > 0);
const PROFILE = 'luoome-t14-browser';
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

const freePort = (): Promise<number> =>
  new Promise((done, fail) => {
    const probe = createServer();
    probe.on('error', fail);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      if (address === null || typeof address === 'string') {
        probe.close();
        fail(new Error('无法分配端口'));
        return;
      }
      const { port } = address;
      probe.close(() => done(port));
    });
  });

interface CdpResponse {
  readonly id?: number;
  readonly result?: Record<string, unknown>;
  readonly error?: { readonly message?: string };
  readonly method?: string;
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
      const timer = setTimeout(() => rejectOpen(new Error(`CDP 连接超时: ${url}`)), 10_000);
      socket.addEventListener('open', () => {
        clearTimeout(timer);
        resolveOpen();
      });
      socket.addEventListener('error', () => {
        clearTimeout(timer);
        rejectOpen(new Error(`CDP 连接失败: ${url}`));
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
  readonly setFileInput: (selector: string, path: string) => Promise<void>;
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
  await cdp.send('DOM.enable', {}, sessionId);
  await cdp.send(
    'Page.addScriptToEvaluateOnNewDocument',
    {
      source: `window.__luoomeErrors = [];
      window.__luoomeImportRequests = [];
      const originalFetch = window.fetch;
      window.fetch = function(input, init) {
        const url = new URL(typeof input === 'string' ? input : input.url, location.href);
        const record = { path: url.pathname, method: init?.method ?? 'GET', status: 0, body: '' };
        if (url.pathname.startsWith('/api/luoome/')) window.__luoomeImportRequests.push(record);
        return originalFetch.apply(this, arguments).then((response) => {
          record.status = response.status;
          response.clone().text().then((text) => { record.body = text.slice(0, 400); }).catch(() => {});
          return response;
        });
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
  const waitFor = async (expression: string, label = '页面状态', timeoutMs = 30_000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if ((await evaluate<boolean>(`Boolean(${expression})`)) === true) return;
      await new Promise((done) => setTimeout(done, 100));
    }
    const text = await evaluate<string>(
      `(document.querySelector('.luo-settings')?.innerText ?? document.body?.innerText ?? '').slice(0, 2500)`,
    );
    throw new Error(`等待「${label}」超时。页面文本片段: ${text}`);
  };
  const navigate = async (url: string) => {
    const loaded = cdp.waitEvent('Page.loadEventFired', sessionId);
    await cdp.send('Page.navigate', { url }, sessionId);
    await loaded;
  };
  const screenshot = async (path: string, fullPage = false) => {
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
  const setFileInput = async (selector: string, path: string) => {
    // 传空字符串表示清空该 input（DOM.setFileInputFiles 用空数组清空）。
    const document = await cdp.send('DOM.getDocument', { depth: 1 }, sessionId);
    const root = document.root as { nodeId?: number } | undefined;
    if (root?.nodeId === undefined) throw new Error('CDP 无法读取 DOM 根节点');
    const found = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector }, sessionId);
    const nodeId = found.nodeId;
    if (typeof nodeId !== 'number' || nodeId === 0)
      throw new Error(`页面上找不到元素: ${selector}`);
    await cdp.send(
      'DOM.setFileInputFiles',
      { files: path === '' ? [] : [path], nodeId },
      sessionId,
    );
  };
  const setViewport = async (width: number, height: number, mobile: boolean) => {
    await cdp.send(
      'Emulation.setDeviceMetricsOverride',
      { width, height, deviceScaleFactor: 1, mobile },
      sessionId,
    );
  };
  return { evaluate, waitFor, navigate, screenshot, setFileInput, setViewport };
};

const waitForChrome = async (userDataDir: string): Promise<string> => {
  const portFile = join(userDataDir, 'DevToolsActivePort');
  for (let attempt = 0; attempt < 400; attempt++) {
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

const launchDsh = (root: string, luoomeHome: string, workspace: string, port: number) => {
  const child = spawn(
    process.execPath,
    [cli, '--profile', PROFILE, '--no-open', '--port', String(port), '--host', '127.0.0.1'],
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
        // 手动补跑需要批处理 policy 装配。
        LUOOME_BATCH_ENABLED: 'true',
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
  for (let attempt = 0; attempt < 2000; attempt++) {
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

const summary: Record<string, unknown> = {};
const root = await mkdtemp(join(tmpdir(), 'luoome-t14-browser-'));
const evidenceDir = join(root, 'evidence');
const workspace = join(root, 'workspace');
const profileDir = join(root, 'profiles', PROFILE);
const luoomeHome = join(root, 'luoome-home');
const launched: ReturnType<typeof launchDsh>[] = [];
const chromeProcesses: ReturnType<typeof spawn>[] = [];
const fixtureScript = join(packageDir, 'src/testing/t14-diagnostics-fixture.ts');

const clickByText = async (page: PageSession, text: string) => {
  const clicked = await page.evaluate<boolean>(`(() => {
    const buttons = [...document.querySelectorAll('button,[role="button"],[role="menuitem"]')];
    const target = buttons.find((element) => element.textContent.trim() === ${JSON.stringify(text)}) ??
      buttons.find((element) => element.getAttribute('aria-label') === ${JSON.stringify(text)});
    if (!target) return false;
    target.click();
    return true;
  })()`);
  if (!clicked) throw new Error(`无法点击 ${text}`);
};

const openSettings = async (page: PageSession) => {
  await page.waitFor(`document.body?.innerText?.includes('LUOOME') === true`, 'DSH 外壳');
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    await page.evaluate(`(() => {
      const dismiss = [...document.querySelectorAll('button')].find((button) => ['继续', 'Continue'].includes(button.textContent.trim()));
      if (dismiss) dismiss.click();
    })()`);
    if (
      await page.evaluate<boolean>(
        `document.querySelector('[data-shortcut-modal="settings"]') !== null`,
      )
    )
      break;
    await page.evaluate(`(() => {
      const buttons = [...document.querySelectorAll('button,[role="button"]')];
      const target = buttons.find((element) => ['账号菜单', 'Account menu'].includes(element.textContent.trim()) ||
        ['账号菜单', 'Account menu'].includes(element.getAttribute('aria-label') ?? ''));
      if (target) target.click();
    })()`);
    await new Promise((done) => setTimeout(done, 200));
    await page.evaluate(`(() => {
      const items = [...document.querySelectorAll('[role="menuitem"],button')];
      const target = items.find((element) => ['设置', 'Settings'].includes(element.textContent.trim())) ??
        items.find((element) => element.getAttribute('role') === 'menuitem' && element.textContent.trim().startsWith('设置'));
      if (target) target.click();
    })()`);
    await new Promise((done) => setTimeout(done, 300));
  }
  await page.waitFor(
    `document.querySelector('[data-shortcut-modal="settings"]') !== null`,
    'DSH 原生设置',
  );
  // 设置弹窗刚挂载时点导航会被后续渲染吃掉：循环点到分区真的出现为止。
  const partition = Date.now() + 30_000;
  while (Date.now() < partition) {
    if (await page.evaluate<boolean>(`document.querySelector('.luo-settings') !== null`)) break;
    await page.evaluate(`(() => {
      const target = [...document.querySelectorAll('button,[role="button"]')].find((element) => element.textContent.trim() === '投资设置');
      if (target) target.click();
    })()`);
    await new Promise((done) => setTimeout(done, 300));
  }
  try {
    await page.waitFor(`document.querySelector('.luo-settings') !== null`, '投资设置分区');
  } catch (error) {
    await writeFile(
      join(evidenceDir, 'debug-settings.json'),
      JSON.stringify(
        await page.evaluate(
          `({ errors: window.__luoomeErrors ?? [], html: (document.querySelector('[data-shortcut-modal="settings"]')?.innerHTML ?? '').slice(0, 2000) })`,
        ),
        null,
        2,
      ),
    );
    throw error;
  }
};

const openStrategies = async (page: PageSession) => {
  await page.evaluate(`(() => {
    const dialog = document.querySelector('[data-shortcut-modal="settings"]');
    const close = dialog && [...dialog.querySelectorAll('button')].find((item) => ['关闭', '关闭设置', 'Close', 'Close settings'].includes(item.textContent.trim()));
    if (close) close.click();
  })()`);
  await page.waitFor(
    `document.querySelector('[data-shortcut-modal="settings"]') === null`,
    '关闭 DSH 设置',
  );
  if (!(await page.evaluate<boolean>(`document.querySelector('.luo-app') !== null`)))
    await clickByText(page, 'LUOOME');
  await page.waitFor(`document.querySelector('.luo-app') !== null`, '业务应用外壳');
  await page.evaluate(`document.querySelector('[data-luoome-view="strategies"]')?.click()`);
  await page.waitFor(
    `document.querySelector('[data-luoome-view="strategies"][aria-current="page"]') !== null`,
    '策略视图',
  );
};

const main = async () => {
  await mkdir(evidenceDir, { recursive: true });
  await mkdir(workspace, { recursive: true });
  await mkdir(profileDir, { recursive: true });
  await mkdir(luoomeHome, { recursive: true });

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

  // 三类坏数据 fixture。
  run('bun', ['--no-env-file', fixtureScript, 'seed', luoomeHome, JSON.stringify(OWNER)]);

  const fixture = launchDsh(root, luoomeHome, workspace, await freePort());
  launched.push(fixture);
  const startup = await waitForReady(fixture);
  const { origin, cookie } = await login(startup);

  // 迁移未完成：必须等插件启动后（ensureSchema 已跑完）再删，否则会被补回去。
  const liveDb = new DatabaseSync(join(luoomeHome, 'luoome.db'));
  try {
    liveDb
      .prepare('DELETE FROM schema_migrations WHERE id = ?')
      .run('m1-06-signal-observation-vintage-v1');
  } finally {
    liveDb.close();
  }

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
  const page = await connectPage(websocketUrl);
  await page.setViewport(1320, 1000, false);
  await page.navigate(startup);
  await openSettings(page);

  // 1) 诊断 section：三类坏数据各 ≥1 条结论，含表名/字段名 + 日期。
  await page.evaluate(
    `document.querySelector('[data-luoome-section="diagnostics"]')?.scrollIntoView({ block: 'start' })`,
  );
  await page.waitFor(
    `document.querySelectorAll('[data-diagnostic-code]').length >= 3`,
    '诊断结论',
    60_000,
  );
  const diagnosticsText = await page.evaluate<string>(
    `document.querySelector('[data-luoome-section="diagnostics"]')?.innerText ?? ''`,
  );
  await writeFile(join(evidenceDir, 't14-diagnostics.txt'), diagnosticsText);
  await page.screenshot(join(evidenceDir, 't14-diagnostics.png'), true);

  const required = [
    ['market-quote-missing', 'price_snapshots.observed_at'],
    ['migration-incomplete', 'schema_migrations.id'],
    ['source-unavailable', 'stock_universe_sync_runs.status'],
  ];
  for (const [code, subject] of required) {
    if (!diagnosticsText.includes(subject))
      throw new Error(
        `诊断缺少 ${code} 的表名/字段（${subject}）：${diagnosticsText.slice(0, 1200)}`,
      );
  }
  if (!/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(diagnosticsText))
    throw new Error(`诊断结论缺少日期：${diagnosticsText.slice(0, 1200)}`);
  // 结论必须带具体表名与日期，而不是「数据有问题」。
  for (const needle of ['price_snapshots', 'schema_migrations', 'stock_universe_sync_runs'])
    if (!diagnosticsText.includes(needle)) throw new Error(`诊断缺少表名 ${needle}`);

  // 2) 策略面板：手动补跑收盘批处理。
  await openStrategies(page);
  // 卡片在「整体运行与观察」折叠区里：先展开，否则 innerText 看不到。
  await page.evaluate(`(() => {
    const details = document.querySelector('details.luo-strategy-operations');
    if (details) details.open = true;
  })()`);
  await page.waitFor(
    `document.querySelector('.luo-app')?.innerText.includes('收盘批处理') === true`,
    '收盘批处理卡片',
    30_000,
  );
  // 卡片先渲染静态文案，profile 到了按钮才可用：等它可点。
  await page.waitFor(
    `(() => { const b = [...document.querySelectorAll('button')].find((item) => item.textContent.trim() === '补跑收盘批处理'); return Boolean(b) && !b.disabled; })()`,
    '补跑按钮可用',
    30_000,
  );
  const clicked = await page.evaluate<boolean>(`(() => {
    const button = [...document.querySelectorAll('button')].find((item) => item.textContent.trim() === '补跑收盘批处理');
    if (!button || button.disabled) return false;
    button.click();
    return true;
  })()`);
  if (!clicked) {
    await writeFile(
      join(evidenceDir, 'debug-batch.json'),
      JSON.stringify(
        {
          profile: await page.evaluate(
            `fetch('api/luoome/profile', { credentials: 'same-origin' }).then((r) => r.json())`,
          ),
          text: await page.evaluate(
            `document.querySelector('.luo-app')?.innerText?.slice(0, 3000) ?? ''`,
          ),
        },
        null,
        2,
      ),
    );
    throw new Error('补跑按钮不可点击（batchEnabled 未开启？）');
  }
  await page.waitFor(
    `document.querySelector('.luo-app')?.innerText.includes('操作已完成') === true`,
    '补跑回执',
    120_000,
  );
  try {
    await page.waitFor(
      `document.querySelector('[data-batch-audit]') !== null`,
      '批次审计结果',
      120_000,
    );
  } catch (error) {
    await writeFile(
      join(evidenceDir, 'debug-batch-audit.json'),
      JSON.stringify(
        {
          text: await page.evaluate(
            `document.querySelector('.luo-app')?.innerText?.slice(0, 4000) ?? ''`,
          ),
          audit: await page.evaluate(
            `fetch('api/luoome/call', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tool: 'get_closing_batch_audit', input: {} }) }).then((r) => r.json())`,
          ),
        },
        null,
        2,
      ),
    );
    throw error;
  }
  const batchRunId = await page.evaluate<string>(
    `document.querySelector('[data-batch-run-id]')?.getAttribute('data-batch-run-id') ?? ''`,
  );
  // 审计证据：当日与前一交易日各查一次，至少一次要能定位到该批次的主报告。
  const auditFor = async (date: string) => {
    const response = await fetch(`${origin}/api/luoome/call`, {
      method: 'POST',
      headers: { cookie, origin: new URL(origin).origin, 'content-type': 'application/json' },
      body: JSON.stringify({ tool: 'get_closing_batch_audit', input: { date } }),
    });
    return (await response.json()) as {
      ok: boolean;
      data?: {
        date: string;
        accounts: {
          accountId: string;
          mainReport: { id: string; workflowRunId: string } | null;
          batchRuns: { id: string }[];
        }[];
      };
    };
  };
  const todayAudit = await auditFor('2026-10-30');
  const priorAudit = await auditFor('2026-10-29');
  const auditEvidence = [todayAudit, priorAudit]
    .filter((entry) => entry.ok && entry.data !== undefined)
    .flatMap((entry) =>
      (entry.data?.accounts ?? [])
        .filter((account) => account.accountId === OWNER.accountId)
        .map((account) => ({
          date: entry.data?.date ?? '',
          mainReportId: account.mainReport?.id ?? '',
          workflowRunId: account.mainReport?.workflowRunId ?? '',
          batchRunIds: account.batchRuns.map((run) => run.id),
        })),
    )
    .filter((entry) => entry.mainReportId !== '' || entry.batchRunIds.length > 0);
  if (auditEvidence.length === 0)
    throw new Error(
      `get_closing_batch_audit 查不到该批次：${JSON.stringify({ todayAudit, priorAudit }).slice(0, 800)}`,
    );
  const auditedRunId =
    auditEvidence.find((entry) => entry.workflowRunId !== '')?.workflowRunId ??
    auditEvidence.flatMap((entry) => entry.batchRunIds)[0] ??
    '';
  const strategiesText = await page.evaluate<string>(
    `document.querySelector('.luo-app')?.innerText ?? ''`,
  );
  await writeFile(join(evidenceDir, 't14-batch.txt'), strategiesText);
  await page.screenshot(join(evidenceDir, 't14-batch.png'), true);

  // 3) 事实核对：1 条 operation + workflow_runs 里确有该批次。
  const db = new DatabaseSync(join(luoomeHome, 'luoome.db'), { readOnly: true });
  let operations = 0;
  let runStatus = '';
  try {
    operations = Number(
      (
        db
          .prepare(
            "SELECT count(*) AS n FROM plugin_operations WHERE json_extract(record_json, '$.tool') = 'run_closing_report_cutoff'",
          )
          .get() as { n?: number }
      ).n ?? 0,
    );
    runStatus = String(
      (
        db.prepare('SELECT status FROM workflow_runs WHERE id = ?').get(auditedRunId) as {
          status?: string;
        }
      )?.status ?? '',
    );
  } finally {
    db.close();
  }
  if (operations !== 1) throw new Error(`补跑应只产 1 条 Operation，实际 ${String(operations)}`);
  if (runStatus === '') throw new Error(`workflow_runs 里查不到批次 ${auditedRunId}`);

  summary.diagnostics = { text: diagnosticsText };
  summary.batch = {
    cardRunId: batchRunId,
    auditedRunId,
    runStatus,
    operations,
    auditEvidence,
    text: strategiesText.slice(0, 4000),
  };
  await writeFile(join(evidenceDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ ok: true, evidenceDir, summary }, null, 2)}\n`);
};

try {
  await main();
} finally {
  for (const fixture of launched) fixture.child.kill('SIGTERM');
  for (const child of chromeProcesses) child.kill('SIGKILL');
}
