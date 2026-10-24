import { z } from 'zod';

/** 个人域写操作的内容哈希（sha256 hex）。 */
export const HashSchema = z.string().regex(/^[a-f0-9]{64}$/);
