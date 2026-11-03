import { describe, expect, it } from 'vitest';
import type { AnalysisContext } from './analysis-context.js';
import {
  applyGoalCommand,
  cancelGoalRun,
  type GoalRoundOutput,
  type GoalRun,
  GoalRunSchema,
} from './goal-run.js';

const now = new Date('2026-11-02T04:00:00Z');
const initial = (): GoalRun =>
  GoalRunSchema.parse({
    id: 'goal',
    accountId: 'account',
    requestId: 'request',
    requestHash: 'hash',
    request: {
      goal: '核实量价研究条件',
      kind: 'advice_stock',
      subject: { kind: 'stock', id: '600519.SH' },
      provider: 'fixture',
      model: 'model',
      maxRounds: 2,
      estimatedTokens: 100,
      estimatedDurationMs: 1000,
    },
    status: 'pending',
    version: 0,
    hostJobId: null,
    attempts: [],
    blockedCondition: null,
    error: null,
    createdAt: now,
    updatedAt: now,
    finishedAt: null,
  });
const snapshot: AnalysisContext = {
  id: 'context',
  accountId: 'account',
  kind: 'advice_stock',
  jobId: null,
  subject: { kind: 'stock', id: '600519.SH' },
  facts: [{ id: 'fact', label: 'quote', value: 100, evidenceIds: [] }],
  factIds: ['fact'],
  dataAsOf: now,
  createdAt: now,
  writeUntil: now,
  expiresAt: now,
  missingFacts: [],
  limitations: [],
  contextHash: 'hash',
};
const output = (status: GoalRoundOutput['status'] = 'continue'): GoalRoundOutput => ({
  summary: '量价事实尚未满足研究目标',
  status,
  factIds: ['fact'],
  needsRevision: false,
  blockedCondition: status === 'blocked' ? '缺少已披露的最近一期财务事实' : null,
});
const record = (
  run: GoalRun,
  round: number,
  revision: number,
  result: GoalRoundOutput | null,
  error: string | null = null,
) =>
  applyGoalCommand(
    run,
    {
      type: 'attempt',
      attempt: {
        round,
        revision,
        contextId: snapshot.id,
        output: result,
        error,
        tokenUsed: 10,
      },
    },
    now,
    snapshot,
  );
describe('bounded goal run state', () => {
  it('finishes only from a validated evidence-bearing conclusion', () => {
    const started = applyGoalCommand(initial(), { type: 'start', hostJobId: 'host' }, now);
    expect(() => record(started, 1, 0, { ...output('completed'), factIds: [] })).toThrow();
    expect(() => record(started, 1, 0, { ...output('completed'), factIds: ['invented'] })).toThrow(
      'goal_unknown_fact_reference',
    );
    const done = record(started, 1, 0, output('completed'));
    expect(done.status).toBe('completed');
    expect(cancelGoalRun(done, now)).toBeNull();
    expect(() => record(done, 2, 0, output())).toThrow('goal_already_terminal');
  });
  it('blocks on round exhaustion rather than claiming the goal was achieved', () => {
    let run = applyGoalCommand(initial(), { type: 'start', hostJobId: 'host' }, now);
    run = record(run, 1, 0, output());
    run = record(run, 2, 0, output());
    expect(run.status).toBe('blocked');
    expect(run.blockedCondition).toContain('round_limit_reached');
    expect(run.attempts.every((attempt) => attempt.output?.factIds.length)).toBe(true);
  });
  it('allows one revision of an invalid attempt and rejects additional revisions', () => {
    let run = applyGoalCommand(initial(), { type: 'start', hostJobId: 'host' }, now);
    run = record(run, 1, 0, null, 'goal_unknown_fact_reference');
    expect(() => record(run, 2, 0, output())).toThrow('goal_attempt_sequence_invalid');
    const done = record(run, 1, 1, output('completed'));
    expect(done.status).toBe('completed');
    const blocked = record(run, 1, 1, null, 'goal_unknown_fact_reference');
    expect(blocked.status).toBe('blocked');
    expect(blocked.blockedCondition).toContain('revision_limit_reached');
    expect(() => record(blocked, 1, 2, output())).toThrow();
  });
  it('treats a requested revision as a draft, and does not silently accept a second request', () => {
    let run = applyGoalCommand(initial(), { type: 'start', hostJobId: 'host' }, now);
    run = record(run, 1, 0, { ...output('completed'), needsRevision: true });
    expect(run.status).toBe('running');
    run = record(run, 1, 1, { ...output('completed'), needsRevision: true });
    expect(run.status).toBe('blocked');
  });
  it('requires concrete blocked conditions and retains already-produced evidence on cancellation', () => {
    let run = applyGoalCommand(initial(), { type: 'start', hostJobId: 'host' }, now);
    expect(() => applyGoalCommand(run, { type: 'block', condition: ' ' }, now)).toThrow();
    run = record(run, 1, 0, output());
    const cancelled = cancelGoalRun(run, now);
    expect(cancelled?.status).toBe('cancelled');
    expect(cancelled?.attempts).toEqual(run.attempts);
    expect(() => record(cancelled as GoalRun, 2, 0, output('completed'))).toThrow(
      'goal_already_terminal',
    );
  });
});
