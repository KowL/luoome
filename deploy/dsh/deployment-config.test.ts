import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

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
      '${DSH_AUTH_USER:?',
      '${DSH_AUTH_HASH:?',
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
      'DSH_PUBLIC_URL=',
      'DSH_TRUSTED_HOST=',
      'LUOOME_OWNER_USER_ID=',
      'LUOOME_OWNER_ACCOUNT_ID=',
      'LUOOME_MARKET_PROVIDER=',
      'DSH_AUTH_USER=',
      'DSH_AUTH_HASH=',
    ])
      expect(envExample).toContain(required);
  });
});

describe('entrypoint.sh 只装配并启动纯插件 profile', () => {
  it('先跑 profile-seed，再启动 DSH profile', () => {
    expect(entrypoint).toContain('node /app/deploy/dsh/profile-seed.mjs');
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
  it('basic auth + 反代 dsh-web，不暴露旧入口', () => {
    expect(caddyfile).toContain('basic_auth');
    expect(caddyfile).toContain('reverse_proxy dsh-web:3080');
    expect(caddyfile).not.toContain('worker');
    expect(caddyfile).not.toContain('mcp');
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
