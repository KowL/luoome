import { toolRegistry } from '@luoome/tools';
import { describe, expect, it } from 'vitest';

/**
 * REQ-M3-09 ① / task-31 的静态守卫：**产出比例类字段的工具必须能说清这个比例有多旧**。
 *
 * 判据必须是**解析后的 schema 对象树**，不是文件文本——task-31 的实测证明文本正则
 * 3/5 是误报（`get-stock-market-view` 有 `indicatorsAsOf`、`sector-quote` 的 schema 在 core、
 * `strategy-backtest` 有 11 处时间字段）。**误报就是「为什么不能用文本正则」的证据。**
 */

/** 比例/命中率类字段名。 */
const RATE_FIELD =
  /^(hitRate|.*Pct|.*Rate|ratio|share|percent|winRate|excessHitRate|coverageRatio|benchmarkCoverageRatio)$/i;

/** 时间字段名（任一即可；新增时间字段时加到这里，而不是给工具开白名单）。 */
const TIME_FIELD =
  /^(asOf|dataAsOf|evaluatedAt|observedAt|recordedAt|sampleAsOf|calculatedAt|generatedAt|createdAt|indicatorsAsOf|baselineAt|decidedAt|finishedAt|startedAt|updatedAt|expiresAt|validUntil|quoteAsOf|quoteObservedAt|from|to|since|until|window|at)$/i;

/**
 * 白名单：**每条必须带理由**，不许通配。
 *
 * 加一条之前先问：这个比例是**给用户看的结论**，还是**运维/队列观测**？
 * 后者没有「有多旧」的语义（它描述的是当下进程状态），可以豁免。
 */
const RATIO_WITHOUT_TIME_ALLOWED: Readonly<Record<string, string>> = {
  get_analysis_metrics:
    '队列运维观测（完成率/失败率），描述的是当前进程内的任务状态，不是给用户的统计结论；且不进 read 面 agent 暴露',
  assess_adaptive_personality:
    '自适应人格评估的**覆盖率**（trainingVintageCoverageRatio 等）是「样本够不够」的门禁指标，不是收益/命中率结论；输出自带 parameterVersion 与 status，补 asOf 需要动 core 的评估 schema（已登记为后续，不在 task-31）',
};

interface FieldHit {
  readonly path: string;
  readonly key: string;
}

const collectFields = (
  schema: unknown,
  path: string,
  acc: FieldHit[],
  seen: Set<unknown>,
): void => {
  if (schema === null || typeof schema !== 'object' || seen.has(schema)) return;
  seen.add(schema);
  const candidate = schema as {
    shape?: Record<string, unknown>;
    element?: unknown;
    options?: unknown[];
  };
  if (candidate.shape !== undefined && candidate.shape !== null)
    for (const [key, sub] of Object.entries(candidate.shape)) {
      acc.push({ path: `${path}.${key}`, key });
      collectFields(sub, `${path}.${key}`, acc, seen);
    }
  if (candidate.element !== undefined) collectFields(candidate.element, `${path}[]`, acc, seen);
  if (Array.isArray(candidate.options))
    for (const option of candidate.options) collectFields(option, path, acc, seen);
};

describe('task-31 比例类字段必须带时间字段（schema 对象树判据）', () => {
  it('所有 read 工具：产出比例/命中率却没声明时间字段的，必须进白名单并写理由', () => {
    const offenders: string[] = [];
    for (const tool of toolRegistry.all()) {
      if (tool.sideEffect !== 'read') continue;
      const fields: FieldHit[] = [];
      collectFields(tool.outputSchema, '', fields, new Set());
      const rates = fields.filter((field) => RATE_FIELD.test(field.key));
      if (rates.length === 0) continue;
      const hasTime = fields.some((field) => TIME_FIELD.test(field.key));
      if (hasTime) continue;
      if (Object.hasOwn(RATIO_WITHOUT_TIME_ALLOWED, tool.name)) continue;
      offenders.push(`${tool.name}（${rates.map((field) => field.path).join(', ')}）`);
    }
    expect(offenders).toEqual([]);
  });

  it('白名单每条都带非空理由（加豁免必须解释为什么）', () => {
    for (const [name, reason] of Object.entries(RATIO_WITHOUT_TIME_ALLOWED)) {
      expect(name.length, 'whitelist key').toBeGreaterThan(0);
      expect(reason.trim().length, `${name} 的理由不能为空`).toBeGreaterThan(0);
    }
  });

  it('判据本身有牙：合成一个「有比例无时间」的 schema 会被抓出来', () => {
    const fields: FieldHit[] = [];
    collectFields(
      {
        shape: {
          hitRate: {},
          denominator: {},
        },
      },
      '',
      fields,
      new Set(),
    );
    expect(fields.some((field) => RATE_FIELD.test(field.key))).toBe(true);
    expect(fields.some((field) => TIME_FIELD.test(field.key))).toBe(false);
  });
});
