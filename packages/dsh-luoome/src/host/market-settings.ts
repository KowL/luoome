import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  FUYAO_DEFAULT_BASE_URL,
  MARKET_SOURCE_MANIFEST,
  type MarketSourceId,
  MarketSourceOrderSchema,
  marketSourceOrderFromEnv,
} from '@luoome/adapters';
import { parseEnvFile } from '@luoome/core';
import { z } from 'zod';
import { invalidInput } from './read-surface.js';
import { readPluginJson } from './routes.js';

const BaseUrl = z
  .url()
  .max(2048)
  .refine((value) => {
    const url = new URL(value);
    return (
      ['https:', 'http:'].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      !/[\r\n\0]/.test(value)
    );
  }, '请输入不含凭据、查询参数或片段的 HTTP(S) 服务地址');

export const SaveMarketSettingsSchema = z
  .object({
    sources: MarketSourceOrderSchema,
    fuyao: z
      .object({
        baseUrl: BaseUrl,
        apiKey: z
          .string()
          .trim()
          .min(1)
          .max(4096)
          .regex(/^[^\r\n\0]+$/)
          .optional(),
      })
      .strict(),
  })
  .strict();

export type SaveMarketSettings = z.infer<typeof SaveMarketSettingsSchema>;

const SOURCE_LABELS: Readonly<Record<MarketSourceId, string>> = {
  eastmoney: '东方财富',
  tencent: '腾讯行情',
  sina: '新浪行情',
  tushare: 'Tushare',
  fuyao: 'FUYAO（同花顺）',
};
const SETTINGS_KEYS = ['LUOOME_MARKET_SOURCES', 'FUYAO_BASE_URL', 'FUYAO_API_KEY'] as const;

export interface MarketSettingsView {
  readonly activeOrder: readonly MarketSourceId[];
  readonly sources: readonly {
    readonly id: MarketSourceId;
    readonly label: string;
    readonly configured: boolean;
  }[];
  readonly fuyao: { readonly baseUrl: string; readonly configured: boolean };
}

export interface MarketSettings {
  read(): MarketSettingsView;
  save(input: SaveMarketSettings): MarketSettingsView;
}

export class MarketSettingsStore {
  private env: Record<string, string | undefined>;

  constructor(
    baseEnv: Readonly<Record<string, string | undefined>>,
    private readonly path: string,
  ) {
    const saved = parseEnvFile(this.readFile());
    this.env = { ...baseEnv };
    // 本地行情配置只能覆盖这三个键，不能改变 owner、工具授权或交易开关。
    for (const key of SETTINGS_KEYS) {
      if (saved[key] !== undefined) this.env[key] = saved[key];
    }
  }

  private readFile(): string {
    return existsSync(this.path) ? readFileSync(this.path, 'utf8') : '';
  }

  runtimeEnv(): Record<string, string | undefined> {
    return { ...this.env };
  }

  read(): MarketSettingsView {
    const sources = (Object.keys(SOURCE_LABELS) as MarketSourceId[]).map((id) => {
      const required = MARKET_SOURCE_MANIFEST[id].requiredEnv;
      return {
        id,
        label: SOURCE_LABELS[id],
        configured: required === undefined || Boolean(this.env[required.key]?.trim()),
      };
    });
    return {
      activeOrder: marketSourceOrderFromEnv(this.env),
      sources,
      fuyao: {
        baseUrl: this.env.FUYAO_BASE_URL?.trim() || FUYAO_DEFAULT_BASE_URL,
        configured: Boolean(this.env.FUYAO_API_KEY?.trim()),
      },
    };
  }

  save(
    input: SaveMarketSettings,
    prepareApply: (env: Record<string, string | undefined>) => () => void,
  ): MarketSettingsView {
    const changes: Record<string, string> = {
      LUOOME_MARKET_SOURCES: input.sources.join(','),
      FUYAO_BASE_URL: input.fuyao.baseUrl.replace(/\/+$/, ''),
      ...(input.fuyao.apiKey === undefined ? {} : { FUYAO_API_KEY: input.fuyao.apiKey }),
    };
    const candidate = { ...this.env, ...changes };
    for (const source of input.sources) {
      const required = MARKET_SOURCE_MANIFEST[source].requiredEnv;
      if (required !== undefined && !candidate[required.key]?.trim())
        throw new Error(`${SOURCE_LABELS[source]} 尚未配置 ${required.key}`);
    }
    const apply = prepareApply(candidate);
    const lines = this.readFile()
      .split('\n')
      .filter(
        (line) =>
          !Object.keys(changes).some((key) =>
            new RegExp(`^(?:export\\s+)?${key}\\s*=`).test(line.trim()),
          ),
      );
    while (lines.at(-1) === '') lines.pop();
    for (const [key, value] of Object.entries(changes)) lines.push(`${key}="${value}"`);
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.tmp-${randomUUID()}`;
    try {
      writeFileSync(temporary, `${lines.join('\n')}\n`, {
        encoding: 'utf8',
        mode: 0o600,
        flag: 'wx',
      });
      renameSync(temporary, this.path);
    } finally {
      rmSync(temporary, { force: true });
    }
    this.env = candidate;
    apply();
    return this.read();
  }
}

export const createMarketSettingsHandler =
  (settings: MarketSettings) =>
  async (request: Request): Promise<Response> => {
    const respond = (body: unknown, status = 200) =>
      Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
    try {
      if (request.method === 'GET') return respond({ ok: true, data: settings.read() });
      const transport = await readPluginJson(request);
      if (transport instanceof Response) return transport;
      const parsed = SaveMarketSettingsSchema.safeParse(transport.value);
      if (!parsed.success)
        return respond(invalidInput('请检查行情源顺序、服务地址和 API Key'), 400);
      for (const source of parsed.data.sources) {
        if (source === 'fuyao' && parsed.data.fuyao.apiKey !== undefined) continue;
        if (!settings.read().sources.find((item) => item.id === source)?.configured)
          return respond(invalidInput(`${SOURCE_LABELS[source]} 尚未配置 API 凭据`), 400);
      }
      return respond({ ok: true, data: settings.save(parsed.data) });
    } catch {
      return respond(
        { ok: false, error: { kind: 'internal', cause: '行情配置读取或保存失败，请重试' } },
        503,
      );
    }
  };
