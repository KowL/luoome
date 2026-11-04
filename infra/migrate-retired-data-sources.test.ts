import { spawnSync } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { migrateContent, resolveEnvFile } from './migrate-retired-data-sources.mjs';

const script = fileURLToPath(new URL('./migrate-retired-data-sources.mjs', import.meta.url));
const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

async function fixture(content: string) {
  const directory = await mkdtemp(join(tmpdir(), 'luoome-config-migration-'));
  directories.push(directory);
  const path = join(directory, '.env');
  await writeFile(path, content, { mode: 0o644 });
  return { directory, path };
}

function run(path: string, args = ['--env-file', path], env = {}) {
  // Node 22 otherwise preloads --env-file even when it follows the script path.
  return spawnSync(process.execPath, ['--', script, ...args], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, ...env },
  });
}

describe('retired data sources pure migration', () => {
  it('removes retired keys and preserves source order and unrelated bytes', () => {
    const input =
      '# TUSHARE_TOKEN=example\nOTHER="private"\nTUSHARE_TOKEN=secret\nTUSHARE_URL=https://secret\nLUOOME_MARKET_SOURCES=sina,tushare,fuyao\nLUOOME_STOCK_UNIVERSE_SOURCES=tushare,sina,eastmoney';
    expect(migrateContent(input)).toEqual({
      content:
        '# TUSHARE_TOKEN=example\nOTHER="private"\nLUOOME_MARKET_SOURCES=sina,fuyao\nLUOOME_STOCK_UNIVERSE_SOURCES=sina,eastmoney',
      changedKeys: [
        'TUSHARE_TOKEN',
        'TUSHARE_URL',
        'LUOOME_MARKET_SOURCES',
        'LUOOME_STOCK_UNIVERSE_SOURCES',
      ],
      sourceCounts: { LUOOME_MARKET_SOURCES: 2, LUOOME_STOCK_UNIVERSE_SOURCES: 2 },
    });
  });

  it('preserves export, quotes, comments, whitespace and CRLF', () => {
    const input =
      '  export TUSHARE_TOKEN="private#value" # retain comment\r\nexport TUSHARE_URL=private # endpoint comment\r\nexport LUOOME_MARKET_SOURCES = "tushare, Tencent,sina"  # markets\r\nLUOOME_STOCK_UNIVERSE_SOURCES=\'tushare\' # universe\r\nKEEP = x # untouched\r\n\r\n';
    expect(migrateContent(input).content).toBe(
      '  # retain comment\r\n# endpoint comment\r\nexport LUOOME_MARKET_SOURCES = "tencent,sina"  # markets\r\nLUOOME_STOCK_UNIVERSE_SOURCES=\'eastmoney,sina\' # universe\r\nKEEP = x # untouched\r\n\r\n',
    );
  });

  it('preserves BOM and inactive assignments inside unrelated multiline quoted values', () => {
    const input =
      '\uFEFFOTHER="first\nTUSHARE_TOKEN=not-active\nLUOOME_MARKET_SOURCES=unknown\nlast"\nTUSHARE_URL=retired\n';
    expect(migrateContent(input).content).toBe(
      '\uFEFFOTHER="first\nTUSHARE_TOKEN=not-active\nLUOOME_MARKET_SOURCES=unknown\nlast"\n',
    );
  });

  it('uses defaults for empty lists or lists containing only retired sources', () => {
    for (const raw of ['', '""', 'tushare', "' TUSHARE,tushare '"]) {
      const result = migrateContent(
        `LUOOME_MARKET_SOURCES=${raw}\nLUOOME_STOCK_UNIVERSE_SOURCES=${raw}\n`,
      );
      expect(result.content).toContain('eastmoney,tencent,sina');
      expect(result.content).toContain('eastmoney,sina');
      expect(migrateContent(result.content).changedKeys).toEqual([]);
    }
  });

  it('does not rewrite valid source formatting or insert absent keys', () => {
    const input = 'LUOOME_MARKET_SOURCES=" SINA, Tencent " # unchanged\nOTHER=anything\n';
    expect(migrateContent(input).content).toBe(input);
    expect(migrateContent(input).changedKeys).toEqual([]);
    expect(migrateContent('# only comments\n').content).toBe('# only comments\n');
  });

  it.each([
    'LUOOME_MARKET_SOURCES=tushare,unknown',
    'LUOOME_MARKET_SOURCES=tushare,sina,SINA',
    'LUOOME_MARKET_SOURCES=eastmoney,tencent,sina,fuyao',
    'LUOOME_MARKET_SOURCES=tushare,,sina',
    'LUOOME_STOCK_UNIVERSE_SOURCES=tushare,fuyao',
    'LUOOME_STOCK_UNIVERSE_SOURCES=sina,sina',
    'LUOOME_MARKET_SOURCES="tushare" unexpected',
    'TUSHARE_TOKEN="unterminated',
  ])('rejects invalid target assignments without exposing values: %s', (assignment) => {
    expect(() => migrateContent(assignment)).toThrow('Invalid configuration');
  });

  it('handles multiline retired quoted values and duplicate active assignments', () => {
    expect(migrateContent('TUSHARE_TOKEN="first\nsecond"\nTUSHARE_TOKEN=third\n').content).toBe('');
    expect(() =>
      migrateContent('LUOOME_MARKET_SOURCES=unknown\nLUOOME_MARKET_SOURCES=tushare'),
    ).toThrow();
  });

  it('resolves explicit path, LUOOME_HOME and home fallback without reading config', () => {
    expect(resolveEnvFile(['--env-file', '/fixture/custom'], {}, '/fixture/home')).toBe(
      '/fixture/custom',
    );
    expect(resolveEnvFile([], { LUOOME_HOME: '/fixture/data' }, '/fixture/home')).toBe(
      '/fixture/data/.env',
    );
    expect(resolveEnvFile([], {}, '/fixture/home')).toBe('/fixture/home/.luoome/.env');
    expect(() => resolveEnvFile(['--env-file'])).toThrow();
    expect(() => resolveEnvFile(['--env-file', ''])).toThrow();
    expect(() => resolveEnvFile(['--unknown', 'value'])).toThrow();
  });
});

describe('explicit Node migration CLI using temporary fixtures', () => {
  it('writes a byte-exact private backup, atomically replaces with mode 0600 and is idempotent', async () => {
    const original = 'TUSHARE_TOKEN=private-token\r\nLUOOME_MARKET_SOURCES="tushare,sina"\r\n';
    const { directory, path } = await fixture(original);
    const first = run(path);
    expect(first.status).toBe(0);
    expect(first.stderr).toBe('');
    expect(JSON.parse(first.stdout)).toEqual({
      changedKeys: ['TUSHARE_TOKEN', 'LUOOME_MARKET_SOURCES'],
      sourceCounts: { LUOOME_MARKET_SOURCES: 1, LUOOME_STOCK_UNIVERSE_SOURCES: 2 },
    });
    const files = await readdir(directory);
    const backups = files.filter((name) => name.startsWith('.env.backup-'));
    expect(backups).toHaveLength(1);
    expect(backups[0]).toMatch(/\.env\.backup-\d{4}-.*-[0-9a-f-]{36}$/);
    expect(files).toHaveLength(2);
    const backup = join(directory, backups[0]);
    expect(await readFile(backup, 'utf8')).toBe(original);
    expect((await stat(backup)).mode & 0o777).toBe(0o600);
    const before = await stat(path);
    expect(before.mode & 0o777).toBe(0o600);
    expect(await readFile(path, 'utf8')).toBe('LUOOME_MARKET_SOURCES="sina"\r\n');
    const second = run(path);
    expect(second.status).toBe(0);
    expect(JSON.parse(second.stdout).changedKeys).toEqual([]);
    expect(await readdir(directory)).toEqual(files);
    const after = await stat(path);
    expect(after.ino).toBe(before.ino);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(first.stdout + first.stderr + second.stdout + second.stderr).not.toContain(
      'private-token',
    );
  });

  it('leaves original bytes, permissions and directory untouched on validation failure', async () => {
    const original =
      'TUSHARE_TOKEN=do-not-log\r\nLUOOME_MARKET_SOURCES=tushare,secret-invalid-source\r\n';
    const { directory, path } = await fixture(original);
    const before = await stat(path);
    const child = run(path);
    expect(child.status).toBe(1);
    expect(child.stdout).toBe('');
    expect(JSON.parse(child.stderr)).toEqual({
      invalidKeys: ['LUOOME_MARKET_SOURCES'],
      errorCount: 1,
    });
    expect(child.stderr).not.toMatch(/do-not-log|secret-invalid-source/);
    expect(await readFile(path, 'utf8')).toBe(original);
    expect((await stat(path)).mode).toBe(before.mode);
    expect((await stat(path)).ino).toBe(before.ino);
    expect(await readdir(directory)).toEqual(['.env']);
  });

  it('uses only the selected home file, ignoring process source and credential overrides', async () => {
    const { directory, path } = await fixture('TUSHARE_URL=private\n');
    const child = run(path, [], {
      LUOOME_HOME: directory,
      LUOOME_MARKET_SOURCES: 'unknown',
      TUSHARE_TOKEN: 'process-secret',
    });
    expect(child.status).toBe(0);
    expect(await readFile(path, 'utf8')).toBe('');
    expect(child.stdout).not.toContain('process-secret');
  });

  it('reports IO and argument errors without printing paths or content', () => {
    const missing = run('/missing/private-path/.env');
    expect(missing.status).toBe(1);
    expect(missing.stdout).toBe('');
    expect(missing.stderr).toBe('{"invalidKeys":[],"errorCount":1}\n');
    const args = run('', ['--bad-option', 'private-value']);
    expect(args.status).toBe(1);
    expect(args.stderr).toBe('{"invalidKeys":[],"errorCount":1}\n');
  });
});
