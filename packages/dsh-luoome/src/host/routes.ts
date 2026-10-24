import type { ToolResult } from '@luoome/core';
import { z } from 'zod';
import { denied, invalidInput, type ReadSurface } from './read-surface.js';

export type RequestAdmission = (
  request: Request,
) => Response | null | undefined | Promise<Response | null | undefined>;

const CallInput = z.object({ tool: z.string().min(1).max(120), input: z.unknown() }).strict();
const MAX_BODY_BYTES = 64 * 1024;

const respond = (result: ToolResult<unknown>, status = 200): Response =>
  Response.json(result, { status, headers: { 'cache-control': 'no-store' } });

export const readPluginJson = async (request: Request): Promise<{ value: unknown } | Response> => {
  if (request.method !== 'POST') {
    const response = respond(invalidInput('POST required'), 405);
    response.headers.set('allow', 'POST');
    return response;
  }
  if (request.headers.get('origin') !== new URL(request.url).origin)
    return respond(denied('same-origin request'), 403);
  if (
    request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json'
  )
    return respond(invalidInput('JSON content type required'), 415);
  if (!request.body) return respond(invalidInput('JSON body required'), 400);
  const reader = request.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let text = '';
  let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_BODY_BYTES) {
        // The HTTP carrier closes unread input after flushing the 413 response.
        // Cancelling a Node request stream here would destroy its response socket.
        return respond(invalidInput('Request body too large'), 413);
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
  } catch {
    return respond(invalidInput('Unreadable request body'), 400);
  } finally {
    reader.releaseLock();
  }
  try {
    return { value: JSON.parse(text) as unknown };
  } catch {
    return respond(invalidInput('Invalid JSON body'), 400);
  }
};

export const createReadCallHandler =
  (surface: ReadSurface, admit: RequestAdmission) =>
  async (request: Request): Promise<Response> => {
    try {
      const rejection = await admit(request);
      if (rejection) return rejection;
    } catch {
      return respond(denied('host authentication'), 403);
    }
    const transport = await readPluginJson(request);
    if (transport instanceof Response) return transport;
    let body: z.infer<typeof CallInput>;
    try {
      const parsed = CallInput.safeParse(transport.value);
      if (!parsed.success) return respond(invalidInput('Invalid call envelope'), 400);
      body = parsed.data;
    } catch {
      return respond(invalidInput('Invalid JSON body'), 400);
    }
    const result = await surface.invoke(body.tool, body.input, request.signal);
    return respond(result, !result.ok && result.error.kind === 'permission_denied' ? 403 : 200);
  };
