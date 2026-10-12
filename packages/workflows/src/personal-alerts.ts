import type { TenantPersonalAlertResultSchema, ToolResult } from '@luoome/core';
import {
  BuildPersonalAlertEvaluationInput,
  CommitPersonalAlertEvaluationInput,
} from '@luoome/tools';
import type { z } from 'zod';
import { defineWorkflow } from './define-workflow.js';

export const PersonalAlertsInput = BuildPersonalAlertEvaluationInput;
export type PersonalAlertsOutput = z.infer<typeof TenantPersonalAlertResultSchema>;

export const personalAlertsWorkflow = defineWorkflow<
  z.infer<typeof PersonalAlertsInput>,
  PersonalAlertsOutput
>({
  name: 'personal-alerts',
  description:
    'worker 专用个人价格条件正式评估；领域租约与租户 fence 保护同事务触发、状态、回执和通知引用',
  input: PersonalAlertsInput,
  steps: [
    async (raw, ctx) => {
      const input = PersonalAlertsInput.parse(raw);
      const built = await ctx.tools.build_personal_alert_evaluation.execute(input);
      if (!built.ok) return built;
      return { ...input, ...(built.data.draft === undefined ? {} : { draft: built.data.draft }) };
    },
    async (raw, ctx): Promise<ToolResult<PersonalAlertsOutput>> =>
      ctx.tools.commit_personal_alert_evaluation.execute(
        CommitPersonalAlertEvaluationInput.parse(raw),
      ),
  ],
});
