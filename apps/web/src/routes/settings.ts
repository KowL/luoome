import {
  createAIStackFromEnv,
  createAShareSentimentManagerFromEnv,
  createFeishuWebhookAdapterFromEnv,
  createMarketAdapterFromEnv,
  MarketSourceIdSchema,
  NotificationManager,
} from '@luoome/adapters';
import { NotificationSchema } from '@luoome/core';
import {
  AgentScenarioIdSchema,
  checkPluginConfig,
  discoverExternalMcpTools,
  sendNotificationTool,
} from '@luoome/tools';
import type { Hono } from 'hono';
import { ZodError, z } from 'zod';
import { createAiSdkChatRuntimeFromStore } from '../ai-sdk-chat-runtime.js';
import { SaveAISettingsSchema } from '../ai-settings.js';
import {
  DATA_TRANSFER_CATEGORIES,
  exportDataArchive,
  importDataArchive,
} from '../data-transfer.js';
import { SaveFeishuSettingsSchema } from '../feishu-settings.js';
import { jsonResult, notFound } from '../http/result.js';
import {
  type MarketDatasetStatusRow,
  SaveMarketSettingsSchema,
  withRuntimeStatus,
} from '../market-settings.js';
import { SaveMcpSettingsSchema } from '../mcp-settings.js';
import type { WebRouteDeps } from './types.js';

export const registerSettingsRoutes = (app: Hono, deps: WebRouteDeps): void => {
  const {
    ctxRef,
    callTool,
    invokeTool,
    requireMutationCapabilities,
    aiSettingsStore,
    marketSettingsStore,
    feishuSettingsStore,
    sharedSources,
    dataTransferDbPath,
    chatRuntimeRef,
  } = deps;

  // 只读：手写 plugins.json 的诊断视图，不提供任何写入 / CAS / permit 入口。
  app.get('/api/settings/plugins', () => jsonResult({ ok: true, data: checkPluginConfig() }));

  app.get('/api/settings/mcp', () => {
    const store = deps.mcpSettingsStore;
    if (!store) return jsonResult(notFound('McpSettingsStore', 'default'));
    return jsonResult({
      ok: true,
      data: { ...store.read(), canManage: deps.exposeWrite && deps.exposeExternal },
    });
  });

  app.post('/api/settings/mcp/preview', async (c) => {
    const denied = requireMutationCapabilities(c.req.raw, ['write', 'external']);
    if (denied) return jsonResult(denied);
    const store = deps.mcpSettingsStore;
    if (!store) return jsonResult(notFound('McpSettingsStore', 'default'));
    try {
      const { scenario } = z
        .strictObject({ scenario: AgentScenarioIdSchema })
        .parse(await c.req.json());
      const tools = await discoverExternalMcpTools(
        store.configPath,
        deps.contextForRequest(),
        scenario,
      );
      return jsonResult({
        ok: true,
        data: {
          scenario,
          tools: tools.map((entry) => ({ name: entry.callable.name, service: entry.service })),
        },
      });
    } catch {
      return jsonResult({
        ok: false,
        error: {
          kind: 'invalid_input',
          message: 'MCP 工具预览失败，请检查场景与本地配置',
          issues: [],
        },
      });
    }
  });

  app.post('/api/settings/mcp/:id', async (c) => {
    const denied = requireMutationCapabilities(c.req.raw, ['write', 'external']);
    if (denied) return jsonResult(denied);
    const store = deps.mcpSettingsStore;
    if (!store) return jsonResult(notFound('McpSettingsStore', 'default'));
    try {
      const input = SaveMcpSettingsSchema.parse(await c.req.json());
      return jsonResult({
        ok: true,
        data: { ...store.save(c.req.param('id'), input), canManage: true, applied: true },
      });
    } catch (error) {
      const message =
        error instanceof ZodError
          ? 'MCP 设置无效，请检查工具、场景和版本'
          : error instanceof Error &&
              [
                'MCP 配置文件无效，请先修复本地配置',
                'MCP 配置已变更，请重新加载后保存',
                '服务尚未登记，请先在本地配置中登记受信服务',
              ].includes(error.message)
            ? error.message
            : 'MCP 设置保存失败';
      return jsonResult({ ok: false, error: { kind: 'invalid_input', message, issues: [] } });
    }
  });

  // ===== AI 模型设置 =====

  app.get('/api/data/categories', () =>
    jsonResult({ ok: true, data: { categories: [...DATA_TRANSFER_CATEGORIES] } }),
  );

  app.post('/api/data/export', async (c) => {
    if (dataTransferDbPath === undefined) {
      return jsonResult(notFound('DataTransferDatabase', 'default'));
    }
    try {
      const body = (await c.req.json()) as { categories?: unknown };
      const categories = Array.isArray(body.categories) ? body.categories : [];
      const archive = exportDataArchive(dataTransferDbPath, categories as string[]);
      const date = archive.exportedAt.slice(0, 10);
      return new Response(JSON.stringify(archive), {
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'content-disposition': `attachment; filename="luoome-${date}.json"`,
        },
      });
    } catch (error) {
      return jsonResult({
        ok: false,
        error: {
          kind: 'invalid_input',
          message: error instanceof Error ? error.message : String(error),
          issues: [],
        },
      });
    }
  });

  app.post('/api/data/import', async (c) => {
    const denied = requireMutationCapabilities(c.req.raw, ['write']);
    if (denied !== null) return jsonResult(denied);
    if (dataTransferDbPath === undefined) {
      return jsonResult(notFound('DataTransferDatabase', 'default'));
    }
    try {
      const body = (await c.req.json()) as { archive?: unknown };
      return jsonResult({
        ok: true,
        data: importDataArchive(dataTransferDbPath, body.archive),
      });
    } catch (error) {
      return jsonResult({
        ok: false,
        error: {
          kind: 'invalid_input',
          message: error instanceof Error ? error.message : String(error),
          issues: [],
        },
      });
    }
  });

  app.get('/api/settings/ai', () => {
    if (aiSettingsStore === undefined) return jsonResult(notFound('AISettingsStore', 'default'));
    try {
      return jsonResult({ ok: true, data: aiSettingsStore.read() });
    } catch (error) {
      return jsonResult({
        ok: false,
        error: {
          kind: 'internal',
          cause: `AI 设置读取失败：${error instanceof Error ? error.message : String(error)}`,
        },
      });
    }
  });

  // ===== 行情数据源设置 =====
  app.get('/api/settings/market', async () => {
    if (marketSettingsStore === undefined) {
      return jsonResult(notFound('MarketSettingsStore', 'default'));
    }
    try {
      const view = marketSettingsStore.read();
      // 叠加运行态（§5）：读模型失败时降级为纯配置态，不拖垮设置读取
      const status = await invokeTool('get_market_data_status', {});
      if (!status.ok) return jsonResult({ ok: true, data: view });
      const datasets = (status.data as { datasets?: MarketDatasetStatusRow[] }).datasets;
      if (!Array.isArray(datasets)) return jsonResult({ ok: true, data: view });
      return jsonResult({ ok: true, data: withRuntimeStatus(view, datasets) });
    } catch (error) {
      return jsonResult({
        ok: false,
        error: {
          kind: 'internal',
          cause: `行情源设置读取失败：${error instanceof Error ? error.message : String(error)}`,
        },
      });
    }
  });

  app.post('/api/settings/market', async (c) => {
    const denied = requireMutationCapabilities(c.req.raw, ['write']);
    if (denied !== null) return jsonResult(denied);
    if (marketSettingsStore === undefined) {
      return jsonResult(notFound('MarketSettingsStore', 'default'));
    }
    try {
      const input = SaveMarketSettingsSchema.parse(await c.req.json());
      const candidateEnv = {
        ...marketSettingsStore.runtimeEnv(),
        LUOOME_MARKET_SOURCES: input.sources.join(','),
      };
      // 只改来源顺序：复用进程级 SourceSet，仅重建 market 与依赖 market 的 sentiment（§4.7）
      const sharedDeps =
        sharedSources?.eastmoney === undefined
          ? {}
          : { sources: { eastmoney: sharedSources.eastmoney } };
      const providerRuntime = sharedSources?.providerRuntime;
      const build = () => {
        const market = createMarketAdapterFromEnv(candidateEnv, {
          ...(providerRuntime === undefined ? {} : { providerRuntime }),
          clock: ctxRef.current.clock,
          logger: ctxRef.current.logger,
          ...sharedDeps,
        });
        const ashareSentiment = createAShareSentimentManagerFromEnv(candidateEnv, {
          ...(providerRuntime === undefined ? {} : { providerRuntime }),
          clock: ctxRef.current.clock,
          logger: ctxRef.current.logger,
          market,
          ...sharedDeps,
        });
        return { market, ashareSentiment };
      };
      const candidate = providerRuntime?.prepare(build) ?? { value: build(), activate() {} };
      const saved = marketSettingsStore.save(input);
      candidate.activate();
      const { market, ashareSentiment } = candidate.value;
      ctxRef.current = {
        ...ctxRef.current,
        adapters: {
          ...ctxRef.current.adapters,
          market,
          marketIntel: { ...ctxRef.current.adapters.marketIntel, ashareSentiment },
        },
      };
      return jsonResult({ ok: true, data: { ...saved, applied: true } });
    } catch (error) {
      if (error instanceof ZodError) {
        return jsonResult({
          ok: false,
          error: {
            kind: 'invalid_input',
            message: '行情源设置校验失败',
            issues: error.issues,
          },
        });
      }
      return jsonResult({
        ok: false,
        error: {
          kind: 'invalid_input',
          message: error instanceof Error ? error.message : String(error),
          issues: [],
        },
      });
    }
  });

  /**
   * 主动探测指定行情源的全部能力（设置页「测试」按钮）：逐项执行 registry handle，
   * 观测自动写入（§4.3），响应携带探测明细与叠加最新运行态的设置视图。
   * 只允许探测已启用源（未启用源不在当前 manager 的 registry 里，无 handle 可执行）。
   */
  app.post('/api/settings/market/:id/test', async (c) => {
    const denied = requireMutationCapabilities(c.req.raw, ['external']);
    if (denied !== null) return jsonResult(denied);
    if (marketSettingsStore === undefined) {
      return jsonResult(notFound('MarketSettingsStore', 'default'));
    }
    const parsed = MarketSourceIdSchema.safeParse(c.req.param('id'));
    if (!parsed.success) {
      return jsonResult({
        ok: false,
        error: { kind: 'invalid_input', message: `未知的行情源：${c.req.param('id')}`, issues: [] },
      });
    }
    const market = ctxRef.current.adapters.market;
    const view = marketSettingsStore.read();
    if (!view.activeOrder.includes(parsed.data)) {
      return jsonResult({
        ok: false,
        error: {
          kind: 'invalid_input',
          message: `行情源 ${parsed.data} 未启用，先启用并保存后再测试`,
          issues: [],
        },
      });
    }
    if (typeof market.probeSource !== 'function') {
      return jsonResult({
        ok: false,
        error: {
          kind: 'adapter_error',
          adapter: market.name,
          cause: '当前行情适配器不支持主动探测',
          recoverable: false,
        },
      });
    }
    const probes = await market.probeSource(parsed.data);
    // 探测后重新聚合一次运行态，前端直接用响应里的 settings 刷新列表
    const fresh = marketSettingsStore.read();
    const status = await invokeTool('get_market_data_status', {});
    const datasets = status.ok
      ? (status.data as { datasets?: MarketDatasetStatusRow[] }).datasets
      : undefined;
    const settings = Array.isArray(datasets) ? withRuntimeStatus(fresh, datasets) : fresh;
    return jsonResult({ ok: true, data: { probes, settings } });
  });

  // ===== 飞书通知设置 =====
  app.get('/api/settings/feishu', () => {
    if (feishuSettingsStore === undefined) {
      return jsonResult(notFound('FeishuSettingsStore', 'default'));
    }
    try {
      return jsonResult({ ok: true, data: feishuSettingsStore.read() });
    } catch (error) {
      return jsonResult({
        ok: false,
        error: {
          kind: 'internal',
          cause: `飞书设置读取失败：${error instanceof Error ? error.message : String(error)}`,
        },
      });
    }
  });

  app.post('/api/settings/feishu', async (c) => {
    const denied = requireMutationCapabilities(c.req.raw, ['write']);
    if (denied !== null) return jsonResult(denied);
    if (feishuSettingsStore === undefined) {
      return jsonResult(notFound('FeishuSettingsStore', 'default'));
    }
    try {
      const input = SaveFeishuSettingsSchema.parse(await c.req.json());
      const saved = feishuSettingsStore.save(input);
      const adapter = createFeishuWebhookAdapterFromEnv(feishuSettingsStore.runtimeEnv(), {
        logger: ctxRef.current.logger,
      });
      if (ctxRef.current.adapters.notification instanceof NotificationManager) {
        ctxRef.current.adapters.notification.configureFeishu(adapter);
      }
      return jsonResult({ ok: true, data: { ...saved, applied: true } });
    } catch (error) {
      if (error instanceof ZodError) {
        return jsonResult({
          ok: false,
          error: {
            kind: 'invalid_input',
            message: '飞书设置校验失败',
            issues: error.issues,
          },
        });
      }
      return jsonResult({
        ok: false,
        error: {
          kind: 'invalid_input',
          message: error instanceof Error ? error.message : String(error),
          issues: [],
        },
      });
    }
  });

  app.post('/api/settings/feishu/test', async (c) => {
    const denied = requireMutationCapabilities(c.req.raw, ['external']);
    if (denied !== null) return jsonResult(denied);
    if (feishuSettingsStore === undefined) {
      return jsonResult(notFound('FeishuSettingsStore', 'default'));
    }
    try {
      if (!feishuSettingsStore.read().configured) {
        return jsonResult({
          ok: false,
          error: { kind: 'invalid_input', message: '请先保存飞书 Webhook', issues: [] },
        });
      }
      const sent = await sendNotificationTool.execute(
        {
          channel: 'feishu',
          feishu: {
            title: '飞书通知连接测试',
            content: 'luoome 已成功连接此群。后续策略 Advice 可通过该 Webhook 投递。',
            level: 'success',
          },
        },
        deps.contextForRequest(),
      );
      if (!sent.ok) return jsonResult(sent);
      const notification = NotificationSchema.parse(sent.data.notification);
      if (notification.result !== 'success') {
        return jsonResult({
          ok: false,
          error: {
            kind: 'adapter_error',
            adapter: 'feishu-webhook',
            cause: notification.errorMessage ?? notification.result,
            recoverable: false,
          },
        });
      }
      return jsonResult({
        ok: true,
        data: {
          channelAccepted: true,
          deviceDeliveryVerified: false,
          acceptedAt: notification.sentAt,
        },
      });
    } catch (error) {
      return jsonResult({
        ok: false,
        error: {
          kind: 'adapter_error',
          adapter: 'feishu-webhook',
          cause: error instanceof Error ? error.message : String(error),
          recoverable: false,
        },
      });
    }
  });

  app.post('/api/settings/ai', async (c) => {
    const denied = requireMutationCapabilities(c.req.raw, ['write']);
    if (denied !== null) return jsonResult(denied);
    if (aiSettingsStore === undefined) return jsonResult(notFound('AISettingsStore', 'default'));
    try {
      const input = SaveAISettingsSchema.parse(await c.req.json());
      const saved = aiSettingsStore.save(input);
      // 只有生成 profile 需要重建 LLM stack；对话 Agent 缺密钥不应阻断生成设置保存，反之亦然。
      if (input.profile === 'generation') {
        const ai = createAIStackFromEnv(aiSettingsStore.runtimeEnv(), {
          logger: ctxRef.current.logger,
        });
        ctxRef.current = {
          ...ctxRef.current,
          adapters: { ...ctxRef.current.adapters, llm: ai.llm },
        };
      }
      chatRuntimeRef.current = createAiSdkChatRuntimeFromStore(
        aiSettingsStore,
        aiSettingsStore.runtimeEnv(),
      );
      return jsonResult({
        ok: true,
        data: { ...saved, applied: true, appliedProfile: input.profile },
      });
    } catch (error) {
      if (error instanceof ZodError) {
        return jsonResult({
          ok: false,
          error: {
            kind: 'invalid_input',
            message: 'AI 设置校验失败',
            issues: error.issues,
          },
        });
      }
      return jsonResult({
        ok: false,
        error: {
          kind: 'internal',
          cause: `AI 设置保存失败：${error instanceof Error ? error.message : String(error)}`,
        },
      });
    }
  });

  app.get('/api/workflow-runs', (c) => {
    const limit = Number(c.req.query('limit') ?? '30');
    return callTool('list_workflow_runs', {
      limit: Number.isFinite(limit) ? limit : 30,
      includeWatch: true,
    });
  });
};
