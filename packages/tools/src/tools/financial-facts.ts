import {
  assertFinancialFactInvariants,
  assertFinancialVintageInvariants,
  type FinancialFact,
  FinancialFactSchema,
  FinancialVintageMissingSchema,
  FinancialVintagePolicySchema,
  FinancialVintageSchema,
} from '@luoome/core';
import { z } from 'zod';

import { defineTool, errAdapterError } from '../define-tool.js';

const STOCK_ID_LIMIT = 5000;
const METRIC_ID_LIMIT = 128;

const IdListSchema = z.array(z.string().trim().min(1)).min(1).max(STOCK_ID_LIMIT);
const MetricIdListSchema = z.array(z.string().trim().min(1)).min(1).max(METRIC_ID_LIMIT);

const IngestionIssueSchema = z
  .object({
    source: z.string().min(1).max(100),
    reason: z.string().min(1).max(100),
    message: z.string().min(1).max(500),
    observedAt: z.coerce.date(),
    stockId: z.string().min(1).max(100).optional(),
    metricId: z.string().min(1).max(100).optional(),
    periodType: z.string().min(1).max(32).optional(),
    periodEnd: z.coerce.date().optional(),
    sourceRecordId: z.string().min(1).max(200).optional(),
    sourceRevision: z.string().min(1).max(200).optional(),
  })
  .strict();

export const SyncFinancialFactsInput = z
  .object({
    stockIds: IdListSchema,
    metricIds: MetricIdListSchema,
    periodFrom: z.coerce.date().optional(),
    periodTo: z.coerce.date().optional(),
  })
  .superRefine((input, issue) => {
    if (
      input.periodFrom !== undefined &&
      input.periodTo !== undefined &&
      input.periodFrom > input.periodTo
    ) {
      issue.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['periodTo'],
        message: 'periodTo 必须不早于 periodFrom',
      });
    }
  });

const SyncCoverageSchema = z
  .object({
    /** requested / covered / missing 的单位是 stockId × metricId 请求对。 */
    requested: z.number().int().nonnegative(),
    received: z.number().int().nonnegative(),
    accepted: z.number().int().nonnegative(),
    rejected: z.number().int().nonnegative(),
    missing: z.number().int().nonnegative(),
    requestedPairs: z.number().int().nonnegative(),
    coveredPairs: z.number().int().nonnegative(),
    missingPairs: z.number().int().nonnegative(),
  })
  .strict();

export const SyncFinancialFactsOutput = z
  .object({
    providerKind: z.literal('mock'),
    source: z.string().min(1).max(100),
    gate: z.literal('not-ready'),
    status: z.enum(['succeeded', 'partial', 'unavailable']),
    coverage: SyncCoverageSchema,
    issues: z.array(IngestionIssueSchema).max(10_000),
    observedAt: z.coerce.date().optional(),
    limitations: z.array(z.string().min(1).max(500)).max(8),
  })
  .strict();

export const GetFinancialFactsInput = z.object({
  stockIds: IdListSchema,
  metricIds: MetricIdListSchema,
  asOf: z.coerce.date(),
  policy: FinancialVintagePolicySchema.default('strict-pit-v1'),
});

export const GetFinancialFactsOutput = z
  .object({
    providerKind: z.literal('mock'),
    gate: z.literal('not-ready'),
    policy: FinancialVintagePolicySchema,
    asOf: z.coerce.date(),
    status: z.enum(['complete', 'partial', 'unavailable']),
    vintageKey: z.string().regex(/^[a-f0-9]{64}$/),
    facts: z.array(FinancialFactSchema),
    missing: z.array(FinancialVintageMissingSchema),
    coverage: z.object({
      requested: z.number().int().nonnegative(),
      available: z.number().int().nonnegative(),
      missing: z.number().int().nonnegative(),
      retracted: z.number().int().nonnegative(),
    }),
    issues: z.array(IngestionIssueSchema).max(10_000),
    limitations: z.array(z.string().min(1).max(500)).max(8),
  })
  .strict();

type IngestionIssue = z.infer<typeof IngestionIssueSchema>;

const asRecord = (value: unknown): Record<string, unknown> | undefined => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
};

const stringField = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim().length > 0 ? value : undefined;

const invalidFactIssue = (input: {
  readonly source: string;
  readonly observedAt: Date;
  readonly value: unknown;
  readonly message: string;
}): IngestionIssue => {
  const record = asRecord(input.value);
  const periodEnd = record?.periodEnd instanceof Date ? record.periodEnd : undefined;
  return {
    source: input.source,
    reason: 'invalid-payload',
    message: input.message,
    observedAt: input.observedAt,
    ...(stringField(record?.stockId) === undefined ? {} : { stockId: record?.stockId as string }),
    ...(stringField(record?.metricId) === undefined
      ? {}
      : { metricId: record?.metricId as string }),
    ...(stringField(record?.periodType) === undefined
      ? {}
      : { periodType: record?.periodType as string }),
    ...(periodEnd === undefined ? {} : { periodEnd }),
    ...(stringField(record?.sourceRecordId) === undefined
      ? {}
      : { sourceRecordId: record?.sourceRecordId as string }),
    ...(stringField(record?.sourceRevision) === undefined
      ? {}
      : { sourceRevision: record?.sourceRevision as string }),
  };
};

const normalizeAdapterIssue = (input: {
  readonly source: string;
  readonly observedAt: Date;
  readonly value: unknown;
}): IngestionIssue => {
  const parsed = IngestionIssueSchema.safeParse(input.value);
  if (parsed.success) return parsed.data;
  const record = asRecord(input.value);
  return {
    source: stringField(record?.source) ?? input.source,
    reason: stringField(record?.reason) ?? 'invalid-payload',
    message: stringField(record?.message) ?? 'adapter 返回了无法解析的 ingestion issue',
    observedAt: record?.observedAt instanceof Date ? record.observedAt : input.observedAt,
    ...(stringField(record?.stockId) === undefined ? {} : { stockId: record?.stockId as string }),
    ...(stringField(record?.metricId) === undefined
      ? {}
      : { metricId: record?.metricId as string }),
  };
};

const dedupeIds = (values: readonly string[]): string[] => [...new Set(values)];

const syncLimitations = [
  'providerKind=mock 仅证明契约切片可运行，不是生产数据证据。',
  'gate=not-ready；缺少经过真实数据门禁的 PIT provider 时不可用于 evaluation-ready 或 operational 评分。',
  'coverage 和 issues 是本次同步的描述性结果，不构成收益、因果或胜率承诺。',
] as const;

const getLimitations = [
  'providerKind=mock 仅表示当前 mock 切片，gate=not-ready；不宣称 evaluation-ready。',
  '读取严格通过 repository.resolveVintage，不回源当前接口补历史。',
  'missing 保留数据缺口；缺失事实不会隐式填零或回退到最新值。',
] as const;

const parseAdapterResult = (
  value: unknown,
):
  | {
      readonly source: string;
      readonly gateStatus: 'not-ready';
      readonly revisions: readonly unknown[];
      readonly issues: readonly unknown[];
      readonly observedAt: Date;
    }
  | undefined => {
  const record = asRecord(value);
  if (record === undefined) return undefined;
  const source = stringField(record.source);
  const resultGateStatus = stringField(record.gateStatus);
  const gate = asRecord(record.gate);
  const gateName = stringField(gate?.name);
  const gateStatus = stringField(gate?.status);
  const revisions = Array.isArray(record.revisions) ? record.revisions : undefined;
  const issues = Array.isArray(record.issues) ? record.issues : undefined;
  const observedAt = record.observedAt instanceof Date ? record.observedAt : undefined;
  if (
    source === undefined ||
    resultGateStatus !== 'not-ready' ||
    gateName !== 'fundamental-data-gate-v1' ||
    gateStatus !== 'not-ready' ||
    revisions === undefined ||
    issues === undefined ||
    observedAt === undefined
  )
    return undefined;
  return { source, gateStatus: 'not-ready', revisions, issues, observedAt };
};

export const syncFinancialFactsTool = defineTool({
  name: 'sync_financial_facts',
  description:
    '从显式注入的 mock 基本面 adapter 拉取并校验 PIT facts 后 append 到仓储；始终标记 gate=not-ready，不宣称生产可用',
  sideEffect: 'external',
  requiredCapabilities: ['external', 'write'],
  input: SyncFinancialFactsInput,
  output: SyncFinancialFactsOutput,
  handler: async (input, ctx) => {
    const adapter = ctx.fundamentalData;
    if (adapter === undefined) {
      return errAdapterError('fundamental-data', '基本面数据 adapter 未配置（unavailable）', true);
    }
    if (
      adapter.gateStatus !== 'not-ready' ||
      adapter.gate.name !== 'fundamental-data-gate-v1' ||
      adapter.gate.status !== 'not-ready'
    ) {
      return errAdapterError(
        'fundamental-data',
        'mock sync 只接受 gateStatus=not-ready 且 gate.status=not-ready 的 adapter',
        false,
      );
    }

    let rawResult: unknown;
    try {
      rawResult = await adapter.fetchFinancialFactRevisions({
        stockIds: dedupeIds(input.stockIds),
        metricIds: dedupeIds(input.metricIds),
        ...(input.periodFrom === undefined ? {} : { periodFrom: input.periodFrom }),
        ...(input.periodTo === undefined ? {} : { periodTo: input.periodTo }),
      });
    } catch (error) {
      const cause = error instanceof Error ? error.message : String(error);
      return errAdapterError('fundamental-data', cause, true);
    }

    const result = parseAdapterResult(rawResult);
    if (result === undefined) {
      return errAdapterError('fundamental-data', 'adapter 返回了无法解析的基本面 payload', true);
    }

    const requestedStockIds = new Set(input.stockIds);
    const requestedMetricIds = new Set(input.metricIds);
    const issues: IngestionIssue[] = result.issues.map((issue) =>
      normalizeAdapterIssue({
        source: result.source,
        observedAt: result.observedAt,
        value: issue,
      }),
    );
    const accepted: FinancialFact[] = [];
    let invalidCandidateCount = 0;
    for (const candidate of result.revisions) {
      const parsed = FinancialFactSchema.safeParse(candidate);
      if (!parsed.success) {
        invalidCandidateCount += 1;
        issues.push(
          invalidFactIssue({
            source: result.source,
            observedAt: result.observedAt,
            value: candidate,
            message: parsed.error.issues.map((issue) => issue.message).join('; '),
          }),
        );
        continue;
      }
      try {
        assertFinancialFactInvariants(parsed.data);
      } catch (error) {
        invalidCandidateCount += 1;
        issues.push(
          invalidFactIssue({
            source: result.source,
            observedAt: result.observedAt,
            value: candidate,
            message: error instanceof Error ? error.message : String(error),
          }),
        );
        continue;
      }
      if (
        !requestedStockIds.has(parsed.data.stockId) ||
        !requestedMetricIds.has(parsed.data.metricId)
      ) {
        invalidCandidateCount += 1;
        issues.push(
          invalidFactIssue({
            source: result.source,
            observedAt: result.observedAt,
            value: parsed.data,
            message: 'adapter 返回了不在本次请求范围内的 stockId/metricId',
          }),
        );
        continue;
      }
      accepted.push(parsed.data);
    }

    try {
      if (accepted.length > 0) await ctx.repos.financialFact.appendMany(accepted);
    } catch (error) {
      const cause = error instanceof Error ? error.message : String(error);
      return errAdapterError('financial-fact-repository', cause, true);
    }

    const requestedPairs = requestedStockIds.size * requestedMetricIds.size;
    const coveredPairs = new Set(accepted.map((fact) => `${fact.stockId}\u0000${fact.metricId}`))
      .size;
    const missingPairs = Math.max(requestedPairs - coveredPairs, 0);
    const rejected = invalidCandidateCount;
    const status =
      accepted.length === 0
        ? ('unavailable' as const)
        : rejected > 0 || missingPairs > 0
          ? ('partial' as const)
          : ('succeeded' as const);

    return {
      providerKind: 'mock' as const,
      source: result.source,
      gate: 'not-ready' as const,
      status,
      coverage: {
        requested: requestedPairs,
        received: result.revisions.length,
        accepted: accepted.length,
        rejected,
        missing: missingPairs,
        requestedPairs,
        coveredPairs,
        missingPairs,
      },
      issues,
      observedAt: result.observedAt,
      limitations: [...syncLimitations],
    };
  },
});

export const getFinancialFactsTool = defineTool({
  name: 'get_financial_facts',
  description:
    '按显式 asOf 从本地 FinancialFactRepository 读取 strict PIT vintage；只读、不回源、不隐式填补缺失',
  sideEffect: 'read',
  input: GetFinancialFactsInput,
  output: GetFinancialFactsOutput,
  handler: async (input, ctx) => {
    const vintage = await ctx.repos.financialFact.resolveVintage({
      stockIds: dedupeIds(input.stockIds),
      metricIds: dedupeIds(input.metricIds),
      asOf: input.asOf,
      policy: input.policy,
    });
    const parsed = FinancialVintageSchema.parse(vintage);
    assertFinancialVintageInvariants(parsed);
    return {
      providerKind: 'mock' as const,
      gate: 'not-ready' as const,
      policy: parsed.policy,
      asOf: parsed.asOf,
      status: parsed.status,
      vintageKey: parsed.vintageKey,
      facts: parsed.facts,
      missing: parsed.missing,
      coverage: parsed.coverage,
      issues: [],
      limitations: [...getLimitations],
    };
  },
});
