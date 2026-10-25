import { describe, expect, it } from 'vitest';
import {
  ANALYSIS_SERVER_NAME,
  BATCH_SERVER_NAME,
  READ_SERVER_NAME,
  SETTINGS_SERVER_NAME,
  type StandaloneRole,
  standaloneProfileEntries,
  standaloneProfilePatch,
  WORKER_SERVER_NAME,
} from './standalone-profile.js';
import {
  apply as applyDiscipline,
  LUOOME_DISCIPLINE_CONSTRAINTS,
  LUOOME_DISCIPLINE_ORDER,
  LUOOME_DISCIPLINE_SECTION,
} from './standalone-prompt.js';

interface ProfileRow {
  readonly id: string;
  readonly name: string;
  readonly config?: {
    readonly serverName?: string;
    readonly command?: string;
    readonly args?: readonly string[];
    readonly env?: Record<string, string>;
    readonly cwd?: string;
    readonly transport?: string;
  };
}

const workerAllowlist = [
  'claim_analysis_jobs',
  'complete_analysis_job',
  'fail_analysis_job',
  'record_advice',
  'record_analysis_result',
  'get_analysis_context',
  'get_analysis_metrics',
  'list_analysis_jobs',
  'get_analysis_job',
];

const options = {
  luoomeCwd: '/srv/luoome',
  luoomeCommand: 'bun',
  luoomeArgs: ['--no-env-file', 'packages/cli/src/index.ts', 'mcp', 'serve'],
  luoomeHome: '/var/lib/luoome',
  disciplinePluginPath: '/opt/luoome/dsh/profile/luoome-discipline.js',
};

const settingsAllowlist = ['create_account', 'create_watchlist', 'add_holding'];
const analysisAllowlist = ['get_analysis_context', 'record_advice', 'record_analysis_result'];
const batchAllowlist = ['run_strategy_daily_cycle', 'run_intraday_plan_batch'];

const rowsOf = (role: StandaloneRole): ProfileRow[] =>
  standaloneProfileEntries({
    ...options,
    role,
    ...(role === 'worker'
      ? { workerToolAllowlist: workerAllowlist }
      : {
          settingsToolAllowlist: settingsAllowlist,
          analysisToolAllowlist: analysisAllowlist,
          batchToolAllowlist: batchAllowlist,
        }),
  }) as unknown as ProfileRow[];

const webRows = (): ProfileRow[] =>
  standaloneProfileEntries({
    ...options,
    role: 'read',
    settingsToolAllowlist: settingsAllowlist,
    analysisToolAllowlist: analysisAllowlist,
    batchToolAllowlist: batchAllowlist,
  }) as unknown as ProfileRow[];

const rowById = (rows: readonly ProfileRow[], id: string): ProfileRow | undefined =>
  rows.find((row) => row.id === id);

const mcpRow = (role: StandaloneRole): ProfileRow => {
  const row = rowsOf(role).find((candidate) => candidate.id.startsWith('mcp-'));
  if (!row) throw new Error('MCP row missing');
  return row;
};

describe('独立 DSH profile 补丁层', () => {
  it('读面实例只暴露只读面', () => {
    const row = mcpRow('read');
    expect(row.name).toBe('@deepseek-ai/dsh-mcp-client');
    expect(row.config?.transport).toBe('stdio');
    expect(row.config?.serverName).toBe(READ_SERVER_NAME);
    expect(row.config?.env?.LUOOME_HOME).toBe('/var/lib/luoome');
    expect(row.config?.env?.LUOOME_EXPOSE_QUEUE).toBeUndefined();
    expect(row.config?.env?.LUOOME_EXPOSE_TOOLS).toBeUndefined();
  });

  it('消费者实例单独收窄到队列工具', () => {
    const row = mcpRow('worker');
    expect(row.config?.serverName).toBe(WORKER_SERVER_NAME);
    expect(row.config?.env?.LUOOME_EXPOSE_QUEUE).toBe('true');
    expect(row.config?.env?.LUOOME_EXPOSE_TOOLS).toBe(workerAllowlist.join(','));
  });

  it('消费者实例缺少白名单时拒绝构造', () => {
    expect(() => standaloneProfileEntries({ ...options, role: 'worker' })).toThrow(/allowlist/);
  });

  it('部署传入的环境变量进入子进程，但覆盖不了暴露面开关', () => {
    const row = standaloneProfileEntries({
      ...options,
      role: 'read',
      luoomeEnv: {
        LUOOME_MARKET_PROVIDER: 'real',
        LUOOME_EXPOSE_QUEUE: 'true',
        LUOOME_EXPOSE_TRADE: 'true',
      },
    }) as unknown as ProfileRow[];
    const mcp = row.find((candidate) => candidate.id.startsWith('mcp-'));
    expect(mcp?.config?.env?.LUOOME_MARKET_PROVIDER).toBe('real');
    expect(mcp?.config?.env?.LUOOME_EXPOSE_QUEUE).toBeUndefined();
    expect(mcp?.config?.env?.LUOOME_EXPOSE_TRADE).toBeUndefined();
  });

  it('消费者实例的暴露面开关覆盖部署传入的值', () => {
    const row = standaloneProfileEntries({
      ...options,
      role: 'worker',
      workerToolAllowlist: workerAllowlist,
      luoomeEnv: { LUOOME_EXPOSE_QUEUE: 'false', LUOOME_EXPOSE_TOOLS: 'get_advice' },
    }) as unknown as ProfileRow[];
    const mcp = row.find((candidate) => candidate.id.startsWith('mcp-'));
    expect(mcp?.config?.env?.LUOOME_EXPOSE_QUEUE).toBe('true');
    expect(mcp?.config?.env?.LUOOME_EXPOSE_TOOLS).toBe(workerAllowlist.join(','));
  });

  it('批处理面是独立实例：写能力 + 只放批处理工具', () => {
    const row = rowsOf('read').find((candidate) => candidate.id === `mcp-${BATCH_SERVER_NAME}`);
    expect(row?.config?.serverName).toBe(BATCH_SERVER_NAME);
    expect(row?.config?.env?.LUOOME_EXPOSE_WRITE).toBe('true');
    expect(row?.config?.env?.LUOOME_EXPOSE_TOOLS).toBe(batchAllowlist.join(','));
    expect(row?.config?.env?.LUOOME_EXPOSE_RESEARCH).toBeUndefined();
  });

  it('两个实例的命名空间互不重叠', () => {
    expect(READ_SERVER_NAME).not.toBe(WORKER_SERVER_NAME);
    expect(mcpRow('read').config?.serverName).not.toBe(mcpRow('worker').config?.serverName);
  });

  it('补丁层是 bundle 之后的用户 insert 操作', () => {
    const patch = standaloneProfilePatch({
      ...options,
      role: 'read',
      settingsToolAllowlist: settingsAllowlist,
      analysisToolAllowlist: analysisAllowlist,
      batchToolAllowlist: batchAllowlist,
    }) as unknown as {
      readonly insert: readonly ProfileRow[];
    }[];
    expect(patch).toHaveLength(1);
    const ids = patch[0]?.insert.map((row) => row.id) ?? [];
    expect(ids).toContain('luoome-discipline');
    expect(ids).toContain('mcp-luoome');
    expect(ids).toContain('mcp-luoome-settings');
    expect(ids).toContain('mcp-luoome-analysis');
    expect(ids).toContain('mcp-luoome-batch');
    expect(ids).toContain('schedule');
    expect(ids).toContain('schedule-tool');
  });

  it('消费者实例重新打开共享凭据存储，否则每轮唤醒都死在缺凭据', () => {
    const patch = standaloneProfilePatch({
      ...options,
      role: 'worker',
      workerToolAllowlist: workerAllowlist,
    }) as unknown as { readonly id: string; readonly disabled?: boolean }[];
    const credentials = patch.find((row) => row.id === 'credentials');
    expect(credentials).toBeDefined();
    expect(credentials?.disabled).toBe(false);
  });

  it('消费者实例的一次性会话落在独立根目录，不混进 GUI 侧栏', () => {
    const patch = standaloneProfilePatch({
      ...options,
      role: 'worker',
      workerToolAllowlist: workerAllowlist,
      workerSessionRoot: '/var/lib/dsh/worker-sessions',
    }) as unknown as { readonly id: string; readonly config?: { readonly root?: string } }[];
    const persistence = patch.find((row) => row.id === 'session-persistence-jsonl');
    expect(persistence?.config?.root).toBe('/var/lib/dsh/worker-sessions');
  });

  it('读面实例不带消费者专属的行补丁', () => {
    const patch = standaloneProfilePatch({
      ...options,
      role: 'read',
      settingsToolAllowlist: settingsAllowlist,
      batchToolAllowlist: batchAllowlist,
    }) as unknown as {
      readonly id?: string;
    }[];
    expect(patch.map((row) => row.id).filter(Boolean)).toEqual([]);
  });

  it('纪律插件注入设计文档 §4.4 的六条约束', () => {
    let captured: { name: string; order: number; text: string } | undefined;
    applyDiscipline({
      systemPrompt: {
        section: (section: { name: string; order: number; text: string }) => {
          captured = section;
        },
      },
    } as never);
    expect(captured?.name).toBe(LUOOME_DISCIPLINE_SECTION);
    expect(captured?.order).toBe(LUOOME_DISCIPLINE_ORDER);
    expect(LUOOME_DISCIPLINE_CONSTRAINTS.length).toBeGreaterThanOrEqual(6);
    for (const constraint of LUOOME_DISCIPLINE_CONSTRAINTS) {
      expect(captured?.text).toContain(constraint);
    }
  });

  it('读面挂了设置实例，写能力只落在设置实例上', () => {
    const rows = standaloneProfileEntries({
      ...options,
      role: 'read',
      settingsToolAllowlist: settingsAllowlist,
      batchToolAllowlist: batchAllowlist,
    }) as unknown as ProfileRow[];
    const read = rows.find((row) => row.id === `mcp-${READ_SERVER_NAME}`);
    const settings = rows.find((row) => row.id === `mcp-${SETTINGS_SERVER_NAME}`);
    expect(read?.config?.env?.LUOOME_EXPOSE_WRITE).toBeUndefined();
    expect(read?.config?.env?.LUOOME_EXPOSE_TOOLS).toBeUndefined();
    expect(settings?.config?.env?.LUOOME_EXPOSE_WRITE).toBe('true');
    expect(settings?.config?.env?.LUOOME_EXPOSE_TOOLS).toBe(settingsAllowlist.join(','));
    expect(settings?.config?.env?.LUOOME_EXPOSE_QUEUE).toBeUndefined();
    expect(settings?.config?.env?.LUOOME_EXPOSE_TRADE).toBeUndefined();
    expect(settings?.config?.env?.LUOOME_MCP_SERVER_NAME).toBe(SETTINGS_SERVER_NAME);
  });

  it('设置面放行研究结构工具，读面不因部署环境带上研究开关', () => {
    const rows = standaloneProfileEntries({
      ...options,
      role: 'read',
      settingsToolAllowlist: settingsAllowlist,
      batchToolAllowlist: batchAllowlist,
      luoomeEnv: { LUOOME_EXPOSE_RESEARCH: 'true' },
    }) as unknown as ProfileRow[];
    const read = rows.find((row) => row.id === `mcp-${READ_SERVER_NAME}`);
    const settings = rows.find((row) => row.id === `mcp-${SETTINGS_SERVER_NAME}`);
    expect(read?.config?.env?.LUOOME_EXPOSE_RESEARCH).toBeUndefined();
    expect(settings?.config?.env?.LUOOME_EXPOSE_RESEARCH).toBe('true');
  });

  it('没给设置白名单时不挂设置实例', () => {
    const rows = standaloneProfileEntries({ ...options, role: 'read' }) as unknown as ProfileRow[];
    expect(rows.find((row) => row.id === `mcp-${SETTINGS_SERVER_NAME}`)).toBeUndefined();
  });

  it('消费者实例不挂设置实例', () => {
    const rows = standaloneProfileEntries({
      ...options,
      role: 'worker',
      workerToolAllowlist: workerAllowlist,
      settingsToolAllowlist: settingsAllowlist,
      batchToolAllowlist: batchAllowlist,
    }) as unknown as ProfileRow[];
    expect(rows.find((row) => row.id === `mcp-${SETTINGS_SERVER_NAME}`)).toBeUndefined();
  });
});

describe('交互式分析面（luoome-analysis）', () => {
  it('Web profile 同时挂读面/设置面/分析面/批处理面四个 MCP 实例', () => {
    const ids = webRows()
      .filter((row) => row.id.startsWith('mcp-'))
      .map((row) => row.id);
    expect(ids).toEqual([
      `mcp-${READ_SERVER_NAME}`,
      `mcp-${SETTINGS_SERVER_NAME}`,
      `mcp-${ANALYSIS_SERVER_NAME}`,
      `mcp-${BATCH_SERVER_NAME}`,
    ]);
  });

  it('分析面精确收窄到交互三工具，并显式声明 server name 与 queue 开关', () => {
    const row = rowById(webRows(), `mcp-${ANALYSIS_SERVER_NAME}`);
    expect(row?.name).toBe('@deepseek-ai/dsh-mcp-client');
    expect(row?.config?.transport).toBe('stdio');
    expect(row?.config?.serverName).toBe(ANALYSIS_SERVER_NAME);
    expect(row?.config?.env?.LUOOME_MCP_SERVER_NAME).toBe(ANALYSIS_SERVER_NAME);
    expect(row?.config?.env?.LUOOME_EXPOSE_QUEUE).toBe('true');
    expect(row?.config?.env?.LUOOME_EXPOSE_TOOLS).toBe(
      'get_analysis_context,record_advice,record_analysis_result',
    );
  });

  it('分析面不开 write / external / research，也不放 worker 的队列管理工具', () => {
    const env = rowById(webRows(), `mcp-${ANALYSIS_SERVER_NAME}`)?.config?.env;
    expect(env?.LUOOME_EXPOSE_WRITE).toBeUndefined();
    expect(env?.LUOOME_EXPOSE_EXTERNAL).toBeUndefined();
    expect(env?.LUOOME_EXPOSE_RESEARCH).toBeUndefined();
    const exposed = new Set((env?.LUOOME_EXPOSE_TOOLS ?? '').split(','));
    for (const workerOnly of [
      'claim_analysis_jobs',
      'complete_analysis_job',
      'fail_analysis_job',
      'get_analysis_job',
      'get_analysis_metrics',
    ]) {
      expect(exposed).not.toContain(workerOnly);
    }
  });

  it('读面、设置面、批处理面都不带队列开关', () => {
    const rows = webRows();
    for (const serverName of [READ_SERVER_NAME, SETTINGS_SERVER_NAME, BATCH_SERVER_NAME]) {
      const env = rowById(rows, `mcp-${serverName}`)?.config?.env;
      expect(env?.LUOOME_EXPOSE_QUEUE, `${serverName} 不应带队列开关`).toBeUndefined();
    }
  });

  it('部署传入的暴露开关与工具白名单不能提升任何实例权限', () => {
    const rows = standaloneProfileEntries({
      ...options,
      role: 'read',
      settingsToolAllowlist: settingsAllowlist,
      analysisToolAllowlist: analysisAllowlist,
      batchToolAllowlist: batchAllowlist,
      luoomeEnv: {
        LUOOME_EXPOSE_QUEUE: 'true',
        LUOOME_EXPOSE_TRADE: 'true',
        LUOOME_EXPOSE_WRITE: 'true',
        LUOOME_EXPOSE_EXTERNAL: 'true',
        LUOOME_EXPOSE_TOOLS: 'claim_analysis_jobs',
      },
    }) as unknown as ProfileRow[];
    const mcpRows = rows.filter((row) => row.id.startsWith('mcp-'));
    expect(mcpRows).toHaveLength(4);
    for (const row of mcpRows) {
      const env = row.config?.env;
      expect(env?.LUOOME_EXPOSE_TRADE, `${row.id} 不应带 trade`).toBeUndefined();
      expect(env?.LUOOME_EXPOSE_EXTERNAL, `${row.id} 的 external 由精确 profile 决定`).toBe(
        row.id === `mcp-${BATCH_SERVER_NAME}` ? 'true' : undefined,
      );
      if (row.id !== `mcp-${ANALYSIS_SERVER_NAME}`) {
        expect(env?.LUOOME_EXPOSE_QUEUE, `${row.id} 不应带队列开关`).toBeUndefined();
      }
    }
    expect(
      rowById(mcpRows, `mcp-${READ_SERVER_NAME}`)?.config?.env?.LUOOME_EXPOSE_TOOLS,
    ).toBeUndefined();
    expect(rowById(mcpRows, `mcp-${SETTINGS_SERVER_NAME}`)?.config?.env?.LUOOME_EXPOSE_TOOLS).toBe(
      settingsAllowlist.join(','),
    );
    expect(rowById(mcpRows, `mcp-${ANALYSIS_SERVER_NAME}`)?.config?.env?.LUOOME_EXPOSE_TOOLS).toBe(
      analysisAllowlist.join(','),
    );
    expect(rowById(mcpRows, `mcp-${BATCH_SERVER_NAME}`)?.config?.env?.LUOOME_EXPOSE_TOOLS).toBe(
      batchAllowlist.join(','),
    );
  });

  it('缺分析白名单时默认不挂分析面', () => {
    const rows = standaloneProfileEntries({
      ...options,
      role: 'read',
      settingsToolAllowlist: settingsAllowlist,
      batchToolAllowlist: batchAllowlist,
    }) as unknown as ProfileRow[];
    expect(rowById(rows, `mcp-${ANALYSIS_SERVER_NAME}`)).toBeUndefined();
  });

  it('显式空数组挂零工具实例，不退化成全量暴露', () => {
    const rows = standaloneProfileEntries({
      ...options,
      role: 'read',
      analysisToolAllowlist: [],
    }) as unknown as ProfileRow[];
    const row = rowById(rows, `mcp-${ANALYSIS_SERVER_NAME}`);
    expect(row).toBeDefined();
    expect(row?.config?.serverName).toBe(ANALYSIS_SERVER_NAME);
    expect(row?.config?.env?.LUOOME_EXPOSE_QUEUE).toBe('true');
    expect(row?.config?.env?.LUOOME_EXPOSE_TOOLS).toBe('');
  });

  it('消费者实例是唯一默认 queue 面，不挂分析实例', () => {
    const rows = standaloneProfileEntries({
      ...options,
      role: 'worker',
      workerToolAllowlist: workerAllowlist,
      analysisToolAllowlist: analysisAllowlist,
    }) as unknown as ProfileRow[];
    expect(rowById(rows, `mcp-${ANALYSIS_SERVER_NAME}`)).toBeUndefined();
  });
});
