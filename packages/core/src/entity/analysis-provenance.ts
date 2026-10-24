import { z } from 'zod';

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
  generatedAt: z.coerce.date(),
});
export type AnalysisProvenance = z.infer<typeof AnalysisProvenanceSchema>;
