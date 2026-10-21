import type { z } from 'zod';
import type { JsonValue } from './protocol.js';
import type { AuthenticatedEndpointSchema } from './runtime-config.js';

export async function postJson<T>(
  target: z.infer<typeof AuthenticatedEndpointSchema>,
  body: JsonValue,
  schema: z.ZodType<T>,
  signal: AbortSignal,
): Promise<T> {
  const response = await fetch(target.endpoint, {
    method: 'POST',
    headers: { authorization: `Bearer ${target.token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    redirect: 'error',
    signal,
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Private endpoint rejected request (${response.status})`);
  }
  if (!response.body) throw new Error('Private endpoint returned no body');
  const reader = response.body.getReader();
  let text = '';
  let bytes = 0;
  const decoder = new TextDecoder();
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 2_000_000) throw new Error('Private response exceeds 2 MB');
      text += decoder.decode(chunk.value, { stream: true });
    }
    return schema.parse(JSON.parse(text + decoder.decode()));
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}
