import { createHash } from 'node:crypto';
import type { AgentCallableTool } from '@luoome/core';
import {
  canonicalJson,
  JsonObjectSchema,
  type JsonValue,
  PROTOCOL_VERSION,
  type ToolManifest,
  type ToolManifestEntry,
  ToolManifestSchema,
} from '@luoome/dsh-bridge/protocol';
import {
  type AgentScenario,
  APPROVED_EXTERNAL_TOOLS,
  addTradeTool,
  recordDecisionTradeTool,
  settleChatDraftTool,
  toolRegistry,
} from '@luoome/tools';
import { z } from 'zod';

const privilegedToolNames = new Set([
  addTradeTool.name,
  recordDecisionTradeTool.name,
  settleChatDraftTool.name,
]);

export interface GatewayBoundTool {
  readonly declaration: ToolManifestEntry;
  readonly inputSchema: z.ZodType;
  readonly wireInputSchema: z.ZodType;
  readonly execute: AgentCallableTool['execute'];
}

export interface GatewayCallableManifest {
  readonly manifest: ToolManifest;
  readonly scenario: string;
  readonly callables: ReadonlyMap<string, GatewayBoundTool>;
}

export const hashGatewayJson = (encoded: string): string =>
  `sha256:${createHash('sha256').update(encoded).digest('hex')}`;

/** JSON transport projects Dates to ISO strings and omits absent object properties only. */
export const encodeGatewayJson = (
  value: unknown,
  maxBytes: number,
  projectDates = false,
): string => {
  const ancestors = new Set<object>();
  let bytes = 0;
  const count = (part: string): string => {
    bytes += Buffer.byteLength(part);
    if (bytes > maxBytes) throw new Error('json-size-limit');
    return part;
  };
  const encode = (item: unknown, depth: number): string => {
    if (depth > 64) throw new Error('json-depth-limit');
    if (item === null || typeof item === 'string' || typeof item === 'boolean') {
      return count(JSON.stringify(item));
    }
    if (typeof item === 'number' && Number.isFinite(item)) return count(JSON.stringify(item));
    if (projectDates && item instanceof Date) return count(JSON.stringify(item.toISOString()));
    if (typeof item !== 'object' || item === null || ancestors.has(item)) {
      throw new Error('non-json-value');
    }
    ancestors.add(item);
    try {
      if (Array.isArray(item)) {
        count('[]');
        const entries: string[] = [];
        for (let index = 0; index < item.length; index += 1) {
          if (!Object.hasOwn(item, index)) throw new Error('non-json-value');
          if (index > 0) count(',');
          entries.push(encode(item[index], depth + 1));
        }
        return `[${entries.join(',')}]`;
      }
      const prototype = Object.getPrototypeOf(item);
      if (prototype !== Object.prototype && prototype !== null) throw new Error('non-json-value');
      count('{}');
      const properties: string[] = [];
      for (const key of Object.keys(item).sort()) {
        const entry = (item as Record<string, unknown>)[key];
        if (projectDates && entry === undefined) continue;
        if (properties.length > 0) count(',');
        properties.push(`${count(JSON.stringify(key))}${count(':')}${encode(entry, depth + 1)}`);
      }
      return `{${properties.join(',')}}`;
    } finally {
      ancestors.delete(item);
    }
  };
  return encode(value, 0);
};

const projectGatewayInput = (schema: z.ZodType): z.ZodType => {
  const projected = new Map<z.ZodType, z.ZodType>();
  const value = (entry: unknown): unknown => {
    if (entry instanceof z.ZodType) return visit(entry);
    if (Array.isArray(entry)) return entry.map(value);
    if (
      entry !== null &&
      typeof entry === 'object' &&
      Object.getPrototypeOf(entry) === Object.prototype
    ) {
      return Object.fromEntries(Object.entries(entry).map(([key, child]) => [key, value(child)]));
    }
    return entry;
  };
  const visit = (node: z.ZodType): z.ZodType => {
    const previous = projected.get(node);
    if (previous !== undefined) return previous;
    // Coerced Dates have an explicit RFC3339 wire subset; original date bounds still run.
    if (node instanceof z.ZodDate && node.def.coerce) {
      let date = z.iso
        .datetime({ offset: true })
        .transform((input) => new Date(input))
        .pipe(node);
      const metadata = node.meta();
      if (metadata !== undefined) date = date.meta(metadata);
      projected.set(node, date);
      return date;
    }
    const descriptors = Object.getOwnPropertyDescriptors(node.def);
    for (const [key, descriptor] of Object.entries(descriptors)) {
      // Zod represents dynamic defaults as getters; evaluating one here freezes its value.
      if (key === 'defaultValue') continue;
      const project = (child: unknown) =>
        node.def.type === 'lazy' && key === 'getter'
          ? () => value((child as () => unknown)())
          : node.def.type === 'pipe' && key === 'out'
            ? child
            : value(child);
      if (descriptor.get !== undefined) {
        const getter = descriptor.get;
        descriptor.get = () => project(getter.call(node.def));
      } else if ('value' in descriptor) {
        descriptor.value = project(descriptor.value);
      }
    }
    const definition = Object.defineProperties({}, descriptors) as z.core.$ZodTypeDef;
    let copy = node.clone(definition);
    const metadata = node.meta();
    if (metadata !== undefined) copy = copy.meta(metadata);
    projected.set(node, copy);
    return copy;
  };
  return visit(schema);
};

export const buildGatewayCallableManifest = (
  tools: readonly AgentCallableTool[],
  scenario: AgentScenario,
  nativeTools: readonly ToolManifestEntry[] = [],
): GatewayCallableManifest => {
  const callables = new Map<string, GatewayBoundTool>();
  for (const callable of tools) {
    if (callables.has(callable.name)) throw new Error(`Duplicate callable: ${callable.name}`);
    const registered = toolRegistry.get(callable.name);
    if (
      registered === undefined ||
      registered.sideEffect === 'trade' ||
      registered.requiredCapabilities.includes('trade')
    ) {
      throw new Error(`Unapproved callable: ${callable.name}`);
    }
    const mode = Object.hasOwn(scenario.draftToolKinds, callable.name) ? 'draft' : 'execute';
    if (
      (mode === 'execute' &&
        (!scenario.readToolNames.includes(callable.name) ||
          !registered.requiredCapabilities.every(
            (capability) =>
              capability === 'read' ||
              (capability === 'external' && APPROVED_EXTERNAL_TOOLS.has(callable.name)),
          ))) ||
      !(callable.inputSchema instanceof z.ZodType)
    ) {
      throw new Error(`Unapproved callable: ${callable.name}`);
    }
    const inputSchema = callable.inputSchema;
    const wireInputSchema = projectGatewayInput(inputSchema);
    const declaration = {
      name: callable.name,
      description: callable.description,
      inputSchema: JsonObjectSchema.parse(z.toJSONSchema(wireInputSchema, { io: 'input' })),
      callMode: mode,
      domain: 'investment',
      sourcePlugin: 'luoome-business',
      executionLocation: 'bun-gateway',
      sideEffect: registered.sideEffect,
      // Draft generation does not authorize or execute the target tool's side effects.
      requiredCapabilities: mode === 'draft' ? ['read'] : [...registered.requiredCapabilities],
      costPolicy: mode === 'draft' || registered.sideEffect === 'read' ? 'free' : 'business-ledger',
    } satisfies ToolManifestEntry;
    callables.set(callable.name, {
      declaration,
      inputSchema,
      wireInputSchema,
      execute: callable.execute.bind(callable),
    });
  }
  if (
    nativeTools.some(
      (tool) =>
        tool.executionLocation !== 'runtime-native' ||
        tool.requiredCapabilities.includes('trade') ||
        privilegedToolNames.has(tool.name) ||
        toolRegistry.get(tool.name) !== undefined,
    )
  ) {
    throw new Error(
      'Native declarations must execute in the runtime with distinct, non-privileged tool names',
    );
  }
  const declarations = [...callables.values()]
    .map((tool) => tool.declaration)
    .concat(nativeTools)
    .sort((a, b) => a.name.localeCompare(b.name, 'en'));
  const manifestHash = hashGatewayJson(
    canonicalJson(
      JSON.parse(
        encodeGatewayJson(
          {
            protocolVersion: PROTOCOL_VERSION,
            scenario: scenario.id,
            tools: declarations,
          },
          2_000_000,
        ),
      ) as JsonValue,
    ),
  );
  const manifest = ToolManifestSchema.parse({
    protocolVersion: PROTOCOL_VERSION,
    manifestHash,
    tools: declarations,
  });
  for (const entry of manifest.tools) {
    const callable = callables.get(entry.name);
    if (callable !== undefined) callables.set(entry.name, { ...callable, declaration: entry });
  }
  return {
    manifest,
    scenario: scenario.id,
    callables,
  };
};
