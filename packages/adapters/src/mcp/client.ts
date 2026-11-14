import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';
import type { Logger } from '@luoome/core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { z } from 'zod';

const name = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,47}$/);
const ServiceSchema = z.strictObject({
  enabled: z.boolean().default(false),
  command: z.string().refine(isAbsolute, 'MCP command must be absolute'),
  args: z.array(z.string().max(2048)).max(32).default([]),
  tools: z
    .array(name)
    .max(16)
    .refine((tools) => new Set(tools).size === tools.length),
  scenarios: z
    .array(z.enum(['research', 'portfolio', 'watch', 'review', 'general']))
    .min(1)
    .max(5),
});
export const ReadOnlyMcpConfigSchema = z.strictObject({
  version: z.literal(1),
  services: z
    .record(z.string().regex(/^[a-z][a-z0-9-]{0,31}$/), ServiceSchema)
    .refine((services) => Object.keys(services).length <= 4),
});
type Service = z.infer<typeof ServiceSchema>;

export interface ReadOnlyMcpTool {
  readonly name: string;
  readonly service: string;
  readonly remoteName: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  validate(input: unknown): boolean;
  authorized(): Promise<boolean>;
  call(input: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
}

export class ReadOnlyMcpClient {
  constructor(
    private readonly configPath: string,
    private readonly logger: Logger,
  ) {}

  async #config() {
    try {
      const raw = await readFile(this.configPath, 'utf8');
      if (Buffer.byteLength(raw) > 65_536) throw new Error('MCP config too large');
      return ReadOnlyMcpConfigSchema.parse(JSON.parse(raw));
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
        this.logger.warn('External MCP configuration is invalid; no external tools are enabled');
      }
      return undefined;
    }
  }

  async #withClient<T>(
    service: Service,
    work: (client: Client) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const transport = new StdioClientTransport({
      command: service.command,
      args: service.args,
      cwd: dirname(this.configPath),
      stderr: 'pipe',
    });
    // Remote diagnostics are untrusted and can contain credentials or private content.
    transport.stderr?.on('data', () => {});
    const client = new Client({ name: 'luoome-readonly-client', version: '1.0.0' });
    try {
      await client.connect(transport, { timeout: 5_000, ...(signal ? { signal } : {}) });
      return await work(client);
    } finally {
      await client.close();
      await transport.close();
    }
  }

  async #list(client: Client, signal?: AbortSignal) {
    const tools: Awaited<ReturnType<Client['listTools']>>['tools'] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 8; page++) {
      const result = await client.listTools(cursor ? { cursor } : {}, {
        timeout: 5_000,
        ...(signal ? { signal } : {}),
      });
      tools.push(...result.tools);
      if (tools.length > 128) throw new Error('External MCP tool inventory too large');
      cursor = result.nextCursor;
      if (!cursor) return tools;
    }
    throw new Error('External MCP pagination limit');
  }

  async discover(scenario: string, parentSignal?: AbortSignal): Promise<ReadOnlyMcpTool[]> {
    const signal = AbortSignal.any([
      AbortSignal.timeout(15_000),
      ...(parentSignal ? [parentSignal] : []),
    ]);
    const config = await this.#config();
    if (!config) return [];
    const tools: ReadOnlyMcpTool[] = [];
    for (const [id, service] of Object.entries(config.services)) {
      if (
        !service.enabled ||
        !service.scenarios.includes(scenario as Service['scenarios'][number]) ||
        !service.tools.length
      )
        continue;
      if (signal.aborted) break;
      const snapshot = JSON.stringify(service);
      const authorized = async () => {
        const current = (await this.#config())?.services[id];
        return current?.enabled === true && JSON.stringify(current) === snapshot;
      };
      try {
        const inventory = await this.#withClient(
          service,
          (client) => this.#list(client, signal),
          signal,
        );
        const names = new Set<string>();
        const discovered: ReadOnlyMcpTool[] = [];
        for (const remote of inventory) {
          if (names.has(remote.name)) throw new Error('Duplicate remote tool');
          names.add(remote.name);
          if (
            !service.tools.includes(remote.name) ||
            remote.annotations?.readOnlyHint !== true ||
            remote.annotations?.destructiveHint !== false
          )
            continue;
          if (!name.safeParse(remote.name).success || JSON.stringify(remote).length > 32_000)
            continue;
          const validate = new AjvJsonSchemaValidator().getValidator(
            remote.inputSchema as Parameters<AjvJsonSchemaValidator['getValidator']>[0],
          );
          const descriptor = JSON.stringify(remote);
          discovered.push({
            name: `mcp_${id}__${remote.name}`,
            service: id,
            remoteName: remote.name,
            description: `Read-only MCP ${id}/${remote.name}. ${remote.description ?? ''}`.slice(
              0,
              4000,
            ),
            inputSchema: remote.inputSchema,
            validate: (input) => validate(input).valid,
            authorized,
            call: async (input, parentSignal) => {
              const signal = AbortSignal.any([
                AbortSignal.timeout(10_000),
                ...(parentSignal ? [parentSignal] : []),
              ]);
              if (!validate(input).valid) throw new Error('Invalid MCP input');
              if (!(await authorized())) throw new Error('External MCP authorization revoked');
              return this.#withClient(
                service,
                async (client) => {
                  const current = (await this.#list(client, signal)).find(
                    (tool) => tool.name === remote.name,
                  );
                  if (JSON.stringify(current) !== descriptor || !(await authorized()))
                    throw new Error('External MCP declaration changed');
                  const result = await client.callTool(
                    { name: remote.name, arguments: input },
                    undefined,
                    { timeout: 10_000, ...(signal ? { signal } : {}) },
                  );
                  if (!(await authorized())) throw new Error('External MCP authorization revoked');
                  if (
                    result.isError ||
                    !Array.isArray(result.content) ||
                    result.content.some((part) => part.type !== 'text') ||
                    JSON.stringify(result).length > 64_000
                  )
                    throw new Error('External MCP returned an error or unsupported content');
                  return {
                    service: id,
                    tool: remote.name,
                    content: result.content,
                    ...(result.structuredContent === undefined
                      ? {}
                      : { structuredContent: result.structuredContent }),
                  };
                },
                signal,
              );
            },
          });
        }
        if (await authorized()) tools.push(...discovered);
      } catch {
        this.logger.warn('External MCP service unavailable; its tools are hidden', { service: id });
      }
    }
    return tools;
  }
}
