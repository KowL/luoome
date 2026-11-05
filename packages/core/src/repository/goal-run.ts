import type { GoalCommand, GoalRun } from '../entity/goal-run.js';

export interface GoalRunRepository {
  create(run: GoalRun): Promise<{ run: GoalRun; replayed: boolean }>;
  find(accountId: string, id: string): Promise<GoalRun | null>;
  apply(input: {
    accountId: string;
    id: string;
    expectedVersion: number;
    command: GoalCommand;
    now: Date;
  }): Promise<GoalRun | null>;
  cancel(accountId: string, id: string, now: Date): Promise<GoalRun | null>;
}
