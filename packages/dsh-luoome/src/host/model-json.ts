import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-llm';
import { z } from 'zod';

/** Both analysis paths use independent, bounded JSON requests with no inherited tools or session history. */
export const requestDshJson = async <S extends z.ZodType>(
  ctx: Context,
  request: {
    readonly provider: string;
    readonly model: string;
    readonly system: string;
    readonly input: unknown;
    readonly schema: S;
    readonly signal: AbortSignal;
  },
): Promise<{ output: z.output<S>; tokenUsed: number | null }> => {
  request.signal.throwIfAborted();
  const llm = ctx.get('llm');
  if (!llm) throw new Error('analysis_model_service_unavailable');
  let text = '';
  let tokenUsed: number | null = null;
  let finished = false;
  for await (const chunk of llm.stream({
    provider: request.provider,
    model: request.model,
    tools: [],
    maxTokens: 4096,
    signal: request.signal,
    system: `${request.system} 仅输出符合以下 schema 的 JSON 对象，不加 Markdown。${JSON.stringify(z.toJSONSchema(request.schema, { unrepresentable: 'any' }))}`,
    messages: [{ role: 'user', content: [{ type: 'text', text: JSON.stringify(request.input) }] }],
  })) {
    request.signal.throwIfAborted();
    if (chunk.type === 'tool-call-delta') throw new Error('analysis_model_attempted_tool_call');
    if (chunk.type === 'text-delta') {
      text += chunk.text;
      if (text.length > 65536) throw new Error('analysis_model_output_too_large');
    }
    if (chunk.type === 'usage') tokenUsed = chunk.usage.totalTokens ?? null;
    if (chunk.type === 'finish') {
      if (chunk.reason.kind !== 'stop')
        throw new Error(`analysis_model_incomplete:${chunk.reason.kind}`);
      finished = true;
    }
  }
  request.signal.throwIfAborted();
  if (!finished) throw new Error('analysis_model_incomplete');
  return { output: request.schema.parse(JSON.parse(text)), tokenUsed };
};
