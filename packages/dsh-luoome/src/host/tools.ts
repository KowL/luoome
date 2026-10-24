import {
  assertSupportedJsonSchema,
  type JsonSchemaNode,
  type ToolDefinition,
  type ToolRuntime,
} from '@deepseek-ai/dsh-tools';
import type { ReadSurface } from './read-surface.js';

export const toolResultJsonSchema: JsonSchemaNode = {
  oneOf: [
    {
      type: 'object',
      properties: { ok: { type: 'boolean', enum: [true] }, data: {} },
      required: ['ok', 'data'],
      additionalProperties: false,
    },
    {
      type: 'object',
      properties: {
        ok: { type: 'boolean', enum: [false] },
        error: {
          type: 'object',
          properties: { kind: { type: 'string' } },
          required: ['kind'],
          additionalProperties: true,
        },
      },
      required: ['ok', 'error'],
      additionalProperties: false,
    },
  ],
};

export const registerReadTools = (
  runtime: Pick<ToolRuntime, 'register'>,
  surface: ReadSurface,
): (() => void) => {
  const unregister: (() => void)[] = [];
  try {
    assertSupportedJsonSchema(toolResultJsonSchema);
    const definitions: ToolDefinition[] = surface.descriptors().map((descriptor) => {
      // Zod attaches non-enumerable ~standard methods; DSH requires wire-format JSON.
      const parameters = JSON.parse(JSON.stringify(descriptor.inputSchema));
      // Raw register() accepts full input schemas; the SDK subset is for output/DSL.
      // Execution must keep going through the domain tool's original Zod validator.
      return {
        name: descriptor.name,
        description: descriptor.description,
        parameters: { ...parameters },
        output: {
          schema: toolResultJsonSchema,
          render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
        },
        execute: (input, exec) => surface.invoke(descriptor.name, input, exec.signal),
      };
    });
    for (const definition of definitions) unregister.push(runtime.register(definition));
  } catch (error) {
    for (const remove of unregister.reverse()) remove();
    surface.dispose();
    throw error;
  }
  return () => {
    surface.dispose();
    for (const remove of unregister.splice(0).reverse()) remove();
  };
};
