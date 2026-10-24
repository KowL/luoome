import { execFile } from 'node:child_process';

export const PANEL_TOOLS = {
  overview: ['list_holdings', 'list_watch_triggers', 'get_advice', 'list_watchlists'],
  // 行情面单独一条数据路由：A 股情绪取数慢于本地事实，拆开后看盘首屏不必等它。
  market: ['get_ashare_sentiment', 'get_market_data_status'],
  strategies: [
    'list_strategies',
    'get_watch_status',
    'get_strategy_reliability_summary',
    'list_pending_strategy_observations',
  ],
  review: ['get_advice_stats', 'list_pending_strategy_observations'],
} as const;

interface PanelConfig {
  cwd: string;
  home: string;
  env?: Record<string, string>;
}
interface PanelContext {
  connection: {
    fetch: {
      register(route: {
        path: string;
        methods: string[];
        requestBody: 'buffered';
        fetch(request: Request): Promise<Response>;
      }): void;
    };
  };
}

export const name = 'luoome-panels';
export const inject = ['connection'];

export function panelEnvironment(config: PanelConfig): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: process.env.HOME };
  for (const [key, value] of Object.entries(config.env ?? {})) {
    if (key.startsWith('LUOOME_') && !key.startsWith('LUOOME_EXPOSE_')) env[key] = value;
  }
  env.LUOOME_HOME = config.home;
  return env;
}

export function apply(ctx: PanelContext, config: PanelConfig): void {
  for (const [panel, names] of Object.entries(PANEL_TOOLS)) {
    ctx.connection.fetch.register({
      path: `/api/luoome.panels/${panel}`,
      methods: ['GET'],
      requestBody: 'buffered',
      async fetch(request) {
        const results = await Promise.all(
          names.map(
            (tool) =>
              new Promise((resolve) => {
                execFile(
                  'bun',
                  [
                    '--no-env-file',
                    'packages/cli/src/index.ts',
                    'tools',
                    'call',
                    tool,
                    '--input',
                    '{}',
                    '--json',
                  ],
                  {
                    cwd: config.cwd,
                    env: panelEnvironment(config),
                    timeout: 60_000,
                    maxBuffer: 4 * 1024 * 1024,
                    signal: request.signal,
                  },
                  (error, stdout) => {
                    try {
                      const result = JSON.parse(stdout);
                      if (typeof result.ok !== 'boolean') throw new Error('invalid result');
                      resolve({ tool, result });
                    } catch {
                      resolve({
                        tool,
                        result: {
                          ok: false,
                          error: {
                            kind: 'unavailable',
                            message: error ? '事实读取失败，请重试' : '事实响应无效',
                          },
                        },
                      });
                    }
                  },
                );
              }),
          ),
        );
        return Response.json({ panel, results }, { headers: { 'cache-control': 'no-store' } });
      },
    });
  }
}
