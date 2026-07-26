import { jsonSchema } from 'ai';
import type { z } from 'zod';
import { toNormalizedJsonSchema } from './provider-quirks.js';

export const toValidatedAISchema = <T>(schema: z.ZodType<T>) =>
  jsonSchema<T>(toNormalizedJsonSchema(schema), {
    validate: (value) => {
      const parsed = schema.safeParse(value);
      return parsed.success
        ? { success: true, value: parsed.data }
        : { success: false, error: parsed.error };
    },
  });
