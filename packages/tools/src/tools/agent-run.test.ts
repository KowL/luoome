import type { AgentRuntimeLike, AgentRuntimeRequest, AgentRuntimeResult } from '@luoome/core';
import { STANDARD_DISCLAIMERS } from '@luoome/core';
import { describe, expect, it } from 'vitest';
import { AGENT_SCENARIOS, BASE_INSTRUCTIONS } from '../agent/scenarios.js';
import { buildAgentCallableTools } from '../agent-whitelist.js';
import { toolRegistry } from '../registry.js';
import { buildTestContext } from '../testing/context.js';
import { agentRunTool } from './agent-run.js';

class StubAgentRuntime implements AgentRuntimeLike {
  readonly name = 'stub-agent';
  request?: AgentRuntimeRequest;

  async run(request: AgentRuntimeRequest): Promise<AgentRuntimeResult> {
    this.request = request;
    const holdings = request.tools.find((item) => item.name === 'list_holdings');
    if (holdings === undefined) throw new Error('list_holdings missing');
    const toolResult = await holdings.execute({});
    return {
      output: {
        conclusion: '持仓查询完成，当前结论仅供研究参考。',
        evidence: ['已读取持仓数据'],
        counterEvidence: ['未读取实时新闻'],
        risks: ['行情可能变化'],
        disclaimers: ['模型输出可能有误'],
        drafts: [
          {
            kind: 'strategy',
            tool: 'create_strategy',
            input: {},
            summary: '缺少必填字段的无效草案',
          },
        ],
      },
      trace: [
        {
          toolName: 'list_holdings',
          input: {},
          output: toolResult.output,
          ok: toolResult.ok,
          durationMs: 1,
        },
      ],
      usedTools: ['list_holdings'],
      totalUsage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
    };
  }
}

class ResearchDraftRuntime implements AgentRuntimeLike {
  readonly name = 'research-draft-agent';

  async run(): Promise<AgentRuntimeResult> {
    return {
      output: {
        conclusion: '仅生成研究写入草案，尚未写入。',
        evidence: ['已读取研究资料'],
        counterEvidence: ['尚未核验来源'],
        risks: ['草案需要用户确认'],
        disclaimers: ['草案不构成投资建议'],
        drafts: [
          {
            kind: 'research',
            tool: 'create_research_topic',
            input: { title: '草案主题', kind: 'theme', subjects: [], tags: [] },
            summary: '待确认的研究主题草案',
          },
        ],
      },
      trace: [],
      usedTools: [],
      totalUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    };
  }
}

const FAILED_QUOTE_TRACE = {
  toolName: 'batch_quote',
  input: { stockIds: ['SZ300857'] },
  output: {
    error: { kind: 'adapter_error', adapter: 'eastmoney', cause: 'timeout', recoverable: true },
  },
  ok: false,
  durationMs: 3,
};

/** 模型隐瞒 trace 中 batch_quote 的失败（不填 partialFailures/unknowns）。 */
class SilentFailureRuntime implements AgentRuntimeLike {
  readonly name = 'silent-failure-agent';

  async run(): Promise<AgentRuntimeResult> {
    return {
      output: {
        conclusion: '行情与持仓完整，结论不受影响。',
        evidence: ['已读取行情'],
        counterEvidence: [],
        risks: ['行情可能变化'],
        disclaimers: ['模型输出可能有误'],
        drafts: [],
      },
      trace: [FAILED_QUOTE_TRACE],
      usedTools: ['batch_quote'],
      totalUsage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
    };
  }
}

/** 模型已如实披露 batch_quote 失败。 */
class DisclosedFailureRuntime implements AgentRuntimeLike {
  readonly name = 'disclosed-failure-agent';

  async run(): Promise<AgentRuntimeResult> {
    return {
      output: {
        conclusion: '行情拉取失败，结论仅基于本地持仓。',
        evidence: ['已读取持仓'],
        counterEvidence: ['实时行情缺失'],
        risks: ['行情数据不可用'],
        disclaimers: ['模型输出可能有误'],
        drafts: [],
        unknowns: ['实时行情'],
        partialFailures: [
          {
            dimension: '实时行情',
            tool: 'batch_quote',
            reason: 'adapter_error：timeout',
            retryable: true,
          },
        ],
      },
      trace: [FAILED_QUOTE_TRACE],
      usedTools: ['batch_quote'],
      totalUsage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
    };
  }
}

/** 模型产出指定 drafts 的 runtime（用于 advice 草案门控测试）。 */
class AdviceDraftRuntime implements AgentRuntimeLike {
  readonly name = 'advice-draft-agent';

  constructor(private readonly drafts: readonly Record<string, unknown>[]) {}

  async run(): Promise<AgentRuntimeResult> {
    return {
      output: {
        conclusion: '已生成分析草案，待用户确认。',
        evidence: [],
        counterEvidence: [],
        risks: ['草案需要用户确认'],
        disclaimers: ['草案不构成投资建议'],
        drafts: this.drafts,
      },
      trace: [],
      usedTools: [],
      totalUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    };
  }
}

describe('agent_run', () => {
  it('未注入 agent runtime 时返回 permission_denied', async () => {
    const ctx = await buildTestContext();
    const result = await agentRunTool.execute({ message: '检查持仓' }, ctx);
    expect(result).toEqual({
      ok: false,
      error: { kind: 'permission_denied', required: 'agent runtime 未配置' },
    });
  });

  it('只向 runtime 暴露批准的 read/external 工具（默认 general 场景）', async () => {
    const runtime = new StubAgentRuntime();
    const ctx = await buildTestContext({ agent: runtime });
    const result = await agentRunTool.execute({ message: '检查持仓' }, ctx);
    expect(result.ok).toBe(true);
    expect(runtime.request?.tools.map((item) => item.name)).toEqual([
      ...AGENT_SCENARIOS.general.readToolNames,
    ]);
    expect(runtime.request?.instructions).toContain(BASE_INSTRUCTIONS);
    for (const callable of buildAgentCallableTools(
      toolRegistry,
      ctx,
      AGENT_SCENARIOS.general.readToolNames,
    )) {
      const sideEffect = toolRegistry.get(callable.name)?.sideEffect;
      expect(['read', 'external']).toContain(sideEffect);
      expect(sideEffect).not.toBe('write');
      expect(sideEffect).not.toBe('advice');
      expect(sideEffect).not.toBe('trade');
    }
  });

  it('按 scenario 切换白名单并追加场景覆写', async () => {
    const runtime = new StubAgentRuntime();
    const ctx = await buildTestContext({ agent: runtime });
    const result = await agentRunTool.execute({ message: '复盘建议', scenario: 'review' }, ctx);
    expect(result.ok).toBe(true);
    const names = runtime.request?.tools.map((item) => item.name) ?? [];
    expect(names).toEqual([...AGENT_SCENARIOS.review.readToolNames]);
    expect(names).toContain('get_confidence_calibration');
    expect(names).not.toContain('run_local_selector_research');
    expect(runtime.request?.instructions).toContain('描述性统计');
  });

  it('派生 usedTools/trace，补齐标准免责声明并丢弃非法 draft', async () => {
    const runtime = new StubAgentRuntime();
    const ctx = await buildTestContext({ agent: runtime });
    const result = await agentRunTool.execute({ message: '检查持仓' }, ctx);
    if (!result.ok) throw new Error('agent_run should succeed');
    expect(result.data.usedTools).toEqual(['list_holdings']);
    expect(result.data.trace[0]).toMatchObject({ toolName: 'list_holdings', ok: true });
    expect(result.data.drafts).toEqual([]);
    expect(result.data.risks).toContain('1 条无效写入草案已被安全门控丢弃');
    for (const disclaimer of STANDARD_DISCLAIMERS) {
      expect(result.data.disclaimers).toContain(disclaimer);
    }
  });

  it('白名单中的每个名字都已注册且不包含 agent_run 自身', () => {
    const names = AGENT_SCENARIOS.general.readToolNames;
    expect(names).not.toContain('agent_run');
    expect(names).not.toContain('list_tactics');
    expect(names).not.toContain('list_stock_groups');
    expect(names).not.toContain('list_stock_pools');
    for (const name of names) {
      expect(toolRegistry.get(name), name).toBeDefined();
    }
  });

  it('研究写入只能作为 schema 校验后的 research 草案返回，不执行写入', async () => {
    const runtime = new ResearchDraftRuntime();
    const ctx = await buildTestContext({ agent: runtime });
    const result = await agentRunTool.execute({ message: '创建研究主题草案' }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.drafts).toEqual([
      expect.objectContaining({ kind: 'research', tool: 'create_research_topic' }),
    ]);
    expect(result.data.usedTools).toEqual([]);
  });

  it('模型输出缺 unknowns/partialFailures 字段时按默认值兼容', async () => {
    const runtime = new StubAgentRuntime();
    const ctx = await buildTestContext({ agent: runtime });
    const result = await agentRunTool.execute({ message: '检查持仓' }, ctx);
    if (!result.ok) throw new Error('agent_run should succeed');
    expect(result.data.unknowns).toEqual([]);
    expect(result.data.partialFailures).toEqual([]);
  });

  it('模型隐瞒工具失败时按 trace 强制补入 partialFailures 并追加 risks 提示', async () => {
    const runtime = new SilentFailureRuntime();
    const ctx = await buildTestContext({ agent: runtime });
    const result = await agentRunTool.execute({ message: '检查行情' }, ctx);
    if (!result.ok) throw new Error('agent_run should succeed');
    expect(result.data.partialFailures).toEqual([
      {
        dimension: 'batch_quote',
        tool: 'batch_quote',
        reason: 'adapter_error：timeout',
        retryable: true,
      },
    ]);
    expect(result.data.risks).toContain(
      '1 项工具失败未由模型披露，已按工具轨迹强制补入 partialFailures',
    );
  });

  it('模型已披露对应 tool 时不重复补入', async () => {
    const runtime = new DisclosedFailureRuntime();
    const ctx = await buildTestContext({ agent: runtime });
    const result = await agentRunTool.execute({ message: '检查行情' }, ctx);
    if (!result.ok) throw new Error('agent_run should succeed');
    expect(result.data.partialFailures).toHaveLength(1);
    expect(result.data.partialFailures[0]?.dimension).toBe('实时行情');
    expect(result.data.unknowns).toEqual(['实时行情']);
    expect(result.data.risks.some((risk) => risk.includes('强制补入 partialFailures'))).toBe(false);
  });

  it('advice 草案通过校验并附带 display 投影，不执行分析', async () => {
    const runtime = new AdviceDraftRuntime([
      {
        kind: 'advice',
        tool: 'analyze_stock',
        input: { stockId: 'SZ300857' },
        summary: '个股分析草案',
      },
    ]);
    const ctx = await buildTestContext({ agent: runtime });
    const result = await agentRunTool.execute({ message: '帮我分析 300857' }, ctx);
    if (!result.ok) throw new Error('agent_run should succeed');
    expect(result.data.drafts).toHaveLength(1);
    expect(result.data.drafts[0]).toMatchObject({ kind: 'advice', tool: 'analyze_stock' });
    expect(result.data.drafts[0]?.display?.targetObject).toBe('个股 Advice（SZ300857）');
    // 草案路径不触发真实分析：库里不应产生 Advice 记录
    expect(await ctx.repos.advice.query({})).toEqual([]);
  });

  it('kind 与 tool 不匹配的 advice 草案仍被门控丢弃', async () => {
    const runtime = new AdviceDraftRuntime([
      {
        kind: 'strategy',
        tool: 'analyze_stock',
        input: { stockId: 'SZ300857' },
        summary: '伪装草案',
      },
    ]);
    const ctx = await buildTestContext({ agent: runtime });
    const result = await agentRunTool.execute({ message: '帮我分析 300857' }, ctx);
    if (!result.ok) throw new Error('agent_run should succeed');
    expect(result.data.drafts).toEqual([]);
    expect(result.data.risks).toContain('1 条无效写入草案已被安全门控丢弃');
  });
});
