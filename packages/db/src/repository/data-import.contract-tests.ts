import type {
  DataImportBackupRef,
  DataImportCommand,
  DataImportRepository,
  DataImportScope,
  DataImportSnapshot,
} from '@luoome/core';
import { afterEach, describe, expect, it } from 'vitest';

export interface DataImportContractHandle {
  readonly repository: DataImportRepository;
  readonly scope: DataImportScope;
  readonly source: DataImportSnapshot;
  readName(): Promise<string | null>;
  changeName(name: string): Promise<void>;
  setOperation(
    state: 'pending' | 'executing' | 'unknown',
    overrides?: {
      readonly id?: string;
      readonly userId?: string;
      readonly accountId?: string;
      readonly tool?: string;
    },
  ): Promise<void>;
  reopen(): Promise<void>;
  close(): void;
}

/**
 * 备份是提交的前置条件：合约用「与当前目标一致」的备份引用，负例可显式覆盖。
 */
export const withFixtureBackup = async (
  repository: DataImportRepository,
  input: Omit<DataImportCommand, 'backup'> & { readonly backup?: DataImportBackupRef },
): Promise<DataImportCommand> => ({
  ...input,
  backup: input.backup ?? {
    backupId: 'fixture-backup',
    archiveDigest: input.snapshot.archiveDigest,
    targetDigest: await repository.targetDigest(input.scope),
  },
});

export const registerDataImportContractTests = (
  label: string,
  factory: () => Promise<DataImportContractHandle>,
): void => {
  describe(`T48 atomic data import (${label})`, () => {
    const handles: DataImportContractHandle[] = [];
    const fixture = async () => {
      const handle = await factory();
      handles.push(handle);
      return handle;
    };
    afterEach(() => {
      for (const handle of handles.splice(0)) handle.close();
    });
    const now = 1000;
    const prepared = async (handle: DataImportContractHandle) => {
      const preview = await handle.repository.preview({
        scope: handle.scope,
        snapshot: handle.source,
        now,
      });
      return {
        scope: handle.scope,
        snapshot: handle.source,
        preview,
        now: now + 1,
        backup: {
          backupId: 'fixture-backup',
          archiveDigest: handle.source.archiveDigest,
          targetDigest: await handle.repository.targetDigest(handle.scope),
        },
      };
    };

    it('预检不改数据，提交后真实数据与独立receipt一致', async () => {
      const handle = await fixture();
      const before = await handle.readName();
      const input = await prepared(handle);
      expect(await handle.readName()).toBe(before);
      expect(input.preview.counts.accounts).toMatchObject({ source: 1, current: 1, expected: 1 });
      const receipt = await handle.repository.commit({ ...input, requestId: 'request-a' });
      expect(await handle.readName()).toBe(handle.source.tables.accounts?.[0]?.name);
      expect(receipt.actual.accounts).toBe(1);
      expect(await handle.repository.findReceipt(handle.scope, 'request-a')).toEqual(receipt);
    });

    it('丢响应后同id与重开均回读首次receipt，不再写业务', async () => {
      const handle = await fixture();
      const input = { ...(await prepared(handle)), requestId: 'request-a' };
      const receipt = await handle.repository.commit(input);
      await handle.changeName('after-first-commit');
      await handle.reopen();
      expect(await handle.repository.commit({ ...input, now: 999999999 })).toEqual(receipt);
      expect(await handle.readName()).toBe('after-first-commit');
    });

    it('同id异digest冲突且不写', async () => {
      const handle = await fixture();
      const input = { ...(await prepared(handle)), requestId: 'request-a' };
      await handle.repository.commit(input);
      const before = await handle.readName();
      await expect(
        handle.repository.commit({
          ...input,
          snapshot: { ...input.snapshot, archiveDigest: 'b'.repeat(64) },
        }),
      ).rejects.toThrow('不同导入内容');
      expect(await handle.readName()).toBe(before);
    });

    it('A恢复→B同文件alias持久→修改目标→重试B仍零业务写', async () => {
      const handle = await fixture();
      const input = await prepared(handle);
      const original = await handle.repository.commit({ ...input, requestId: 'request-a' });
      const alias = await handle.repository.commit({ ...input, requestId: 'request-b' });
      expect(alias.originalRequestId).toBe(original.requestId);
      expect(alias.requestId).toBe('request-b');
      await handle.changeName('after-alias');
      await handle.reopen();
      expect(
        await handle.repository.commit({ ...input, requestId: 'request-b', now: 999999999 }),
      ).toEqual(alias);
      expect(await handle.readName()).toBe('after-alias');
    });

    it('同计数目标内容改变也使preview失效且无receipt', async () => {
      const handle = await fixture();
      const input = { ...(await prepared(handle)), requestId: 'request-stale' };
      await handle.changeName('changed-after-preview');
      await expect(handle.repository.commit(input)).rejects.toThrow('重新预检');
      expect(await handle.readName()).toBe('changed-after-preview');
      expect(await handle.repository.findReceipt(handle.scope, input.requestId)).toBeNull();
    });

    it.each(['pending', 'executing', 'unknown'] as const)(
      '同账户其它user的%s操作阻断',
      async (state) => {
        const handle = await fixture();
        const input = { ...(await prepared(handle)), requestId: 'request-blocked' };
        const before = await handle.readName();
        await handle.setOperation(state);
        await expect(handle.repository.commit(input)).rejects.toThrow('Operation');
        expect(await handle.readName()).toBe(before);
        expect(await handle.repository.findReceipt(handle.scope, input.requestId)).toBeNull();
      },
    );

    it('排除本次导入自身的 executing，但同id异工具或异账户仍阻断', async () => {
      const handle = await fixture();
      const self = { ...(await prepared(handle)), requestId: 'request-self' };
      await handle.setOperation('executing', {
        id: 'request-self',
        userId: handle.scope.userId,
        tool: 'restore_data_import',
      });
      const receipt = await handle.repository.commit(self);
      expect(receipt.requestId).toBe('request-self');
      expect(await handle.repository.findReceipt(handle.scope, 'request-self')).toEqual(receipt);
      // 同 id 但工具名不是本次导入：不是「已核验的本次导入」，必须阻断。
      await handle.setOperation('executing', { id: 'request-other-tool', tool: 'close_holding' });
      await expect(
        handle.repository.commit({ ...self, requestId: 'request-other-tool' }),
      ).rejects.toThrow('Operation');
      // 同 id、同工具，但属于其它账户：不构成本次导入自身。
      await handle.setOperation('executing', {
        id: 'request-other-account',
        accountId: 'another-account',
        tool: 'restore_data_import',
      });
      await expect(
        handle.repository.commit({ ...self, requestId: 'request-other-account' }),
      ).rejects.toThrow('Operation');
    });

    it('缺少备份、备份属于别的快照或备份后目标变化时拒绝提交且零业务写', async () => {
      const handle = await fixture();
      const input = await prepared(handle);
      const before = await handle.readName();
      expect(await handle.repository.targetDigest(handle.scope)).toBe(input.preview.preDigest);

      for (const backup of [
        {
          backupId: '',
          archiveDigest: input.snapshot.archiveDigest,
          targetDigest: input.backup.targetDigest,
        },
        { backupId: 'b1', archiveDigest: 'b'.repeat(64), targetDigest: input.backup.targetDigest },
        {
          backupId: 'b2',
          archiveDigest: input.snapshot.archiveDigest,
          targetDigest: 'c'.repeat(64),
        },
      ]) {
        await expect(
          handle.repository.commit({
            ...input,
            requestId: `request-${backup.backupId || 'missing'}`,
            backup,
          }),
        ).rejects.toThrow('备份');
        expect(await handle.readName()).toBe(before);
        expect(
          await handle.repository.findReceipt(
            handle.scope,
            `request-${backup.backupId || 'missing'}`,
          ),
        ).toBeNull();
      }

      // 备份之后目标被改过：同一个 backup 引用必须失效，且要求重新备份 + 重新预检。
      await handle.changeName('changed-after-backup');
      await expect(
        handle.repository.commit({ ...input, requestId: 'request-after-change' }),
      ).rejects.toThrow('重新备份');
      expect(await handle.readName()).toBe('changed-after-backup');
      expect(await handle.repository.findReceipt(handle.scope, 'request-after-change')).toBeNull();
    });

    it('账本差额预检失败且不改数据和receipt', async () => {
      const handle = await fixture();
      const rows = handle.source.tables.accounts ?? [];
      const invalid = {
        ...handle.source,
        tables: {
          ...handle.source.tables,
          accounts: rows.map((row) => ({ ...row, cash_balance: Number(row.cash_balance) + 1 })),
        },
      };
      const before = await handle.readName();
      await expect(
        handle.repository.preview({ scope: handle.scope, snapshot: invalid, now }),
      ).rejects.toThrow('账本');
      expect(await handle.readName()).toBe(before);
      expect(await handle.repository.findReceipt(handle.scope, 'never-written')).toBeNull();
    });
  });
};
