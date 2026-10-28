import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * 宿主机直部署的静态守卫（不依赖 systemd/docker，可在 node/vitest 下运行）。
 *
 * 直部署把容器原本提供的隔离交给 systemd，所以单元里的加固项就是这套部署的
 * 安全边界：服务进程只绑 loopback、只写自己的数据面、没有提权能力，
 * 公网入口仍然只有 Caddy 一个。
 */
const directDir = new URL('.', import.meta.url);
const read = (file: string): string => readFileSync(new URL(file, directDir), 'utf8');

/** shell 与 systemd 里的变量引用字面量。 */
const shellVar = (name: string): string => `\${${name}}`;

const dshUnit = read('./luoome-dsh.service');
const caddyUnit = read('./luoome-caddy.service');
const caddyfile = read('./Caddyfile');
const install = read('./install.sh');
const upgrade = read('./upgrade.sh');

describe('DSH 单元以非特权账号跑在宿主机上', () => {
  it('用专用系统账号运行，并且不给任何 capability', () => {
    expect(dshUnit).toContain('User=luoome');
    expect(dshUnit).toContain('Group=luoome');
    expect(dshUnit).toMatch(/^CapabilityBoundingSet=$/m);
    expect(dshUnit).toContain('NoNewPrivileges=true');
  });

  it('只绑 loopback，DSH 与 Pocket 都不监听公网地址', () => {
    expect(dshUnit).toContain('--host 127.0.0.1');
    expect(dshUnit).toContain('DSH_POCKET_BIND_HOST=127.0.0.1');
    expect(dshUnit).not.toContain('0.0.0.0');
  });

  it('补回容器原本提供的隔离', () => {
    for (const directive of [
      'ProtectSystem=strict',
      'ProtectHome=read-only',
      'PrivateTmp=true',
      'PrivateDevices=true',
      'ProtectProc=invisible',
      'ProcSubset=pid',
      'RestrictSUIDSGID=true',
      'RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX',
    ])
      expect(dshUnit).toContain(directive);
  });

  it('HOME 要能列出也要能新建目录：ProtectHome 不能把整棵树遮掉', () => {
    // ProtectHome=true 会把 /home 变不可访问，ReadWritePaths 覆盖不了，
    // 目录选择器会报 cannot list /home/luoome: EACCES。
    expect(dshUnit).toContain('Environment=HOME=/home/luoome');
    expect(dshUnit).toMatch(/^ProtectHome=read-only$/m);
    expect(dshUnit).not.toMatch(/^ProtectHome=true$/m);
    expect(dshUnit).toContain('/home/luoome');
  });

  it('只允许写自己的数据面，不给整块 /opt 或 /home', () => {
    const writePaths = (dshUnit.match(/^ReadWritePaths=(.*)$/m)?.[1] ?? '')
      .split(/\s+/)
      .filter(Boolean)
      .sort();
    expect(writePaths).toEqual([
      '/home/luoome',
      '/opt/luoome/dsh/home',
      '/opt/luoome/dsh/luoome-home',
      '/opt/luoome/dsh/workspace',
    ]);
  });

  it('不能牺牲 Node 的 JIT 内存', () => {
    expect(dshUnit).not.toContain('MemoryDenyWriteExecute=true');
  });

  it('配置来自 root 可控的 EnvironmentFile，缺文件就不能起', () => {
    expect(dshUnit).toContain('EnvironmentFile=/opt/luoome/dsh/host.env');
    // 前缀 `-` 会让缺失的 EnvironmentFile 被静默忽略，等于放开 fail closed。
    expect(dshUnit).not.toMatch(/^EnvironmentFile=.*-$/m);
    expect(dshUnit).toContain(shellVar('DSH_PUBLIC_URL'));
    expect(dshUnit).toContain(shellVar('DSH_TRUSTED_HOST'));
    expect(dshUnit).toContain(shellVar('DSH_PROFILE'));
  });
});

describe('Caddy 是宿主机上唯一的公网入口', () => {
  it('只保留绑定 80 的能力', () => {
    expect(caddyUnit).toContain('AmbientCapabilities=CAP_NET_BIND_SERVICE');
    expect(caddyUnit).toContain('CapabilityBoundingSet=CAP_NET_BIND_SERVICE');
    expect(caddyUnit).toContain('NoNewPrivileges=true');
  });

  it('上游是本机 Pocket 的 loopback 端口，不再依赖容器 DNS', () => {
    expect(caddyfile).toContain('reverse_proxy 127.0.0.1:3081');
    expect(caddyfile).not.toContain('dsh-web:');
    expect(caddyfile).not.toContain('0.0.0.0');
  });

  it('保留 /dsh/ 前缀、跨站栅栏与兜底 404', () => {
    expect(caddyfile).toContain('handle_path /dsh/*');
    expect(caddyfile).toContain('redir /dsh /dsh/ 308');
    expect(caddyfile).toContain('respond @crossOrigin 403');
    expect(caddyfile).toContain('respond 404');
  });

  it('只用自己需要的 env，不把旧的 basic auth 哈希带进新服务', () => {
    expect(caddyUnit).toContain('EnvironmentFile=/opt/luoome/dsh/caddy.env');
    expect(install).not.toContain('DSH_AUTH_HASH');
  });
});

describe('安装脚本只做安装面', () => {
  it('不碰数据、不启停服务、不用 docker', () => {
    expect(install).not.toMatch(/\bdocker\b/);
    // 只允许 daemon-reload：安装器不接管正在跑的服务，启停交给运维。
    const executed = install
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('systemctl '));
    expect(executed).toEqual(['systemctl daemon-reload']);
    expect(install).toContain('set -euo pipefail');
  });

  it('校验 Node 压缩包后再铺到 /usr/local', () => {
    expect(install).toContain('sha256sum -c -');
    expect(install).toContain('--strip-components=1');
  });

  it('装齐 DSH 与 dsh-pocket，并应用 pocket 补丁', () => {
    expect(install).toContain('@deepseek-ai/dsh@');
    expect(install).toContain('dsh-pocket@');
    expect(install).toContain('pocket-prefix.mjs');
  });

  it('装配 profile 时显式给 home 与全局模块目录', () => {
    expect(install).toContain(`--home "${shellVar('DSH_HOME')}"`);
    expect(install).toContain(`--modules "${shellVar('GLOBAL_MODULES')}"`);
    expect(install).toContain(`--pocket "${shellVar('GLOBAL_MODULES')}/dsh-pocket"`);
  });

  it('已有配置不覆盖，缺的变量才补', () => {
    expect(install).toContain(`grep -q "^${shellVar('key')}="`);
  });

  it('插件产物缺失时明确失败，不造假', () => {
    expect(install).toContain(`[ -f "${shellVar('PLUGIN_ARTIFACT')}" ]`);
  });
});

describe('升级脚本可回滚', () => {
  it('先备份 profile 与事实库，再重启并验收', () => {
    expect(upgrade).toContain(`cp -a "${shellVar('DSH_HOME')}/profiles/${shellVar('PROFILE')}"`);
    expect(upgrade).toContain('luoome.db');
    expect(upgrade).toContain('systemctl restart');
    expect(upgrade).toContain('dsh-web-probe.mjs');
    expect(upgrade).not.toMatch(/\bdocker\b/);
  });

  it('事实库备份走 SQLite backup API，不能只复制活跃主文件', () => {
    expect(upgrade).toContain('node:sqlite');
    expect(upgrade).toContain('await backup(db, process.env.BACKUP_DB)');
    expect(upgrade).not.toMatch(/cp -a "\$\{LUOOME_HOME\}\/luoome\.db"/);
    // 恢复前必须清掉旧 WAL，否则残留日志会盖掉刚恢复的库。
    expect(upgrade).toContain(`rm -f "${shellVar('LUOOME_HOME')}/luoome.db-wal"`);
  });

  it('验收失败就装回备份', () => {
    expect(upgrade).toMatch(
      /dsh-web-probe\.mjs" "\$\{PUBLIC_URL\}" "\$\{PIN_FILE\}"; then\n {2}rollback/,
    );
    expect(upgrade).toContain(`rm -rf "${shellVar('DSH_HOME')}/profiles/${shellVar('PROFILE')}"`);
  });
});
