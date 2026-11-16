import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { money } from '@luoome/core';
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createDrizzleRepos } from '../../client.js';
import { makeAdvice, makeNotification, makeWatchTrigger } from '../contract-tests.js';

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

it('checks Advice publication under the SQLite write lock and preserves historical rows on revocation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'luoome-advice-fence-'));
  const path = join(root, 'db.sqlite');
  const h = createDrizzleRepos(path),
    probe = createDrizzleRepos(path);
  probe.db.run(sql`PRAGMA busy_timeout = 0`);
  try {
    const history = makeAdvice('historical');
    await h.repos.advice.save(history);
    let checks = 0;
    const denied = () => {
      checks++;
      expect(() => probe.db.run(sql`BEGIN IMMEDIATE`)).toThrow();
      throw new Error('analysis revoked');
    };
    await expect(
      h.repos.withWriteGuard(denied, () => h.repos.advice.save(makeAdvice('new'))),
    ).rejects.toThrow('analysis revoked');
    await expect(
      h.repos.withWriteGuard(denied, () => h.repos.advice.save({ ...history, confidence: 99 })),
    ).rejects.toThrow('analysis revoked');
    expect(checks).toBe(2);
    expect(await h.repos.advice.findById('new')).toBeNull();
    expect(await h.repos.advice.findById(history.id)).toEqual(history);
  } finally {
    h.close();
    probe.close();
    rmSync(root, { recursive: true, force: true });
  }
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

it('strategy publication checks inside the write transaction and allows only failure finalization after revocation', async () => {
  const { makeStrategy, makeStrategyVersion, makeStrategyRun } = await import(
    '../contract-tests.js'
  );
  const root = mkdtempSync(join(tmpdir(), 'luoome-strategy-fence-'));
  const path = join(root, 'db.sqlite');
  const h = createDrizzleRepos(path),
    probe = createDrizzleRepos(path);
  probe.db.run(sql`PRAGMA busy_timeout = 0`);
  try {
    const version = makeStrategyVersion('strategy-1', 1, { publishedAt: new Date('2026-01-01') });
    await h.repos.strategy.create(
      makeStrategy('strategy-1', { status: 'active', currentVersionId: version.id }),
    );
    await h.repos.strategy.createVersion(version);
    const running = makeStrategyRun('revoked-strategy-run', {
      status: 'running',
      finishedAt: undefined,
      summary: undefined,
    });
    await h.repos.strategyRun.saveStartedRun(running);
    const denied = () => {
      expect(() => probe.db.run(sql`BEGIN IMMEDIATE`)).toThrow();
      throw new Error('revoked');
    };
    await expect(
      h.repos.withWriteGuard(denied, () =>
        h.repos.strategyRun.commitRun({
          run: makeStrategyRun(running.id, { startedAt: running.startedAt }),
          results: [],
          signals: [],
        }),
      ),
    ).rejects.toThrow('revoked');
    expect((await h.repos.strategyRun.findRunById(running.id))?.status).toBe('running');
    await h.repos.withWriteGuard(denied, () =>
      h.repos.strategyRun.commitRun({
        run: makeStrategyRun(running.id, {
          startedAt: running.startedAt,
          status: 'failed',
          error: 'revoked',
        }),
        results: [],
        signals: [],
      }),
    );
    expect((await h.repos.strategyRun.findRunById(running.id))?.status).toBe('failed');
    await expect(
      h.repos.withWriteGuard(denied, () =>
        h.repos.strategyRun.saveStartedRun({ ...running, id: 'new-revoked' }),
      ),
    ).rejects.toThrow('revoked');
    expect(await h.repos.strategyRun.findRunById('new-revoked')).toBeNull();
  } finally {
    h.close();
    probe.close();
    rmSync(root, { recursive: true, force: true });
  }
});

it('fences watch trigger/state/attempt writes and permits only a reserved receipt to finish after revocation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'luoome-watch-fence-'));
  const path = join(root, 'db.sqlite');
  const h = createDrizzleRepos(path),
    probe = createDrizzleRepos(path);
  probe.db.run(sql`PRAGMA busy_timeout = 0`);
  try {
    const trigger = makeWatchTrigger('watch', { deliveryStatus: 'pending', notified: false });
    const state = {
      poolId: trigger.poolId,
      stockId: trigger.stockId,
      ruleId: trigger.ruleId,
      active: true,
      lastEvaluatedAt: trigger.createdAt,
    };
    await h.repos.watchTrigger.save(trigger);
    const denied = () => {
      expect(() => probe.db.run(sql`BEGIN IMMEDIATE`)).toThrow();
      throw new Error('watch revoked');
    };
    for (const operation of [
      () => h.repos.watchTrigger.save({ ...trigger, id: 'late' }),
      () =>
        h.repos.watchTrigger.commitEvaluation({
          now: trigger.createdAt,
          triggers: [{ ...trigger, id: 'late' }],
          states: [state],
        }),
      () => h.repos.watchRuleState.upsertMany([state]),
      () => h.repos.watchTrigger.beginDelivery([trigger.id], trigger.createdAt, 'revoked'),
      () => h.repos.watchTrigger.setDeliveryStatus([trigger.id], 'sent'),
    ]) {
      await expect(
        h.repos.withWriteGuard(denied, async () => {
          await operation();
        }),
      ).rejects.toThrow('watch revoked');
    }
    expect(await h.repos.watchTrigger.findById('late')).toBeNull();
    expect(await h.repos.watchRuleState.listByPool(trigger.poolId)).toEqual([]);
    await h.repos.watchTrigger.beginDelivery([trigger.id], trigger.createdAt, 'reserved');
    expect(
      await h.repos.watchTrigger.completeDelivery([trigger.id], 'reserved', trigger.createdAt),
    ).toBe(false);
    await h.repos.notification.save(makeNotification('wrong'));
    expect(
      await h.repos.watchTrigger.completeDelivery([trigger.id], 'wrong', trigger.createdAt),
    ).toBe(false);
    await h.repos.notification.save(makeNotification('reserved'));
    expect(
      await h.repos.watchTrigger.completeDelivery(['missing'], 'reserved', trigger.createdAt),
    ).toBe(false);
    expect(
      await h.repos.withWriteGuard(denied, () =>
        h.repos.watchTrigger.completeDelivery([trigger.id], 'reserved', trigger.createdAt),
      ),
    ).toBe(true);
    expect(await h.repos.watchTrigger.findById(trigger.id)).toMatchObject({
      deliveryStatus: 'sent',
      notificationId: 'reserved',
      deliveryAttempts: 1,
    });
    expect(await h.repos.watchTrigger.listRecent({})).toHaveLength(1);
  } finally {
    h.close();
    probe.close();
    rmSync(root, { recursive: true, force: true });
  }
});
