import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { money } from '@luoome/core';
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createDrizzleRepos } from '../../client.js';

const bar = (close: number) => ({
  stockId: '002594.SZ',
  date: new Date('2026-11-11'),
  open: money(close),
  high: money(close),
  low: money(close),
  close: money(close),
  volume: 100,
  adjustment: 'qfq' as const,
  source: 'fixture',
});

describe('SQLite publication fences', () => {
  it('checks after acquiring the real writer lock, so late A cannot overwrite committed B', async () => {
    const root = mkdtempSync(join(tmpdir(), 'luoome-write-fence-'));
    const path = join(root, 'db.sqlite');
    const checked = join(root, 'checked');
    const revoked = join(root, 'revoked');
    const handle = createDrizzleRepos(path);
    let child: ReturnType<typeof Bun.spawn> | undefined;
    try {
      const script = join(root, 'late.ts');
      const module = new URL('../../client.ts', import.meta.url).pathname;
      writeFileSync(
        script,
        `import {createDrizzleRepos} from ${JSON.stringify(module)};
        import {existsSync,writeFileSync} from 'node:fs';
        const h=createDrizzleRepos(${JSON.stringify(path)},{migrate:false});
        console.log('ready');await Bun.stdin.text();console.log('attempting');
        try {
          await h.repos.withWriteGuard(()=>{
            writeFileSync(${JSON.stringify(checked)},'checked');
            if(existsSync(${JSON.stringify(revoked)}))throw new Error('revoked');
          },()=>h.repos.dailyBar.saveMany([{
            ...${JSON.stringify(bar(10))},date:new Date('2026-11-11')
          }]));process.exitCode=2;
        } catch(e) {if(e.message!=='revoked')throw e;}
        finally {h.close();}`,
      );
      child = Bun.spawn(['bun', '--no-env-file', script], {
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const reader = (child.stdout as ReadableStream<Uint8Array>).getReader();
      const ready = await reader.read();
      expect(new TextDecoder().decode(ready.value)).toContain('ready');
      handle.db.run(sql`BEGIN IMMEDIATE`);
      if (typeof child.stdin === 'number' || child.stdin === undefined)
        throw new Error('missing input pipe');
      child.stdin.write('go');
      child.stdin.end();
      const attempt = await reader.read();
      expect(new TextDecoder().decode(attempt.value)).toContain('attempting');
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(existsSync(checked)).toBe(false);
      writeFileSync(revoked, 'revoked');
      await handle.repos.dailyBar.saveMany([bar(20)]);
      handle.db.run(sql`COMMIT`);
      expect(await child.exited).toBe(0);
      expect(existsSync(checked)).toBe(true);
      expect(
        (await handle.repos.dailyBar.latestBefore('002594.SZ', new Date('2026-11-12'), 1))[0]
          ?.close,
      ).toBe(20);
    } finally {
      child?.kill();
      handle.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('shares public market CAS state across connections, expires entries and rolls back failed changes', () => {
    const root = mkdtempSync(join(tmpdir(), 'luoome-market-store-'));
    const path = join(root, 'db.sqlite');
    const a = createDrizzleRepos(path),
      b = createDrizzleRepos(path);
    try {
      expect(
        a.repos.publicMarket.update('public', 1, 10, () => ({ value: 'one', result: 1 })),
      ).toBe(1);
      expect(b.repos.publicMarket.read('public', 2)).toBe('one');
      expect(
        b.repos.publicMarket.update('public', 2, 10, (value) => ({
          value: `${value}-two`,
          result: value,
        })),
      ).toBe('one');
      expect(() =>
        a.repos.publicMarket.update('public', 3, 10, () => {
          throw new Error('rollback');
        }),
      ).toThrow('rollback');
      expect(a.repos.publicMarket.read('public', 9)).toBe('one-two');
      expect(a.repos.publicMarket.read('public', 10)).toBeNull();
      expect(
        b.repos.publicMarket.update('public', 10, 20, (value) => ({ value: 'new', result: value })),
      ).toBeNull();
    } finally {
      a.close();
      b.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
