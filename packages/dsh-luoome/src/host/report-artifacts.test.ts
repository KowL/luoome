import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createReportArtifacts } from './report-artifacts.js';

const dirs: string[] = [];
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'luoome-reports-'));
  dirs.push(dir);
  return join(dir, 'reports');
};

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('REQ-M3-08 报告交付物写盘载体', () => {
  it('creates the reports directory 0700 and writes the file 0600', async () => {
    const directory = tempDir();
    const writer = createReportArtifacts({ directory });
    const result = await writer.write({
      fileName: '2026-07-29-opening-all-accounts.md',
      content: '# 报告\n',
      overwrite: false,
    });
    expect(result.written).toBe(true);
    expect(result.path).toBe(join(directory, '2026-07-29-opening-all-accounts.md'));
    expect(statSync(directory).mode & 0o777).toBe(0o700);
    expect(statSync(result.path).mode & 0o777).toBe(0o600);
    expect(await writer.read('2026-07-29-opening-all-accounts.md')).toBe('# 报告\n');
  });

  it('is idempotent without overwrite and rewrites with it', async () => {
    const writer = createReportArtifacts({ directory: tempDir() });
    const first = await writer.write({ fileName: 'a.md', content: 'one', overwrite: false });
    const second = await writer.write({ fileName: 'a.md', content: 'two', overwrite: false });
    expect(first.written).toBe(true);
    expect(second.written).toBe(false);
    expect(await writer.read('a.md')).toBe('one');
    const third = await writer.write({ fileName: 'a.md', content: 'two', overwrite: true });
    expect(third.written).toBe(true);
    expect(await writer.read('a.md')).toBe('two');
  });

  it('leaves no temporary file behind (atomic rename)', async () => {
    const directory = tempDir();
    const writer = createReportArtifacts({ directory });
    await writer.write({ fileName: 'b.md', content: 'x', overwrite: false });
    expect(readdirSync(directory).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    expect(readdirSync(directory)).toEqual(['b.md']);
  });

  it('rejects file names carrying path fragments', async () => {
    const directory = tempDir();
    const writer = createReportArtifacts({ directory });
    for (const fileName of ['../escape.md', 'a/b.md', '.hidden.md', `${'x'.repeat(200)}.md`]) {
      await expect(
        writer.write({ fileName, content: 'x', overwrite: false }),
        fileName,
      ).rejects.toThrow(/invalid report artifact file name/);
    }
    expect(existsSync(join(directory, '..', 'escape.md'))).toBe(false);
  });

  it('returns null when reading a missing file', async () => {
    const writer = createReportArtifacts({ directory: tempDir() });
    expect(await writer.read('missing.md')).toBeNull();
  });
});
