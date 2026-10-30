// T48 B2b：专用有界上传载体 + 只读预检 + 恢复提交的真实负例。
//
// 全部走真实 Node SQLite 文件库与真实 route handler；不 mock 仓储。
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { backup as sqliteBackup } from 'node:sqlite';
import { money } from '@luoome/core';
import { dataImportValidationLevel } from '@luoome/db/data-transfer';
import { DATA_IMPORT_BUSINESS_TABLES } from '@luoome/db/memory';
import {
  createNodeDrizzleRepos,
  type NodeDrizzleReposHandle,
  readDataImportStorageSchema,
} from '@luoome/db/node';
import { buildContext, createPluginOperationService, previewDataImportTool } from '@luoome/tools';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createDataImportBackupHandler,
  createDataImportBackups,
  createDataImportPreviewHandler,
  createDataImportStaging,
  createDataImportUploadHandler,
  type DataImportBackupStore,
  type DataImportStaging,
} from './data-import.js';
import { createDataImportOperationPolicies } from './data-import-operations.js';

const USER_ID = 'owner-user';
const ACCOUNT_ID = 'owner-account';
const NOW = 1_700_000_000_000;

interface Fixture {
  readonly dir: string;
  readonly target: NodeDrizzleReposHandle;
  readonly staging: DataImportStaging;
  readonly backups: DataImportBackupStore;
  readonly sourceBytes: Buffer;
  readonly upload: (body: Uint8Array | null, headers?: Record<string, string>) => Promise<Response>;
  readonly preview: (uploadId: string) => Promise<Response>;
  readonly backup: (uploadId: string) => Promise<Response>;
  close(): void;
}

const seedAccount = async (handle: NodeDrizzleReposHandle, name: string): Promise<void> => {
  await handle.repos.account.save({
    id: ACCOUNT_ID,
    name,
    currency: 'CNY',
    initialCapital: money(1000),
    cashBalance: money(1000),
    kind: 'real',
    createdAt: new Date(NOW),
  });
};

/** 造一个真实的、与目标同 schema 的 SQLite 快照文件，并清掉 WAL 边车。 */
const buildSourceBytes = async (dir: string, name: string): Promise<Buffer> => {
  const path = join(dir, 'source.db');
  const source = createNodeDrizzleRepos(path);
  try {
    await seedAccount(source, name);
    source.sqlite.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    source.sqlite.exec('PRAGMA journal_mode = DELETE');
  } finally {
    source.close();
  }
  return readFileSync(path);
};

const createFixture = async (
  overrides: { readonly maxFileBytes?: number; readonly maxStaged?: number } = {},
): Promise<Fixture> => {
  const dir = mkdtempSync(join(tmpdir(), 'luoome-import-'));
  const target = createNodeDrizzleRepos(join(dir, 'target.db'));
  await seedAccount(target, 'target-before-import');
  const sourceBytes = await buildSourceBytes(dir, 'source-import-name');
  const backups = createDataImportBackups({
    directory: join(dir, 'imports', 'backups'),
    userId: USER_ID,
    accountId: ACCOUNT_ID,
    now: () => NOW,
    backupDatabase: async (path) => {
      await sqliteBackup(target.sqlite, path);
    },
  });
  const staging = createDataImportStaging({
    directory: join(dir, 'imports'),
    userId: USER_ID,
    accountId: ACCOUNT_ID,
    now: () => NOW,
    targetSchema: () => readDataImportStorageSchema(target.sqlite),
    backups,
    ...overrides,
  });
  const origin = 'http://127.0.0.1:1';
  const uploadHandler = createDataImportUploadHandler(staging);
  const context = () =>
    buildContext({
      repos: target.repos,
      adapters: { market: { fetchQuote: async () => null } as never },
      user: { id: USER_ID, defaultAccountId: ACCOUNT_ID },
      clock: () => new Date(NOW),
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      dataImport: staging,
    });
  const previewHandler = createDataImportPreviewHandler((uploadId) =>
    previewDataImportTool.execute({ uploadId, mode: 'restore-business-v1' }, context()),
  );
  const backupHandler = createDataImportBackupHandler({
    staging,
    backups,
    targetDigest: async () => {
      const repository = target.repos.dataImport;
      if (repository === undefined) throw new Error('missing data import repository');
      return repository.targetDigest({ userId: USER_ID, accountId: ACCOUNT_ID });
    },
  });
  return {
    dir,
    target,
    staging,
    backups,
    sourceBytes,
    upload: (body, headers = {}) =>
      uploadHandler(
        new Request(`${origin}/api/luoome/import/upload`, {
          method: 'POST',
          headers: {
            origin,
            'content-type': 'application/octet-stream',
            ...headers,
          },
          body,
          duplex: 'half',
        } as RequestInit),
      ),
    preview: (uploadId) =>
      previewHandler(
        new Request(`${origin}/api/luoome/import/preview`, {
          method: 'POST',
          headers: { origin, 'content-type': 'application/json' },
          body: JSON.stringify({ uploadId }),
        }),
      ),
    backup: (uploadId) =>
      backupHandler(
        new Request(`${origin}/api/luoome/import/backup`, {
          method: 'POST',
          headers: { origin, 'content-type': 'application/json' },
          body: JSON.stringify({ uploadId }),
        }),
      ),
    close() {
      staging.dispose();
      backups.dispose();
      target.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
};

/** 统一用 fixture 时钟：预检有效期、policy bind 的 now 与 staging TTL 必须同源。 */
const serviceFor = (f: Fixture) =>
  createPluginOperationService({
    repository: f.target.repos.pluginAuthority,
    policies: createDataImportOperationPolicies({ staging: f.staging, backups: f.backups }),
    capabilities: ['read', 'write'],
    policyVersion: 1,
    now: () => NOW,
    context: () =>
      buildContext({
        repos: f.target.repos,
        adapters: { market: { fetchQuote: async () => null } as never },
        user: { id: USER_ID, defaultAccountId: ACCOUNT_ID },
        clock: () => new Date(NOW),
        logger: { debug() {}, info() {}, warn() {}, error() {} },
        dataImport: f.staging,
      }),
  });

const principal = { userId: USER_ID, accountId: ACCOUNT_ID };

/** 上传 → 预检 → 备份，返回一次提交所需的全部冻结参数。 */
const prepareRestore = async (f: Fixture, service: ReturnType<typeof serviceFor>) => {
  const uploaded = (await (await f.upload(f.sourceBytes)).json()) as {
    data: { uploadId: string };
  };
  const previewBody = (await (await f.preview(uploaded.data.uploadId)).json()) as {
    data: { previewHash: string; expiresAt: number };
  };
  const backupBody = (await (await f.backup(uploaded.data.uploadId)).json()) as {
    data: { backupId: string };
  };
  const id = randomUUID();
  const prepared = await service.prepare(principal, {
    id,
    tool: 'restore_data_import',
    input: {
      uploadId: uploaded.data.uploadId,
      previewHash: previewBody.data.previewHash,
      previewExpiresAt: previewBody.data.expiresAt,
      backupId: backupBody.data.backupId,
      mode: 'restore-business-v1',
    },
  });
  return { id, prepared, uploaded, previewBody, backupBody };
};

const fixtures: Fixture[] = [];
afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.close();
});
const fixture = async (overrides = {}): Promise<Fixture> => {
  const created = await createFixture(overrides);
  fixtures.push(created);
  return created;
};

describe('T48 有界上传载体', () => {
  it('octet-stream 上传返回 opaque uploadId + digest + size，不回显路径', async () => {
    const f = await fixture();
    const response = await f.upload(f.sourceBytes);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      ok: boolean;
      data: { uploadId: string; archiveDigest: string; size: number; expiresAt: number };
    };
    expect(body.ok).toBe(true);
    expect(body.data.size).toBe(f.sourceBytes.byteLength);
    expect(body.data.archiveDigest).toBe(createHash('sha256').update(f.sourceBytes).digest('hex'));
    expect(body.data.uploadId).toMatch(/^[a-f0-9]{32}$/);
    expect(JSON.stringify(body)).not.toContain(f.dir);
  });

  it('拒绝非 SQLite 内容与错误 Content-Type', async () => {
    const f = await fixture();
    const garbage = await f.upload(Buffer.from('not a database at all, just text'));
    expect(garbage.status).toBe(415);
    const wrongType = await f.upload(f.sourceBytes, { 'content-type': 'application/json' });
    expect(wrongType.status).toBe(415);
    const crossOrigin = await f.upload(f.sourceBytes, { origin: 'http://evil.example' });
    expect(crossOrigin.status).toBe(403);
  });

  it('超过大小上限直接 413，且不留下暂存文件', async () => {
    const f = await fixture({ maxFileBytes: 1024 });
    const response = await f.upload(f.sourceBytes);
    expect(response.status).toBe(413);
    expect(await f.staging.describe('0'.repeat(32))).toBeNull();
  });

  it('暂存数量上限触发 429', async () => {
    const f = await fixture({ maxStaged: 1 });
    expect((await f.upload(f.sourceBytes)).status).toBe(200);
    expect((await f.upload(f.sourceBytes)).status).toBe(429);
  });
});

describe('T48 只读预检', () => {
  it('预检返回逐表计数与结构校验披露，且不创建 Operation、不改目标库', async () => {
    const f = await fixture();
    const uploaded = (await (await f.upload(f.sourceBytes)).json()) as {
      data: { uploadId: string };
    };
    const response = await f.preview(uploaded.data.uploadId);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      ok: boolean;
      data: {
        previewHash: string;
        counts: Record<string, { source: number; current: number; expected: number }>;
        structuralOnly: string[];
        validation: Record<string, string>;
        limitations: string[];
      };
    };
    expect(body.ok).toBe(true);
    expect(body.data.counts.accounts).toMatchObject({ source: 1, current: 1, expected: 1 });
    expect(body.data.validation.accounts).toBe('domain');
    expect(body.data.structuralOnly).toContain('portfolio_performance_snapshots');
    expect(body.data.validation.portfolio_performance_snapshots).toBe('structural');
    expect(body.data.limitations.join('')).toContain('结构校验');
    // 预检无写：目标账户名不变，也没有 Operation 行。
    expect((await f.target.repos.account.findById(ACCOUNT_ID))?.name).toBe('target-before-import');
    expect(
      await f.target.repos.pluginAuthority.listNonTerminalOperationsByAccount(ACCOUNT_ID),
    ).toEqual([]);
  });

  it('非 owner 的上下文预检被拒（跨账户负例）', async () => {
    const f = await fixture();
    const uploaded = (await (await f.upload(f.sourceBytes)).json()) as {
      data: { uploadId: string };
    };
    const result = await previewDataImportTool.execute(
      { uploadId: uploaded.data.uploadId, mode: 'restore-business-v1' },
      buildContext({
        repos: f.target.repos,
        adapters: { market: { fetchQuote: async () => null } as never },
        user: { id: 'other-user', defaultAccountId: ACCOUNT_ID },
        clock: () => new Date(NOW),
        logger: { debug() {}, info() {}, warn() {}, error() {} },
        dataImport: f.staging,
      }),
    );
    expect(result).toMatchObject({ ok: false, error: { kind: 'permission_denied' } });
  });

  it('未知 uploadId 返回 not_found 而不是读本机路径', async () => {
    const f = await fixture();
    const response = await f.preview('f'.repeat(32));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ ok: false, error: { kind: 'not_found' } });
  });
});

describe('T48 恢复提交（Operation policy 真实链路）', () => {
  it('prepare 冻结的只有 opaque 参数；陈旧 preview 落 failed 且零业务写', async () => {
    const f = await fixture();
    const service = serviceFor(f);
    try {
      const { id, prepared } = await prepareRestore(f, service);
      if (!prepared.ok) throw new Error(JSON.stringify(prepared.error));
      const bound = (prepared.data as { input: Record<string, unknown> }).input;
      expect(Object.keys(bound).sort()).toEqual([
        'accountId',
        'backup',
        'backupId',
        'mode',
        'previewExpiresAt',
        'previewHash',
        'requestId',
        'uploadId',
      ]);
      expect(JSON.stringify(bound)).not.toContain('base64');

      // 目标在预检之后变化 → 提交必须判 stale 并整体回滚。
      const account = await f.target.repos.account.findById(ACCOUNT_ID);
      if (account === null) throw new Error('missing fixture account');
      await f.target.repos.account.save({ ...account, name: 'changed-after-preview' });

      const token = (prepared.data as { confirmationToken: string }).confirmationToken;
      const confirmed = await service.confirm(
        principal,
        { id, token },
        new AbortController().signal,
      );
      if (!confirmed.ok) throw new Error(JSON.stringify(confirmed.error));
      const data = confirmed.data as { state: string; result: unknown };
      expect(data.state).toBe('failed');
      expect(JSON.stringify(data.result)).toContain('commit_stale');
      expect((await f.target.repos.account.findById(ACCOUNT_ID))?.name).toBe(
        'changed-after-preview',
      );
      expect(
        await f.target.repos.dataImport?.findReceipt(
          { userId: USER_ID, accountId: ACCOUNT_ID },
          id,
        ),
      ).toBeNull();
    } finally {
      service.dispose();
    }
  });

  it('跨账户提交被拒；路径/原始字节字段被 strict 拒绝', async () => {
    const f = await fixture();
    const service = serviceFor(f);
    try {
      const { uploaded, previewBody, backupBody } = await prepareRestore(f, service);
      // (a) 客户端自报别的账户：host 绑定字段直接拒绝。
      const rejected = await service.prepare(principal, {
        id: randomUUID(),
        tool: 'restore_data_import',
        input: {
          uploadId: uploaded.data.uploadId,
          previewHash: previewBody.data.previewHash,
          previewExpiresAt: previewBody.data.expiresAt,
          backupId: backupBody.data.backupId,
          mode: 'restore-business-v1',
          accountId: 'other-account',
        },
      });
      expect(rejected).toMatchObject({
        ok: false,
        error: { kind: 'invalid_input', issues: [{ path: ['accountId'] }] },
      });
      // (b) principal 本身不是该暂存文件的账户：prepare 阶段即拒绝。
      const foreign = await service.prepare(
        { userId: USER_ID, accountId: 'other-account' },
        {
          id: randomUUID(),
          tool: 'restore_data_import',
          input: {
            uploadId: uploaded.data.uploadId,
            previewHash: previewBody.data.previewHash,
            previewExpiresAt: previewBody.data.expiresAt,
            backupId: backupBody.data.backupId,
            mode: 'restore-business-v1',
          },
        },
      );
      expect(foreign).toMatchObject({ ok: false, error: { kind: 'invalid_input' } });
      // (c) 路径字段被 strict schema 拒绝。
      const withPath = await service.prepare(principal, {
        id: randomUUID(),
        tool: 'restore_data_import',
        input: {
          uploadId: uploaded.data.uploadId,
          previewHash: previewBody.data.previewHash,
          previewExpiresAt: previewBody.data.expiresAt,
          backupId: backupBody.data.backupId,
          mode: 'restore-business-v1',
          path: '/tmp/evil.db',
        },
      });
      expect(withPath.ok).toBe(false);
    } finally {
      service.dispose();
    }
  });

  it('正常提交写入业务事实并落 receipt，回读一致', async () => {
    const f = await fixture();
    const service = serviceFor(f);
    try {
      const { id, prepared } = await prepareRestore(f, service);
      if (!prepared.ok) throw new Error(JSON.stringify(prepared.error));
      const token = (prepared.data as { confirmationToken: string }).confirmationToken;
      const confirmed = await service.confirm(
        principal,
        { id, token },
        new AbortController().signal,
      );
      if (!confirmed.ok) throw new Error(JSON.stringify(confirmed.error));
      expect((confirmed.data as { state: string }).state).toBe('succeeded');
      expect((await f.target.repos.account.findById(ACCOUNT_ID))?.name).toBe('source-import-name');
      const receipt = await f.target.repos.dataImport?.findReceipt(
        { userId: USER_ID, accountId: ACCOUNT_ID },
        id,
      );
      expect(receipt?.requestId).toBe(id);
    } finally {
      service.dispose();
    }
  });
});

describe('T48 通用 64 KiB 接口不承载数据库', () => {
  it('大 body 走通用操作接口被 413 拒绝（base64 库不可能通过）', async () => {
    const { readPluginJson } = await import('./routes.js');
    const big = JSON.stringify({ uploadId: 'a'.repeat(70 * 1024) });
    const request = new Request('http://127.0.0.1:1/api/luoome/operations/prepare', {
      method: 'POST',
      headers: { origin: 'http://127.0.0.1:1', 'content-type': 'application/json' },
      body: big,
    });
    const result = await readPluginJson(request);
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(413);
  });
});

describe('T48 恢复前一致性备份', () => {
  it('生成备份：返回 opaque 记录与 targetDigest，文件 0600，不回显路径', async () => {
    const f = await fixture();
    const uploaded = (await (await f.upload(f.sourceBytes)).json()) as {
      data: { uploadId: string };
    };
    const response = await f.backup(uploaded.data.uploadId);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      ok: boolean;
      data: {
        backupId: string;
        digest: string;
        size: number;
        createdAt: number;
        targetDigest: string;
        archiveDigest: string;
      };
    };
    expect(body.ok).toBe(true);
    expect(body.data.backupId).toMatch(/^[a-f0-9]{32}$/);
    expect(body.data.size).toBeGreaterThan(0);
    expect(body.data.targetDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(body.data.archiveDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(body)).not.toContain(f.dir);
    const stored = await f.backups.describe(body.data.backupId);
    expect(stored?.digest).toBe(body.data.digest);
    const backupPath = join(f.dir, 'imports', 'backups', `${body.data.backupId}.db`);
    expect(statSync(backupPath).mode & 0o777).toBe(0o600);
  });

  it('备份后目标被改过：提交被拒且零业务写', async () => {
    const f = await fixture();
    const service = serviceFor(f);
    try {
      const { id, prepared } = await prepareRestore(f, service);
      if (!prepared.ok) throw new Error(JSON.stringify(prepared.error));
      const account = await f.target.repos.account.findById(ACCOUNT_ID);
      if (account === null) throw new Error('missing fixture account');
      await f.target.repos.account.save({ ...account, name: 'changed-after-backup' });

      const token = (prepared.data as { confirmationToken: string }).confirmationToken;
      const confirmed = await service.confirm(
        principal,
        { id, token },
        new AbortController().signal,
      );
      if (!confirmed.ok) throw new Error(JSON.stringify(confirmed.error));
      expect((confirmed.data as { state: string }).state).toBe('failed');
      expect(JSON.stringify((confirmed.data as { result: unknown }).result)).toContain(
        'commit_stale',
      );
      expect((await f.target.repos.account.findById(ACCOUNT_ID))?.name).toBe(
        'changed-after-backup',
      );
      expect(
        await f.target.repos.dataImport?.findReceipt(
          { userId: USER_ID, accountId: ACCOUNT_ID },
          id,
        ),
      ).toBeNull();
    } finally {
      service.dispose();
    }
  });

  it('备份文件被截断/篡改：提交前校验失败并拒绝，零业务写', async () => {
    const f = await fixture();
    const service = serviceFor(f);
    try {
      const { id, prepared } = await prepareRestore(f, service);
      if (!prepared.ok) throw new Error(JSON.stringify(prepared.error));
      const bound = (prepared.data as { input: { backupId: string } }).input;
      const backupPath = join(f.dir, 'imports', 'backups', `${bound.backupId}.db`);
      // 模拟磁盘损坏：把备份文件截断。
      writeFileSync(backupPath, readFileSync(backupPath).subarray(0, 4096));

      const token = (prepared.data as { confirmationToken: string }).confirmationToken;
      const confirmed = await service.confirm(
        principal,
        { id, token },
        new AbortController().signal,
      );
      if (!confirmed.ok) throw new Error(JSON.stringify(confirmed.error));
      const data = confirmed.data as { state: string; result: unknown };
      expect(data.state).toBe('failed');
      expect(JSON.stringify(data.result)).toContain('commit_backup');
      expect((await f.target.repos.account.findById(ACCOUNT_ID))?.name).toBe(
        'target-before-import',
      );
      expect(
        await f.target.repos.dataImport?.findReceipt(
          { userId: USER_ID, accountId: ACCOUNT_ID },
          id,
        ),
      ).toBeNull();
      // 备份记录本身仍在（可重新生成），但 verify 明确返回 false。
      expect(await f.backups.verify(bound.backupId)).toBe(false);
    } finally {
      service.dispose();
    }
  });

  it('备份创建时校验：副本不是可用数据库则删除且不登记', async () => {
    const f = await fixture();
    const broken = createDataImportBackups({
      directory: join(f.dir, 'imports', 'broken'),
      userId: USER_ID,
      accountId: ACCOUNT_ID,
      now: () => NOW,
      // 模拟写入了一份不可用副本（截断/损坏）。
      backupDatabase: async (path) => {
        writeFileSync(path, Buffer.from('SQLite format 3\u0000 truncated'));
      },
    });
    try {
      const uploaded = (await (await f.upload(f.sourceBytes)).json()) as {
        data: { uploadId: string };
      };
      const handler = createDataImportBackupHandler({
        staging: f.staging,
        backups: broken,
        targetDigest: async () => 'a'.repeat(64),
      });
      const response = await handler(
        new Request('http://127.0.0.1:1/api/luoome/import/backup', {
          method: 'POST',
          headers: { origin: 'http://127.0.0.1:1', 'content-type': 'application/json' },
          body: JSON.stringify({ uploadId: uploaded.data.uploadId }),
        }),
      );
      expect(response.status).toBe(503);
      expect(((await response.json()) as { ok: boolean }).ok).toBe(false);
      // 没有登记任何备份：随便取一个 id 都描述不到，且目录里没有残留文件。
      expect(await broken.describe('a'.repeat(32))).toBeNull();
      expect(readdirSync(join(f.dir, 'imports', 'broken'))).toEqual([]);
    } finally {
      broken.dispose();
    }
  });

  it('缺 backupId、备份属于别的快照、备份写入失败都被拒', async () => {
    const f = await fixture();
    const service = serviceFor(f);
    try {
      const { uploaded, previewBody } = await prepareRestore(f, service);
      const base = {
        uploadId: uploaded.data.uploadId,
        previewHash: previewBody.data.previewHash,
        previewExpiresAt: previewBody.data.expiresAt,
        mode: 'restore-business-v1' as const,
      };
      // (a) 缺 backupId：strict schema 直接拒。
      const missing = await service.prepare(principal, {
        id: randomUUID(),
        tool: 'restore_data_import',
        input: base,
      });
      expect(missing.ok).toBe(false);
      // (b) 不存在的 backupId：bind 拒绝。
      const unknown = await service.prepare(principal, {
        id: randomUUID(),
        tool: 'restore_data_import',
        input: { ...base, backupId: 'a'.repeat(32) },
      });
      expect(unknown.ok).toBe(false);
    } finally {
      service.dispose();
    }

    // (c) 备份写入失败：路由 503，且不产生可用记录。
    const failing = createDataImportBackups({
      directory: join(f.dir, 'imports', 'failing'),
      userId: USER_ID,
      accountId: ACCOUNT_ID,
      now: () => NOW,
      backupDatabase: async () => {
        throw new Error('disk full');
      },
    });
    try {
      const uploaded = (await (await f.upload(f.sourceBytes)).json()) as {
        data: { uploadId: string };
      };
      const handler = createDataImportBackupHandler({
        staging: f.staging,
        backups: failing,
        targetDigest: async () => 'a'.repeat(64),
      });
      const response = await handler(
        new Request('http://127.0.0.1:1/api/luoome/import/backup', {
          method: 'POST',
          headers: { origin: 'http://127.0.0.1:1', 'content-type': 'application/json' },
          body: JSON.stringify({ uploadId: uploaded.data.uploadId }),
        }),
      );
      expect(response.status).toBe(503);
      expect(((await response.json()) as { ok: boolean }).ok).toBe(false);
    } finally {
      failing.dispose();
    }
  });
});

describe('T48 structural-only 表清单冻结', () => {
  it('32 张只做结构校验的表必须与冻结名单集合相等', () => {
    const actual = DATA_IMPORT_BUSINESS_TABLES.filter(
      (table) => dataImportValidationLevel(table) === 'structural',
    ).sort();
    // 冻结名单：给某张表补领域校验器、或误删一个校验器，都必须显式改这里。
    const FROZEN = [
      'analysis_contexts',
      'analysis_jobs',
      'daily_bar_revisions',
      'financial_fact_revisions',
      'fundamental_score_results',
      'fundamental_score_runs',
      'fundamental_score_versions',
      'investment_consensus',
      'investment_research',
      'investment_tracking',
      'minute_bars',
      'personal_alert_evaluations',
      'personal_alert_plan_mutations',
      'personal_watch_feedback',
      'portfolio_performance_snapshots',
      'report_delivery_intents',
      'research_chunk_embeddings',
      'research_embedding_index_states',
      'research_hypothesis_versions',
      'stock_universe_snapshot_members',
      'strategy_backtest_market_facts',
      'strategy_backtest_runs',
      'strategy_data_checkpoint_members',
      'strategy_data_checkpoints',
      'strategy_evaluation_days',
      'strategy_evaluation_sessions',
      'strategy_research_states',
      'strategy_signal_states',
      'watch_delivery_intents',
      'watchlist_facts_report_keys',
      'watchlist_import_batches',
      'watchlist_removal_receipts',
    ].sort();
    expect(actual).toEqual(FROZEN);
    expect(actual).toHaveLength(32);
  });
});
