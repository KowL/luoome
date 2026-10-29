import type { ScheduleCatalogEntry } from '@deepseek-ai/dsh-schedule';
import type {
  PluginAuthorityRepository,
  PluginOperation,
  Strategy,
  StrategyRun,
  StrategySchedule,
  ToolResult,
} from '@luoome/core';
import {
  getStrategyRunDataHealth,
  StrategyDailyCycleAuditInputSummarySchema,
  StrategyDailyCycleAuditOutputSummarySchema,
} from '@luoome/core';
import { type PluginPrincipal, pluginInputHash, pluginInputJson } from '@luoome/tools';
import { dshScheduleHash } from './dsh-identity.js';
import type { ReadSurface } from './read-surface.js';

export interface ResearchTaskStatus {
  readonly taskId: string;
  readonly title: string;
  readonly status: 'active' | 'inactive';
  readonly nextScheduledAt: string;
  readonly grantStatus: 'missing' | 'disabled' | 'expired' | 'changed' | 'valid';
  readonly lastDelivery: ScheduleCatalogEntry['lastDelivery'] | null;
  readonly operation: {
    readonly operationId: string;
    readonly state: PluginOperation['state'];
    readonly createdAt: number;
    readonly updatedAt: number;
    readonly result: unknown;
  } | null;
}

export interface ResearchContinuity {
  readonly status:
    | 'disabled'
    | 'paused'
    | 'not-configured'
    | 'blocked'
    | 'waiting'
    | 'running'
    | 'healthy'
    | 'partial'
    | 'stale'
    | 'unknown';
  readonly reasons: readonly string[];
  readonly automationsEnabled: boolean;
  readonly schedule: ToolResult<unknown>;
  readonly tasks: readonly ResearchTaskStatus[];
  readonly taskSource: 'available' | 'unavailable';
  readonly latestRun: StrategyRun | null;
  readonly audit: unknown;
  readonly factCutoff: string | null;
  readonly notificationStatus: 'not-verified';
  readonly limitations: readonly string[];
}

export interface ResearchContinuityOptions {
  readonly read: ReadSurface;
  readonly repository: PluginAuthorityRepository;
  readonly profile: string;
  readonly policyVersion: number;
  readonly automationsEnabled: boolean;
  readonly dailyCycleEnabled: boolean;
  readonly tasks?: () => Promise<readonly ScheduleCatalogEntry[]>;
  readonly principalForSession: (sessionId: string) => PluginPrincipal | null;
  readonly now: () => number;
}

const DAILY_CYCLE = 'run_strategy_daily_cycle';

export const scheduledResearchOperationId = (
  identity: { userId: string; profile: string; sessionId: string; taskId: string },
  occurrenceId: string,
  accountId: string,
): string =>
  `schedule:${pluginInputHash({ identity, occurrenceId, tool: DAILY_CYCLE, accountId })}`;

export const createResearchContinuityReader = (options: ResearchContinuityOptions) => {
  const taskStatus = async (
    task: ScheduleCatalogEntry,
    principal: PluginPrincipal,
  ): Promise<ResearchTaskStatus | null> => {
    const owner = options.principalForSession(task.sessionId);
    if (owner?.userId !== principal.userId || owner.accountId !== principal.accountId) return null;
    const grant = await options.repository.findGrant(
      `batch:${task.id}:${principal.accountId}`,
      principal.userId,
    );
    const identity = {
      profile: options.profile,
      userId: principal.userId,
      sessionId: task.sessionId,
      taskId: task.id,
    };
    // A task title or prompt is never evidence that it can run this capability.
    const expectedInput = { accountId: principal.accountId };
    const hasCall = grant?.allowedCalls.some(
      (call) =>
        call.tool === DAILY_CYCLE &&
        call.accountId === principal.accountId &&
        call.inputJson === pluginInputJson(expectedInput) &&
        call.inputHash === pluginInputHash(expectedInput) &&
        call.capabilities.includes('write') &&
        call.capabilities.includes('external'),
    );
    if (grant && !hasCall) return null;
    const sameIdentity =
      grant !== null &&
      grant.identity.userId === identity.userId &&
      grant.identity.profile === identity.profile &&
      grant.identity.sessionId === identity.sessionId &&
      grant.identity.taskId === identity.taskId;
    const grantStatus: ResearchTaskStatus['grantStatus'] =
      grant === null
        ? 'missing'
        : !grant.enabled
          ? 'disabled'
          : options.now() < grant.createdAt || options.now() >= grant.expiresAt
            ? 'expired'
            : !sameIdentity ||
                grant.policyVersion !== options.policyVersion ||
                grant.scheduleHash !== dshScheduleHash(task)
              ? 'changed'
              : 'valid';
    let operation: PluginOperation | null = null;
    const delivery = task.lastDelivery;
    if (
      delivery &&
      grant &&
      sameIdentity &&
      Date.parse(delivery.scheduledAt) >= grant.createdAt &&
      Date.parse(delivery.scheduledAt) < grant.expiresAt &&
      Date.parse(delivery.deliveredAt) >= Date.parse(delivery.scheduledAt) &&
      Date.parse(delivery.deliveredAt) <= options.now()
    ) {
      const found = await options.repository.findOperation({
        ...principal,
        id: scheduledResearchOperationId(identity, delivery.scheduledAt, principal.accountId),
      });
      if (
        found?.tool === DAILY_CYCLE &&
        found.policyVersion === options.policyVersion &&
        found.authorization.kind === 'schedule' &&
        found.authorization.grantId === grant.id &&
        found.authorization.grantVersion === grant.version &&
        found.inputHash === pluginInputHash(expectedInput)
      )
        operation = found;
    }
    return {
      taskId: task.id,
      title: task.title,
      status: task.status,
      nextScheduledAt: task.scheduledAt,
      grantStatus,
      lastDelivery: delivery ?? null,
      operation:
        operation === null
          ? null
          : {
              operationId: operation.id,
              state: operation.state,
              createdAt: operation.createdAt,
              updatedAt: operation.updatedAt,
              result: operation.resultJson === null ? null : JSON.parse(operation.resultJson),
            },
    };
  };

  // 面板会为每个策略各读一次日循环审计；同一次打开发生在毫秒级内，
  // 共享这一份工作流运行列表，避免 N 个策略重复拉取与解码同一批审计。
  const workflowRunsMemo = new Map<string, { at: number; value: ToolResult<unknown> }>();
  const WORKFLOW_RUNS_TTL_MS = 30_000;
  const readWorkflowRuns = async (
    principal: PluginPrincipal,
    signal: AbortSignal,
  ): Promise<ToolResult<unknown>> => {
    const key = `${principal.userId}:${principal.accountId}`;
    const cached = workflowRunsMemo.get(key);
    if (cached !== undefined && options.now() - cached.at < WORKFLOW_RUNS_TTL_MS)
      return cached.value;
    const value = await options.read.invoke(
      'list_workflow_runs',
      { workflowName: 'strategy-daily-cycle', includeWatch: false, limit: 200 },
      signal,
    );
    workflowRunsMemo.set(key, { at: options.now(), value });
    return value;
  };

  return async (
    principal: PluginPrincipal,
    strategyId: string,
    signal: AbortSignal,
  ): Promise<ResearchContinuity> => {
    const [definition, scheduleResult, runResult, auditResult] = await Promise.all([
      options.read.invoke('get_strategy', { strategyId }, signal),
      options.read.invoke('get_strategy_schedule', { strategyId }, signal),
      options.read.invoke(
        'list_strategy_runs',
        { strategyId, scope: 'operational', limit: 1 },
        signal,
      ),
      readWorkflowRuns(principal, signal),
    ]);
    const strategy = definition.ok ? (definition.data as { strategy: Strategy }).strategy : null;
    const schedule = scheduleResult.ok
      ? (scheduleResult.data as { schedule: StrategySchedule | null }).schedule
      : null;
    const latestRun = runResult.ok
      ? ((runResult.data as { runs: StrategyRun[] }).runs[0] ?? null)
      : null;
    let taskSource: ResearchContinuity['taskSource'] = 'unavailable';
    let tasks: ResearchTaskStatus[] = [];
    if (options.tasks) {
      try {
        tasks = (
          await Promise.all((await options.tasks()).map((task) => taskStatus(task, principal)))
        ).filter((task): task is ResearchTaskStatus => task !== null);
        taskSource = 'available';
      } catch {
        taskSource = 'unavailable';
      }
    }
    const enabled = options.automationsEnabled && options.dailyCycleEnabled;
    const active = tasks.filter((task) => task.status === 'active' && task.grantStatus === 'valid');
    const receipts = active
      .flatMap((task) => (task.operation === null ? [] : [task.operation]))
      .sort((left, right) => right.updatedAt - left.updatedAt);
    const receipt = receipts[0];
    const audit =
      auditResult.ok && receipt && latestRun
        ? ((
            auditResult.data as {
              runs: {
                status: string;
                startedAt: string;
                finishedAt?: string;
                inputSummary?: unknown;
                summary?: unknown;
              }[];
            }
          ).runs.find((row) => {
            const input = StrategyDailyCycleAuditInputSummarySchema.safeParse(row.inputSummary);
            const output = StrategyDailyCycleAuditOutputSummarySchema.safeParse(row.summary);
            return (
              input.success &&
              output.success &&
              input.data.strategyId === strategyId &&
              input.data.scheduleId === schedule?.id &&
              input.data.requestedBy === 'scheduled' &&
              output.data.runId === latestRun.id &&
              output.data.status !== 'skipped' &&
              Date.parse(row.startedAt) >= receipt.createdAt &&
              row.finishedAt !== undefined &&
              Date.parse(row.finishedAt) <= receipt.updatedAt &&
              new Date(latestRun.startedAt).getTime() >= Date.parse(row.startedAt) &&
              latestRun.finishedAt !== undefined &&
              new Date(latestRun.finishedAt).getTime() <= Date.parse(row.finishedAt)
            );
          }) ?? null)
        : null;
    const reasons: string[] = [];
    let status: ResearchContinuity['status'];
    if (!definition.ok || !scheduleResult.ok || !runResult.ok) {
      status = 'unknown';
      reasons.push('策略、日程或真实运行事实读取失败，无法核对持续观察状态。');
    } else if (strategy?.status === 'paused' || strategy?.status === 'archived') {
      status = 'paused';
      reasons.push('策略已暂停或归档，不接收新的持续运行。');
    } else if (!schedule) {
      status = 'not-configured';
      reasons.push('尚未配置 StrategySchedule。');
    } else if (!schedule.enabled) {
      status = 'disabled';
      reasons.push('策略日程已关闭。');
    } else if (!enabled) {
      status = 'disabled';
      reasons.push('部署尚未显式开启批处理与自动执行，策略日程本身不会触发运行。');
    } else if (taskSource === 'unavailable') {
      status = 'unknown';
      reasons.push('无法读取宿主任务，不能确认后台正在执行。');
    } else if (active.length === 0) {
      status = 'blocked';
      reasons.push('缺少有效的 DSH 任务和匹配当前账户、任务定义及调用参数的授权。');
    } else if (receipt?.state === 'executing') {
      status = 'running';
      reasons.push('最近一次宿主投递对应的业务操作仍在执行。');
    } else if (receipt?.state === 'unknown' || receipt?.state === 'failed') {
      status = 'unknown';
      reasons.push('最近一次业务操作结果待核对，不能盲目重复执行。');
    } else if (receipt?.state !== 'succeeded' || !latestRun) {
      status = 'waiting';
      reasons.push('任务和授权已配置，尚未同时取得本策略运行事实及可核对的业务回执。');
    } else {
      const value = receipt.result as ToolResult<{ outcome?: string }>;
      const dataHealth = getStrategyRunDataHealth(latestRun);
      const stale =
        schedule.lastRunId !== latestRun.id ||
        latestRun.strategyVersionId !== strategy?.currentVersionId ||
        new Date(latestRun.dataAsOf).getTime() > options.now() ||
        (schedule.nextRunAt !== undefined &&
          new Date(schedule.nextRunAt).getTime() < options.now());
      if (!value?.ok || value.data.outcome === 'failed' || latestRun.status === 'failed') {
        status = 'partial';
        reasons.push('最近业务回执或策略运行包含失败，需查看原始事实。');
      } else if (value.data.outcome === 'skipped') {
        status = 'waiting';
        reasons.push('最近批次跳过执行，不能据此确认本策略本次已运行。');
      } else if (stale || new Date(latestRun.startedAt).getTime() < receipt.createdAt) {
        status = 'stale';
        reasons.push('运行版本、事实截止或到期日程尚未与当前状态对齐。');
      } else if (audit === null) {
        status = 'unknown';
        reasons.push('缺少与本次业务操作时间、策略、日程及运行身份相符的日循环审计。');
      } else if (
        value.data.outcome === 'partial' ||
        audit.status !== 'succeeded' ||
        dataHealth === 'partial' ||
        dataHealth === 'unavailable' ||
        latestRun.publication?.status !== 'published'
      ) {
        status = 'partial';
        reasons.push('任务已执行，数据覆盖或发布资格仍有缺口。');
      } else {
        status = 'healthy';
        reasons.push('有效任务授权、业务回执及本策略最新发布运行已核对。');
      }
    }
    return {
      status,
      reasons,
      automationsEnabled: enabled,
      schedule: scheduleResult,
      tasks,
      taskSource,
      latestRun,
      audit,
      factCutoff: latestRun === null ? null : new Date(latestRun.dataAsOf).toISOString(),
      notificationStatus: 'not-verified',
      limitations: [
        'DSH 投递回执只证明提醒已进入会话，业务执行以操作回执与策略运行事实为准。',
        '持续观察状态不证明通知送达，不会创建任务、授权、通知或交易。',
      ],
    };
  };
};
