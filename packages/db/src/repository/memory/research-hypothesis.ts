import {
  assertResearchHypothesisVersionInvariants,
  InvariantError,
  type ResearchHypothesisVersion,
  type ResearchHypothesisVersionRepository,
} from '@luoome/core';

const copy = <T>(value: T): T => structuredClone(value);

export class InMemoryResearchHypothesisVersionRepository
  implements ResearchHypothesisVersionRepository
{
  private readonly items = new Map<string, ResearchHypothesisVersion>();

  async create(version: ResearchHypothesisVersion): Promise<void> {
    assertResearchHypothesisVersionInvariants(version);
    if (version.status !== 'active') {
      throw new InvariantError('新 ResearchHypothesisVersion 必须为 active');
    }
    if (this.items.has(version.id)) {
      throw new InvariantError(`ResearchHypothesisVersion 已存在: ${version.id}`);
    }
    const versions = [...this.items.values()].filter((item) => item.topicId === version.topicId);
    if (versions.some((item) => item.version === version.version)) {
      throw new InvariantError('(topicId, version) 必须唯一');
    }
    const maxVersion = Math.max(0, ...versions.map((item) => item.version));
    if (version.version !== maxVersion + 1) {
      throw new InvariantError('ResearchHypothesisVersion.version 必须严格递增');
    }
    const active = versions.find((item) => item.status === 'active');
    if (active !== undefined && version.supersedesId !== active.id) {
      throw new InvariantError('新版本必须 supersede 当前 active ResearchHypothesisVersion');
    }
    if (version.supersedesId !== undefined) {
      const superseded = this.items.get(version.supersedesId);
      if (superseded === undefined || superseded.topicId !== version.topicId) {
        throw new InvariantError('supersedesId 必须指向同一 Topic 的既有版本');
      }
    }

    if (active !== undefined) {
      this.items.set(active.id, { ...active, status: 'superseded' });
    }
    this.items.set(version.id, copy(version));
  }

  async findById(id: string): Promise<ResearchHypothesisVersion | null> {
    const value = this.items.get(id);
    return value === undefined ? null : copy(value);
  }

  async list(
    input: Parameters<ResearchHypothesisVersionRepository['list']>[0] = {},
  ): Promise<readonly ResearchHypothesisVersion[]> {
    return [...this.items.values()]
      .filter((item) => input.topicId === undefined || item.topicId === input.topicId)
      .filter((item) => input.status === undefined || item.status === input.status)
      .sort((left, right) => right.version - left.version || left.id.localeCompare(right.id))
      .slice(0, input.limit ?? 50)
      .map(copy);
  }
}
