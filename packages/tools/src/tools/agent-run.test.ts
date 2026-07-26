import type { AgentRuntimeLike, AgentRuntimeRequest, AgentRuntimeResult } from '@luoome/core';
import { STANDARD_DISCLAIMERS } from '@luoome/core';
import { describe, expect, it } from 'vitest';
import { AGENT_V1_TOOL_NAMES, buildAgentCallableTools } from '../agent-whitelist.js';
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
            kind: 'stock-group',
            tool: 'create_stock_group',
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

describe('agent_run', () => {
  it('未注入 agent runtime 时返回 permission_denied', async () => {
    const ctx = await buildTestContext();
    const result = await agentRunTool.execute({ message: '检查持仓' }, ctx);
    expect(result).toEqual({
      ok: false,
      error: { kind: 'permission_denied', required: 'agent runtime 未配置' },
    });
  });

  it('只向 runtime 暴露批准的 read/external 工具', async () => {
    const runtime = new StubAgentRuntime();
    const ctx = await buildTestContext({ agent: runtime });
    const result = await agentRunTool.execute({ message: '检查持仓' }, ctx);
    expect(result.ok).toBe(true);
    expect(runtime.request?.tools.map((item) => item.name)).toEqual([...AGENT_V1_TOOL_NAMES]);
    for (const callable of buildAgentCallableTools(toolRegistry, ctx)) {
      const sideEffect = toolRegistry.get(callable.name)?.sideEffect;
      expect(['read', 'external']).toContain(sideEffect);
      expect(sideEffect).not.toBe('write');
      expect(sideEffect).not.toBe('advice');
      expect(sideEffect).not.toBe('trade');
    }
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
    expect(AGENT_V1_TOOL_NAMES).not.toContain('agent_run');
    for (const name of AGENT_V1_TOOL_NAMES) {
      expect(toolRegistry.get(name), name).toBeDefined();
    }
  });
});
