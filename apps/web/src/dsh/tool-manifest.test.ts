import type { AgentCallableTool } from '@luoome/core';
import { ToolManifestSchema } from '@luoome/dsh-bridge/protocol';
import { AGENT_SCENARIOS, toolRegistry } from '@luoome/tools';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { buildGatewayCallableManifest, encodeGatewayJson } from './tool-manifest.js';

const callable = (name: string, inputSchema: unknown = z.object({})): AgentCallableTool => ({
  name,
  description: `fixture ${name}`,
  inputSchema,
  execute: async () => ({ ok: true, output: {} }),
});

const native = {
  name: 'web_fetch',
  description: 'Approved native fetch fixture',
  inputSchema: { type: 'object' },
  callMode: 'execute' as const,
  domain: 'web',
  sourcePlugin: 'official-web',
  executionLocation: 'runtime-native' as const,
  sideEffect: 'external' as const,
  requiredCapabilities: ['external'],
  costPolicy: 'free' as const,
};

describe('Gateway callable manifest', () => {
  it.each(Object.values(AGENT_SCENARIOS))(
    'projects the actual $id scenario inventory without weakening unsupported fields',
    (scenario) => {
      const tools = [...scenario.readToolNames, ...Object.keys(scenario.draftToolKinds)].map(
        (name) => {
          const registered = toolRegistry.get(name);
          if (registered === undefined) throw new Error(`Missing scenario tool: ${name}`);
          return { ...callable(name, registered.inputSchema), description: registered.description };
        },
      );
      const built = buildGatewayCallableManifest(tools, scenario);
      expect(built.manifest.tools).toHaveLength(tools.length);
      expect(ToolManifestSchema.safeParse(built.manifest).success).toBe(true);
    },
  );

  it('derives only the current callable set and hashes capabilities/schema/native composition', () => {
    const quote = callable('fetch_quote', z.object({ stockId: z.string().min(1) }));
    const draft = callable('create_watchlist');
    const built = buildGatewayCallableManifest([quote, draft], AGENT_SCENARIOS.research, [native]);
    expect(ToolManifestSchema.safeParse(built.manifest).success).toBe(true);
    expect(built.manifest.tools.map((tool) => tool.name)).toEqual([
      'create_watchlist',
      'fetch_quote',
      'web_fetch',
    ]);
    expect([...built.callables.keys()]).toEqual(['fetch_quote', 'create_watchlist']);
    expect(built.manifest.tools[0]).toMatchObject({
      callMode: 'draft',
      sideEffect: 'write',
      costPolicy: 'free',
    });
    expect(built.manifest.tools[1]).toMatchObject({
      callMode: 'execute',
      requiredCapabilities: ['external'],
      costPolicy: 'business-ledger',
    });
    expect(
      buildGatewayCallableManifest([draft, quote], AGENT_SCENARIOS.research, [native]).manifest
        .manifestHash,
    ).toBe(built.manifest.manifestHash);
    expect(
      buildGatewayCallableManifest([quote, draft], AGENT_SCENARIOS.research).manifest.manifestHash,
    ).not.toBe(built.manifest.manifestHash);
    expect(
      buildGatewayCallableManifest([callable('fetch_quote')], AGENT_SCENARIOS.research).manifest
        .manifestHash,
    ).not.toBe(
      buildGatewayCallableManifest([quote], AGENT_SCENARIOS.research).manifest.manifestHash,
    );
  });

  it.each([
    'settle_chat_draft',
    'add_trade',
    'ensure_default_account',
    'get_stock_market_view',
    'agent_run',
  ])('does not expose %s even when its name is supplied', (name) => {
    expect(() =>
      buildGatewayCallableManifest([callable(name)], AGENT_SCENARIOS.research),
    ).toThrow();
  });

  it('rejects duplicate business/native names and narrowing to another scenario', () => {
    expect(() =>
      buildGatewayCallableManifest(
        [callable('fetch_quote'), callable('fetch_quote')],
        AGENT_SCENARIOS.research,
      ),
    ).toThrow();
    expect(() =>
      buildGatewayCallableManifest([callable('fetch_quote')], AGENT_SCENARIOS.research, [
        { ...native, name: 'fetch_quote' },
      ]),
    ).toThrow();
    expect(() =>
      buildGatewayCallableManifest(
        [callable('get_decision_loop_review')],
        AGENT_SCENARIOS.research,
      ),
    ).toThrow();
    expect(() =>
      buildGatewayCallableManifest([], AGENT_SCENARIOS.research, [
        { ...native, executionLocation: 'bun-gateway' },
      ]),
    ).toThrow();
  });

  it('rejects privileged capability names disguised as approved native entries', () => {
    for (const declaration of [
      { ...native, requiredCapabilities: ['trade'] },
      { ...native, name: 'settle_chat_draft' },
      { ...native, name: 'add_trade' },
    ]) {
      expect(() =>
        buildGatewayCallableManifest([], AGENT_SCENARIOS.research, [declaration]),
      ).toThrow();
    }
  });

  it.each(['create_watchlist', 'fetch_quote'])(
    'rejects native %s impersonating a business tool omitted from the callable set',
    (name) => {
      expect(() =>
        buildGatewayCallableManifest([], AGENT_SCENARIOS.research, [{ ...native, name }]),
      ).toThrow();
    },
  );

  it('preserves dynamic defaults when validating the original callable input', () => {
    let current = 1;
    const schema = z
      .object({ value: z.number().default(() => current) })
      .refine((input) => input.value === current);
    const built = buildGatewayCallableManifest(
      [callable('search_stocks', schema)],
      AGENT_SCENARIOS.research,
    );
    current = 2;
    expect(schema.safeParse({}).success).toBe(true);
    expect(built.callables.get('search_stocks')?.wireInputSchema.safeParse({}).success).toBe(true);
  });

  it('rejects a sparse array instead of projecting a missing element to an empty array', () => {
    const sparse = new Array(1);
    expect(() => encodeGatewayJson({ values: sparse }, 1_000, true)).toThrow();
    expect(() => encodeGatewayJson({ values: sparse }, 1_000)).toThrow();
  });

  it('retains unions, enums, optional/default fields and numeric/nested constraints', () => {
    const schema = z
      .object({
        values: z
          .array(
            z.union([
              z.literal('unknown'),
              z.object({ amount: z.number().min(0.01).max(10), direction: z.enum(['up', 'down']) }),
            ]),
          )
          .max(3),
        optional: z.string().optional(),
        defaulted: z.boolean().default(false),
      })
      .strict();
    const built = buildGatewayCallableManifest(
      [callable('search_stocks', schema)],
      AGENT_SCENARIOS.research,
    );
    const parameters = built.manifest.tools[0]?.inputSchema;
    expect(parameters).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: ['values'],
    });
    expect(parameters?.properties).toMatchObject({
      values: {
        type: 'array',
        maxItems: 3,
        items: {
          anyOf: [
            { const: 'unknown' },
            {
              properties: {
                amount: { minimum: 0.01, maximum: 10 },
                direction: { enum: ['up', 'down'] },
              },
            },
          ],
        },
      },
    });
    expect(() =>
      buildGatewayCallableManifest(
        [callable('search_stocks', z.object({ date: z.date() }))],
        AGENT_SCENARIOS.research,
      ),
    ).toThrow();
    expect(() =>
      buildGatewayCallableManifest([callable('search_stocks', {})], AGENT_SCENARIOS.research),
    ).toThrow();
  });

  it('projects valid dates, omits absent optional object fields and rejects non-JSON corruption', () => {
    expect(
      JSON.parse(
        encodeGatewayJson(
          { when: new Date('2026-10-20T00:00:00Z'), optional: undefined, values: [0, false, null] },
          1_000,
          true,
        ),
      ),
    ).toEqual({ when: '2026-10-20T00:00:00.000Z', values: [0, false, null] });
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    for (const value of [NaN, Infinity, 1n, new Map(), new Date('invalid'), [undefined], cyclic]) {
      expect(() => encodeGatewayJson(value, 1_000, true)).toThrow();
    }
    expect(() => encodeGatewayJson({ text: '中'.repeat(30) }, 50, true)).toThrow();
  });

  it('advertises and enforces RFC3339 for coerced dates while retaining date bounds and metadata', () => {
    const schema = z
      .object({
        since: z.coerce
          .date()
          .min(new Date('2026-01-01T00:00:00Z'))
          .describe('Fact boundary')
          .optional(),
        nested: z.array(z.union([z.object({ at: z.coerce.date() }), z.literal('unknown')])),
      })
      .strict()
      .describe('Dated input');
    const built = buildGatewayCallableManifest(
      [callable('search_stocks', schema)],
      AGENT_SCENARIOS.research,
    );
    const bound = built.callables.get('search_stocks');
    expect(bound?.declaration.inputSchema).toMatchObject({
      description: 'Dated input',
      properties: { since: { type: 'string', format: 'date-time', description: 'Fact boundary' } },
    });
    expect(
      bound?.wireInputSchema.safeParse({
        since: '2026-10-20T08:00:00+08:00',
        nested: [{ at: '2026-10-20T00:00:00Z' }],
      }).success,
    ).toBe(true);
    for (const since of [null, 0, '2026-10-20', '2025-10-20T00:00:00Z', 'invalid']) {
      expect(bound?.wireInputSchema.safeParse({ since, nested: [] }).success).toBe(false);
    }
    expect(schema.safeParse({ since: 0, nested: [] }).success).toBe(false);
    expect(bound?.wireInputSchema.safeParse({ nested: ['unknown'] }).success).toBe(true);
    expect(() =>
      buildGatewayCallableManifest(
        [callable('search_stocks', z.object({ unsupported: z.bigint() }))],
        AGENT_SCENARIOS.research,
      ),
    ).toThrow();
  });
});
