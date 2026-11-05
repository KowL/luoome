import {
  type MarketDumpRun,
  type MarketDumpRunRepository,
  MarketDumpRunSchema,
} from '@luoome/core';

/** MarketDumpRun 的 in-memory 实现；语义对齐 DrizzleMarketDumpRunRepository。 */
export class InMemoryMarketDumpRunRepository implements MarketDumpRunRepository {
  private readonly runs = new Map<string, MarketDumpRun>();

  async saveStarted(run: MarketDumpRun): Promise<void> {
    const parsed = MarketDumpRunSchema.parse(run);
    if (parsed.status !== 'running') {
      throw new Error('market_dump_runs: saveStarted 只接受 running 状态');
    }
    const existing = this.runs.get(parsed.runId);
    if (existing !== undefined) {
      if (
        existing.kind === parsed.kind &&
        existing.dumpId === parsed.dumpId &&
        existing.requestedAt.getTime() === parsed.requestedAt.getTime()
      ) {
        return;
      }
      throw new Error(`market_dump_runs: runId ${parsed.runId} 已存在且身份不一致`);
    }
    this.runs.set(parsed.runId, parsed);
  }

  async findById(runId: string): Promise<MarketDumpRun | null> {
    return this.runs.get(runId) ?? null;
  }

  async listRecent(input: {
    readonly kind?: MarketDumpRun['kind'];
    readonly limit?: number;
  }): Promise<readonly MarketDumpRun[]> {
    const limit = input.limit ?? 20;
    return [...this.runs.values()]
      .filter((run) => input.kind === undefined || run.kind === input.kind)
      .sort(
        (left, right) =>
          right.requestedAt.getTime() - left.requestedAt.getTime() ||
          right.runId.localeCompare(left.runId),
      )
      .slice(0, limit);
  }

  async findResumable(input: {
    readonly kind: MarketDumpRun['kind'];
    readonly dumpId: string;
    readonly artifactSha256: string;
  }): Promise<MarketDumpRun | null> {
    const match = [...this.runs.values()]
      .filter(
        (run) =>
          run.kind === input.kind &&
          run.dumpId === input.dumpId &&
          run.artifactSha256 === input.artifactSha256 &&
          run.status === 'running',
      )
      .sort(
        (left, right) =>
          right.requestedAt.getTime() - left.requestedAt.getTime() ||
          right.runId.localeCompare(left.runId),
      );
    return match[0] ?? null;
  }

  async advanceCheckpoint(input: {
    readonly runId: string;
    readonly recordedAt: Date;
    readonly nextRowOffset: number;
    readonly processedRows: number;
    readonly minDate: Date | null;
    readonly maxDate: Date | null;
  }): Promise<void> {
    const current = await this.requireRunning(input.runId);
    const recordedAt = current.recordedAt ?? input.recordedAt;
    const startedAt = current.startedAt ?? input.recordedAt;
    this.runs.set(input.runId, {
      ...current,
      recordedAt,
      startedAt,
      nextRowOffset: input.nextRowOffset,
      processedRows: input.processedRows,
      minDate: input.minDate,
      maxDate: input.maxDate,
    });
  }

  async markDownloaded(input: {
    readonly runId: string;
    readonly artifactSha256: string;
    readonly artifactBytes: number;
    readonly downloadedAt: Date;
  }): Promise<void> {
    const current = await this.requireRunning(input.runId);
    this.runs.set(input.runId, {
      ...current,
      artifactSha256: input.artifactSha256,
      artifactBytes: input.artifactBytes,
      downloadedAt: input.downloadedAt,
    });
  }

  async finish(input: {
    readonly runId: string;
    readonly status: 'complete' | 'failed';
    readonly finishedAt: Date;
    readonly errorKind?: string;
    readonly errorMessage?: string;
  }): Promise<void> {
    const current = await this.requireRunning(input.runId);
    if (input.status === 'complete' && current.artifactSha256 === null) {
      throw new Error('market_dump_runs: complete 前必须先 markDownloaded');
    }
    if (input.status === 'failed' && input.errorKind === undefined) {
      throw new Error('market_dump_runs: failed 必须携带 errorKind');
    }
    this.runs.set(input.runId, {
      ...current,
      status: input.status,
      finishedAt: input.finishedAt,
      errorKind: input.status === 'failed' ? (input.errorKind ?? null) : null,
      errorMessage: input.status === 'failed' ? (input.errorMessage ?? null) : null,
    });
  }

  private async requireRunning(runId: string): Promise<MarketDumpRun> {
    const current = await this.findById(runId);
    if (current === null) throw new Error(`market_dump_runs: run ${runId} 不存在`);
    if (current.status !== 'running') {
      throw new Error(`market_dump_runs: run ${runId} 已进入终态 ${current.status}`);
    }
    return current;
  }
}
