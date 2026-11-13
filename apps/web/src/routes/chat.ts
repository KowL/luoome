import { settleChatDraftTool } from '@luoome/tools';
import type { Hono } from 'hono';
import { z } from 'zod';
import { createChatStreamResponse } from '../chat.js';
import { jsonResult } from '../http/result.js';
import type { WebRouteDeps } from './types.js';

export const registerChatRoutes = (app: Hono, deps: WebRouteDeps): void => {
  const { contextForRequest, callTool, requireMutationCapabilities, chatRuntimeRef } = deps;

  app.get('/api/chat/sessions', () => callTool('list_chat_sessions', { limit: 100 }));
  app.post('/api/chat/sessions', async (c) => {
    const denied = requireMutationCapabilities(c.req.raw, ['write']);
    if (denied !== null) return jsonResult(denied);
    let body: unknown = {};
    try {
      body = await c.req.json();
    } catch {
      // 空请求体等同默认标题。
    }
    return callTool('create_chat_session', body);
  });
  app.get('/api/chat/sessions/:id', (c) =>
    callTool('get_chat_session', { sessionId: c.req.param('id'), messageLimit: 200 }),
  );
  app.patch('/api/chat/sessions/:id', async (c) => {
    const denied = requireMutationCapabilities(c.req.raw, ['write']);
    if (denied !== null) return jsonResult(denied);
    let body: { title?: unknown };
    try {
      body = (await c.req.json()) as { title?: unknown };
    } catch {
      body = {};
    }
    return callTool('rename_chat_session', {
      sessionId: c.req.param('id'),
      title: body.title,
    });
  });
  app.delete('/api/chat/sessions/:id', (c) => {
    const denied = requireMutationCapabilities(c.req.raw, ['write']);
    if (denied !== null) return jsonResult(denied);
    return callTool('delete_chat_session', { sessionId: c.req.param('id') });
  });
  app.post('/api/chat/sessions/:id/drafts/:messageId/:toolCallId', async (c) => {
    const denied = requireMutationCapabilities(c.req.raw, ['write', 'external']);
    if (denied !== null) return jsonResult(denied);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      body = null;
    }
    const parsed = z.object({ approved: z.boolean() }).strict().safeParse(body);
    if (!parsed.success)
      return jsonResult({
        ok: false,
        error: {
          kind: 'invalid_input',
          message: '确认请求必须是 { approved: boolean }，不能替换草案输入',
          issues: [],
        },
      });
    return jsonResult(
      await settleChatDraftTool.execute(
        {
          sessionId: c.req.param('id'),
          messageId: c.req.param('messageId'),
          toolCallId: c.req.param('toolCallId'),
          approved: parsed.data.approved,
        },
        contextForRequest(),
      ),
    );
  });

  app.post('/api/chat', async (c) => {
    const denied = requireMutationCapabilities(c.req.raw, ['write', 'external']);
    if (denied !== null) return jsonResult(denied);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return jsonResult({
        ok: false,
        error: {
          kind: 'invalid_input',
          message: '请求体必须是 JSON：{ "messages": [...] }',
          issues: [],
        },
      });
    }
    const runtime = chatRuntimeRef.current;
    if (runtime === undefined) {
      const llmName = contextForRequest().adapters.llm.name;
      const cause =
        llmName === 'ai-unconfigured'
          ? 'AI 模型尚未配置，请前往设置页完成 LLM 设置'
          : 'AI 对话运行时初始化失败，请检查是否已安装 Node.js 环境或配置 LUOOME_DSH_NODE_PATH';
      return new Response(
        JSON.stringify({
          ok: false,
          error: {
            kind: 'llm_error',
            provider: llmName,
            cause,
            retryable: false,
          },
        }),
        {
          status: 503,
          headers: { 'content-type': 'application/json; charset=utf-8' },
        },
      );
    }
    return createChatStreamResponse(body, contextForRequest(), runtime, c.req.raw.signal);
  });
};
