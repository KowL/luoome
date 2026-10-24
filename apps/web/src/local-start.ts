// @luoome/web —— 单机形态的 Web 启动。
//
// 单机形态在这里直接装配本地 ctx 与四个设置 store，不经过任何租户/平台设施；
// 认证由前置反向代理承担（DSH 部署里是 Caddy 的 basic auth + 启动 token）。

import { FeishuSettingsStore } from './feishu-settings.js';
import { createLocalWebContext } from './local-context.js';
import { MarketSettingsStore } from './market-settings.js';
import { ResearchVaultSettingsStore } from './research-vault-settings.js';
import { createWebApp, WEB_SERVER_IDLE_TIMEOUT_SECONDS } from './server.js';

export interface LocalWebServerHandle {
  readonly port: number;
  stop(closeActiveConnections?: boolean): Promise<void>;
}

export const startLocalWeb = async (options: {
  readonly port: number;
  readonly host?: string;
}): Promise<LocalWebServerHandle> => {
  const env = process.env;
  const handle = await createLocalWebContext(env);
  try {
    const app = createWebApp(handle.ctx, {
      marketSettingsStore: new MarketSettingsStore(env),
      researchVaultSettingsStore: new ResearchVaultSettingsStore(env),
      feishuSettingsStore: new FeishuSettingsStore(env),
      dataTransferDbPath: handle.dbPath,
    });
    const server = Bun.serve({
      port: options.port,
      hostname: options.host ?? env.LUOOME_HOST ?? '127.0.0.1',
      fetch: app.fetch,
      idleTimeout: WEB_SERVER_IDLE_TIMEOUT_SECONDS,
    });
    console.info(`luoome Web listening on port ${server.port}; mode=local`);
    return {
      port: server.port as number,
      stop: async (closeActiveConnections = false) => {
        await server.stop(closeActiveConnections);
        handle.close();
      },
    };
  } catch (error) {
    handle.close();
    throw error;
  }
};
