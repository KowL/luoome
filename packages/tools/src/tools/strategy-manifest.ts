import {
  buildStrategyResearchManifest,
  canonicalStrategyResearchManifestJson,
  StrategyResearchManifestSchema,
  type StrategyResearchManifestValidation,
  StrategyResearchStateSchema,
  strategyResearchManifestHash,
  validateStrategyResearchManifest,
} from '@luoome/core';
import { z } from 'zod';

import { defineTool, errInvalidInput, errNotFound } from '../define-tool.js';

const ManifestHashSchema = z.string().regex(/^[a-f0-9]{64}$/);

const UnsupportedSchema = z.object({
  capabilities: z.array(z.string()),
  datasets: z.array(z.string()),
  evaluator: z.array(z.string()),
  executionModes: z.array(z.string()),
  timeSlice: z.array(z.string()),
});
export const StrategyManifestValidationOutput = z.object({
  status: z.enum(['supported', 'unsupported', 'invalid']),
  manifest: StrategyResearchManifestSchema.optional(),
  canonicalJson: z.string().min(1).optional(),
  manifestHash: ManifestHashSchema.optional(),
  errors: z.array(z.string()),
  unsupported: UnsupportedSchema,
});

export const ExportStrategyManifestInput = z.object({
  versionId: z.string().min(1),
  accountId: z.string().min(1).optional(),
});

export const ExportStrategyManifestOutput = z.object({
  manifest: StrategyResearchManifestSchema,
  canonicalJson: z.string().min(1),
  manifestHash: ManifestHashSchema,
  evidenceReferences: z.array(z.string()),
  researchState: StrategyResearchStateSchema.optional(),
  reproducibility: z.object({
    definitionPortable: z.literal(true),
    marketDataIncluded: z.literal(false),
    trialSnapshotsIncluded: z.literal(false),
    limitations: z.array(z.string()),
  }),
});

export const ImportStrategyManifestInput = z.object({
  /** JSON object or canonical JSON string；只校验，不写入 Strategy。 */
  manifest: z.unknown(),
});

export const ValidateStrategyManifestInput = ImportStrategyManifestInput;

const parseManifestInput = (
  raw: unknown,
): { readonly value?: unknown; readonly parseError?: string } => {
  if (typeof raw !== 'string') return { value: raw };
  try {
    return { value: JSON.parse(raw) };
  } catch {
    return { parseError: 'manifest 不是有效 JSON' };
  }
};

const validationOutput = (
  result: StrategyResearchManifestValidation,
): z.infer<typeof StrategyManifestValidationOutput> => ({
  status: result.status,
  ...(result.manifest === undefined ? {} : { manifest: result.manifest }),
  ...(result.canonicalJson === undefined ? {} : { canonicalJson: result.canonicalJson }),
  ...(result.manifestHash === undefined ? {} : { manifestHash: result.manifestHash }),
  errors: [...result.errors],
  unsupported: {
    capabilities: [...result.unsupported.capabilities],
    datasets: [...result.unsupported.datasets],
    evaluator: [...result.unsupported.evaluator],
    executionModes: [...result.unsupported.executionModes],
    timeSlice: [...result.unsupported.timeSlice],
  },
});

export const exportStrategyManifestTool = defineTool({
  name: 'export_strategy_manifest',
  description:
    '导出不可变 StrategyVersion 的 canonical、versioned JSON 研究定义；包含字段/能力依赖、数据集、求值器、时间切片和执行模型，不写入或发布任何版本',
  sideEffect: 'read',
  input: ExportStrategyManifestInput,
  output: ExportStrategyManifestOutput,
  handler: async (input, ctx) => {
    const version = await ctx.repos.strategy.findVersionById(input.versionId);
    if (version === null) return errNotFound('StrategyVersion', input.versionId);
    try {
      const manifest = buildStrategyResearchManifest(version);
      const [sessions, backtests, researchState] = await Promise.all([
        ctx.repos.strategyEvaluation.listSessions({ strategyId: version.strategyId, limit: 100 }),
        ctx.repos.strategyBacktest.listRuns({ strategyId: version.strategyId, limit: 100 }),
        ctx.repos.strategyEvaluation.findResearchState({
          strategyId: version.strategyId,
          accountId: input.accountId ?? ctx.user.defaultAccountId,
        }),
      ]);
      const matchingResearch =
        researchState !== null &&
        (researchState.state.baseVersionId === version.id ||
          researchState.state.candidateVersionId === version.id)
          ? researchState
          : undefined;
      return {
        manifest,
        canonicalJson: canonicalStrategyResearchManifestJson(manifest),
        manifestHash: strategyResearchManifestHash(manifest),
        evidenceReferences: [
          ...new Set([
            `strategy-version:${version.id}`,
            `definition-hash:${version.definitionHash}`,
            ...sessions
              .filter((session) => session.strategyVersionId === version.id)
              .map((session) => `strategy-evaluation:${session.id}`),
            ...backtests
              .filter((run) => run.spec.strategyVersionId === version.id)
              .map((run) => `strict-backtest:${run.id}`),
            ...(matchingResearch?.state.conclusion?.evidenceReferences ?? []),
          ]),
        ],
        ...(matchingResearch === undefined ? {} : { researchState: matchingResearch }),
        reproducibility: {
          definitionPortable: true as const,
          marketDataIncluded: false as const,
          trialSnapshotsIncluded: false as const,
          limitations: [
            'manifest 固定定义与求值器/数据集声明；证据引用依赖原本地库，不包含完整日线、行情或供应商历史修订包。',
            '内存 trial 快照只保留身份，不保证重新下载相同事实；evaluation 的 PIT universe/checkpoint/revision 与严格回测市场事实必须另行保留。',
            '此导出不表示证据通过门禁，不改变发布状态；T+1/T+3/T+5 观察不是组合回测。',
            ...(sessions.length === 100 || backtests.length === 100
              ? ['证据发现最多扫描最近 100 个会话与 100 个严格回测；可能存在更多旧证据。']
              : []),
          ],
        },
      };
    } catch (error) {
      return errInvalidInput(
        `StrategyVersion 无法导出为 portable manifest: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  },
});

export const validateStrategyManifestTool = defineTool({
  name: 'validate_strategy_manifest',
  description:
    '校验 portable Strategy research manifest 的 schema、definition hash、字段依赖和兼容能力；缺能力显式返回 unsupported，不执行导入或发布',
  sideEffect: 'read',
  input: ValidateStrategyManifestInput,
  output: StrategyManifestValidationOutput,
  handler: async (input, _ctx) => {
    const parsed = parseManifestInput(input.manifest);
    if (parsed.parseError !== undefined) return errInvalidInput(parsed.parseError);
    return validationOutput(validateStrategyResearchManifest(parsed.value));
  },
});

export const importStrategyManifestTool = defineTool({
  name: 'import_strategy_manifest',
  description:
    '安全导入并校验 portable Strategy research manifest；只返回校验后的内存 manifest，不写入 Strategy、不自动校验发布、不触发运行或交易',
  sideEffect: 'read',
  input: ImportStrategyManifestInput,
  output: StrategyManifestValidationOutput,
  handler: async (input, _ctx) => {
    const parsed = parseManifestInput(input.manifest);
    if (parsed.parseError !== undefined) return errInvalidInput(parsed.parseError);
    const result = validateStrategyResearchManifest(parsed.value);
    if (result.status === 'invalid') {
      return errInvalidInput(`portable manifest 校验失败: ${result.errors.join('; ')}`);
    }
    return validationOutput(result);
  },
});
