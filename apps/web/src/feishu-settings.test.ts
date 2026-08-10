import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { FeishuSettingsStore } from './feishu-settings.js';

const directories: string[] = [];

const createStore = () => {
  const directory = mkdtempSync(join(tmpdir(), 'luoome-feishu-settings-'));
  directories.push(directory);
  return new FeishuSettingsStore(
    { LUOOME_HOME: directory },
    { secretPath: join(directory, '.env') },
  );
};

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe('FeishuSettingsStore', () => {
  it('保存到 0600 环境文件但读取视图不回显 Webhook', () => {
    const store = createStore();
    writeFileSync(store.secretPath, 'MINIMAX_API_KEY=keep\n');
    const webhook = 'https://open.feishu.cn/open-apis/bot/v2/hook/test-secret-token';
    expect(store.save({ webhookUrl: webhook, clearWebhook: false })).toEqual({
      configured: true,
      endpoint: 'open.feishu.cn',
    });
    expect(JSON.stringify(store.read())).not.toContain('test-secret-token');
    expect(readFileSync(store.secretPath, 'utf8')).toBe(
      `MINIMAX_API_KEY=keep\nLUOOME_FEISHU_WEBHOOK_URL=${webhook}\n`,
    );
    expect(statSync(store.secretPath).mode & 0o777).toBe(0o600);
  });

  it('留空保留既有密钥，显式清除会写空值覆盖启动环境', () => {
    const store = createStore();
    store.save({
      webhookUrl: 'https://open.feishu.cn/open-apis/bot/v2/hook/existing',
      clearWebhook: false,
    });
    expect(store.save({ webhookUrl: '', clearWebhook: false }).configured).toBe(true);
    writeFileSync(
      store.secretPath,
      `${readFileSync(store.secretPath, 'utf8')}LUOOME_MARKET_SOURCES=eastmoney\n`,
    );
    expect(store.save({ clearWebhook: true })).toEqual({
      configured: false,
      endpoint: 'open.feishu.cn',
    });
    expect(readFileSync(store.secretPath, 'utf8')).toBe(
      'LUOOME_MARKET_SOURCES=eastmoney\nLUOOME_FEISHU_WEBHOOK_URL=\n',
    );
    expect(
      new FeishuSettingsStore(
        {
          LUOOME_FEISHU_WEBHOOK_URL:
            'https://open.feishu.cn/open-apis/bot/v2/hook/stale-startup-value',
        },
        { secretPath: store.secretPath },
      ).read().configured,
    ).toBe(false);
  });

  it('拒绝非官方主机、HTTP、查询参数和旧版路径', () => {
    const store = createStore();
    for (const webhookUrl of [
      'https://example.com/open-apis/bot/v2/hook/token',
      'http://open.feishu.cn/open-apis/bot/v2/hook/token',
      'https://open.feishu.cn/open-apis/bot/v2/hook/token?secret=1',
      'https://open.feishu.cn/open-apis/bot/hook/token',
    ]) {
      expect(() => store.save({ webhookUrl, clearWebhook: false })).toThrow(
        '仅支持飞书自定义机器人的 HTTPS Webhook',
      );
    }
  });
});
