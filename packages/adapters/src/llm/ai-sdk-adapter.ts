import type { LLMGenerateRequest } from '@luoome/core';
import { generateText, NoObjectGeneratedError, Output } from 'ai';
import type { z } from 'zod';
import type { ResolvedAIModelProfile } from './model-catalog.js';
import {
  buildSystemContent,
  recoverMalformedText,
  toNormalizedJsonSchema,
} from './provider-quirks.js';
import { toValidatedAISchema } from './schema.js';
import type { LLMAdapter, LLMGenerateResult } from './types.js';

const truncate = (value: string, maxChars: number): string => {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}...[truncated ${value.length - maxChars} chars]`;
};

const buildRaw = (result: {
  readonly text: string;
  readonly response: { readonly body?: unknown };
  readonly usage: unknown;
}): string =>
  JSON.stringify({
    text: result.text,
    body: result.response.body ?? null,
    usage: result.usage,
  });

const buildRawFromError = (error: NoObjectGeneratedError): string =>
  JSON.stringify({
    text: error.text ?? '',
    response: error.response ?? null,
    usage: error.usage ?? null,
    finishReason: error.finishReason ?? null,
  });

export class AISDKAdapter implements LLMAdapter {
  readonly name: string;

  constructor(private readonly profile: ResolvedAIModelProfile) {
    this.name = profile.modelRef;
  }

  async generate<T = unknown>(request: LLMGenerateRequest): Promise<LLMGenerateResult<T>> {
    if (request.schema === undefined) {
      throw new Error(`${this.name} 需要 schema`);
    }
    const schema = request.schema as z.ZodType<T>;
    const normalizedSchema = toNormalizedJsonSchema(schema);
    const quirks = this.profile.quirks;

    try {
      const result = await generateText({
        model: this.profile.model,
        system: quirks.injectSchemaIntoSystem
          ? buildSystemContent(request.system, normalizedSchema)
          : request.system,
        prompt: truncate(JSON.stringify(request.data), this.profile.maxPromptChars),
        output: Output.object({ schema: toValidatedAISchema(schema) }),
        abortSignal: AbortSignal.timeout(this.profile.timeoutMs),
        maxRetries: this.profile.maxRetries,
        ...(this.profile.providerType === 'anthropic'
          ? { providerOptions: { anthropic: { structuredOutputMode: 'auto' } } }
          : {}),
      });
      return { ...result.output, raw: buildRaw(result) };
    } catch (error) {
      if (
        quirks.recoverMalformedText &&
        NoObjectGeneratedError.isInstance(error) &&
        error.text !== undefined
      ) {
        const recovered = recoverMalformedText(error.text, schema);
        return { ...recovered, raw: buildRawFromError(error) };
      }
      throw error;
    }
  }
}

export type { LLMAdapter, LLMGenerateRequest, LLMGenerateResult };
