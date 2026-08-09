import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { createResearchVaultAdapterFromEnv } from '@luoome/adapters';
import { parseEnvFile } from '@luoome/core';
import { z } from 'zod';

const singleLine = (label: string) =>
  z
    .string()
    .trim()
    .min(1, `${label}不能为空`)
    .refine((value) => !/[\r\n\0]/.test(value), `${label}必须是单行文本`);

export const SaveResearchVaultSettingsSchema = z.object({
  vaultPath: z
    .string()
    .trim()
    .refine((value) => !/[\r\n\0]/.test(value), 'Vault 路径必须是单行文本'),
  researchRoot: singleLine('研究目录').default('Research'),
  managedRoot: singleLine('受管目录').default('Research/Luoome'),
  vaultId: z
    .string()
    .trim()
    .max(100)
    .refine((value) => !/[\r\n\0]/.test(value), 'Vault ID 必须是单行文本')
    .default(''),
  maxTextMb: z.number().int().min(1).max(100).default(10),
  maxAttachmentMb: z.number().int().min(1).max(1024).default(100),
});
export type SaveResearchVaultSettings = z.infer<typeof SaveResearchVaultSettingsSchema>;

export interface ResearchVaultSettingsView {
  readonly configured: boolean;
  readonly vaultName?: string;
  readonly researchRoot: string;
  readonly managedRoot: string;
  readonly vaultId: string;
  readonly maxTextMb: number;
  readonly maxAttachmentMb: number;
  readonly effectiveVaultId?: string;
  readonly configError?: string;
}

const KEYS = {
  vaultPath: 'LUOOME_RESEARCH_VAULT',
  researchRoot: 'LUOOME_RESEARCH_ROOT',
  managedRoot: 'LUOOME_RESEARCH_MANAGED_ROOT',
  vaultId: 'LUOOME_RESEARCH_VAULT_ID',
  maxTextMb: 'LUOOME_RESEARCH_MAX_TEXT_MB',
  maxAttachmentMb: 'LUOOME_RESEARCH_MAX_ATTACHMENT_MB',
} as const;

const INVALID_CONFIG_MESSAGE = 'Vault 配置无效，请检查 Vault 路径和扫描目录';

const readText = (path: string): string => {
  try {
    return existsSync(path) ? readFileSync(path, 'utf8') : '';
  } catch {
    return '';
  }
};

const atomicWrite = (path: string, content: string): void => {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, content, { encoding: 'utf8', mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
  chmodSync(path, 0o600);
};

const serializeEnvValue = (value: string): string => {
  if (/[\r\n\0]/.test(value)) throw new Error('配置值必须是单行文本');
  if (/\s#/.test(value) || value.startsWith('#') || /^['"]|['"]$/.test(value)) {
    if (value.includes("'")) throw new Error('配置值不能同时包含 # 和单引号');
    return `'${value}'`;
  }
  return value;
};

const updateEnvContent = (content: string, values: Readonly<Record<string, string>>): string => {
  const keys = new Set(Object.keys(values));
  const lines = content.split('\n').filter((line) => {
    const match = line.trim().match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    return match?.[1] === undefined || !keys.has(match[1]);
  });
  while (lines.at(-1) === '') lines.pop();
  for (const [key, value] of Object.entries(values))
    lines.push(`${key}=${serializeEnvValue(value)}`);
  return `${lines.join('\n')}\n`;
};

const validateVaultDirectories = (
  env: Readonly<Record<string, string | undefined>>,
  researchRoot: string,
): void => {
  try {
    const adapter = createResearchVaultAdapterFromEnv(env);
    if (adapter === undefined) throw new Error('Vault 未配置');
    const vaultPath = env.LUOOME_RESEARCH_VAULT;
    if (vaultPath === undefined) throw new Error('Vault 未配置');
    const vaultRoot = realpathSync(vaultPath);
    if (!statSync(vaultRoot).isDirectory()) throw new Error('Vault 根路径不是目录');
    const scanRoot = realpathSync(resolve(vaultRoot, researchRoot.replaceAll('\\', '/')));
    const relativeScanRoot = relative(vaultRoot, scanRoot);
    if (
      relativeScanRoot === '..' ||
      relativeScanRoot.startsWith(`..${sep}`) ||
      isAbsolute(relativeScanRoot) ||
      !statSync(scanRoot).isDirectory()
    ) {
      throw new Error('扫描目录不在 Vault 内');
    }
  } catch {
    throw new Error(INVALID_CONFIG_MESSAGE);
  }
};

export class ResearchVaultSettingsStore {
  readonly secretPath: string;
  private readonly sessionEnv: Record<string, string | undefined> = {};

  constructor(
    private readonly baseEnv: Readonly<Record<string, string | undefined>>,
    paths: { readonly secretPath?: string } = {},
  ) {
    const home = baseEnv.LUOOME_HOME?.trim() || join(homedir(), '.luoome');
    this.secretPath = paths.secretPath ?? join(home, '.env');
  }

  runtimeEnv(): Record<string, string | undefined> {
    return {
      ...this.baseEnv,
      ...parseEnvFile(readText(this.secretPath)),
      ...this.sessionEnv,
    };
  }

  read(): ResearchVaultSettingsView {
    const env = this.runtimeEnv();
    const vaultPath = env.LUOOME_RESEARCH_VAULT?.trim() ?? '';
    const input = {
      researchRoot: env.LUOOME_RESEARCH_ROOT?.trim() || 'Research',
      managedRoot: env.LUOOME_RESEARCH_MANAGED_ROOT?.trim() || 'Research/Luoome',
      vaultId: env.LUOOME_RESEARCH_VAULT_ID?.trim() ?? '',
      maxTextMb: Number(env.LUOOME_RESEARCH_MAX_TEXT_MB || 10),
      maxAttachmentMb: Number(env.LUOOME_RESEARCH_MAX_ATTACHMENT_MB || 100),
    };
    if (vaultPath === '') return { ...input, configured: false };
    try {
      const adapter = createResearchVaultAdapterFromEnv(env);
      return {
        ...input,
        configured: true,
        vaultName: basename(vaultPath),
        ...(adapter === undefined ? {} : { effectiveVaultId: adapter.vaultId }),
      };
    } catch {
      return {
        ...input,
        configured: true,
        vaultName: basename(vaultPath),
        configError: INVALID_CONFIG_MESSAGE,
      };
    }
  }

  save(raw: SaveResearchVaultSettings): ResearchVaultSettingsView {
    const input = SaveResearchVaultSettingsSchema.parse(raw);
    const vaultPath = input.vaultPath || this.runtimeEnv().LUOOME_RESEARCH_VAULT?.trim();
    if (!vaultPath) throw new Error('Vault 路径不能为空');
    const serialized = {
      [KEYS.vaultPath]: vaultPath,
      [KEYS.researchRoot]: input.researchRoot,
      [KEYS.managedRoot]: input.managedRoot,
      [KEYS.vaultId]: input.vaultId,
      [KEYS.maxTextMb]: String(input.maxTextMb),
      [KEYS.maxAttachmentMb]: String(input.maxAttachmentMb),
    };
    const candidateEnv = { ...this.runtimeEnv(), ...serialized };
    validateVaultDirectories(candidateEnv, input.researchRoot);

    atomicWrite(this.secretPath, updateEnvContent(readText(this.secretPath), serialized));
    Object.assign(this.sessionEnv, serialized);
    return this.read();
  }
}
