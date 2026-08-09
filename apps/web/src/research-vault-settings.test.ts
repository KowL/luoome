import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  ResearchVaultSettingsStore,
  SaveResearchVaultSettingsSchema,
} from './research-vault-settings.js';

const temporaryDirectories: string[] = [];

const fixture = () => {
  const directory = mkdtempSync(join(tmpdir(), 'luoome-vault-settings-'));
  temporaryDirectories.push(directory);
  const vaultPath = join(directory, 'Investment Vault');
  mkdirSync(vaultPath);
  const store = new ResearchVaultSettingsStore(
    { LUOOME_HOME: directory },
    { secretPath: join(directory, '.env') },
  );
  return { directory, vaultPath, store };
};

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('ResearchVaultSettingsStore', () => {
  it('未配置时返回安全默认值', () => {
    const { store } = fixture();
    expect(store.read()).toEqual({
      configured: false,
      researchRoot: 'Research',
      managedRoot: 'Research/Luoome',
      vaultId: '',
      maxTextMb: 10,
      maxAttachmentMb: 100,
    });
  });

  it('验证真实 Vault 后原子保存全部设置并立即更新 runtime env', () => {
    const { vaultPath, store } = fixture();
    writeFileSync(store.secretPath, 'MINIMAX_API_KEY=keep\n');
    const view = store.save({
      vaultPath,
      researchRoot: 'Research',
      managedRoot: 'Research/Luoome',
      vaultId: 'investment-vault',
      maxTextMb: 12,
      maxAttachmentMb: 128,
    });
    expect(view).toMatchObject({
      configured: true,
      vaultName: 'Investment Vault',
      effectiveVaultId: 'investment-vault',
      maxTextMb: 12,
      maxAttachmentMb: 128,
    });
    expect(view).not.toHaveProperty('vaultPath');
    expect(store.runtimeEnv()).toMatchObject({
      LUOOME_RESEARCH_VAULT: vaultPath,
      LUOOME_RESEARCH_MAX_ATTACHMENT_MB: '128',
    });
    const content = readFileSync(store.secretPath, 'utf8');
    expect(content).toContain('MINIMAX_API_KEY=keep');
    expect(content).toContain(`LUOOME_RESEARCH_VAULT=${vaultPath}`);
    expect(statSync(store.secretPath).mode & 0o777).toBe(0o600);
  });

  it('路径不存在或目录边界非法时拒绝保存且不覆盖原配置', () => {
    const { directory, store } = fixture();
    writeFileSync(store.secretPath, 'KEEP=value\n');
    expect(() =>
      store.save({
        vaultPath: join(directory, 'missing'),
        researchRoot: 'Research',
        managedRoot: 'Research/Luoome',
        vaultId: '',
        maxTextMb: 10,
        maxAttachmentMb: 100,
      }),
    ).toThrow();
    expect(readFileSync(store.secretPath, 'utf8')).toBe('KEEP=value\n');
  });

  it('约束大小范围和单行路径', () => {
    expect(() =>
      SaveResearchVaultSettingsSchema.parse({
        vaultPath: '/tmp/a\nb',
        researchRoot: 'Research',
        managedRoot: 'Research/Luoome',
        vaultId: '',
        maxTextMb: 0,
        maxAttachmentMb: 100,
      }),
    ).toThrow();
  });
});
