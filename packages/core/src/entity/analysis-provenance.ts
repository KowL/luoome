import { z } from 'zod';
import { AnalysisMissingFactSchema } from './analysis-context.js';

export const AnalysisProvenanceSchema = z.object({
  generatorKind: z.enum([
    'dsh-chat',
    'dsh-headless',
    // 历史托管 worker 写入的来源；保留以解析旧分析记录。
    'dsh-worker',
    'embedded-dsh',
    'manual',
    'legacy-ai',
  ]),
  model: z.string().min(1).optional(),
  skillVersion: z.string().min(1).optional(),
  promptHash: z.string().min(1).optional(),
  sessionRef: z.string().min(1).optional(),
  contextId: z.string().min(1).optional(),
  jobId: z.string().min(1).optional(),
  evidenceFactIds: z.array(z.string().min(1)),
  /**
   * 报告显式声明的缺口（与 context.missingFacts 同结构）。
   * checker 用它做**完整性**对账：context 里每条 blocking 缺口都必须在这里出现。
   * 旧报告没有该字段 → 空数组：若 context 有 blocking 缺口，会被判 omitted-blocking-missing-fact。
   */
  acknowledgedMissingFacts: z.array(AnalysisMissingFactSchema).optional(),
  generatedAt: z.coerce.date(),
});
export type AnalysisProvenance = z.infer<typeof AnalysisProvenanceSchema>;
