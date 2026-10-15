import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PublicMarketStore } from '@luoome/core';
import { createDrizzlePublicMarketStore } from './public-market-client.js';
import { createMemoryPublicMarketStore } from './public-market-memory.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const root = () => {
  const path = mkdtempSync(join(tmpdir(), 'luoome-public-market-'));
  roots.push(path);
  return path;
};
const contract = (name: string, factory: () => PublicMarketStore) =>
  describe(name, () => {
    test('atomic updates roll back exceptions and expire at the same boundary', () => {
      const store = factory();
      expect(store.read('x', 0)).toBeNull();
      expect(store.update('x', 0, 100, () => ({ value: 'one', result: 'claimed' }))).toBe(
        'claimed',
      );
      expect(() =>
        store.update('x', 50, 200, (value) => {
          expect(value).toBe('one');
          throw new Error('rollback');
        }),
      ).toThrow('rollback');
      expect(store.read('x', 99)).toBe('one');
      expect(store.read('x', 100)).toBeNull();
      store.update('x', 100, 200, (value) => {
        expect(value).toBeNull();
        return { value: 'two', result: null };
      });
      expect(store.read('x', 101)).toBe('two');
    });
  });
contract('memory public market store', createMemoryPublicMarketStore);
contract('Drizzle public market store', () =>
  createDrizzlePublicMarketStore(join(root(), 'public.sqlite')),
);

test('independent Web/worker processes coalesce stock requests and keep a single persisted HTTP quota', async () => {
  const directory = root();
  const database = join(directory, 'public.sqlite');
  const log = join(directory, 'http.log');
  const client = new URL('./public-market-client.ts', import.meta.url).pathname;
  const coordinator = new URL(
    '../../../adapters/src/market/request-coordinator.ts',
    import.meta.url,
  ).pathname;
  const script = `
    import { appendFileSync } from 'node:fs';
    import { createDrizzlePublicMarketStore } from ${JSON.stringify(client)};
    import { MarketRequestCoordinator, marketRequestConfigFromEnv } from ${JSON.stringify(coordinator)};
    const c = new MarketRequestCoordinator(createDrizzlePublicMarketStore(${JSON.stringify(database)}), { ...marketRequestConfigFromEnv({}), requestsPerWindow: 3 });
    const http = c.fetchFor('eastmoney', async () => {
      appendFileSync(${JSON.stringify(log)}, 'attempt\\n');
      await Bun.sleep(50);
      return new Response('{}');
    });
    const handle = { source: 'eastmoney', capability: 'quote', coverage: [], execute: async ({ stockId }) => {
      await http('https://fixture.invalid');
      const time = new Date('2026-10-15T02:00:00Z');
      return { stockId, source: 'eastmoney', observedAt: time, fetchedAt: time, ts: time, timestampSource: 'upstream', open: 10, high: 11, low: 9, close: 10, volume: 100 };
    }};
    const common = await c.execute(handle, { stockId: 'shared.SH' });
    const others = await Promise.allSettled(Array.from({ length: 10 }, (_, i) => c.execute(handle, { stockId: process.pid + '-' + i })));
    process.stdout.write(JSON.stringify({ common: common.stockId, asOf: common.observedAt.toISOString(), successes: others.filter((x) => x.status === 'fulfilled').length }));
  `;
  const children = Array.from({ length: 4 }, () =>
    Bun.spawn([process.execPath, '--no-env-file', '--eval', script], {
      stdout: 'pipe',
      stderr: 'pipe',
    }),
  );
  const results = await Promise.all(
    children.map(async (child) => {
      const [output, error, exit] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(error).toBe('');
      expect(exit).toBe(0);
      return JSON.parse(output) as { common: string; asOf: string; successes: number };
    }),
  );
  expect(
    results.every(
      (result) => result.common === 'shared.SH' && result.asOf === '2026-10-15T02:00:00.000Z',
    ),
  ).toBe(true);
  expect(results.reduce((sum, result) => sum + result.successes, 0)).toBe(2);
  expect(readFileSync(log, 'utf8').trim().split('\n')).toHaveLength(3);
  const reopened = createDrizzlePublicMarketStore(database);
  expect(reopened.read('provider:eastmoney', Date.now())).not.toBeNull();
});
