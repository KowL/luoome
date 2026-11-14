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

The server permits `read` and `advice` by default, and only discovers tools whose dependencies are ready. Without model or market configuration, local queries such as `list_watchlists`, `get_advice` and local-fallback `search_stocks` remain available. AI analysis requires model credentials and market capabilities. External market and news tools require `LUOOME_MARKET_PROVIDER=real`; Research Vault tools also require a mounted Vault and `LUOOME_EXPOSE_RESEARCH=true`. Readiness checks configuration and installed capabilities, not upstream network health.

After configuring dependencies, restart the MCP process and rediscover tools. If a tool is absent, check its required dependencies and permissions before selecting another discovered capability.

- `LUOOME_EXPOSE_READ=false` or `LUOOME_EXPOSE_ADVICE=false` disables that category.
- `LUOOME_EXPOSE_WRITE=true` adds write tools.
- `LUOOME_EXPOSE_EXTERNAL=true` adds tools that contact external services or persist fetched data.
- `LUOOME_EXPOSE_TRADE=true` is forbidden and makes the MCP server fail at startup.

Only enable write/external capabilities when the user understands the side effects. The Skill must still request transaction-level confirmation before invoking them.

After changing MCP configuration, restart the host and verify that its MCP tool discovery includes luoome tools. If discovery fails, run `luoome mcp serve` manually to inspect startup errors; do not bypass permission checks.


## Outbound MCP services in Web Chat

The built-in Web Agent can opt into separately configured readonly MCP services through its Bun Gateway.
These run-local tools are not relayed by `luoome mcp serve` and do not extend this Skill's connected tool inventory.
See the [user guide](../../../docs/USER_GUIDE.md#只读-mcp-服务供内置-agent-使用) for explicit service enablement, tool and scenario allowlists, and disablement.
