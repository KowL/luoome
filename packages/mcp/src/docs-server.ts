import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

const Input = z.strictObject({
  query: z.string().trim().min(1).max(100),
  limit: z.number().int().min(1).max(5).default(3),
});
const files = ['README.md', 'CONTEXT.md', 'docs/ARCHITECTURE.md', 'docs/USER_GUIDE.md'];
const root = new URL('../../../', import.meta.url);

export const startDocsMcpServer = async () => {
  const server = new Server(
    { name: 'luoome-docs', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: [
      {
        name: 'search_docs',
        description:
          'Search maintained luoome documentation; returns source paths and excerpts. No private portfolio data.',
        inputSchema: z.toJSONSchema(Input, { io: 'input' }),
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      },
    ],
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const input = Input.safeParse(request.params.arguments);
    if (request.params.name !== 'search_docs' || !input.success)
      return {
        isError: true,
        content: [{ type: 'text', text: 'Invalid documentation search request' }],
      };
    const matches = [];
    for (const path of files) {
      const text = await readFile(fileURLToPath(new URL(path, root)), 'utf8');
      const offset = text.toLowerCase().indexOf(input.data.query.toLowerCase());
      if (offset >= 0)
        matches.push({ path, excerpt: text.slice(Math.max(0, offset - 120), offset + 600) });
    }
    return {
      content: [
        { type: 'text', text: JSON.stringify({ matches: matches.slice(0, input.data.limit) }) },
      ],
    };
  });
  await server.connect(new StdioServerTransport());
  return server;
};

if (import.meta.main) await startDocsMcpServer();
