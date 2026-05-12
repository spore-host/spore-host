# AI Assistant Integration (MCP)

The spore.host MCP server lets you manage compute through AI assistants that support the Model Context Protocol — including Claude Desktop and Cursor. Instead of running CLI commands, you describe what you need in plain language.

## What you can do

```
"What instances do I have running and how long until they terminate?"
"Find me the cheapest 8-GPU instance for a training job in us-east-1."
"Stop the rstudio instance — I forgot to shut it down."
"Extend the bert-training TTL by 6 hours."
"What's the current Spot price for p4d.24xlarge across regions?"
"Do I have enough quota to launch a p5.48xlarge in us-east-1?"
```

The assistant has access to eight tools covering instance search, status, and lifecycle management.

## Install

```sh
brew install spore-host/tap/spore-host-mcp
```

Or download from the [releases page](https://github.com/spore-host/spore-host/releases/latest).

## Configure Claude Desktop

Add spore.host to `~/.claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "spore-host": {
      "command": "/usr/local/bin/spore-host-mcp"
    }
  }
}
```

Restart Claude Desktop. You'll see a hammer icon in the input bar when the MCP server is connected.

## Configure Cursor

Add to your Cursor MCP settings (Settings → MCP → Add Server):

```json
{
  "name": "spore-host",
  "command": "/usr/local/bin/spore-host-mcp"
}
```

## Available tools

| Tool | What it does |
|------|-------------|
| `truffle_find` | Natural language instance search with GPU specs and pricing |
| `truffle_spot_prices` | Current Spot prices by AZ for a specific instance type |
| `truffle_quota_check` | Whether your account can launch a given instance type |
| `spawn_list` | List running instances (filter by state and region) |
| `spawn_status` | Detailed status for an instance by name or ID |
| `spawn_stop` | Stop or hibernate a running instance |
| `spawn_terminate` | Permanently terminate an instance |
| `spawn_extend` | Update an instance's TTL |

## Credentials

The MCP server uses the same AWS credential chain as the CLI — `~/.aws/credentials`, environment variables, or instance metadata. No additional configuration is needed if the CLI is already working.

## Tips

**Ask for context before acting.** The assistant won't terminate an instance without telling you what it's about to do. If you ask "clean up my running instances," it will list them and ask for confirmation.

**Natural language works for instance search.** You don't need to know exact instance type names: "a GPU with at least 40GB of VRAM for inference" will find appropriate options.

**Region defaults.** The MCP server uses your configured AWS default region unless you specify otherwise. Say "in us-west-2" or "across all regions" explicitly if you want different behaviour.
