import { randomUUID } from 'node:crypto';
import {
  AnalysisContextSchema,
  AnalysisFailureSchema,
  type AnalysisJob,
  AnalysisJobSchema,
  AnalysisJobStatusSchema,
  AnalysisKindSchema,
  analysisContextTimingError,
  dateInShanghai,
} from '@luoome/core';
import { z } from 'zod';
import {
  defineTool,
  errInvalidInput,
  errLeaseLostBeforeCommit,
  errNotFound,
} from '../define-tool.js';
import { AnalysisContextRequest, analysisHash, assembleAnalysisContext } from './context.js';

const Account = z.object({ accountId: z.string().min(1).optional() });
const JobId = Account.extend({ jobId: z.string().min(1) });
export const enqueueAnalysisJobTool = defineTool({
  name: 'enqueue_analysis_job',
  description: '内部生产者：冻结事实并幂等入队，不执行推理。',
  sideEffect: 'write',
  input: AnalysisContextRequest.extend({
    source: z.enum(['workflow', 'tool', 'schedule', 'chat']),
    priority: z.number().int().min(0).max(100).default(50),
    notBefore: z.coerce.date().optional(),
  }),
  output: z.object({ jobId: z.string(), deduped: z.boolean() }),
  handler: async (input, ctx) => {
    /**
     * ## 受理与执行解耦（REQ-M5-01）
     *
     * 受理路径**只做三件事**：校验 subject → 算去重键 → 入队。**不装配上下文。**
     *
     * 为什么：`assembleAnalysisContext` 要读库、聚合行情/持仓/事件事实——那是重活。
     * 它留在这里，受理耗时**必然**随数据量增长，`≤2s` 靠机器快是碰巧，不是保证。
     *
     * ⇒ 装配移到**执行阶段**（claim 时）。代价是 `dataAsOf` 在受理时还不可知，
     * 暂记 `now`，claim 时用真实装配结果覆盖。
     */
    const accountId = input.accountId ?? ctx.user.defaultAccountId;
    if ((await ctx.repos.account.findById(accountId)) === null)
      return errNotFound('Account', accountId);
    const now = ctx.clock();
    const job: AnalysisJob = {
      id: randomUUID(),
      kind: input.kind,
      source: input.source,
      accountId,
      subject: input.subject,
      priority: input.priority,
      dedupeKey: analysisHash({
        kind: input.kind,
        accountId,
        subject: input.subject,
        tradingDate: dateInShanghai(now),
        options: input.options,
      }),
      // **不再携带 snapshot**：装配推迟到 claim。`payload` 只留受理阶段已知的东西。
      payload: { options: input.options, subject: input.subject, kind: input.kind },
      dataAsOf: now,
      notBefore: input.notBefore ?? now,
      status: 'pending',
      attempts: 0,
      maxAttempts: 3,
      claimToken: null,
      claimedBy: null,
      leaseUntil: null,
      contextId: null,
      result: null,
      error: null,
      createdAt: now,
      updatedAt: now,
      finishedAt: null,
    };
    const result = await ctx.repos.analysis.enqueue(job);
    return { jobId: result.job.id, deduped: result.deduped };
  },
});

export const listAnalysisJobsTool = defineTool({
  name: 'list_analysis_jobs',
  description: '读取当前账户分析队列状态。',
  sideEffect: 'read',
  input: Account.extend({
    status: AnalysisJobStatusSchema.optional(),
    kinds: z.array(AnalysisKindSchema).optional(),
    limit: z.number().int().min(1).max(500).default(50),
    since: z.coerce.date().optional(),
  }),
  output: z.object({ jobs: z.array(AnalysisJobSchema) }),
  handler: async (input, ctx) => ({
    jobs: await ctx.repos.analysis.listJobs({
      accountId: input.accountId ?? ctx.user.defaultAccountId,
      limit: input.limit,
      ...(input.status ? { statuses: [input.status] } : {}),
      ...(input.kinds ? { kinds: input.kinds } : {}),
      ...(input.since ? { since: input.since } : {}),
    }),
  }),
});
export const getAnalysisJobTool = defineTool({
  name: 'get_analysis_job',
  description: '读取分析任务及终态摘要。',
  sideEffect: 'read',
  input: JobId,
  output: AnalysisJobSchema,
  handler: async (input, ctx) =>
    (await ctx.repos.analysis.findJob(input.accountId ?? ctx.user.defaultAccountId, input.jobId)) ??
    errNotFound('AnalysisJob', input.jobId),
});
export const claimAnalysisJobsTool = defineTool({
  name: 'claim_analysis_jobs',
  description: '领取当前账户的分析任务及冻结事实；租约 token 是写回凭据。',
  sideEffect: 'queue',
  input: Account.extend({
    owner: z.string().min(1).max(200),
    refresh: z
      .object({
        jobId: z.string().min(1),
        claimToken: z.string().min(1),
        contextId: z.string().min(1),
      })
      .optional(),
    kinds: z.array(AnalysisKindSchema).optional(),
    limit: z.number().int().min(1).max(10).default(1),
    leaseSeconds: z.number().int().min(10).max(1800).default(300),
  }),
  output: z.object({
    claims: z.array(
      z.object({ job: AnalysisJobSchema, claimToken: z.string(), context: AnalysisContextSchema }),
    ),
  }),
  handler: async (input, ctx) => {
    const accountId = input.accountId ?? ctx.user.defaultAccountId;
    const now = ctx.clock();
    if (input.refresh) {
      const current = await ctx.repos.analysis.findJob(accountId, input.refresh.jobId);
      if (
        current?.status !== 'claimed' ||
        current.claimToken !== input.refresh.claimToken ||
        !current.leaseUntil ||
        current.leaseUntil <= now
      )
        return errLeaseLostBeforeCommit();
      const fresh = await ctx.repos.analysis.findContext(accountId, input.refresh.contextId);
      if (
        !fresh ||
        fresh.jobId ||
        fresh.recordedResult ||
        fresh.kind !== current.kind ||
        fresh.subject.kind !== current.subject.kind ||
        fresh.subject.id !== current.subject.id
      )
        return errInvalidInput('context_mismatch');
      const timingError = analysisContextTimingError(fresh, now);
      if (timingError) return errInvalidInput(timingError);
      const context = {
        ...fresh,
        id: randomUUID(),
        jobId: current.id,
        writeUntil: current.leaseUntil,
        expiresAt: new Date(now.getTime() + 30 * 86400000),
        createdAt: now,
      };
      const job = await ctx.repos.analysis.refreshContext({
        accountId,
        jobId: current.id,
        token: input.refresh.claimToken,
        now,
        context,
      });
      if (!job) return errInvalidInput('context_refresh_unavailable');
      return { claims: [{ job, claimToken: input.refresh.claimToken, context }] };
    }
    const jobs = await ctx.repos.analysis.listJobs({
      accountId,
      statuses: ['pending', 'claimed'],
      ...(input.kinds ? { kinds: input.kinds } : {}),
    });
    const claims = [];
    for (const candidate of jobs) {
      if (claims.length >= input.limit) break;
      /**
       * **执行阶段才装配**（REQ-M5-01）：受理只排期，装配发生在 claim。
       *
       * 装配结果写进 `context`，供下游执行使用；同时把真实的 `dataAsOf`
       * 回填到 job（受理时它只能是 `now`）。
       */
      const assembled = await assembleAnalysisContext(
        {
          kind: candidate.kind,
          subject: candidate.subject,
          accountId: candidate.accountId,
          options: (candidate.payload.options ?? {}) as never,
        },
        ctx,
      );
      if (assembled === null) continue;
      /**
       * `context.dataAsOf` 必须与 `job.dataAsOf` **完全一致**（repository 的 `context_mismatch` 校验）。
       *
       * 受理时 `job.dataAsOf` 记的是 `now`（装配还没发生）；这里拿到真实装配结果后，
       * **先把 job 的 `dataAsOf` 回填成真实值**，再构造 context —— 否则两者永远不等。
       */
      /**
       * **时序**（REQ-M5-01）：claim 的陈旧判定（`isAnalysisContextStale`）用的是
       * `job.dataAsOf` —— 此刻它还是受理时写的占位值 `now`，那一步**先发生**。
       * 装配成功后**立即回填**，于是**下一次** claim 用的是真值。
       *
       * ⇒ 「第一次 claim 用占位值」是解耦的已知代价；回填保证它只影响一次。
       */
      const backfilled = await ctx.repos.analysis.setJobDataAsOf({
        accountId,
        jobId: candidate.id,
        dataAsOf: assembled.dataAsOf,
        now,
      });
      if (backfilled === null) continue;

      const context = {
        ...assembled,
        id: randomUUID(),
        jobId: candidate.id,
        writeUntil: new Date(now.getTime() + input.leaseSeconds * 1000),
        expiresAt: new Date(now.getTime() + 30 * 86400000),
        createdAt: now,
      };
      const claimToken = randomUUID();
      const job = await ctx.repos.analysis.claim({
        accountId,
        jobId: candidate.id,
        owner: input.owner,
        token: claimToken,
        now,
        leaseUntil: context.writeUntil,
        context,
      });
      if (job) claims.push({ job, claimToken, context });
    }
    return { claims };
  },
});
export const failAnalysisJobTool = defineTool({
  name: 'fail_analysis_job',
  description: '报告消费失败；可重试任务回队列，耗尽或永久失败进入死信。',
  sideEffect: 'queue',
  input: JobId.extend({
    claimToken: z.string().min(1),
    error: AnalysisFailureSchema,
    retryAfterSeconds: z.number().int().min(0).max(86400).default(60),
  }),
  output: AnalysisJobSchema,
  handler: async (input, ctx) => {
    const now = ctx.clock();
    return (
      (await ctx.repos.analysis.fail({
        accountId: input.accountId ?? ctx.user.defaultAccountId,
        jobId: input.jobId,
        token: input.claimToken,
        error: input.error,
        now,
        notBefore: new Date(now.getTime() + input.retryAfterSeconds * 1000),
      })) ?? errLeaseLostBeforeCommit()
    );
  },
});
export const cancelAnalysisJobTool = defineTool({
  name: 'cancel_analysis_job',
  description: '人工取消尚未完成的任务，立即关闭旧事实包的写回窗口。',
  sideEffect: 'write',
  input: JobId,
  output: AnalysisJobSchema,
  handler: async (input, ctx) =>
    (await ctx.repos.analysis.cancel(
      input.accountId ?? ctx.user.defaultAccountId,
      input.jobId,
      ctx.clock(),
    )) ?? errInvalidInput('job_not_cancellable'),
});
export const requeueAnalysisJobTool = defineTool({
  name: 'requeue_analysis_job',
  description: '人工重排死信任务；存在同键活动任务时拒绝。',
  sideEffect: 'write',
  input: JobId,
  output: AnalysisJobSchema,
  handler: async (input, ctx) =>
    (await ctx.repos.analysis.requeue(
      input.accountId ?? ctx.user.defaultAccountId,
      input.jobId,
      ctx.clock(),
    )) ?? errInvalidInput('job_not_requeueable'),
});
export const getAnalysisMetricsTool = defineTool({
  name: 'get_analysis_metrics',
  description: '读取积压、完成/失败率及尚未回收的过期租约；不改变任务状态。',
  sideEffect: 'read',
  input: Account.extend({ windowDays: z.number().int().min(1).max(365).default(7) }),
  output: z.object({
    pending: z.number(),
    readyPending: z.number(),
    claimed: z.number(),
    deadLetter: z.number(),
    oldestPendingAgeMs: z.number(),
    completed: z.number(),
    failed: z.number(),
    completionRate: z.number(),
    failureRate: z.number(),
    claimExpiredNotRecycled: z.object({ count: z.number(), oldestAgeMs: z.number() }),
    byKind: z.record(z.string(), z.number()),
  }),
  handler: async (input, ctx) => {
    const now = ctx.clock().getTime();
    const jobs = await ctx.repos.analysis.listJobs({
      accountId: input.accountId ?? ctx.user.defaultAccountId,
    });
    const pending = jobs.filter((job) => job.status === 'pending');
    const claimed = jobs.filter((job) => job.status === 'claimed');
    const expired = claimed.filter((job) => job.leaseUntil && job.leaseUntil.getTime() <= now);
    const recent = jobs.filter(
      (job) => job.finishedAt && job.finishedAt.getTime() >= now - input.windowDays * 86400000,
    );
    const completed = recent.filter((job) => job.status === 'completed').length;
    const failed = recent.filter((job) => ['failed', 'dead_letter'].includes(job.status)).length;
    const byKind: Record<string, number> = {};
    for (const job of jobs) byKind[job.kind] = (byKind[job.kind] ?? 0) + 1;
    return {
      pending: pending.length,
      readyPending: pending.filter((job) => job.notBefore.getTime() <= now).length,
      claimed: claimed.length,
      deadLetter: jobs.filter((job) => job.status === 'dead_letter').length,
      oldestPendingAgeMs: Math.max(0, ...pending.map((job) => now - job.createdAt.getTime())),
      completed,
      failed,
      completionRate: completed + failed ? completed / (completed + failed) : 0,
      failureRate: completed + failed ? failed / (completed + failed) : 0,
      claimExpiredNotRecycled: {
        count: expired.length,
        oldestAgeMs: Math.max(0, ...expired.map((job) => now - (job.leaseUntil?.getTime() ?? now))),
      },
      byKind,
    };
  },
});
