// T48 B2a 账户级互斥 gate 的真实 fixture。
//
// 全部用例用**真实** `createPluginOperationService` + 真实 `InMemoryPluginAuthorityRepository`
// + 真实 `InMemoryDataImportRepository`，只把「业务事实账本」换成测试内存库。
// 每个暂停点都是显式 Promise barrier（不 sleep、不靠超时推断），release 放在 finally。
import { randomUUID } from 'node:crypto';
import {
  DATA_IMPORT_PREVIEW_TTL_MS,
  DataImportError,
  type DataImportSnapshot,
  type DataImportStorageSchema,
  type DataImportTables,
  type PluginOperation,
  type ToolContext,
  type ToolResult,
} from '@luoome/core';
import {
  createInMemoryRepos,
  DATA_IMPORT_BUSINESS_TABLES,
  InMemoryDataImportRepository,
} from '@luoome/db/memory';
import {
  CloseHoldingInput,
  type ConfirmablePluginTool,
  closeHoldingTool,
  createPluginOperationService,
  defineTool,
} from '@luoome/tools';
import { buildTestContext } from '@luoome/tools/testing';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

const NOW = 1_000_000;
const USER_ID = 'owner-user';
const accountRow = (accountId: string, name: string) => ({
  id: accountId,
  name,
  kind: 'real',
  currency: 'CNY',
  initial_capital: 1000,
  cash_balance: 1000,
  created_at: 1000,
});
const tables = (accountId: string, name: string): DataImportTables => ({
  ...Object.fromEntries(DATA_IMPORT_BUSINESS_TABLES.map((table) => [table, []])),
  accounts: [accountRow(accountId, name)],
});
const storageSchema = (): DataImportStorageSchema =>
  Object.fromEntries(
    DATA_IMPORT_BUSINESS_TABLES.map((table) => [
      table,
      {
        columns: [{ name: 'id', type: 'TEXT', notNull: true, primaryKey: 1, hidden: 0 }],
        indexes: [],
      },
    ]),
  );
const snapshotFor = (accountId: string): DataImportSnapshot => ({
  format: 'sqlite',
  manifestVersion: 1,
  archiveDigest: 'a'.repeat(64),
  schema: storageSchema(),
  tables: tables(accountId, 'source-import-name'),
  ignoredCounts: {},
});

/** 确定性 drain：只把微任务与已就绪的宏任务跑完，不等待任何时长。 */
const drain = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

const operation = (
  accountId: string,
  id: string,
  patch: Partial<PluginOperation> = {},
): PluginOperation =>
  ({
    id,
    userId: USER_ID,
    accountId,
    tool: 'close_holding',
    inputJson: '{}',
    inputHash: 'a'.repeat(64),
    policyVersion: 1,
    requiredCapabilities: ['write'],
    authorization: { kind: 'human', tokenHash: 'b'.repeat(64) },
    state: 'pending',
    claimToken: null,
    resultJson: null,
    createdAt: NOW - 1000,
    updatedAt: NOW - 1000,
    expiresAt: NOW + 600_000,
    ...patch,
  }) as PluginOperation;

const restoreInput = z
  .object({
    uploadId: z.string().min(1),
    previewHash: z.string().min(1),
    previewExpiresAt: z.number().int().positive(),
    backupId: z.string().min(1),
    backup: z
      .object({
        backupId: z.string().min(1),
        archiveDigest: z.string().min(1),
        targetDigest: z.string().min(1),
      })
      .strict()
      .optional(),
  })
  .strict();

interface Harness {
  readonly ctx: ToolContext;
  readonly service: ReturnType<typeof createPluginOperationService>;
  readonly dataImport: InMemoryDataImportRepository;
  readonly accountId: string;
  readonly principal: { readonly userId: string; readonly accountId: string };
  readonly scope: { readonly userId: string; readonly accountId: string };
  readonly previewHash: string;
  readonly previewExpiresAt: number;
  readonly observed: {
    selfExecuting: boolean;
    holdersDuringCommit: number;
    peakDuringCommit: number;
  };
  readonly prepareImport: () => Promise<{ id: string; token: string }>;
  readonly runImport: () => Promise<ToolResult<unknown>>;
  readonly dispose: () => void;
}

const buildHarness = async (
  options: {
    readonly closeBindBarrier?: () => Promise<void>;
    readonly businessBarrier?: () => Promise<void>;
  } = {},
): Promise<Harness> => {
  const base = await buildTestContext();
  const accountId = base.user.defaultAccountId;
  const scope = { userId: USER_ID, accountId };
  const principal = { userId: USER_ID, accountId };
  const authority = base.repos.pluginAuthority;
  const snapshot = snapshotFor(accountId);
  const dataImport = new InMemoryDataImportRepository(
    { tables: tables(accountId, 'target-before-import'), receipts: [], operations: [] },
    {
      nonTerminalOperations: () => authority.listNonTerminalOperationsByAccount(accountId),
    },
  );
  const ctx: ToolContext = {
    ...base,
    user: { id: USER_ID, defaultAccountId: accountId },
    repos: { ...base.repos, dataImport },
  };
  const observed = { selfExecuting: false, holdersDuringCommit: -1, peakDuringCommit: -1 };
  // 备份引用：目标在这批 fixture 里只由导入本身改变，初始摘要就是提交时的摘要。
  const fixtureBackupDigest = await dataImport.targetDigest(scope);
  let service: ReturnType<typeof createPluginOperationService>;

  const restoreTool = defineTool({
    name: 'restore_data_import',
    description: 'fixture: 恢复业务快照（走真实 commit 路径）',
    sideEffect: 'write',
    input: z
      .object({
        accountId: z.string().min(1),
        requestId: z.string().min(1),
        uploadId: z.string().min(1),
        previewHash: z.string().min(1),
        previewExpiresAt: z.number().int().positive(),
        backupId: z.string().min(1),
        backup: z
          .object({
            backupId: z.string().min(1),
            archiveDigest: z.string().min(1),
            targetDigest: z.string().min(1),
          })
          .strict()
          .optional(),
      })
      .strict(),
    output: z.object({ receipt: z.unknown() }),
    handler: async (input, context) => {
      const repo = context.repos.dataImport;
      if (repo === undefined) throw new Error('fixture 缺少 dataImport 仓储');
      const importScope = { userId: context.user.id, accountId: input.accountId };
      // 提交前观察：本次 Operation 必须已经 executing，且整条 confirm 只持一次 lease。
      const self = await context.repos.pluginAuthority.listNonTerminalOperationsByAccount(
        input.accountId,
      );
      observed.selfExecuting = self.some(
        (entry) =>
          entry.id === input.requestId &&
          entry.state === 'executing' &&
          entry.tool === 'restore_data_import',
      );
      const lease = service.accountLease(input.accountId);
      observed.holdersDuringCommit = lease.holders;
      observed.peakDuringCommit = lease.peak;
      const preview = await repo.preview({
        scope: importScope,
        snapshot,
        now: input.previewExpiresAt - DATA_IMPORT_PREVIEW_TTL_MS,
      });
      if (preview.previewHash !== input.previewHash) throw new Error('fixture preview 已过期');
      try {
        const receipt = await repo.commit({
          scope: importScope,
          requestId: input.requestId,
          snapshot,
          preview: { previewHash: preview.previewHash, expiresAt: input.previewExpiresAt },
          backup: input.backup ?? {
            backupId: input.backupId,
            archiveDigest: snapshot.archiveDigest,
            targetDigest: '',
          },
          now: NOW,
        });
        return { receipt };
      } catch (error) {
        if (error instanceof DataImportError)
          return {
            ok: false,
            error: {
              kind: 'invalid_input',
              message: `import_${error.code}: ${error.message}`,
              issues: [],
            },
          };
        throw error;
      }
    },
  });
  const restorePolicy: ConfirmablePluginTool = {
    tool: restoreTool,
    scheduled: false,
    hostBoundFields: ['accountId', 'requestId'],
    // commit 在事务内被拒即回滚；handler 把 DataImportError 翻成非 ok 结果，所以失败可直接落终态。
    settleFailureAsFailed: true,
    bind(raw, owner, operationId) {
      const input = restoreInput.parse(raw);
      return {
        ...input,
        accountId: owner.accountId,
        requestId: operationId,
        backup: {
          backupId: input.backupId,
          archiveDigest: snapshot.archiveDigest,
          targetDigest: fixtureBackupDigest,
        },
      };
    },
    async receipt() {
      return null;
    },
  };
  const closePolicy: ConfirmablePluginTool = {
    tool: closeHoldingTool,
    scheduled: false,
    async bind(raw, owner, _operationId, context) {
      const input = CloseHoldingInput.parse(raw);
      const holding = await context.repos.holding.findById(input.holdingId);
      if (holding === null || holding.closedAt !== null) throw new Error('fixture 持仓不可平仓');
      if (holding.accountId !== owner.accountId) throw new Error('fixture 持仓账户不符');
      // 精确复现「已读 open holding、尚未 insertOperation」的 await 窗口。
      if (options.closeBindBarrier !== undefined) await options.closeBindBarrier();
      return input;
    },
    async receipt() {
      return null;
    },
  };
  const businessTool = defineTool({
    name: 'fixture_business',
    description: 'fixture: 认领后暂停的业务写',
    sideEffect: 'write',
    input: z.object({ accountId: z.string() }).strict(),
    output: z.object({ done: z.boolean() }),
    handler: async () => {
      if (options.businessBarrier !== undefined) await options.businessBarrier();
      return { done: true };
    },
  });
  const businessPolicy: ConfirmablePluginTool = {
    tool: businessTool,
    scheduled: false,
    bind(raw, owner) {
      const input = businessTool.inputSchema.parse(raw);
      if (input.accountId !== owner.accountId) throw new Error('fixture 账户不符');
      return input;
    },
    async receipt() {
      return null;
    },
  };

  service = createPluginOperationService({
    repository: authority,
    policies: [restorePolicy, closePolicy, businessPolicy],
    capabilities: ['read', 'write'],
    policyVersion: 1,
    now: () => NOW,
    context: () => ctx,
  });

  const prepared = await dataImport.preview({ scope, snapshot, now: NOW });
  const previewHash = prepared.previewHash;
  const previewExpiresAt = prepared.expiresAt;

  const prepareImport = async (): Promise<{ id: string; token: string }> => {
    const id = randomUUID();
    const prepared = await service.prepare(principal, {
      id,
      tool: 'restore_data_import',
      input: {
        uploadId: 'upload-1',
        previewHash,
        previewExpiresAt,
        backupId: 'f'.repeat(32),
      },
    });
    if (!prepared.ok) throw new Error(JSON.stringify(prepared.error));
    return { id, token: (prepared.data as { confirmationToken: string }).confirmationToken };
  };
  const runImport = async (): Promise<ToolResult<unknown>> => {
    const request = await prepareImport();
    return service.confirm(principal, request, new AbortController().signal);
  };

  return {
    ctx,
    service,
    dataImport,
    accountId,
    principal,
    scope,
    previewHash,
    previewExpiresAt,
    observed,
    prepareImport,
    runImport,
    dispose: () => service.dispose(),
  };
};

const resultData = (result: ToolResult<unknown>) => {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.data as { state: string; operationId: string; result: unknown };
};

describe('T48 B2a 账户级互斥 gate', () => {
  it('pending close_holding 阻断恢复，显式 cancel 后放行', async () => {
    const harness = await buildHarness();
    try {
      const closeId = randomUUID();
      const prepared = await harness.service.prepare(harness.principal, {
        id: closeId,
        tool: 'close_holding',
        input: { holdingId: 'test-holding-002594' },
      });
      if (!prepared.ok) throw new Error(JSON.stringify(prepared.error));
      const token = (prepared.data as { confirmationToken: string }).confirmationToken;

      const blockedRequest = await harness.prepareImport();
      const blocked = resultData(
        await harness.service.confirm(
          harness.principal,
          blockedRequest,
          new AbortController().signal,
        ),
      );
      expect(blocked.state).toBe('failed');
      expect(JSON.stringify(blocked.result)).toContain('import_busy');
      expect(harness.dataImport.snapshot().tables.accounts?.[0]?.name).toBe('target-before-import');

      // failed 是终态：同 requestId 再 confirm 只回读 failed，零业务写、零 receipt。
      const replay = resultData(
        await harness.service.confirm(
          harness.principal,
          blockedRequest,
          new AbortController().signal,
        ),
      );
      expect(replay.state).toBe('failed');
      expect(replay.operationId).toBe(blocked.operationId);
      expect(harness.dataImport.snapshot().tables.accounts?.[0]?.name).toBe('target-before-import');
      expect(await harness.dataImport.findReceipt(harness.scope, blockedRequest.id)).toBeNull();

      const cancelled = await harness.service.cancel(harness.principal, { id: closeId, token });
      expect(cancelled.ok).toBe(true);

      // 换新 requestId 才允许重新提交。
      const allowed = resultData(await harness.runImport());
      expect(allowed.state).toBe('succeeded');
      expect(allowed.operationId).not.toBe(blocked.operationId);
      expect(harness.dataImport.snapshot().tables.accounts?.[0]?.name).toBe('source-import-name');
    } finally {
      harness.dispose();
    }
  });

  it('bind 已读 open holding、尚未 insert 的 await 窗口内恢复必须等待', async () => {
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    let enteredBind = false;
    const harness = await buildHarness({
      closeBindBarrier: async () => {
        enteredBind = true;
        await barrier;
      },
    });
    try {
      const closeId = randomUUID();
      const preparing = harness.service.prepare(harness.principal, {
        id: closeId,
        tool: 'close_holding',
        input: { holdingId: 'test-holding-600519' },
      });
      await drain();
      expect(enteredBind).toBe(true);
      // 此刻数据库里还没有 Operation：只有账户 lease 能挡住恢复。
      expect(
        await harness.ctx.repos.pluginAuthority.listNonTerminalOperationsByAccount(
          harness.accountId,
        ),
      ).toEqual([]);

      const importing = harness.runImport();
      await drain();
      expect(harness.observed.holdersDuringCommit).toBe(-1);
      expect(harness.service.accountLease(harness.accountId)).toMatchObject({
        holders: 1,
        peak: 1,
        waiters: 1,
      });

      release();
      expect((await preparing).ok).toBe(true);
      const blocked = resultData(await importing);
      expect(blocked.state).toBe('failed');
      expect(JSON.stringify(blocked.result)).toContain('import_busy');
      expect(harness.dataImport.snapshot().tables.accounts?.[0]?.name).toBe('target-before-import');
      // 放行后 lease 完全归还，没有泄漏的持有者。
      expect(harness.service.accountLease(harness.accountId)).toMatchObject({
        holders: 0,
        peak: 1,
      });
    } finally {
      release();
      harness.dispose();
    }
  });

  it('claim 已落 executing、业务未执行时恢复被阻断', async () => {
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    let enteredBusiness = false;
    const harness = await buildHarness({
      businessBarrier: async () => {
        enteredBusiness = true;
        await barrier;
      },
    });
    try {
      const businessId = randomUUID();
      const prepared = await harness.service.prepare(harness.principal, {
        id: businessId,
        tool: 'fixture_business',
        input: { accountId: harness.accountId },
      });
      if (!prepared.ok) throw new Error(JSON.stringify(prepared.error));
      const token = (prepared.data as { confirmationToken: string }).confirmationToken;
      const confirming = harness.service.confirm(
        harness.principal,
        { id: businessId, token },
        new AbortController().signal,
      );
      await drain();
      expect(enteredBusiness).toBe(true);
      expect(
        await harness.ctx.repos.pluginAuthority.listNonTerminalOperationsByAccount(
          harness.accountId,
        ),
      ).toMatchObject([{ id: businessId, state: 'executing' }]);

      // (a) 进程内：恢复被账户 lease 挡住，业务尚未执行完时不会进入提交。
      const importing = harness.runImport();
      await drain();
      expect(harness.observed.holdersDuringCommit).toBe(-1);

      // (b) 跨进程等价路径：绕过 lease 直接提交，权威复查同样阻断。
      const preview = await harness.dataImport.preview({
        scope: harness.scope,
        snapshot: snapshotFor(harness.accountId),
        now: NOW,
      });
      await expect(
        harness.dataImport.commit({
          scope: harness.scope,
          requestId: randomUUID(),
          snapshot: snapshotFor(harness.accountId),
          preview,
          backup: {
            backupId: 'f'.repeat(32),
            archiveDigest: snapshotFor(harness.accountId).archiveDigest,
            targetDigest: await harness.dataImport.targetDigest(harness.scope),
          },
          now: NOW,
        }),
      ).rejects.toThrow('Operation');

      release();
      expect((await confirming).ok).toBe(true);
      const allowed = resultData(await importing);
      expect(allowed.state).toBe('succeeded');
      expect(harness.dataImport.snapshot().tables.accounts?.[0]?.name).toBe('source-import-name');
    } finally {
      release();
      harness.dispose();
    }
  });

  it('同 account 不同 user 的非终态操作同样阻断', async () => {
    const harness = await buildHarness();
    try {
      await harness.ctx.repos.pluginAuthority.insertOperation(
        operation(harness.accountId, 'other-user-operation', {
          userId: 'another-user',
          tool: 'close_holding',
        }),
      );
      const blocked = resultData(await harness.runImport());
      expect(blocked.state).toBe('failed');
      expect(JSON.stringify(blocked.result)).toContain('import_busy');
      expect(harness.dataImport.snapshot().tables.accounts?.[0]?.name).toBe('target-before-import');
    } finally {
      harness.dispose();
    }
  });

  it('导入自身的 executing 被排除，且整条 confirm 只持一次 lease', async () => {
    const harness = await buildHarness();
    try {
      const result = resultData(await harness.runImport());
      expect(result.state).toBe('succeeded');
      // 提交发生时本次 Operation 确实是 executing —— 排除逻辑生效才可能成功。
      expect(harness.observed.selfExecuting).toBe(true);
      expect(harness.dataImport.snapshot().tables.accounts?.[0]?.name).toBe('source-import-name');
      // 若导入 handler 二次取锁，confirm 会自死锁；峰值 1 证明没有重复取锁。
      expect(harness.observed.holdersDuringCommit).toBe(1);
      expect(harness.observed.peakDuringCommit).toBe(1);
      expect(harness.service.accountLease(harness.accountId)).toMatchObject({
        holders: 0,
        peak: 1,
      });
      const receipt = await harness.dataImport.findReceipt(harness.scope, result.operationId);
      expect(receipt?.requestId).toBe(result.operationId);
    } finally {
      harness.dispose();
    }
  });
});

// 内存替身只用于测试；这里同时钉住「生产装配不会拿到它」。
it('createInMemoryRepos 仍不装配内存导入替身', () => {
  expect(createInMemoryRepos().dataImport).toBeUndefined();
});
