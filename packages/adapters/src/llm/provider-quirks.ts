import { z } from 'zod';

export interface ProviderQuirks {
  readonly injectSchemaIntoSystem: boolean;
  readonly recoverMalformedText: boolean;
}

export const NO_PROVIDER_QUIRKS: ProviderQuirks = {
  injectSchemaIntoSystem: false,
  recoverMalformedText: false,
};

const JSON_OUTPUT_INSTRUCTION =
  '你必须只输出一个严格符合以下 JSON Schema 的 JSON 对象：' +
  '不要输出思考过程，不要输出 Markdown，不要代码围栏，不要任何解释文字。';

export const buildSystemContent = (
  system: string,
  schema: Readonly<Record<string, unknown>>,
): string => `${system}\n\n${JSON_OUTPUT_INSTRUCTION}\n\nJSON Schema:\n${JSON.stringify(schema)}`;

const isEmptySchemaObject = (value: unknown): boolean =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.keys(value).length === 0;

export const normalizeOpenAISchema = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(normalizeOpenAISchema);
  if (value === null || typeof value !== 'object') return value;
  const normalized: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    normalized[key] =
      key === 'additionalProperties' && isEmptySchemaObject(child)
        ? true
        : normalizeOpenAISchema(child);
  }
  return normalized;
};

export const toNormalizedJsonSchema = (schema: z.ZodType): Record<string, unknown> =>
  normalizeOpenAISchema(z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' })) as Record<
    string,
    unknown
  >;

export const stripThinkAndFences = (text: string): string => {
  const thinkClose = /<\/think>/gi;
  let lastIndex = -1;
  for (const match of text.matchAll(thinkClose)) lastIndex = match.index;
  const tail = lastIndex >= 0 ? text.slice(lastIndex + 8) : text;
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```\s*$/.exec(tail.trim());
  return fenced !== null ? (fenced[1] ?? '') : tail.trim();
};

export const recoverMalformedText = <T>(text: string, schema: z.ZodType<T>): T => {
  const parsed = JSON.parse(stripThinkAndFences(text)) as unknown;
  return schema.parse(parsed);
};
