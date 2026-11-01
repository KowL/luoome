// biome-ignore-all lint/suspicious/noTemplateCurlyInString: 本文件里出现的 `${VAR}` 是**被断言的 shell 源码字面量**，
// 不是 JS 模板插值——静态守卫要对着脚本原文断言，所以这些字符必须原样保留。
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

  it('工作区旧路径要能访问：/workspace 软链接回数据目录', () => {
    // 历史会话的 cwd 与工作区记录都写着 /workspace；缺了它会话会报
    // working-directory: directory does not exist: "/workspace"。
    expect(install).toContain('WORKSPACE_COMPAT_PATH');
    expect(install).toContain(
      `ln -sfn "${shellVar('DSH_WORKSPACE')}" "${shellVar('WORKSPACE_COMPAT_PATH')}"`,
    );
  });

  it('安装时检查工作区记录路径与真实目录是否一致', () => {
    // DSH 挂载会话的判定是 realpath(cwd) === 记录的 path；对不上就报
    // session/workspace-attach-failed。安装器只检查并告警，不改运行中的数据。
    expect(install).toContain('storages/workspace.json');
    expect(install).toContain('session/workspace-attach-failed');
    expect(install).toContain('realpathSync');
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

/**
 * task-36：`upgrade.sh` 的备份保留策略 + 磁盘预检。
 *
 * 判据用**真跑 bash**而不是读源码：正则、数组排序、`${#array[@]}` 这类语义，
 * 静态读文本读不出来（前几轮就有过「只看一类证据」的误判）。
 */
describe('备份保留策略与磁盘预检（task-36）', () => {
  const upgrade = read('./upgrade.sh');

  /** 把 `upgrade.sh` 里的三个函数抠出来单独跑，避免整脚本的 root/systemctl 前置。 */
  const extractFunctions = (): string => {
    const names = ['require_positive_keep', 'require_disk_space', 'prune_backups'];
    const chunks = names.map((name) => {
      const start = upgrade.indexOf(`${name}() {`);
      if (start < 0) throw new Error(`upgrade.sh 缺少函数 ${name}`);
      const end = upgrade.indexOf('\n}', start);
      if (end < 0) throw new Error(`函数 ${name} 未闭合`);
      return upgrade.slice(start, end + 2);
    });
    return [
      'set -euo pipefail',
      `log() { printf '[upgrade] %s\\n' "$*" >&2; }`,
      `fail() { printf '[upgrade] 错误：%s\\n' "$*" >&2; exit 1; }`,
      'BACKUP_ROOT=' + '"' + '${BACKUP_ROOT:-}' + '"',
      "BACKUP_STAMP_PATTERN='^[0-9]{8}T[0-9]{6}Z$'",
      'BACKUP_ESTIMATE_MB=900',
      'REQUIRED_FREE_MB=$((BACKUP_ESTIMATE_MB * 2))',
      'DEPLOY_ROOT=' + '"' + '${DEPLOY_ROOT:-}' + '"',
      ...chunks,
      '__RUN__',
    ].join('\n');
  };

  const runBash = (
    script: string,
    env: Record<string, string> = {},
  ): { status: number; stdout: string; stderr: string } => {
    const result = spawnSync('bash', ['-c', script], {
      encoding: 'utf8',
      env: { ...process.env, ...env },
    });
    return { status: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
  };

  it('保留最近 N 份；手工备份（pre-* 等）不在候选里，永不被删', () => {
    const root = mkdtempSync(join(tmpdir(), 'luoome-backups-'));
    try {
      // 8 个时间戳目录 + 2 个手工目录 + 1 个非目录文件。
      const stamps = [
        '20261001T000000Z',
        '20261002T000000Z',
        '20261003T000000Z',
        '20261004T000000Z',
        '20261005T000000Z',
        '20261006T000000Z',
        '20261007T000000Z',
        '20261008T000000Z',
      ];
      for (const stamp of [...stamps, 'pre-migration', 'retention-manual']) {
        mkdirSync(join(root, stamp));
      }
      writeFileSync(join(root, 'workspace.json.1'), '{}');

      const script = extractFunctions().replace('__RUN__', 'prune_backups 3');
      const result = runBash(script, { BACKUP_ROOT: root });
      expect(result.status, result.stderr).toBe(0);

      const left = readdirSync(root).sort();
      // 最近 3 个时间戳保留。
      expect(left).toContain('20261008T000000Z');
      expect(left).toContain('20261007T000000Z');
      expect(left).toContain('20261006T000000Z');
      // 更早的时间戳被删。
      expect(left).not.toContain('20261001T000000Z');
      expect(left).not.toContain('20261005T000000Z');
      // **手工备份必须原样保留**（这就是白名单的意义）。
      expect(left).toContain('pre-migration');
      expect(left).toContain('retention-manual');
      expect(left).toContain('workspace.json.1');
      // 删之前有清单可追溯。
      expect(result.stderr).toContain('清理旧备份：20261005T000000Z');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('KEEP 校验：0 / 负数 / 非数字一律 fail，绝不清空', () => {
    const root = mkdtempSync(join(tmpdir(), 'luoome-backups-'));
    try {
      for (const stamp of ['20261001T000000Z', '20261002T000000Z']) mkdirSync(join(root, stamp));
      const script = extractFunctions().replace(
        '__RUN__',
        'KEEP="$(require_positive_keep)"; echo "OK:$KEEP"',
      );

      for (const bad of ['0', '-1', 'abc', '3.5', '']) {
        const result = runBash(script, { BACKUP_ROOT: root, LUOOME_BACKUP_KEEP: bad });
        if (bad === '') {
          // 空值 = 未设置 → 走默认 5，不算错误。
          expect(result.status).toBe(0);
          expect(result.stdout).toContain('OK:5');
          continue;
        }
        expect(result.status, `KEEP=${bad} 应当失败`).not.toBe(0);
        expect(result.stderr).toContain('LUOOME_BACKUP_KEEP');
        // 失败后备份一份都不能少。
        expect(readdirSync(root).sort()).toEqual(['20261001T000000Z', '20261002T000000Z']);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('磁盘预检在写任何东西之前失败', () => {
    const script = extractFunctions().replace(
      '__RUN__',
      `REQUIRED_FREE_MB=999999999; require_disk_space`,
    );
    const result = runBash(script, { BACKUP_ROOT: '', DEPLOY_ROOT: tmpdir() });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('可用空间不足');
  });

  it('脚本结构：清理只在成功路径上，且预检/校验在备份之前', () => {
    const pruneIndex = upgrade.indexOf('prune_backups ' + '"' + '${KEEP_BACKUPS}' + '"');
    const completeIndex = upgrade.indexOf('log "升级完成');
    const precheckIndex = upgrade.indexOf('require_disk_space');
    const backupIndex = upgrade.indexOf('mkdir -p ' + '"' + '${BACKUP_DIR}' + '"');
    // 清理在「升级完成」之前但之后于一切部署动作 — 用「在文件末尾附近且只有一处」表达。
    expect(pruneIndex).toBeGreaterThan(0);
    expect(completeIndex).toBeGreaterThan(pruneIndex);
    // 预检必须早于建备份目录。
    expect(precheckIndex).toBeGreaterThan(0);
    expect(precheckIndex).toBeLessThan(backupIndex);
    // 回滚里不出现清理。
    const rollbackStart = upgrade.indexOf('rollback() {');
    const rollbackEnd = upgrade.indexOf('\n}', rollbackStart);
    expect(upgrade.slice(rollbackStart, rollbackEnd)).not.toContain('prune_backups');
  });
});
