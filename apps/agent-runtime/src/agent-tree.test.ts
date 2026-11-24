import { describe, expect, it } from 'vitest';
import { awaitDescendants, RunAgentTree, recordAgentDiagnostic } from './agent-tree.js';

const clock = (start = 0) => {
  let current = start;
  return {
    now: () => current,
    sleep: async (ms: number) => {
      current += ms;
    },
    advance: (ms: number) => {
      current += ms;
    },
  };
};

describe('RunAgentTree descendant completion', () => {
  it('abandons descendants that hit the wait deadline instead of failing the run', async () => {
    const tree = new RunAgentTree('root');
    tree.spawn('child-a', 'root');
    tree.spawn('child-b', 'root');
    const time = clock();
    expect(
      await awaitDescendants(tree, {
        deadline: 100,
        cancelled: () => false,
        now: time.now,
        sleep: time.sleep,
      }),
    ).toBe('abandoned');
    expect(tree.hasActiveDescendants()).toBe(false);
    expect(tree.snapshot()).toEqual([
      { agentId: 'root', parentAgentId: null, depth: 0, status: 'active' },
      { agentId: 'child-a', parentAgentId: 'root', depth: 1, status: 'abandoned' },
      { agentId: 'child-b', parentAgentId: 'root', depth: 1, status: 'abandoned' },
    ]);
  });

  it('completes once every descendant reaches a terminal state', async () => {
    const tree = new RunAgentTree('root');
    tree.spawn('child-a', 'root');
    tree.spawn('grandchild', 'child-a');
    const time = clock();
    const wait = await awaitDescendants(tree, {
      deadline: 1000,
      cancelled: () => false,
      now: time.now,
      sleep: async (ms) => {
        time.sleep(ms);
        if (time.now() >= 20) {
          tree.dispose('grandchild');
          tree.dispose('child-a');
        }
      },
    });
    expect(wait).toBe('settled');
    expect(tree.hasActiveDescendants()).toBe(false);
  });

  it('reports cancellation so the existing cancel path owns the outcome', async () => {
    const tree = new RunAgentTree('root');
    tree.spawn('child-a', 'root');
    let cancelled = false;
    const wait = await awaitDescendants(tree, {
      deadline: 1000,
      cancelled: () => cancelled,
      now: () => 0,
      sleep: async () => {
        cancelled = true;
      },
    });
    expect(wait).toBe('cancelled');
    // 用户取消不是放弃：后代在收尾时按确定终态终止。
    tree.terminateDescendants();
    expect(tree.hasActiveDescendants()).toBe(false);
    expect(tree.snapshot()).toEqual([
      { agentId: 'root', parentAgentId: null, depth: 0, status: 'active' },
      { agentId: 'child-a', parentAgentId: 'root', depth: 1, status: 'terminal' },
    ]);
  });

  it('keeps an abandoned descendant abandoned across settle and teardown', () => {
    const tree = new RunAgentTree('root');
    tree.spawn('child-a', 'root');
    tree.abandon('child-a');
    tree.dispose('child-a');
    tree.terminateDescendants();
    expect(tree.snapshot()[1]).toEqual({
      agentId: 'child-a',
      parentAgentId: 'root',
      depth: 1,
      status: 'abandoned',
    });
    // abandoned 是终态：不再算活跃后代，根从不被放弃。
    expect(tree.hasActiveDescendants()).toBe(false);
    tree.abandon('root');
    expect(tree.snapshot()[0]?.status).toBe('active');
  });

  it('records only parent-linked spawn/dispose/abandon diagnostics and stays idempotent', () => {
    const tree = new RunAgentTree('root');
    expect(recordAgentDiagnostic(tree, { code: 'inventory', tools: [] })).toBe(false);
    expect(
      recordAgentDiagnostic(tree, {
        code: 'subagent.spawn',
        agentId: 'child-a',
        parentAgentId: 'root',
        depth: 9,
        allowlist: ['fetch_quote'],
      }),
    ).toBe(true);
    // 重复与未知父级的派生事件不会凭空放大活跃后代。
    recordAgentDiagnostic(tree, {
      code: 'subagent.spawn',
      agentId: 'child-a',
      parentAgentId: 'root',
    });
    recordAgentDiagnostic(tree, { code: 'subagent.spawn', agentId: 'orphan', parentAgentId: 'x' });
    expect(tree.hasActiveDescendants()).toBe(true);
    expect(tree.snapshot()).toEqual([
      { agentId: 'root', parentAgentId: null, depth: 0, status: 'active' },
      { agentId: 'child-a', parentAgentId: 'root', depth: 1, status: 'active' },
    ]);
    expect(
      recordAgentDiagnostic(tree, {
        code: 'subagent.abandoned',
        agentId: 'child-a',
        parentAgentId: 'root',
        reason: 'deadline',
      }),
    ).toBe(true);
    expect(tree.snapshot()[1]?.status).toBe('abandoned');
    // 放弃后的正常结算不再把节点改回普通终态。
    expect(
      recordAgentDiagnostic(tree, {
        code: 'subagent.disposed',
        agentId: 'child-a',
        parentAgentId: 'root',
      }),
    ).toBe(true);
    expect(tree.snapshot()[1]?.status).toBe('abandoned');
    expect(tree.hasActiveDescendants()).toBe(false);
  });
});
