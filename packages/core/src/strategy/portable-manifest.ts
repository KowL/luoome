import { createHash } from 'node:crypto';

import { z } from 'zod';

import {
  StrategyDslV1Schema,
  type StrategyVersion,
  StrategyVersionSchema,
  strategyDefinitionHash,
} from '../entity/strategy.js';
import { InvariantError } from '../error/index.js';
import {
  inspectStrategyDefinitionReferences,
  type StrategyDefinitionReferences,
  type StrategyFieldDataSource,
} from './field-registry.js';

const ManifestIdentifierSchema = z.string().regex(/^[a-z0-9][a-z0-9._:-]{0,127}$/);
const ManifestHashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const ManifestDataSourceSchema = z.enum(['quote', 'daily-bars', 'meta', 'limit-up-ladder']);
const ManifestFieldTypeSchema = z.enum(['number', 'boolean', 'string']);
const ManifestDatasetRoleSchema = z.enum(['universe', 'quote', 'daily-bars', 'limit-up-ladder']);
const ManifestExecutionModeSchema = z.enum(['scan', 'scheduled', 'replay', 'backtest']);

export const PORTABLE_STRATEGY_MANIFEST_TYPE = 'luoome.strategy-research-manifest' as const;
export const PORTABLE_STRATEGY_MANIFEST_SCHEMA_VERSION = 1 as const;

export const PORTABLE_STRATEGY_MANIFEST_SUPPORTED_CAPABILITIES = [
  'universe.cn-a-shares',
  'market.quote',
  'market.daily-bars-qfq',
  'market.limit-up-ladder-pit',
] as const;

export const PORTABLE_STRATEGY_MANIFEST_SUPPORTED_DATASETS = [
  { role: 'universe', id: 'cn-a-shares-universe', version: 'v1', coverage: 'CN_A_SHARES_SH_SZ' },
  { role: 'quote', id: 'quote-snapshot', version: 'v1', coverage: 'CN_A_SHARES_SH_SZ' },
  {
    role: 'daily-bars',
    id: 'daily-bars-qfq',
    version: 'v1',
    coverage: 'CN_A_SHARES_SH_SZ',
  },
  {
    role: 'limit-up-ladder',
    id: 'limit-up-ladder-pit',
    version: 'v1',
    coverage: 'CN_A_SHARES_SH_SZ',
  },
] as const;

export const PORTABLE_STRATEGY_MANIFEST_SUPPORTED_EVALUATOR = {
  id: 'luoome.strategy-dsl',
  version: 'v1',
  definitionSchemaVersion: 1,
  unknownPolicy: 'propagate',
} as const;

export const PORTABLE_STRATEGY_MANIFEST_SUPPORTED_EXECUTION_MODES = [
  'scan',
  'scheduled',
  'replay',
] as const;

const ManifestFieldSchema = z
  .object({
    path: z.string().min(1).max(200),
    type: ManifestFieldTypeSchema,
    unit: z.string().min(1).max(64).optional(),
    requiredLookback: z.number().int().nonnegative().max(10000).optional(),
    dataSource: ManifestDataSourceSchema,
  })
  .strict();

const ManifestDatasetSchema = z
  .object({
    role: ManifestDatasetRoleSchema,
    id: ManifestIdentifierSchema,
    version: ManifestIdentifierSchema,
    coverage: z.literal('CN_A_SHARES_SH_SZ'),
    adjustment: z.enum(['raw', 'qfq']).optional(),
  })
  .strict();

const ManifestEvaluatorSchema = z
  .object({
    id: ManifestIdentifierSchema,
    version: ManifestIdentifierSchema,
    definitionSchemaVersion: z.number().int().positive(),
    unknownPolicy: z.enum(['propagate', 'fail']),
  })
  .strict();

const ManifestTimeSliceSchema = z
  .object({
    kind: z.enum(['point-in-time', 'rolling']),
    calendar: z.literal('CN_A_SHARES'),
    timezone: z.literal('Asia/Shanghai'),
    lookbackTradingDays: z.number().int().nonnegative().max(10000),
    futureDataPolicy: z.enum(['available-as-of', 'reject']),
  })
  .strict();

const ManifestExecutionSchema = z
  .object({
    model: ManifestIdentifierSchema,
    version: ManifestIdentifierSchema,
    modes: z.array(ManifestExecutionModeSchema).min(1).max(4),
    unknownPolicy: z.enum(['propagate', 'fail']),
  })
  .strict();

export const StrategyResearchManifestSchema = z
  .object({
    manifestType: z.literal(PORTABLE_STRATEGY_MANIFEST_TYPE),
    schemaVersion: z.literal(PORTABLE_STRATEGY_MANIFEST_SCHEMA_VERSION),
    strategy: z
      .object({
        strategyId: ManifestIdentifierSchema,
        strategyVersionId: ManifestIdentifierSchema,
        version: z.number().int().positive(),
        definitionHash: ManifestHashSchema,
        definition: StrategyDslV1Schema,
      })
      .strict(),
    dependencies: z
      .object({
        capabilities: z.array(ManifestIdentifierSchema).min(1).max(32),
        fields: z.array(ManifestFieldSchema).max(100),
      })
      .strict(),
    datasets: z.array(ManifestDatasetSchema).min(1).max(32),
    evaluator: ManifestEvaluatorSchema,
    timeSlice: ManifestTimeSliceSchema,
    execution: ManifestExecutionSchema,
  })
  .strict();

export type StrategyResearchManifest = z.infer<typeof StrategyResearchManifestSchema>;
export type StrategyResearchManifestField = z.infer<typeof ManifestFieldSchema>;
export type StrategyResearchManifestDataset = z.infer<typeof ManifestDatasetSchema>;

export interface StrategyResearchManifestValidation {
  readonly status: 'supported' | 'unsupported' | 'invalid';
  readonly manifest?: StrategyResearchManifest;
  readonly canonicalJson?: string;
  readonly manifestHash?: string;
  readonly errors: readonly string[];
  readonly unsupported: {
    readonly capabilities: readonly string[];
    readonly datasets: readonly string[];
    readonly evaluator: readonly string[];
    readonly executionModes: readonly string[];
    readonly timeSlice: readonly string[];
  };
}

const emptyUnsupported = (): StrategyResearchManifestValidation['unsupported'] => ({
  capabilities: [],
  datasets: [],
  evaluator: [],
  executionModes: [],
  timeSlice: [],
});

const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value;
};

const unique = <T>(values: readonly T[]): T[] => [...new Set(values)];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * StrategyDslV1Schema is deliberately backwards-compatible and strips unknown
 * object keys. A portable manifest cannot do that: stripping a key would make
 * an import look like a different, supported strategy. Keep this boundary
 * check next to the manifest contract rather than changing the runtime DSL
 * parser used by legacy StrategyVersion records.
 */
const findUnknownDefinitionKeys = (definition: unknown): string[] => {
  const errors: string[] = [];
  const visit = (value: unknown, path: string, allowed: readonly string[]): void => {
    if (!isRecord(value)) return;
    const allowedSet = new Set(allowed);
    for (const key of Object.keys(value)) {
      if (!allowedSet.has(key)) errors.push(`${path}.${key}: DSL 字段不受 portable manifest 支持`);
    }
  };
  if (!isRecord(definition)) return errors;

  visit(definition, 'strategy.definition', [
    'schemaVersion',
    'metadata',
    'universe',
    'selection',
    'scoring',
    'signals',
  ]);
  visit(definition.metadata, 'strategy.definition.metadata', ['style', 'horizon']);
  visit(definition.universe, 'strategy.definition.universe', [
    'coverage',
    'includeStockIds',
    'excludeStockIds',
  ]);
  const selection = isRecord(definition.selection) ? definition.selection : undefined;
  visit(selection, 'strategy.definition.selection', ['logic', 'rules']);
  const selectionRules = selection?.rules;
  if (Array.isArray(selectionRules)) {
    for (const [index, rule] of selectionRules.entries()) {
      visit(rule, `strategy.definition.selection.rules.${index}`, [
        'id',
        'name',
        'when',
        'evidence',
      ]);
    }
  }
  visit(definition.scoring, 'strategy.definition.scoring', ['method', 'components', 'top']);
  if (isRecord(definition.scoring) && Array.isArray(definition.scoring.components)) {
    for (const [index, component] of definition.scoring.components.entries()) {
      visit(component, `strategy.definition.scoring.components.${index}`, [
        'ruleId',
        'score',
        'weight',
      ]);
    }
  }
  visit(definition.signals, 'strategy.definition.signals', ['entry', 'exit', 'risk']);
  if (isRecord(definition.signals)) {
    for (const signalType of ['entry', 'exit', 'risk'] as const) {
      const rules = definition.signals[signalType];
      if (!Array.isArray(rules)) continue;
      for (const [index, rule] of rules.entries()) {
        const path = `strategy.definition.signals.${signalType}.${index}`;
        visit(rule, path, ['id', 'name', 'when', 'evidence', 'score', 'direction', 'emission']);
        if (isRecord(rule))
          visit(rule.emission, `${path}.emission`, ['mode', 'cooldownTradingDays']);
      }
    }
  }
  return errors;
};

const sortFields = (fields: readonly StrategyResearchManifestField[]) =>
  [...fields].sort((left, right) => left.path.localeCompare(right.path));

const sortDatasets = (datasets: readonly StrategyResearchManifestDataset[]) =>
  [...datasets].sort(
    (left, right) =>
      left.role.localeCompare(right.role) ||
      left.id.localeCompare(right.id) ||
      left.version.localeCompare(right.version),
  );

const normalizeManifest = (manifest: StrategyResearchManifest): StrategyResearchManifest => ({
  ...manifest,
  dependencies: {
    ...manifest.dependencies,
    capabilities: [...manifest.dependencies.capabilities].sort(),
    fields: sortFields(manifest.dependencies.fields),
  },
  datasets: sortDatasets(manifest.datasets),
  execution: {
    ...manifest.execution,
    modes: [...manifest.execution.modes].sort(),
  },
});

const capabilityForSource: Record<StrategyFieldDataSource, string> = {
  quote: 'market.quote',
  'daily-bars': 'market.daily-bars-qfq',
  meta: 'market.daily-bars-qfq',
  'limit-up-ladder': 'market.limit-up-ladder-pit',
};

const datasetForSource: Record<StrategyFieldDataSource, StrategyResearchManifestDataset> = {
  quote: {
    role: 'quote',
    id: 'quote-snapshot',
    version: 'v1',
    coverage: 'CN_A_SHARES_SH_SZ',
  },
  'daily-bars': {
    role: 'daily-bars',
    id: 'daily-bars-qfq',
    version: 'v1',
    coverage: 'CN_A_SHARES_SH_SZ',
    adjustment: 'qfq',
  },
  meta: {
    role: 'daily-bars',
    id: 'daily-bars-qfq',
    version: 'v1',
    coverage: 'CN_A_SHARES_SH_SZ',
    adjustment: 'qfq',
  },
  'limit-up-ladder': {
    role: 'limit-up-ladder',
    id: 'limit-up-ladder-pit',
    version: 'v1',
    coverage: 'CN_A_SHARES_SH_SZ',
  },
};

const referencesToFields = (
  references: StrategyDefinitionReferences,
): StrategyResearchManifestField[] =>
  references.fields.map((field) => ({
    path: field.path,
    type: field.type,
    ...(field.unit === undefined ? {} : { unit: field.unit }),
    ...(field.requiredLookback === undefined ? {} : { requiredLookback: field.requiredLookback }),
    dataSource: field.dataSource,
  }));

const referencesToDependencies = (references: StrategyDefinitionReferences) => {
  const capabilities = unique([
    'universe.cn-a-shares',
    ...references.fields.map((field) => capabilityForSource[field.dataSource]),
  ]).sort();
  const datasets = [
    {
      role: 'universe' as const,
      id: 'cn-a-shares-universe',
      version: 'v1',
      coverage: 'CN_A_SHARES_SH_SZ' as const,
    },
    ...unique(references.fields.map((field) => field.dataSource)).map(
      (source) => datasetForSource[source],
    ),
  ];
  return { capabilities, fields: sortFields(referencesToFields(references)), datasets };
};

const expectedCapabilities = (references: StrategyDefinitionReferences): readonly string[] =>
  unique([
    'universe.cn-a-shares',
    ...references.fields.map((field) => capabilityForSource[field.dataSource]),
  ]).sort();

const expectedDatasetRoles = (references: StrategyDefinitionReferences): readonly string[] =>
  unique([
    'universe',
    ...references.fields.map((field) => datasetForSource[field.dataSource].role),
  ]);

const fieldIdentity = (field: StrategyResearchManifestField): string =>
  JSON.stringify(canonicalize(field));

const datasetIdentity = (dataset: StrategyResearchManifestDataset): string =>
  `${dataset.role}:${dataset.id}@${dataset.version}`;

export const buildStrategyResearchManifest = (
  version: StrategyVersion,
): StrategyResearchManifest => {
  const rawVersion = version as unknown as Record<string, unknown>;
  const unknownDefinitionKeys = findUnknownDefinitionKeys(rawVersion.definition);
  if (unknownDefinitionKeys.length > 0) {
    throw new InvariantError(unknownDefinitionKeys.join('; '));
  }
  const parsed = StrategyVersionSchema.parse(version);
  if (parsed.definitionHash !== strategyDefinitionHash(parsed.definition)) {
    throw new InvariantError('StrategyVersion.definitionHash 与 canonical definition 不一致');
  }
  const references = inspectStrategyDefinitionReferences(parsed.definition);
  if (references.validationErrors.length > 0) {
    throw new InvariantError(
      `Strategy definition 依赖校验失败: ${references.validationErrors.join('; ')}`,
    );
  }
  const dependencies = referencesToDependencies(references);
  return normalizeManifest(
    StrategyResearchManifestSchema.parse({
      manifestType: PORTABLE_STRATEGY_MANIFEST_TYPE,
      schemaVersion: PORTABLE_STRATEGY_MANIFEST_SCHEMA_VERSION,
      strategy: {
        strategyId: parsed.strategyId,
        strategyVersionId: parsed.id,
        version: parsed.version,
        definitionHash: parsed.definitionHash,
        definition: parsed.definition,
      },
      dependencies: {
        capabilities: dependencies.capabilities,
        fields: dependencies.fields,
      },
      datasets: dependencies.datasets,
      evaluator: PORTABLE_STRATEGY_MANIFEST_SUPPORTED_EVALUATOR,
      timeSlice: {
        kind: 'point-in-time',
        calendar: 'CN_A_SHARES',
        timezone: 'Asia/Shanghai',
        lookbackTradingDays: references.requiredLookback,
        futureDataPolicy: 'available-as-of',
      },
      execution: {
        model: 'deterministic-rule-evaluator',
        version: 'v1',
        modes: [...PORTABLE_STRATEGY_MANIFEST_SUPPORTED_EXECUTION_MODES],
        unknownPolicy: 'propagate',
      },
    }),
  );
};

export const canonicalStrategyResearchManifestJson = (manifest: StrategyResearchManifest): string =>
  JSON.stringify(canonicalize(normalizeManifest(StrategyResearchManifestSchema.parse(manifest))));

export const strategyResearchManifestHash = (manifest: StrategyResearchManifest): string =>
  createHash('sha256').update(canonicalStrategyResearchManifestJson(manifest)).digest('hex');

const validationError = (errors: readonly string[]): StrategyResearchManifestValidation => ({
  status: 'invalid',
  errors,
  unsupported: emptyUnsupported(),
});

const parseIssues = (error: z.ZodError): string[] =>
  error.issues.map((issue) => `${issue.path.join('.') || 'manifest'}: ${issue.message}`);

export const validateStrategyResearchManifest = (
  input: unknown,
): StrategyResearchManifestValidation => {
  const parsed = StrategyResearchManifestSchema.safeParse(input);
  if (!parsed.success) return validationError(parseIssues(parsed.error));

  const manifest = normalizeManifest(parsed.data);
  const errors: string[] = [];
  const unsupported = {
    capabilities: [] as string[],
    datasets: [] as string[],
    evaluator: [] as string[],
    executionModes: [] as string[],
    timeSlice: [] as string[],
  };
  const references = inspectStrategyDefinitionReferences(manifest.strategy.definition);
  errors.push(
    ...findUnknownDefinitionKeys(
      isRecord(input) && isRecord(input.strategy) ? input.strategy.definition : undefined,
    ),
  );
  if (manifest.strategy.definitionHash !== strategyDefinitionHash(manifest.strategy.definition)) {
    errors.push('strategy.definitionHash 与 canonical definition 不一致');
  }
  errors.push(...references.validationErrors);

  const expectedFields = sortFields(referencesToFields(references));
  const actualFields = sortFields(manifest.dependencies.fields);
  const fieldsMatch =
    expectedFields.length === actualFields.length &&
    expectedFields.every((field, index) => {
      const actual = actualFields[index];
      return actual !== undefined && fieldIdentity(field) === fieldIdentity(actual);
    });
  if (!fieldsMatch) {
    errors.push('dependencies.fields 必须完整且精确匹配 definition 的注册字段依赖');
  }

  const capabilities = unique(manifest.dependencies.capabilities);
  if (capabilities.length !== manifest.dependencies.capabilities.length) {
    errors.push('dependencies.capabilities 不得重复');
  }
  for (const capability of expectedCapabilities(references)) {
    if (!capabilities.includes(capability)) {
      errors.push(`dependencies.capabilities 缺少必需能力: ${capability}`);
    }
  }
  unsupported.capabilities = capabilities.filter(
    (capability) =>
      !(PORTABLE_STRATEGY_MANIFEST_SUPPORTED_CAPABILITIES as readonly string[]).includes(
        capability,
      ),
  );

  const roles = new Set(manifest.datasets.map((dataset) => dataset.role));
  for (const role of expectedDatasetRoles(references)) {
    if (!roles.has(role as z.infer<typeof ManifestDatasetRoleSchema>)) {
      errors.push(`datasets 缺少必需数据集角色: ${role}`);
    }
  }
  unsupported.datasets = manifest.datasets
    .filter(
      (dataset) =>
        !(
          PORTABLE_STRATEGY_MANIFEST_SUPPORTED_DATASETS as readonly StrategyResearchManifestDataset[]
        ).some(
          (supported) =>
            supported.role === dataset.role &&
            supported.id === dataset.id &&
            supported.version === dataset.version,
        ),
    )
    .map(datasetIdentity);

  if (
    manifest.evaluator.id !== PORTABLE_STRATEGY_MANIFEST_SUPPORTED_EVALUATOR.id ||
    manifest.evaluator.version !== PORTABLE_STRATEGY_MANIFEST_SUPPORTED_EVALUATOR.version ||
    manifest.evaluator.definitionSchemaVersion !==
      PORTABLE_STRATEGY_MANIFEST_SUPPORTED_EVALUATOR.definitionSchemaVersion ||
    manifest.evaluator.unknownPolicy !==
      PORTABLE_STRATEGY_MANIFEST_SUPPORTED_EVALUATOR.unknownPolicy
  ) {
    unsupported.evaluator = [
      `${manifest.evaluator.id}@${manifest.evaluator.version}/schema-${manifest.evaluator.definitionSchemaVersion}`,
    ];
  }

  unsupported.executionModes = manifest.execution.modes.filter(
    (mode) =>
      !(PORTABLE_STRATEGY_MANIFEST_SUPPORTED_EXECUTION_MODES as readonly string[]).includes(mode),
  );
  if (
    manifest.execution.model !== 'deterministic-rule-evaluator' ||
    manifest.execution.version !== 'v1'
  ) {
    unsupported.executionModes = unique([
      ...unsupported.executionModes,
      `${manifest.execution.model}@${manifest.execution.version}`,
    ]);
  }

  if (
    manifest.timeSlice.kind !== 'point-in-time' ||
    manifest.timeSlice.calendar !== 'CN_A_SHARES' ||
    manifest.timeSlice.timezone !== 'Asia/Shanghai' ||
    manifest.timeSlice.futureDataPolicy !== 'available-as-of'
  ) {
    unsupported.timeSlice = ['time-slice semantics'];
  }
  if (manifest.timeSlice.lookbackTradingDays !== references.requiredLookback) {
    errors.push('timeSlice.lookbackTradingDays 必须匹配字段依赖的 requiredLookback');
  }

  const status =
    errors.length > 0
      ? 'invalid'
      : Object.values(unsupported).some((items) => items.length > 0)
        ? 'unsupported'
        : 'supported';
  const canonicalJson = canonicalStrategyResearchManifestJson(manifest);
  return {
    status,
    manifest,
    canonicalJson,
    manifestHash: createHash('sha256').update(canonicalJson).digest('hex'),
    errors,
    unsupported,
  };
};

export const strategyResearchManifestRequiredFields = (
  manifest: StrategyResearchManifest,
): readonly string[] => manifest.dependencies.fields.map((field) => field.path);
