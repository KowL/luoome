# MCP setup

The luoome Skill is the instruction and orchestration layer. The luoome MCP server remains the transport, typed-schema and permission layer. Install/import the entire `skills/luoome/` directory so the Skill can load its references.

## Prerequisites

- The `luoome` executable is installed and available to the Agent host.
- `luoome mcp serve` can start with the intended `LUOOME_HOME`.
- Market and LLM providers are configured only when the requested capability needs them; see the root [environment variable table](../../../README.md#环境变量).

## Claude Desktop

Add a stdio server entry to the host's MCP configuration:

```json
{
  "mcpServers": {
    "luoome": {
      "command": "luoome",
      "args": ["mcp", "serve"],
      "env": {
        "LUOOME_HOME": "/Users/you/.luoome"
      }
    }
  }
}
```

Use an absolute executable path when `luoome` is not on the desktop application's `PATH`.

## OpenClaw

Configure a stdio MCP server using the harness's supported syntax:

```yaml
mcps:
  - name: luoome
    transport: stdio
    command: luoome
    args: [mcp, serve]
    allowSideEffects: [read, advice]
```

## Hermes and other MCP hosts

Register `luoome mcp serve` as a stdio MCP server. Import this Skill separately through the host's Skill installation mechanism; MCP registration alone does not load the Skill's operating rules.

## Permission boundary

The server exposes `read` and `advice` by default.

- `LUOOME_EXPOSE_WRITE=true` adds write tools.
- `LUOOME_EXPOSE_EXTERNAL=true` adds tools that contact external services or persist fetched data.
- `LUOOME_EXPOSE_TRADE=true` is forbidden and makes the MCP server fail at startup.

Only enable write/external capabilities when the user understands the side effects. The Skill must still request transaction-level confirmation before invoking them.

After changing MCP configuration, restart the host and verify that its MCP tool discovery includes luoome tools. If discovery fails, run `luoome mcp serve` manually to inspect startup errors; do not bypass permission checks.
