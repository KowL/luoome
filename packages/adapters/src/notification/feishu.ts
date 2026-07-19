import { type FeishuPayload, NOTIFICATION_BRAND, type NotificationChannel } from '@luoome/core';

/**
 * 飞书 Webhook 适配器（plan-v0.2-v0.3 §2.5）。
 *
 * 设计：
 * - 通过 env `LUOOME_FEISHU_WEBHOOK_URL` 配置 incoming webhook。
 * - 缺 URL 时 send 走 suppressed（由上层 manager 落库为 result='suppressed'）。
 * - POST 5xx / timeout → 抛 FeishuAdapterError（recoverable=true）。
 * - POST 4xx（鉴权 / 限流）→ 抛 FeishuAdapterError（recoverable=false）。
 * - 不重试（重试由调用方 / workflow 决定）。
 *
 * 卡片格式（v0.3 简版）：interactive card，含 title + markdown content + atMobiles。
 * 飞书响应：{"StatusCode":0,"StatusMessage":"success"} 视为成功。
 */

export type FeishuSendResult =
  | { readonly ok: true; readonly statusCode: number }
  | { readonly ok: false; readonly statusCode: number; readonly message: string };

/** 飞书适配器错误（供 manager 转成 Notification result='failed' + errorMessage）。 */
export class FeishuAdapterError extends Error {
  override readonly name = 'FeishuAdapterError';
  constructor(
    message: string,
    readonly statusCode: number | undefined,
    readonly recoverable: boolean,
  ) {
    super(message);
  }
}

export interface FeishuWebhookAdapterOptions {
  readonly webhookUrl: string;
  /** 注入 fetch（测试用）；默认用全局 fetch。类型用宽松的函数签名避开 Node 22 + Bun 差异。 */
  readonly fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>;
  /** 单次请求超时（ms），默认 5000。 */
  readonly timeoutMs?: number;
  /** 日志回调。 */
  readonly logger?: {
    info(message: string, meta?: Record<string, unknown>): void;
    warn(message: string, meta?: Record<string, unknown>): void;
    error(message: string, meta?: Record<string, unknown>): void;
  };
}

const DEFAULT_TIMEOUT_MS = 5_000;

/** 把 FeishuPayload 转成飞书交互式卡片 JSON。 */
const toFeishuCard = (payload: FeishuPayload): Record<string, unknown> => {
  const elements: unknown[] = [
    {
      tag: 'markdown',
      content: `**${payload.title}**\n\n${payload.content}`,
    },
  ];
  const card: Record<string, unknown> = {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: `[${NOTIFICATION_BRAND}] ${payload.title}` },
      template: feishuTemplateForLevel(payload.level),
    },
    elements,
  };
  return card;
};

const feishuTemplateForLevel = (level: FeishuPayload['level']): string => {
  switch (level) {
    case 'info':
      return 'blue';
    case 'success':
      return 'green';
    case 'warn':
      return 'orange';
    case 'error':
      return 'red';
  }
};

export class FeishuWebhookAdapter {
  readonly name: string = 'feishu-webhook';
  readonly channel: NotificationChannel = 'feishu';

  private readonly webhookUrl: string;
  private readonly fetchImpl: (input: string, init?: RequestInit) => Promise<Response>;
  private readonly timeoutMs: number;
  private readonly logger: FeishuWebhookAdapterOptions['logger'];

  constructor(options: FeishuWebhookAdapterOptions) {
    this.webhookUrl = options.webhookUrl;
    this.fetchImpl =
      options.fetchImpl ??
      (globalThis.fetch.bind(globalThis) as (i: string, init?: RequestInit) => Promise<Response>);
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.logger = options.logger;
  }

  /** 发送一条通知。失败抛 FeishuAdapterError。 */
  async send(payload: FeishuPayload): Promise<FeishuSendResult> {
    const body: Record<string, unknown> = {
      msg_type: 'interactive',
      card: toFeishuCard(payload),
    };
    if (payload.atMobiles !== undefined && payload.atMobiles.length > 0) {
      body.at = { atMobiles: payload.atMobiles };
    }

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort('timeout'), this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(this.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: ac.signal,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.logger?.warn('feishu webhook send failed (network)', { msg });
      throw new FeishuAdapterError(`feishu send failed: ${msg}`, undefined, true);
    } finally {
      clearTimeout(timer);
    }

    if (res.status >= 500) {
      const text = await safeReadText(res);
      this.logger?.warn('feishu webhook 5xx', { status: res.status, text });
      throw new FeishuAdapterError(
        `feishu server error ${res.status}: ${text.slice(0, 200)}`,
        res.status,
        true,
      );
    }
    if (res.status === 429 || (res.status >= 400 && res.status < 500)) {
      const text = await safeReadText(res);
      this.logger?.error('feishu webhook 4xx', { status: res.status, text });
      throw new FeishuAdapterError(
        `feishu client error ${res.status}: ${text.slice(0, 200)}`,
        res.status,
        false,
      );
    }

    // 飞书业务码（StatusCode != 0）
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      // 200 但非 JSON — 仍视为成功（飞书偶发行为）
      this.logger?.info('feishu webhook sent', { status: res.status });
      return { ok: true, statusCode: res.status };
    }
    const statusCode = (json as { StatusCode?: unknown })?.StatusCode;
    if (typeof statusCode === 'number' && statusCode !== 0) {
      const msg = (json as { msg?: unknown })?.msg ?? 'unknown';
      this.logger?.error('feishu webhook business error', { statusCode, msg });
      throw new FeishuAdapterError(
        `feishu business error ${statusCode}: ${String(msg)}`,
        res.status,
        false,
      );
    }
    this.logger?.info('feishu webhook sent', { status: res.status });
    return { ok: true, statusCode: res.status };
  }
}

const safeReadText = async (res: Response): Promise<string> => {
  try {
    return await res.text();
  } catch {
    return '';
  }
};
