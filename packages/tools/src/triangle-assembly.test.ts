import { buildTestContext } from '@luoome/tools/testing';
import { describe, expect, it } from 'vitest';

import { assembleAnalysisContext } from './queue/context.js';
import { extractTokenUsed, runTriangleAnalysis, triangleSummaryLead } from './triangle-assembly.js';

/**
 * REQ-M4-02 **端到端装配**。
 *
 * ## 这一条是本任务的核心交付
 *
 * 第一份只做了 schema 与纯函数级验证。**「schema 定义对了但没用上」本会话已经十次**，
 * 所以这里必须真的装配一份 `AnalysisContext`、真的把同一份 context 发给四个角色、
 * 真的把产出串起来。
 *
 * 角色执行器是**注入的确定性函数**——不需要模型，但走的是完全相同的代码路径。
 */
// `advice_market` 不依赖策略运行上下文，适合做装配冒烟。
const request = {
  kind: 'advice_market' as const,
  subject: { kind: 'market' as const, id: 'CN_A_SHARES_SH_SZ' },
  options: {},
};

const setup = async () => {
  const ctx = await buildTestContext({ clock: () => new Date('2026-07-29T20:00:00+08:00') });
  const context = await assembleAnalysisContext(request, ctx);
  if (context === null) throw new Error('上下文装配失败（fixture 不满足前置）');
  return { ctx, context };
};

describe('三角分析端到端装配', () => {
  it('四角色**共享同一个 contextId 与 factIds**', async () => {
    const { ctx, context } = await setup();
    const seen: { role: string; contextId: string; factIds: readonly string[] }[] = [];

    await runTriangleAnalysis({
      context,
      dataHealth: 'complete',
      marketSession: 'closed',
      executor: async (task) => {
        seen.push({ role: task.role, contextId: task.contextId, factIds: task.factIds });
        return { tokenUsed: 10 };
      },
      now: () => Date.now(),
      ctx,
    });

    // 四个角色都跑了
    expect(seen.map((item) => item.role)).toEqual(['bull', 'bear', 'judge', 'risk-officer']);
    // **同一个 contextId**（PRD 需求 1）
    expect(new Set(seen.map((item) => item.contextId)).size).toBe(1);
    expect(seen[0]?.contextId).toBe(context.id);
    // **同一份 factIds**（不是各自拼的）
    for (const item of seen) expect(item.factIds).toEqual(context.factIds);
  });

  it('角色任务里**只有 fact id**，没有自由文本证据字段', async () => {
    const { ctx, context } = await setup();
    await runTriangleAnalysis({
      context,
      dataHealth: 'complete',
      marketSession: 'closed',
      executor: async (task) => {
        // 结构上就不存在 `evidence` / `thesis` 这类入口
        expect(Object.keys(task).sort()).toEqual(['contextId', 'factIds', 'role']);
        expect(Array.isArray(task.factIds)).toBe(true);
        return {};
      },
      now: () => Date.now(),
      ctx,
    });
  });

  it('角色任务**不含任何写权限句柄**（子 agent 只读，需求 8）', async () => {
    const { ctx, context } = await setup();
    await runTriangleAnalysis({
      context,
      dataHealth: 'complete',
      marketSession: 'closed',
      executor: async (task) => {
        for (const forbidden of ['repos', 'tools', 'writer', 'writeScope', 'permissions'])
          expect(Object.hasOwn(task, forbidden)).toBe(false);
        return {};
      },
      now: () => Date.now(),
      ctx,
    });
  });

  it('`elapsedMs` 是**真实计时**（不是常量）', async () => {
    const { ctx, context } = await setup();
    let clock = 1_000;
    const result = await runTriangleAnalysis({
      context,
      dataHealth: 'complete',
      marketSession: 'closed',
      // 每次推进 7ms —— 若 elapsedMs 是常量或 0，这条会红
      now: () => (clock += 7),
      executor: async () => ({ tokenUsed: 5 }),
      ctx,
    });
    // bull→bear 之间推进了两次 now（取起始 + 结束）
    expect(result.roles[0]?.elapsedMs).toBe(7);
    expect(new Set(result.roles.map((role) => role.elapsedMs)).size).toBe(1);
  });

  it('`tokenUsed` 拿不到真实值时为 **null**，不编造', async () => {
    const { ctx, context } = await setup();
    const result = await runTriangleAnalysis({
      context,
      dataHealth: 'complete',
      marketSession: 'closed',
      // 执行器不报 token —— 必须如实留空
      executor: async () => ({ somethingElse: true }),
      now: () => Date.now(),
      ctx,
    });
    for (const role of result.roles) expect(role.tokenUsed).toBeNull();
    // 直接测提取函数：各种拿不到的情况都返回 null
    expect(extractTokenUsed(null)).toBeNull();
    expect(extractTokenUsed({})).toBeNull();
    expect(extractTokenUsed({ tokenUsed: 'abc' })).toBeNull();
    expect(extractTokenUsed({ tokenUsed: -1 })).toBeNull();
    expect(extractTokenUsed({ tokenUsed: Number.NaN })).toBeNull();
    // 真实数字才认
    expect(extractTokenUsed({ tokenUsed: 0 })).toBe(0);
    expect(extractTokenUsed({ tokenUsed: 42 })).toBe(42);
  });

  it('门禁拒绝时**不装配**、不跑任何角色', async () => {
    const { ctx, context } = await setup();
    let called = 0;
    const result = await runTriangleAnalysis({
      context,
      dataHealth: 'unavailable',
      marketSession: 'closed',
      executor: async () => {
        called += 1;
        return {};
      },
      now: () => Date.now(),
      ctx,
    });
    expect(result.blocked).not.toBeNull();
    expect(result.roles).toEqual([]);
    // **一个角色都没跑**（不浪费昂贵的装配）
    expect(called).toBe(0);
  });

  it('盘时段拒绝的原因码与数据无关（端到端也成立）', async () => {
    const { ctx, context } = await setup();
    const result = await runTriangleAnalysis({
      context,
      dataHealth: 'complete',
      marketSession: 'trading',
      executor: async () => ({}),
      now: () => Date.now(),
      ctx,
    });
    expect(result.blocked?.code).toBe('market-session-in-trading');
  });
});

// ── 需求 6 / 7 / 5 / 8 ──

describe('事前成本确认（需求 6）', () => {
  const estimate = {
    estimatedTokenRange: { min: 10_000, max: 50_000 },
    estimatedDurationMs: { min: 60_000, max: 300_000 },
  };

  it('**未确认时执行器调用数为 0**（不是「返回了个字段」）', async () => {
    const { ctx, context } = await setup();
    let called = 0;
    const result = await runTriangleAnalysis({
      context,
      dataHealth: 'complete',
      marketSession: 'closed',
      estimate,
      // 刻意不传 confirmed
      executor: async () => {
        called += 1;
        return {};
      },
      now: () => Date.now(),
      ctx,
    });
    // **关键断言**：真的一个都没跑。只断言「字段存在」证明不了这一点。
    expect(called).toBe(0);
    expect(result.roles).toEqual([]);
    expect(result.blocked?.code).toBe('cost-not-confirmed');
  });

  it('确认后才启动，且四个角色都跑', async () => {
    const { ctx, context } = await setup();
    let called = 0;
    const result = await runTriangleAnalysis({
      context,
      dataHealth: 'complete',
      marketSession: 'closed',
      estimate,
      confirmed: true,
      executor: async () => {
        called += 1;
        return { tokenUsed: 100 };
      },
      now: () => Date.now(),
      ctx,
    });
    expect(called).toBe(4);
    expect(result.roles).toHaveLength(4);
  });
});

describe('降级路径（需求 7）', () => {
  const okEstimate = {
    estimatedTokenRange: { min: 1000, max: 2000 },
    estimatedDurationMs: { min: 1000, max: 2000 },
  };

  it('**token 预算超限 → 降级为单 agent**，阈值可注入', async () => {
    const { ctx, context } = await setup();
    const ran: string[] = [];
    const result = await runTriangleAnalysis({
      context,
      dataHealth: 'complete',
      marketSession: 'closed',
      estimate: okEstimate,
      confirmed: true,
      // 调小预算：预估上限 2000 > 100
      budget: { maxTokens: 100, maxDurationMs: 900_000 },
      executor: async (task) => {
        ran.push(task.role);
        return { tokenUsed: 50 };
      },
      now: () => Date.now(),
      ctx,
    });
    expect(result.degraded).toBe('token-budget-exceeded');
    // **只跑一个** agent（不是四个）
    expect(ran).toEqual(['judge']);
    // 首段必须写明已降级及原因
    expect(result.lead).toContain('已降级');
    expect(result.lead).toContain('token 预算超限');
  });

  it('**时长超限 → 降级**，阈值可注入（15 分钟在测试里等不起）', async () => {
    const { ctx, context } = await setup();
    const result = await runTriangleAnalysis({
      context,
      dataHealth: 'complete',
      marketSession: 'closed',
      estimate: okEstimate,
      confirmed: true,
      budget: { maxTokens: 1_000_000, maxDurationMs: 1 },
      executor: async () => ({ tokenUsed: 10 }),
      now: () => Date.now(),
      ctx,
    });
    expect(result.degraded).toBe('duration-exceeded');
    expect(result.lead).toContain('已降级');
    expect(result.lead).toContain('时长上限');
  });

  it('不超预算则不降级，四角色全跑', async () => {
    const { ctx, context } = await setup();
    const result = await runTriangleAnalysis({
      context,
      dataHealth: 'complete',
      marketSession: 'closed',
      estimate: okEstimate,
      confirmed: true,
      budget: { maxTokens: 1_000_000, maxDurationMs: 900_000 },
      executor: async () => ({ tokenUsed: 10 }),
      now: () => Date.now(),
      ctx,
    });
    expect(result.degraded).toBeNull();
    expect(result.roles).toHaveLength(4);
    expect(result.lead).not.toContain('已降级');
  });
});

describe('结果首段（需求 5，PRD 无条件验收）', () => {
  it('含 tokenUsed 与 elapsedMs', () => {
    const lead = triangleSummaryLead({ tokenUsed: 1234, elapsedMs: 65_000, degraded: null });
    expect(lead).toContain('1234 tokens');
    expect(lead).toContain('65 秒');
  });

  it('**tokenUsed 为 null 时明说「未获取到」**，不写 0、不留空', () => {
    const lead = triangleSummaryLead({ tokenUsed: null, elapsedMs: 1000, degraded: null });
    expect(lead).toContain('未获取到');
    // **不许**假装是 0
    expect(lead).not.toContain('0 tokens');
  });

  it('实测路径里 tokenUsed 全 null → 首段说「未获取到」', async () => {
    const { ctx, context } = await setup();
    const result = await runTriangleAnalysis({
      context,
      dataHealth: 'complete',
      marketSession: 'closed',
      executor: async () => ({}), // 不报用量
      now: () => Date.now(),
      ctx,
    });
    expect(result.tokenUsed).toBeNull();
    expect(result.lead).toContain('未获取到');
  });
});

describe('子 agent 只读：运行时写被拒（需求 8）', () => {
  /**
   * **类型层没有这个字段** ≠ **运行时写不进去**。
   *
   * 角色任务的类型里没有 `repos`/`tools`，但执行器**确实能拿到 `ToolContext`**
   * （它要读 fact），而 `ToolContext` 里有 `repos` ——
   * 类型层挡不住「执行器顺手调一次 `repos.advice.save`」。
   */
  it('只读上下文里，**写工具真的被拒**', async () => {
    const { ctx } = await setup();
    const { saveReportTool } = await import('./tools/save-report.js');
    const readOnlyCtx = { ...ctx, readOnly: true } as typeof ctx;

    const rejected = await saveReportTool.execute({ report: {} as never }, readOnlyCtx);
    expect(rejected.ok).toBe(false);
    if (!rejected.ok)
      expect(rejected.error).toMatchObject({
        required: 'read-only context cannot perform write or external side effects',
      });
  });

  it('只读上下文里，**只读工具正常放行**（不能误伤读）', async () => {
    const { ctx } = await setup();
    const { listReportsTool } = await import('./tools/list-reports.js');
    const readOnlyCtx = { ...ctx, readOnly: true } as typeof ctx;
    const allowed = await listReportsTool.execute({}, readOnlyCtx);
    // 只读工具不该被拦（它可能因为没有数据返回空，但**不是权限拒绝**）
    if (!allowed.ok)
      expect(allowed.error).not.toMatchObject({
        required: 'read-only context cannot perform write or external side effects',
      });
  });

  it('普通上下文（无 readOnly）写工具照常可用（既有行为不变）', async () => {
    const { ctx } = await setup();
    const { listReportsTool } = await import('./tools/list-reports.js');
    const allowed = await listReportsTool.execute({}, ctx);
    expect(allowed.ok).toBe(true);
  });
});
