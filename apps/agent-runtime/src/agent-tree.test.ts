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
  it('keeps the run incomplete while any descendant is active, even after root idle', async () => {
    const tree = new RunAgentTree('root');
    tree.spawn('child-a', 'root');
    const time = clock();
    expect(
      await awaitDescendants(tree, {
        deadline: 100,
        cancelled: () => false,
        now: time.now,
        sleep: time.sleep,
      }),
    ).toBe(false);
    expect(tree.hasActiveDescendants()).toBe(true);
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
    expect(wait).toBe(true);
    expect(tree.hasActiveDescendants()).toBe(false);
  });

  it('terminates every descendant deterministically when the run is cancelled', async () => {
    const tree = new RunAgentTree('root');
    tree.spawn('child-a', 'root');
    tree.spawn('child-b', 'root');
    tree.spawn('grandchild', 'child-a');
    let cancelled = false;
    const wait = await awaitDescendants(tree, {
      deadline: 1000,
      cancelled: () => cancelled,
      now: () => 0,
      sleep: async () => {
        cancelled = true;
      },
    });
    expect(wait).toBe(false);
    tree.terminateDescendants();
    expect(tree.hasActiveDescendants()).toBe(false);
    expect(tree.snapshot()).toEqual([
      { agentId: 'root', parentAgentId: null, depth: 0, status: 'active' },
      { agentId: 'child-a', parentAgentId: 'root', depth: 1, status: 'terminal' },
      { agentId: 'child-b', parentAgentId: 'root', depth: 1, status: 'terminal' },
      { agentId: 'grandchild', parentAgentId: 'child-a', depth: 2, status: 'terminal' },
    ]);
  });

  it('records only parent-linked spawn/dispose diagnostics and stays idempotent', () => {
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
        code: 'subagent.disposed',
        agentId: 'child-a',
        parentAgentId: 'root',
      }),
    ).toBe(true);
    expect(tree.hasActiveDescendants()).toBe(false);
  });
});
