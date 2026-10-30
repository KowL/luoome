// T48 B2c 浏览器验收：真实 DSH Web profile + 本机 Google Chrome（CDP）。
//
// 两条旅程：
//   A. 空库 recovery-only：插件只装配恢复面 → 上传快照 → 只读预检（逐表计数 +
//      structural-only 披露）→ 备份确认 → 恢复业务快照 → 回执；刷新后回执仍可读。
//   B. 已有库：同一流程恢复另一份快照 → 账户名被替换 → `/api/luoome/state` 回读一致。
// 另含：同一 tick 双击只产生一个 Operation；跨 Origin 上传 403。
//
// 运行：`npm exec --yes --package=tsx@4 --package=node@24 -- tsx infra/dsh/data-import-acceptance.ts`
// （需要 Node 24 的 node:sqlite；Bun 运行时不提供该内置模块。）
// 这是载体/交互验收，不是真实用户数据验收：库与快照都是临时合成 fixture。
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
const PROFILE = 'luoome-data-import-browser';
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

const fixtureScript = join(packageDir, 'src/testing/data-import-fixture.ts');

/** 建一份空 schema 库（与插件启动时的 ensureSchema 同一套 DDL）。 */
const initSchema = (path: string): void => {
  run('bun', ['--no-env-file', fixtureScript, 'schema', path]);
};

/** 在库里写 owner 账户；结果是无 WAL 边车的独立快照。 */
const seedAccount = (path: string, name: string): void => {
  run('bun', ['--no-env-file', fixtureScript, 'seed', path, JSON.stringify(OWNER), name]);
};

/** 同一 tick 双击只应落一条 restore Operation：直接数事实库里的行。 */
const restoreOperationCount = (home: string, state?: string): number => {
  const db = new DatabaseSync(join(home, 'luoome.db'), { readOnly: true });
  try {
    const row = (
      state === undefined
        ? db
            .prepare(
              "SELECT count(*) AS n FROM plugin_operations WHERE json_extract(record_json, '$.tool') = 'restore_data_import'",
            )
            .get()
        : db
            .prepare(
              "SELECT count(*) AS n FROM plugin_operations WHERE json_extract(record_json, '$.tool') = 'restore_data_import' AND state = ?",
            )
            .get(state)
    ) as { n?: number } | undefined;
    return Number(row?.n ?? 0);
  } finally {
    db.close();
  }
};

const summary: Record<string, unknown> = {};
const root = await mkdtemp(join(tmpdir(), 'luoome-import-browser-'));
const evidenceDir = join(root, 'evidence');
const workspace = join(root, 'workspace');
const profileDir = join(root, 'profiles', PROFILE);
const launched: ReturnType<typeof launchDsh>[] = [];
const chromeProcesses: ReturnType<typeof spawn>[] = [];

const clickButton = async (page: PageSession, label: string) => {
  const labels = [label, ...({ 账号菜单: ['Account menu'], 设置: ['Settings'] }[label] ?? [])];
  const clicked = await page.evaluate<boolean>(
    `(() => {
      const buttons = [...document.querySelectorAll('button,[role="button"],[role="menuitem"]')];
      const labels = ${JSON.stringify(labels)};
      const target = buttons.find((element) => labels.includes(element.textContent.trim())) ??
        buttons.find((element) => labels.includes(element.getAttribute('aria-label'))) ??
        buttons.find((element) => element.getAttribute('role') === 'menuitem' && labels.some((label) => element.textContent.trim().startsWith(label)));
      if (!target) return false;
      target.click();
      return true;
    })()`,
  );
  if (!clicked) throw new Error(`无法点击 ${label}`);
};

const openSettings = async (page: PageSession) => {
  await page.waitFor(`document.body?.innerText?.includes('LUOOME') === true`, 'DSH 外壳');
  // 预览版说明弹层会延迟出现并遮挡账号菜单：先反复关闭，再尝试打开设置。
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
  await clickButton(page, '投资设置');
  await page.waitFor(`document.querySelector('.luo-settings') !== null`, '投资设置分区');
  await page.waitFor(
    `document.querySelector('input[aria-label="快照文件"]') !== null`,
    '数据恢复区块',
  );
};

/** 选文件 → 预检 → 服务端备份；返回备份 id。 */
const uploadPreviewBackup = async (page: PageSession, snapshotPath: string, round = 1) => {
  // 同一个路径再选一次不会触发 change：重试轮次用不同文件名。
  const path = round === 1 ? snapshotPath : `${snapshotPath}.round-${String(round)}.db`;
  if (round !== 1) await cp(snapshotPath, path);
  await page.setFileInput('input[aria-label="快照文件"]', path);
  try {
    await page.waitFor(
      `document.querySelector('.luo-settings')?.innerText.includes('预检完成') === true`,
      '预检完成',
      60_000,
    );
  } catch (error) {
    await writeFile(
      join(evidenceDir, 'debug-upload-timeout.txt'),
      await page.evaluate<string>(`document.querySelector('.luo-settings')?.innerText ?? ''`),
    );
    await writeFile(
      join(evidenceDir, 'debug-upload-timeout.json'),
      JSON.stringify(
        await page.evaluate(
          `({ requests: window.__luoomeImportRequests, errors: window.__luoomeErrors, files: document.querySelector('input[aria-label="快照文件"]')?.files?.length ?? -1 })`,
        ),
        null,
        2,
      ),
    );
    throw error;
  }
  const disabledWithoutBackup = await page.evaluate<boolean>(`(() => {
    const button = [...document.querySelectorAll('button')].find((item) => item.textContent.trim() === '恢复业务快照');
    return button ? button.disabled : true;
  })()`);
  if (!disabledWithoutBackup) throw new Error('未生成备份时「恢复业务快照」必须禁用');
  const backupClicked = await page.evaluate<boolean>(`(() => {
    const button = [...document.querySelectorAll('button')].find((item) => item.getAttribute('aria-label') === '生成恢复前备份');
    if (!button || button.disabled) return false;
    button.click();
    return true;
  })()`);
  if (!backupClicked) throw new Error('生成备份按钮不可点击');
  await page.waitFor(
    `document.querySelector('.luo-settings')?.innerText.includes('已生成恢复前一致性备份') === true`,
    '备份完成',
    60_000,
  );
  const backupId = await page.evaluate<string>(
    `document.querySelector('[data-backup-id]')?.getAttribute('data-backup-id') ?? ''`,
  );
  if (!/^[a-f0-9]{32}$/.test(backupId)) throw new Error(`备份 id 非法: ${backupId}`);
  return backupId;
};

/** 目标没变时只需重新生成备份（不占新的暂存配额）。 */
const regenerateBackup = async (page: PageSession, previousId: string) => {
  const clicked = await page.evaluate<boolean>(`(() => {
    const button = [...document.querySelectorAll('button')].find((item) => item.getAttribute('aria-label') === '生成恢复前备份');
    if (!button || button.disabled) return false;
    button.click();
    return true;
  })()`);
  if (!clicked) throw new Error('重新生成备份按钮不可点击');
  await page.waitFor(
    `(() => { const id = document.querySelector('[data-backup-id]')?.getAttribute('data-backup-id') ?? ''; return id.length === 32 && id !== ${JSON.stringify(previousId)}; })()`,
    '重新生成备份',
    60_000,
  );
  const next = await page.evaluate<string>(
    `document.querySelector('[data-backup-id]')?.getAttribute('data-backup-id') ?? ''`,
  );
  if (!/^[a-f0-9]{32}$/.test(next)) throw new Error(`备份 id 非法: ${next}`);
  return next;
};

const submitRestore = async (page: PageSession, expect: 'ok' | 'rejected') => {
  const clicked = await page.evaluate<boolean>(`(() => {
    const button = [...document.querySelectorAll('button')].find((item) => item.textContent.trim() === '恢复业务快照');
    if (!button || button.disabled) return false;
    button.click();
    button.click();
    return true;
  })()`);
  if (!clicked) throw new Error('恢复按钮不可点击');
  await page.waitFor(
    `document.querySelector('.luo-settings')?.innerText.includes('业务快照已恢复') === true || document.querySelector('.luo-settings')?.innerText.includes('提交被拒') === true`,
    '恢复提交结果',
    90_000,
  );
  const text = await page.evaluate<string>(
    `document.querySelector('.luo-settings')?.innerText ?? ''`,
  );
  if (expect === 'ok' && !text.includes('业务快照已恢复'))
    throw new Error(`恢复未成功。页面文本: ${text.slice(0, 1800)}`);
  if (expect === 'rejected' && !text.includes('提交被拒'))
    throw new Error(`预期提交被拒。页面文本: ${text.slice(0, 1800)}`);
  return text;
};

const runJourney = async (options: {
  readonly label: 'empty' | 'existing';
  readonly home: string;
  readonly snapshotPath: string;
  /**
   * 每一轮「备份之后做点什么，再提交」的干扰：目标被改（targetDigest 失效）、
   * 备份文件被损坏（字节校验失败）。每次干扰后都必须被拒，然后重新预检 + 重新备份。
   */
  readonly disturbances?: readonly {
    readonly run: (backupId: string) => Promise<void>;
    /** 被拒后如何恢复：目标变了要重新上传预检；只坏了备份则重新生成备份即可。 */
    readonly retry: 'reupload' | 'rebackup';
  }[];
}) => {
  await mkdir(options.home, { recursive: true });
  const fixture = launchDsh(root, options.home, workspace, await freePort());
  launched.push(fixture);
  const startup = await waitForReady(fixture);
  const { origin, cookie } = await login(startup);

  const chromeUserData = join(root, `chrome-${options.label}`);
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
  await page.setViewport(1320, 900, false);
  await page.navigate(startup);
  await openSettings(page);

  const previewText = await page.evaluate<string>(
    `document.querySelector('.luo-settings')?.innerText ?? ''`,
  );
  await writeFile(join(evidenceDir, `data-import-${options.label}-preview.txt`), previewText);

  let backupId = await uploadPreviewBackup(page, options.snapshotPath);
  const previewAfterBackup = await page.evaluate<string>(
    `document.querySelector('.luo-settings')?.innerText ?? ''`,
  );
  await writeFile(
    join(evidenceDir, `data-import-${options.label}-preview.txt`),
    previewAfterBackup,
  );
  for (const needle of [
    'SQLite 业务快照',
    '仅做结构校验的',
    'OWNER',
    '恢复业务快照',
    '合并分类数据',
    '不校验领域不变量',
    '重新生成备份',
  ])
    if (!previewAfterBackup.includes(needle))
      throw new Error(`预检未披露「${needle}」。文本片段: ${previewAfterBackup.slice(0, 1500)}`);
  await page.evaluate(
    `document.querySelector('[data-backup-id]')?.scrollIntoView({ block: 'center' })`,
  );
  await page.screenshot(join(evidenceDir, `data-import-${options.label}-preview.png`), true);

  const rejections: string[] = [];
  for (const [index, disturb] of (options.disturbances ?? []).entries()) {
    await disturb.run(backupId);
    const rejected = await submitRestore(page, 'rejected');
    rejections.push(rejected);
    await writeFile(
      join(evidenceDir, `data-import-${options.label}-rejected-${String(index + 1)}.txt`),
      rejected,
    );
    await page.screenshot(
      join(evidenceDir, `data-import-${options.label}-rejected-${String(index + 1)}.png`),
      true,
    );
    // 被拒后必须重新预检/重新备份才能再提交；暂存配额只有 2 份，目标没变时不必重新上传。
    backupId =
      disturb.retry === 'reupload'
        ? await uploadPreviewBackup(page, options.snapshotPath, index + 2)
        : await regenerateBackup(page, backupId);
  }

  const afterText = await submitRestore(page, 'ok');
  await writeFile(join(evidenceDir, `data-import-${options.label}-after.txt`), afterText);
  await writeFile(
    join(evidenceDir, `data-import-${options.label}-network.json`),
    `${JSON.stringify(
      await page.evaluate(
        `({ requests: window.__luoomeImportRequests, errors: window.__luoomeErrors, session: sessionStorage.getItem('luoome-import-session') })`,
      ),
      null,
      2,
    )}\n`,
  );
  const receiptLine = afterText
    .split('\n')
    .map((line) => line.trim())
    .find((line) => /^回执 [0-9a-f-]{36}$/.test(line));
  if (receiptLine === undefined) throw new Error('页面上没有回执行');
  await page.evaluate(
    `document.querySelectorAll('.luo-operation-ref')[0]?.scrollIntoView({ block: 'center' })`,
  );
  await page.screenshot(join(evidenceDir, `data-import-${options.label}-receipt.png`), true);

  // 刷新后回执仍可读。
  await page.navigate(`${origin}/`);
  await openSettings(page);
  await page.waitFor(
    `document.querySelector('.luo-settings')?.innerText.includes('回执 ') === true`,
    '刷新后回执',
  );
  const stored = await page.evaluate<string>(
    `sessionStorage.getItem('luoome-import-session') ?? ''`,
  );
  if (/token/i.test(stored)) throw new Error('sessionStorage 不应保存凭证');
  if (stored.includes('.db')) throw new Error('sessionStorage 不应保存文件路径');
  await page.evaluate(
    `document.querySelectorAll('.luo-operation-ref')[0]?.scrollIntoView({ block: 'center' })`,
  );
  await page.screenshot(join(evidenceDir, `data-import-${options.label}-reload.png`), true);

  // 跨 Origin 上传必须被拒。
  const crossOrigin = await fetch(`${origin}/api/luoome/import/upload`, {
    method: 'POST',
    headers: { cookie, origin: 'http://evil.example', 'content-type': 'application/octet-stream' },
    body: new Uint8Array([1, 2, 3]),
  });
  if (crossOrigin.status !== 403)
    throw new Error(`跨 Origin 上传应 403，实际 ${String(crossOrigin.status)}`);

  // 双击只产生一个 Operation：数库里 restore 操作的条数。
  const state = (await fetch(`${origin}/api/luoome/state?panel=settings`, {
    headers: { cookie, origin: new URL(origin).origin },
  }).then((response) => response.json())) as {
    configuration?: { policies?: { name: string }[] };
  };
  const policyNames = (state.configuration?.policies ?? []).map((item) => item.name);
  if (!policyNames.includes('restore_data_import'))
    throw new Error(`恢复 policy 未装配，实际 ${JSON.stringify(policyNames)}`);

  const operations = restoreOperationCount(options.home, 'succeeded');
  if (operations !== 1)
    throw new Error(
      `同一 tick 双击应只产生一个成功的 restore Operation，实际 ${String(operations)}`,
    );

  summary[options.label] = {
    origin,
    receiptLine,
    backupId,
    rejections,
    restoreOperations: operations,
    structuralDisclosure: (previewText.match(/仅做结构校验的 (\d+) 张表/) ?? [])[1] ?? null,
    sessionStorage: stored,
    crossOriginStatus: crossOrigin.status,
    policies: policyNames,
  };
  return { origin, cookie, page, fixture };
};

const main = async () => {
  await mkdir(evidenceDir, { recursive: true });
  await mkdir(workspace, { recursive: true });
  await mkdir(profileDir, { recursive: true });

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

  // 快照：空库建账用、已有库改名用。两份都与插件 schema 同版本。
  const emptySnapshot = join(root, 'snapshot-empty.db');
  const existingSnapshot = join(root, 'snapshot-existing.db');
  initSchema(emptySnapshot);
  seedAccount(emptySnapshot, '恢复建账');
  initSchema(existingSnapshot);
  seedAccount(existingSnapshot, '恢复后的账户名');

  const emptyHome = join(root, 'home-empty');
  const existingHome = join(root, 'home-existing');
  await mkdir(emptyHome, { recursive: true });
  await mkdir(existingHome, { recursive: true });
  // 已有库先放一个不同名字的账户，证明恢复真的替换了事实。
  seedAccount(join(existingHome, 'luoome.db'), '恢复前的账户名');

  await runJourney({ label: 'empty', home: emptyHome, snapshotPath: emptySnapshot });
  const existing = await runJourney({
    label: 'existing',
    home: existingHome,
    snapshotPath: existingSnapshot,
    disturbances: [
      {
        // 1) 备份之后改目标：提交必须因 targetDigest 失效被拒，且零业务写。
        run: async () => {
          const db = new DatabaseSync(join(existingHome, 'luoome.db'));
          try {
            db.prepare('UPDATE accounts SET name = ? WHERE id = ?').run(
              '备份后被改动',
              OWNER.accountId,
            );
          } finally {
            db.close();
          }
        },
        retry: 'reupload',
      },
      {
        // 2) 备份文件被损坏：提交前字节校验失败，同样拒绝且零业务写。
        run: async (backupId) => {
          const path = join(existingHome, 'imports', 'backups', `${backupId}.db`);
          const bytes = await readFile(path);
          await writeFile(path, bytes.subarray(0, 4096));
        },
        retry: 'rebackup',
      },
    ],
  });

  const state = (await fetch(`${existing.origin}/api/luoome/state?panel=settings`, {
    headers: { cookie: existing.cookie, origin: new URL(existing.origin).origin },
  }).then((response) => response.json())) as {
    tools?: { name?: string; ok?: boolean; data?: { account?: { name?: string } } }[];
  };
  const account = state.tools?.find((tool) => tool.name === 'get_account')?.data?.account;
  if (account?.name !== '恢复后的账户名')
    throw new Error(`恢复后账户名应为「恢复后的账户名」，实际 ${String(account?.name)}`);
  summary.existingAccountName = account.name;

  await writeFile(join(evidenceDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ ok: true, evidenceDir, summary }, null, 2)}\n`);
};

try {
  await main();
} finally {
  for (const fixture of launched) fixture.child.kill('SIGTERM');
  for (const child of chromeProcesses) child.kill('SIGKILL');
}
