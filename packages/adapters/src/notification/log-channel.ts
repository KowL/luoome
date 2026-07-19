import type { LogPayload, NotificationChannel } from '@luoome/core';

import type { NotificationChannelAdapter } from './types.js';

/**
 * Log 通道适配器（默认 fallback / 调试用）。
 * 不做实际 IO，仅通过 logger 输出。
 */

export interface LogChannelOptions {
  readonly logger: {
    info(message: string, meta?: Record<string, unknown>): void;
    warn(message: string, meta?: Record<string, unknown>): void;
    error(message: string, meta?: Record<string, unknown>): void;
  };
}

export class LogChannelAdapter implements NotificationChannelAdapter<LogPayload> {
  readonly name: string = 'log-channel';
  readonly channel: NotificationChannel = 'log';

  constructor(private readonly options: LogChannelOptions) {}

  async send(payload: LogPayload): Promise<{ readonly ok: true }> {
    const meta = { title: payload.title, level: payload.level };
    const line = `[luoome/notify] ${payload.title} — ${payload.content}`;
    switch (payload.level) {
      case 'info':
        this.options.logger.info(line, meta);
        break;
      case 'success':
        this.options.logger.info(`✅ ${line}`, meta);
        break;
      case 'warn':
        this.options.logger.warn(line, meta);
        break;
      case 'error':
        this.options.logger.error(line, meta);
        break;
    }
    return { ok: true };
  }
}
