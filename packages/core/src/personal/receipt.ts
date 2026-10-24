import { z } from 'zod';
import { HashSchema } from './hash.js';

/**
 * 个人写操作的回执：单机版的幂等凭据。
 * operationId + inputHash 标识一次操作，resultRef 指向落库结果。
 */
export const PersonalOperationReceiptSchema = z.object({
  operationId: z.string().min(1),
  inputHash: HashSchema,
  resultRef: z.string().min(1),
  resultHash: HashSchema,
  status: z.enum(['succeeded', 'partial']),
  committedAt: z.coerce.date(),
});
export type PersonalOperationReceipt = z.infer<typeof PersonalOperationReceiptSchema>;
