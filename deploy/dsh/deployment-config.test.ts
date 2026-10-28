import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { patchPocketBindHost, patchPocketProxy, prefixPocketHeaders } from './pocket-prefix.mjs';

/**
 * 默认部署切纯插件的静态守卫（不依赖 docker，可在 node/vitest 下运行）。
 *
 * 需求文档 §9 M5 / §10.1：默认部署由 DSH 用 Node 加载 dsh-luoome 插件（host/client/skills），
 * 事实库是 Node SQLite；不启动 MCP 实例、Bun CLI、旧 Bun Web、analysis worker 或
 * queue probe。旧 MCP/Bun 入口源码保留（P5 再删），只是默认部署不再启动。
 */
const deployDir = new URL('.', import.meta.url);
const read = (file: string): string => readFileSync(new URL(file, deployDir), 'utf8');

const compose = read('./compose.yaml');
const envExample = read('./production.env.example');
const entrypoint = read('./entrypoint.sh');
const dockerfile = read('./Dockerfile');
const caddyfile = read('./Caddyfile');
const profileSeed = read('./profile-seed.mjs');

/** 取 YAML 顶层 section 下的二级 key；本文件的结构简单，够用且不引入 YAML 依赖。 */
const sectionKeys = (yaml: string, section: string): string[] => {
  const lines = yaml.split('\n');
  const start = lines.indexOf(`${section}:`);
  if (start < 0) return [];
  const keys: string[] = [];
  for (const line of lines.slice(start + 1)) {
    // 下一个顶层 key 说明 section 结束。
    if (/^[^\s#]/.test(line)) break;
    const match = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (match?.[1]) keys.push(match[1]);
  }
  return keys;
};

const dockerRuntimeStage = (): string => {
  const marker = /^FROM \$\{NODE_IMAGE\}/m.exec(dockerfile)?.index ?? -1;
  return marker < 0 ? '' : dockerfile.slice(marker);
};

describe('默认 compose 只部署纯插件 Web + Caddy', () => {
  it('service 名单只有 dsh-web 与 caddy', () => {
    expect(sectionKeys(compose, 'services').sort()).toEqual(['caddy', 'dsh-web']);
  });

  it('不再声明旧 MCP/worker 服务、业务变量或专属地址', () => {
    for (const forbidden of [
      'dsh-worker',
      'DSH_WORKER_',
      'LUOOME_MCP_',
      'luoome-worker',
      'luoome-analysis',
      'analysis-worker',
      'queue-probe',
      '172.28.0.6',
    ])
      expect(compose).not.toContain(forbidden);
    expect(compose).not.toMatch(/["']worker["']/);
  });

  it('owner/事实库变量与必需变量保持 fail-closed', () => {
    for (const required of [
      '${LUOOME_RELEASE:?',
      '${LUOOME_OWNER_USER_ID:?',
      '${LUOOME_OWNER_ACCOUNT_ID:?',
      '${DSH_PUBLIC_URL:?',
      '${DSH_TRUSTED_HOST:?',
    ])
      expect(compose).toContain(required);
    expect(compose).toContain('LUOOME_HOME: /var/lib/luoome');
    expect(compose).toContain('LUOOME_MARKET_PROVIDER');
    expect(compose).toContain('172.28.0.5');
    expect(compose).toContain('172.28.0.2');
  });

  it('Bun 只作为构建参数出现，运行阶段是 Node 镜像', () => {
    expect(compose).toContain('BUN_IMAGE:');
    const environmentSection = compose.slice(compose.indexOf('environment: &environment'));
    expect(environmentSection).not.toContain('BUN_IMAGE');
    expect(dockerRuntimeStage()).not.toMatch(/\bbun\b/);
    expect(dockerfile).toContain('bun pm pack');
    expect(dockerRuntimeStage()).toContain('npm install --omit=dev --global @deepseek-ai/dsh');
  });
});

describe('只读容器里 HOME 必须可写', () => {
  it('把 /home/node 挂成命名卷并显式声明 HOME', () => {
    // DSH 应用内目录选择器默认浏览 HOME，创建工作区就是在当前目录下 mkdir；
    // 容器只读且 HOME 不在卷上时，用户会看到 EROFS。
    expect(compose).toContain('HOME: /home/node');
    expect(compose).toMatch(/- dsh_home_node:\/home\/node/);
    expect(sectionKeys(compose, 'volumes')).toContain('dsh_home_node');
  });

  it('不靠放开只读根文件系统来绕过 HOME 不可写', () => {
    expect(compose).toContain('read_only: true');
  });

  it('镜像里的 home 目录归属运行用户，空卷继承该属主', () => {
    expect(dockerfile).toMatch(/chown[^\n]*\/home\/node/);
  });
});

describe('production.env.example 只列纯插件默认部署变量', () => {
  it('不再包含 MCP/worker 配置', () => {
    for (const forbidden of ['LUOOME_MCP_', 'DSH_WORKER_', 'analysis-worker', 'queue-probe'])
      expect(envExample).not.toContain(forbidden);
  });

  it('覆盖纯插件必需变量', () => {
    for (const required of [
      'LUOOME_RELEASE=',
      'BUN_IMAGE=',
      'NODE_IMAGE=',
      'CADDY_IMAGE=',
      'DSH_POCKET_VERSION=',
      'DSH_PUBLIC_URL=',
      'DSH_TRUSTED_HOST=',
      'LUOOME_OWNER_USER_ID=',
      'LUOOME_OWNER_ACCOUNT_ID=',
      'LUOOME_MARKET_PROVIDER=',
    ])
      expect(envExample).toContain(required);
  });
});

describe('entrypoint.sh 只装配并启动纯插件 profile', () => {
  it('发布包绑定当前部署文件并拒绝旧监听配置', () => {
    execFileSync('python3', ['-B', new URL('./upgrade.test.py', deployDir).pathname], {
      encoding: 'utf8',
      stdio: 'pipe',
    });
  });
  it('旧部署传入容器 IP 时仍监听 Pocket 所需的 loopback', () => {
    const root = mkdtempSync(join(tmpdir(), 'luoome-entrypoint-'));
    try {
      const bin = join(root, 'bin');
      mkdirSync(bin);
      writeFileSync(join(bin, 'node'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      writeFileSync(join(bin, 'dsh'), '#!/bin/sh\nprintf \'%s\\n\' "$@"\n', {
        mode: 0o755,
      });
      const args = execFileSync('sh', [new URL('./entrypoint.sh', deployDir).pathname, 'web'], {
        encoding: 'utf8',
        env: {
          PATH: `${bin}:${process.env.PATH}`,
          DSH_WORKSPACE: root,
          LUOOME_OWNER_USER_ID: 'fixture-owner',
          LUOOME_OWNER_ACCOUNT_ID: 'fixture-account',
          DSH_BIND_HOST: '172.28.0.5',
          DSH_PORT: '3080',
          DSH_PUBLIC_URL: 'http://fixture.invalid/dsh/',
          DSH_TRUSTED_HOST: 'fixture.invalid',
        },
      })
        .trim()
        .split('\n');
      expect(args[args.indexOf('--host') + 1]).toBe('127.0.0.1');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('先跑 profile-seed，再启动 DSH profile', () => {
    expect(entrypoint).toContain('node /app/deploy/dsh/profile-seed.mjs');
    expect(entrypoint).toContain('--pocket /usr/local/lib/node_modules/dsh-pocket');
    expect(entrypoint).toContain('exec dsh --profile "$DSH_PROFILE"');
    expect(entrypoint).not.toMatch(/\bbun\b/);
  });

  it('不再启动 MCP/worker/queue probe，也不再调用 legacy bootstrap', () => {
    for (const forbidden of [
      'bootstrap.ts',
      'queue-probe',
      'luoome-worker',
      'luoome-web"',
      'DSH_WORKER',
    ])
      expect(entrypoint).not.toContain(forbidden);
  });

  it('owner 缺失时 shell 层 fail closed', () => {
    expect(entrypoint).toContain('${LUOOME_OWNER_USER_ID:?');
    expect(entrypoint).toContain('${LUOOME_OWNER_ACCOUNT_ID:?');
  });
});

describe('profile-seed.mjs 是纯插件安装步骤', () => {
  it('安装插件 host/client/skills 并写入 DSH profile', () => {
    expect(profileSeed).toContain("const PLUGIN_NAME = 'dsh-luoome'");
    expect(profileSeed).toContain('@deepseek-ai/dsh-web-app');
    expect(profileSeed).toContain('dist/client.js');
    expect(profileSeed).toContain('cordis.patch.yml');
    expect(profileSeed).toContain("'luoome-plugin'");
    expect(profileSeed).not.toMatch(/\bbun\b/);
  });
});

describe('Caddy 仍是唯一公网入口且保持 fail closed', () => {
  it('只反代 Pocket，由 Pocket 完成公网密码与 DSH token 握手', () => {
    expect(caddyfile).toContain('reverse_proxy dsh-web:3081');
    expect(caddyfile).not.toContain('basic_auth');
    expect(caddyfile).not.toContain('dsh-web:3080');
    expect(compose).toContain('DSH_BIND_HOST: 127.0.0.1');
    expect(compose).not.toMatch(/308[01]:308[01]/);
    expect(compose).toContain('dsh-web-probe.mjs');
    expect(dockerfile).toContain('HEALTHCHECK');
    expect(dockerfile).toMatch(/dsh-pocket@\$\{DSH_POCKET_VERSION\}/);
    expect(envExample).toContain('DSH_POCKET_VERSION=2.12.0');
    expect(envExample).not.toContain('DSH_AUTH_HASH=');
    expect(caddyfile).not.toContain('worker');
    expect(caddyfile).not.toContain('mcp');
  });

  it('在 Pocket 重写 Origin 前拒绝浏览器跨站请求', () => {
    expect(caddyfile).toContain('header Origin *');
    expect(caddyfile).toContain('not header Origin http://{$DSH_PUBLIC_IP:134.175.83.56}');
    expect(caddyfile).toContain('respond @crossOrigin 403');
  });

  it('只将 /dsh/ 转给 Pocket，根路径与其它路径不进入 DSH', () => {
    expect(caddyfile).toContain('handle_path /dsh/*');
    expect(caddyfile).toContain('redir /dsh /dsh/ 308');
    expect(caddyfile).toContain('respond 404');
    expect(envExample).toContain('DSH_PUBLIC_URL=http://134.175.83.56/dsh/\n');
    expect(dockerfile).toContain('node /app/deploy/dsh/pocket-prefix.mjs');
  });
});

describe('Pocket 代理的绑定地址必须可收口', () => {
  const makePackage = (root: string): string => {
    const lib = join(root, 'lib');
    mkdirSync(lib, { recursive: true });
    writeFileSync(
      join(lib, 'service.mjs'),
      [
        'export async function startProxy() {',
        '  return {',
        "    host: '0.0.0.0',",
        '  };',
        '}',
        '',
      ].join('\n'),
    );
    writeFileSync(
      join(lib, 'proxy.mjs'),
      [
        'const server = createServer((req, res) => {',
        '  // upstream',
        '});',
        'const login = `action="/pocket-login"`;',
        'const redirect = `content="0; url=/"`;',
        `const retry = \`<a href="/?\${HANDSHAKE_RETRY_PARAM}=1"\`;`,
        '',
      ].join('\n'),
    );
    return root;
  };

  it('把硬编码的 0.0.0.0 换成可配地址，默认只绑 loopback', () => {
    const root = mkdtempSync(join(tmpdir(), 'pocket-bind-'));
    try {
      const service = join(makePackage(root), 'lib', 'service.mjs');
      expect(patchPocketBindHost(service)).toBe(true);
      const source = readFileSync(service, 'utf8');
      expect(source).toContain("host: process.env.DSH_POCKET_BIND_HOST ?? '127.0.0.1',");
      expect(source).not.toContain("host: '0.0.0.0',");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('重复打补丁不叠加（重复安装时 npm 不会重装同版本包）', () => {
    const root = mkdtempSync(join(tmpdir(), 'pocket-idem-'));
    try {
      const pkg = makePackage(root);
      const service = join(pkg, 'lib', 'service.mjs');
      const proxy = join(pkg, 'lib', 'proxy.mjs');
      expect(patchPocketBindHost(service)).toBe(true);
      expect(patchPocketBindHost(service)).toBe(false);
      expect(patchPocketProxy(proxy)).toBe(true);
      expect(patchPocketProxy(proxy)).toBe(false);
      const patched = readFileSync(proxy, 'utf8');
      expect(patched.split('prefixPocketResponse(res);').length - 1).toBe(1);
      expect(patched.split('import { prefixPocketResponse }').length - 1).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('容器里显式放开到 bridge 网络，宿主机直部署默认只绑 loopback', () => {
    expect(compose).toContain('DSH_POCKET_BIND_HOST: "0.0.0.0"');
    expect(dockerfile).toContain(
      'node /app/deploy/dsh/pocket-prefix.mjs /usr/local/lib/node_modules/dsh-pocket',
    );
  });
});

describe('Pocket 子路径的登录和会话', () => {
  it('把登录跳转与 cookie 限定在 /dsh/，清除迁移前的根 cookie', () => {
    const headers = prefixPocketHeaders({
      location: '/?dsh-pocket-auth=1',
      'set-cookie': [
        'dsh-pocket-token=pin; HttpOnly; Path=/; SameSite=Lax',
        'dsh-auth-test=session; Path=/',
      ],
    });
    expect(headers.location).toBe('/dsh/?dsh-pocket-auth=1');
    expect(headers['set-cookie']).toEqual([
      'dsh-pocket-token=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax',
      'dsh-pocket-token=pin; HttpOnly; Path=/dsh/; SameSite=Lax',
      'dsh-auth-test=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax',
      'dsh-auth-test=session; Path=/dsh/',
    ]);
  });

  it('保留已带前缀的跳转和站外跳转', () => {
    for (const location of ['/dsh/', '/dsh/?ready=1', 'https://provider.example/login'])
      expect(prefixPocketHeaders({ Location: location }).Location).toBe(location);
  });
});

describe('旧 MCP/Bun 入口只保留源码，不进入默认部署', () => {
  it.each(['bootstrap.ts', 'queue-e2e.ts', 'queue-probe.ts', 'settings-tools.ts'])(
    '%s 仍然存在（P5 再删）',
    (file) => {
      expect(existsSync(new URL(file, deployDir))).toBe(true);
    },
  );

  it('legacy bootstrap 明确标注不再由默认部署调用', () => {
    expect(read('./bootstrap.ts')).toContain('LEGACY');
    expect(read('./bootstrap.ts')).toContain('profile-seed.mjs');
  });
});
