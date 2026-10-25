import type { JsonValue } from './protocol.js';

export const READ_SERVER_NAME = 'luoome';
export const WORKER_SERVER_NAME = 'luoome-worker';
export const SETTINGS_SERVER_NAME = 'luoome-settings';
export const ANALYSIS_SERVER_NAME = 'luoome-analysis';
export const BATCH_SERVER_NAME = 'luoome-batch';

/**
 * 批处理面的工具白名单：DSH 定时任务唤起会话后由 agent 调用。
 * 名字与 @luoome/mcp 的 batchTools 一一对应（deploy/dsh/batch-tools.test.ts 守着这条契约）。
 */
export const BATCH_TOOL_NAMES = [
  'run_strategy_daily_cycle',
  'run_closing_report_cutoff',
  'run_portfolio_performance_snapshot',
  'run_intraday_plan_batch',
  'run_strategy_autonomy_weekly',
] as const;

export type StandaloneRole = 'read' | 'worker';

export interface StandaloneProfileOptions {
  readonly role: StandaloneRole;
  /** luoome 业务进程的工作目录。 */
  readonly luoomeCwd: string;
  /** luoome 业务进程的启动命令与参数。 */
  readonly luoomeCommand: string;
  readonly luoomeArgs: readonly string[];
  /** 单机数据目录，SQLite 事实库所在。 */
  readonly luoomeHome: string;
  /** 系统提示词纪律插件的绝对路径（构建产物）。 */
  readonly disciplinePluginPath: string;
  readonly panelsPluginPath?: string;
  /** 传给 luoome 业务进程的环境变量；暴露面开关由本模块覆盖，不接受外部覆盖。 */
  readonly luoomeEnv?: Readonly<Record<string, string>>;
  /** 消费者实例暴露的队列工具白名单；消费者角色必填。 */
  readonly workerToolAllowlist?: readonly string[];
  /** 交互面设置实例暴露的配置类写工具白名单；为空则不挂设置实例。 */
  readonly settingsToolAllowlist?: readonly string[];
  /**
   * 交互面分析实例暴露的分析工具白名单。
   * 未提供（undefined）时不挂分析实例；显式空数组挂零工具实例（fails closed），
   * 不能退化成全量暴露。
   */
  readonly analysisToolAllowlist?: readonly string[];
  /** 交互面批处理实例暴露的定时任务入口白名单；为空则不挂批处理实例。 */
  readonly batchToolAllowlist?: readonly string[];
  /** 消费者实例一次性会话的落盘根目录；与 GUI 侧栏隔离。 */
  readonly workerSessionRoot?: string;
  readonly toolCallTimeoutMs?: number;
  /** 连接失败时是否让整个 DSH 启动失败。 */
  readonly failOnStartupError?: boolean;
}

const serverNameFor = (role: StandaloneRole): string =>
  role === 'worker' ? WORKER_SERVER_NAME : READ_SERVER_NAME;

/**
 * 暴露面开关只由本模块决定：部署传入的环境变量里出现这些键一律丢弃，
 * 否则一次配置失误就能把读面实例变成写面实例，或放出 trade。
 */
const EXPOSURE_SWITCHES = [
  'LUOOME_EXPOSE_DENY',
  'LUOOME_EXPOSE_EXTERNAL',
  'LUOOME_EXPOSE_QUEUE',
  'LUOOME_EXPOSE_RESEARCH',
  'LUOOME_EXPOSE_TOOLS',
  'LUOOME_EXPOSE_TRADE',
  'LUOOME_EXPOSE_WRITE',
] as const;

/**
 * 独立 DSH profile 的用户补丁行。
 * 读面实例与消费者实例是两个独立进程（§5.4.4），各挂自己的 MCP 实例；
 * 两个实例指向同一个单机事实库，靠队列租约实现先到先得。
 */
export function standaloneProfileEntries(options: StandaloneProfileOptions): JsonValue[] {
  const serverName = serverNameFor(options.role);
  const env: Record<string, string> = { ...options.luoomeEnv, LUOOME_HOME: options.luoomeHome };
  for (const key of EXPOSURE_SWITCHES) delete env[key];
  if (options.role === 'worker') {
    const allowlist = options.workerToolAllowlist ?? [];
    if (allowlist.length === 0) {
      throw new Error('Worker MCP instance requires an explicit queue tool allowlist');
    }
    env.LUOOME_EXPOSE_QUEUE = 'true';
    env.LUOOME_EXPOSE_TOOLS = allowlist.join(',');
  }
  const settingsAllowlist = options.role === 'read' ? (options.settingsToolAllowlist ?? []) : [];
  const settingsEnv: Record<string, string> = {
    ...env,
    LUOOME_MCP_SERVER_NAME: SETTINGS_SERVER_NAME,
    LUOOME_EXPOSE_WRITE: 'true',
    LUOOME_EXPOSE_TOOLS: settingsAllowlist.join(','),
    // 设置面放行研究结构工具（建主题/文档/假设版本）；私有研究内容仍在
    // 读面之外——白名单是精确匹配，研究类读取工具不会因此进面。
    LUOOME_EXPOSE_RESEARCH: 'true',
  };
  // 分析面：只开 queue 能力（record_* 的 sideEffect 是 queue）加精确工具白名单；
  // server name 必须显式写死，不能依赖「开 queue 就默认叫 worker」的 fallback。
  // 显式空数组是零工具实例（fails closed），区别于 undefined 的不挂载。
  const analysisAllowlist = options.role === 'read' ? options.analysisToolAllowlist : undefined;
  const analysisEnv: Record<string, string> | undefined =
    analysisAllowlist === undefined
      ? undefined
      : {
          ...env,
          LUOOME_MCP_SERVER_NAME: ANALYSIS_SERVER_NAME,
          LUOOME_EXPOSE_QUEUE: 'true',
          LUOOME_EXPOSE_TOOLS: analysisAllowlist.join(','),
        };
  // 批处理面：只暴露 DSH 定时任务要调的五个批处理入口。
  const batchAllowlist = options.role === 'read' ? (options.batchToolAllowlist ?? []) : [];
  const batchEnv: Record<string, string> = {
    ...env,
    LUOOME_MCP_SERVER_NAME: BATCH_SERVER_NAME,
    LUOOME_EXPOSE_WRITE: 'true',
    LUOOME_EXPOSE_EXTERNAL: 'true',
    LUOOME_EXPOSE_TOOLS: batchAllowlist.join(','),
  };
  return [
    {
      id: `mcp-${serverName}`,
      name: '@deepseek-ai/dsh-mcp-client',
      config: {
        transport: 'stdio',
        serverName,
        command: options.luoomeCommand,
        args: [...options.luoomeArgs],
        env,
        cwd: options.luoomeCwd,
        toolCallTimeoutMs: options.toolCallTimeoutMs ?? 60_000,
        failOnStartupError: options.failOnStartupError ?? true,
      },
    },
    ...(settingsAllowlist.length > 0
      ? [
          {
            id: `mcp-${SETTINGS_SERVER_NAME}`,
            name: '@deepseek-ai/dsh-mcp-client',
            config: {
              transport: 'stdio',
              serverName: SETTINGS_SERVER_NAME,
              command: options.luoomeCommand,
              args: [...options.luoomeArgs],
              env: settingsEnv,
              cwd: options.luoomeCwd,
              toolCallTimeoutMs: options.toolCallTimeoutMs ?? 60_000,
              failOnStartupError: options.failOnStartupError ?? true,
            },
          },
        ]
      : []),
    ...(analysisEnv !== undefined
      ? [
          {
            id: `mcp-${ANALYSIS_SERVER_NAME}`,
            name: '@deepseek-ai/dsh-mcp-client',
            config: {
              transport: 'stdio',
              serverName: ANALYSIS_SERVER_NAME,
              command: options.luoomeCommand,
              args: [...options.luoomeArgs],
              env: analysisEnv,
              cwd: options.luoomeCwd,
              toolCallTimeoutMs: options.toolCallTimeoutMs ?? 60_000,
              failOnStartupError: options.failOnStartupError ?? true,
            },
          },
        ]
      : []),
    ...(batchAllowlist.length > 0
      ? [
          {
            id: `mcp-${BATCH_SERVER_NAME}`,
            name: '@deepseek-ai/dsh-mcp-client',
            config: {
              transport: 'stdio',
              serverName: BATCH_SERVER_NAME,
              command: options.luoomeCommand,
              args: [...options.luoomeArgs],
              env: batchEnv,
              cwd: options.luoomeCwd,
              toolCallTimeoutMs: options.toolCallTimeoutMs ?? 60_000,
              failOnStartupError: options.failOnStartupError ?? true,
            },
          },
        ]
      : []),
    {
      id: 'luoome-discipline',
      name: options.disciplinePluginPath,
    },
    ...(options.role === 'read'
      ? [
          // DSH 定时任务：schedule 服务负责持久化与到点投递，
          // schedule-tool 让 agent 能自己建/查/改提醒。
          { id: 'schedule', name: '@deepseek-ai/dsh-schedule' },
          { id: 'schedule-tool', name: '@deepseek-ai/dsh-tool-schedule' },
        ]
      : []),
    ...(options.role === 'read' && options.panelsPluginPath
      ? [
          {
            id: 'luoome-panels',
            name: options.panelsPluginPath,
            config: { cwd: options.luoomeCwd, home: options.luoomeHome, env },
          },
        ]
      : []),
  ];
}

/**
 * 消费者实例专属的行补丁。
 *
 * headless bundle 把共享凭据存储关掉了（注释写的是「一次性任务用启动时凭据」），
 * 但我们的消费者是常驻循环，每轮唤醒都要从 DSH home 的凭据存储取模型 key，
 * 否则每轮都死在 MISSING_CREDENTIAL。
 *
 * 另一条把会话目录挪出 GUI 侧栏：消费者每轮唤醒都是一个一次性会话，
 * 留在默认根目录会把侧栏根目录堆成「未分组」。
 */
function workerRowPatches(options: StandaloneProfileOptions): JsonValue[] {
  if (options.role !== 'worker') return [];
  return [
    { id: 'credentials', disabled: false },
    {
      id: 'session-persistence-jsonl',
      config: { root: options.workerSessionRoot ?? '/var/lib/dsh/worker-sessions' },
    },
  ];
}

/** 追加在 bundle 补丁之后的 profile 用户补丁层。 */
export function standaloneProfilePatch(options: StandaloneProfileOptions): JsonValue {
  return [{ insert: standaloneProfileEntries(options) }, ...workerRowPatches(options)];
}
