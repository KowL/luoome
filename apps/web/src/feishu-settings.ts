import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { parseEnvFile } from '@luoome/core';
import { z } from 'zod';

const WEBHOOK_KEY = 'LUOOME_FEISHU_WEBHOOK_URL';

const FeishuWebhookUrlSchema = z
  .url('Webhook 必须是合法 URL')
  .max(2_048)
  .refine((value) => {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      url.hostname === 'open.feishu.cn' &&
      /^\/open-apis\/bot\/v2\/hook\/[A-Za-z0-9_-]+$/.test(url.pathname) &&
      url.username === '' &&
      url.password === '' &&
      url.search === '' &&
      url.hash === ''
    );
  }, '仅支持飞书自定义机器人的 HTTPS Webhook');

export const SaveFeishuSettingsSchema = z.object({
  webhookUrl: z
    .string()
    .trim()
    .max(2_048)
    .refine((value) => !/[\r\n\0]/.test(value), 'Webhook 必须是单行文本')
    .optional(),
  clearWebhook: z.boolean().default(false),
});
export type SaveFeishuSettings = z.infer<typeof SaveFeishuSettingsSchema>;

export interface FeishuSettingsView {
  readonly configured: boolean;
  readonly endpoint: 'open.feishu.cn';
}

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

const updateEnvContent = (content: string, value: string): string => {
  const pattern = new RegExp(`^(?:export\\s+)?${WEBHOOK_KEY}\\s*=`);
  const lines = content.split('\n').filter((line) => !pattern.test(line.trim()));
  while (lines.at(-1) === '') lines.pop();
  lines.push(`${WEBHOOK_KEY}=${value}`);
  return lines.length === 0 ? '' : `${lines.join('\n')}\n`;
};

export class FeishuSettingsStore {
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

  webhookUrl(): string | undefined {
    const value = this.runtimeEnv()[WEBHOOK_KEY]?.trim();
    return value === undefined || value === '' ? undefined : FeishuWebhookUrlSchema.parse(value);
  }

  read(): FeishuSettingsView {
    return { configured: this.webhookUrl() !== undefined, endpoint: 'open.feishu.cn' };
  }

  save(raw: SaveFeishuSettings): FeishuSettingsView {
    const input = SaveFeishuSettingsSchema.parse(raw);
    const current = this.webhookUrl();
    const next = input.clearWebhook
      ? null
      : input.webhookUrl === undefined || input.webhookUrl === ''
        ? current
        : FeishuWebhookUrlSchema.parse(input.webhookUrl);
    if (next === undefined) throw new Error('请填写飞书 Webhook');
    atomicWrite(this.secretPath, updateEnvContent(readText(this.secretPath), next ?? ''));
    this.sessionEnv[WEBHOOK_KEY] = next ?? '';
    return this.read();
  }
}
