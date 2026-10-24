import { z } from 'zod';

/** 单机版的执行身份：本地用户即唯一主体。 */
export const LocalExecutionIdentitySchema = z.object({
  mode: z.literal('local'),
  userId: z.string().min(1),
});
export type LocalExecutionIdentity = z.infer<typeof LocalExecutionIdentitySchema>;

export const ExecutionIdentitySchema = LocalExecutionIdentitySchema;
export type ExecutionIdentity = z.infer<typeof ExecutionIdentitySchema>;
