import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ReadOnlyMcpConfigSchema, resolveMcpConfigPath } from '@luoome/adapters';
import { z } from 'zod';

export const SaveMcpSettingsSchema = ReadOnlyMcpConfigSchema.shape.services.valueType
  .pick({ enabled: true, tools: true, scenarios: true })
  .extend({ enabled: z.boolean(), revision: z.string().regex(/^[a-f0-9]{64}$/) });

const message = 'MCP 配置文件无效，请先修复本地配置';

export class McpSettingsStore {
  readonly configPath: string;
  constructor(env: Readonly<Record<string, string | undefined>>) {
    this.configPath = resolveMcpConfigPath(env);
  }

  #load() {
    let raw: string | undefined;
    try {
      raw = readFileSync(this.configPath, 'utf8');
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT'))
        throw new Error(message);
    }
    const revision = createHash('sha256')
      .update(raw ?? '')
      .digest('hex');
    try {
      if (Buffer.byteLength(raw ?? '') > 65_536) throw new Error(message);
      const config = ReadOnlyMcpConfigSchema.parse(
        raw === undefined ? { version: 1, services: {} } : JSON.parse(raw),
      );
      return { config, revision };
    } catch {
      throw new Error(message);
    }
  }

  #builtin() {
    return {
      enabled: false,
      command: process.execPath,
      args: [
        '--no-env-file',
        fileURLToPath(new URL('../../../packages/mcp/src/docs-server.ts', import.meta.url)),
      ],
      tools: ['search_docs'],
      scenarios: ['research' as const],
    };
  }

  read() {
    try {
      const { config, revision } = this.#load();
      const services = { ...config.services };
      if (services.docs === undefined && Object.keys(services).length < 4)
        services.docs = this.#builtin();
      return {
        revision,
        services: Object.entries(services).map(([id, service]) => ({
          id,
          enabled: service.enabled,
          tools: service.tools,
          scenarios: service.scenarios,
          label:
            id === 'docs' &&
            service.command === this.#builtin().command &&
            JSON.stringify(service.args) === JSON.stringify(this.#builtin().args)
              ? 'luoome 文档检索'
              : id,
        })),
      };
    } catch {
      return { revision: '', services: [], configError: message };
    }
  }

  save(id: string, rawInput: unknown) {
    const input = SaveMcpSettingsSchema.parse(rawInput);
    const { config, revision } = this.#load();
    if (revision !== input.revision) throw new Error('MCP 配置已变更，请重新加载后保存');
    const service = config.services[id] ?? (id === 'docs' ? this.#builtin() : undefined);
    if (service === undefined) throw new Error('服务尚未登记，请先在本地配置中登记受信服务');
    const next = ReadOnlyMcpConfigSchema.parse({
      ...config,
      services: {
        ...config.services,
        [id]: {
          ...service,
          enabled: input.enabled,
          tools: input.tools,
          scenarios: input.scenarios,
        },
      },
    });
    mkdirSync(dirname(this.configPath), { recursive: true, mode: 0o700 });
    const temp = `${this.configPath}.tmp-${randomUUID()}`;
    try {
      writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
      renameSync(temp, this.configPath);
      chmodSync(this.configPath, 0o600);
    } finally {
      rmSync(temp, { force: true });
    }
    return this.read();
  }
}
