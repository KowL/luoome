import { toolRegistry } from '@luoome/tools';
import type { Hono } from 'hono';
import { z } from 'zod';
import {
  EXPOSED_SIDE_EFFECTS,
  KNOWN_UNEXPOSED_TOOLS,
  WEB_AGENT_TOOL_NAMES,
  WEB_ALLOWED_EXTERNAL,
} from '../http/exposure.js';
import { jsonResult, notFound, permissionDenied } from '../http/result.js';
import type { WebRouteDeps } from './types.js';

const decisionAccountTools = new Set(['save_decision_review']);

export const registerToolGatewayRoutes = (app: Hono, deps: WebRouteDeps): void => {
  const {
    contextForRequest,
    mutationPermission,
    bindDecisionAccount,
    exposeWrite,
    exposeExternal,
  } = deps;

  app.post('/api/tools/:name/call', async (c) => {
    const name = c.req.param('name');
    const tool = toolRegistry.get(name);

    if (tool === undefined) {
      const known = KNOWN_UNEXPOSED_TOOLS[name];
      if (known !== undefined) {
        return jsonResult(permissionDenied(`sideEffect=${known} 的 tool 不通过 web 暴露`));
      }
      return jsonResult(notFound('Tool', name));
    }
    // 通用 tool 路由只暴露 WEB_AGENT_TOOL_NAMES（= toolRegistry 的 47 个 Agent Tool）；其余实现改为专用 REST 路由/App Service。
    if (!WEB_AGENT_TOOL_NAMES.has(name)) {
      return jsonResult(notFound('Tool', name));
    }
    const primaryAllowed =
      (EXPOSED_SIDE_EFFECTS.has(tool.sideEffect) && (tool.sideEffect !== 'write' || exposeWrite)) ||
      (tool.sideEffect === 'external' && exposeExternal && WEB_ALLOWED_EXTERNAL.has(name));
    const capabilitiesAllowed = tool.requiredCapabilities.every(
      (capability) =>
        (capability !== 'write' || exposeWrite) &&
        (capability !== 'external' || exposeExternal) &&
        capability !== 'trade',
    );
    if (!primaryAllowed || !capabilitiesAllowed) {
      return jsonResult(permissionDenied(`web 端不暴露 ${tool.sideEffect} 类 tool（${name}）`));
    }
    if (tool.sideEffect === 'write' || tool.sideEffect === 'external') {
      const denied = mutationPermission(c.req.raw);
      if (denied !== null) return jsonResult(denied);
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return jsonResult({
        ok: false,
        error: {
          kind: 'invalid_input',
          message: '请求体必须是 JSON：{ "input": {...} }',
          issues: [],
        },
      });
    }
    const input =
      typeof body === 'object' && body !== null && 'input' in body
        ? (body as { input: unknown }).input
        : {};
    if (name === 'append_chat_message') {
      const userMessage = z
        .object({
          role: z.literal('user'),
          parts: z
            .array(z.object({ type: z.literal('text'), text: z.string().min(1) }).strict())
            .min(1),
        })
        .safeParse(input);
      if (!userMessage.success)
        return jsonResult(permissionDenied('助手消息和草案执行记录只能由服务器生成'));
    }
    if (decisionAccountTools.has(name)) {
      const bound = bindDecisionAccount(c.req.raw, input);
      if ('denied' in bound) return jsonResult(bound.denied);
      return jsonResult(await tool.execute(bound.input, contextForRequest()));
    }
    return jsonResult(await tool.execute(input, contextForRequest()));
  });
};
