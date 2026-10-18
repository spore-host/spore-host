---
description: "The spore.host MCP server lets you manage compute through AI assistants that support the Model Context Protocol — Claude Code, Claude Desktop, Cursor, Windsurf, and more."
---

# AI Assistant Integration (MCP)

The spore.host MCP server lets you manage compute through AI assistants that support the Model Context Protocol — Claude Code, Claude Desktop, Cursor, Windsurf, and any other MCP-compatible client. Instead of running CLI commands, you describe what you need in plain language.

## What you can do

```
"What instances do I have running and how long until they terminate?"
"Find me the cheapest 8-GPU instance for a training job in us-east-1."
"Stop the rstudio instance — I forgot to shut it down."
"Extend the bert-training TTL by 6 hours."
"What's the current Spot price for p4d.24xlarge across regions?"
"Do I have enough quota to launch a p5.48xlarge in us-east-1?"
```

The assistant has 13 tools covering instance search, status, lifecycle management and capacity watches. Two of them can create billable resources; see [below](#available-tools).

## Install

```sh
brew install spore-host/tap/spore-host-mcp
```

Or download from the [releases page](https://github.com/spore-host/spore-host/releases/latest).

## Configure

`spore-host-mcp` is a standard stdio MCP server — it works with any
MCP-compatible client. Point the client at the installed binary (`which
spore-host-mcp` if you're unsure of the path; Homebrew installs to
`/opt/homebrew/bin` on Apple Silicon, `/usr/local/bin` on Intel/Linux). Set
`AWS_PROFILE` in the server's environment if you use a named profile.

### Claude Code

From your project directory:

```sh
claude mcp add spore-host -- spore-host-mcp
# with a named AWS profile:
claude mcp add spore-host -e AWS_PROFILE=my-profile -- spore-host-mcp
```

`claude mcp list` confirms it's connected. Use `-s user` to make it available
across all projects, or `-s project` to share it with your team via
`.mcp.json`. Restart Claude Code after adding so the tools load.

### Claude Desktop

Add spore.host to Claude Desktop's config file:
`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS, or
`%APPDATA%\Claude\claude_desktop_config.json` on Windows. Use the path
`which spore-host-mcp` prints (`/opt/homebrew/bin` on Apple Silicon Homebrew,
`/usr/local/bin` on Intel):

```json
{
  "mcpServers": {
    "spore-host": {
      "command": "/opt/homebrew/bin/spore-host-mcp"
    }
  }
}
```

Restart Claude Desktop. You'll see a hammer icon in the input bar when the MCP server is connected.

### Cursor

Add to your Cursor MCP settings (Settings → MCP → Add Server), or create
`.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "spore-host": {
      "command": "/opt/homebrew/bin/spore-host-mcp"
    }
  }
}
```

### Windsurf

Add to `~/.codeium/windsurf/mcp_config.json` (Settings → Cascade → MCP servers →
Add), using the same `mcpServers` block shown above.

### Other clients (Kiro, Codex, Zed, Continue, …)

Any client that speaks the Model Context Protocol over stdio can run it. The
config differs per client, but the essentials are the same everywhere:

- **command:** the absolute path to `spore-host-mcp`
- **transport:** stdio (the default; no args)
- **env (optional):** `AWS_PROFILE` / `AWS_REGION`, or `SPORE_PROFILE` /
  `SPORE_REGION`

Most clients read a JSON config with an `mcpServers` (or equivalent) map — reuse
the block shown for Claude Desktop above, adjusting the file location to the
client's own MCP config path.

## Available tools

| Tool | What it does |
|------|-------------|
| `truffle_find` | Natural language instance search with GPU specs and pricing |
| `truffle_spot_prices` | Current Spot prices by AZ for a specific instance type |
| `truffle_quota_check` | Whether your account can launch a given instance type |
| `spawn_list` | List running instances (filter by state and region) |
| `spawn_status` | Detailed status for an instance by name or ID |
| `spawn_stop` | Stop or hibernate a running instance |
| `spawn_terminate` | Permanently terminate an instance (two-phase — preview, then `confirm=true`) |
| `spawn_extend` | Update an instance's TTL |
| `spawn_task_run` | **Launches a billable instance** from a TaskSpec; TTL required; `dry_run=true` previews |
| `spawn_app_launch` | Validates and plans an app launch; doesn't launch |
| `lagotto_list` | List your capacity watches |
| `lagotto_status` | Details of one of your watches |
| `lagotto_watch` | Create a watch: `notify`, or `hold` (**reserves billable capacity**) |

`spawn_task_run` and `lagotto_watch action=hold` are the two tools that spend
money. See the [MCP server reference](/tools/mcp-server) for their safeguards.

## Credentials

The MCP server uses the same AWS credential chain as the CLI — `~/.aws/credentials`, environment variables (`AWS_PROFILE`/`AWS_REGION`), or instance metadata. It also honors the shared spore.host config base: `SPORE_PROFILE`/`SPORE_REGION` and the `[spore]` table of `~/.config/spore/config.toml`. No additional configuration is needed if the CLI is already working.

## Tips

**Terminate is two-phase.** `spawn_terminate` never destroys an instance on the first call — it previews the exact instance that would be terminated, and only a second call with `confirm=true` actually terminates it. If the name you give matches more than one instance, it's refused (use the instance ID) so the wrong box can't be destroyed. Ask "clean up my running instances" and the assistant will list them and confirm before acting.

**Natural language works for instance search.** You don't need to know exact instance type names: "a GPU with at least 40GB of VRAM for inference" will find appropriate options.

**Region defaults.** The MCP server uses your configured AWS default region unless you specify otherwise. Say "in us-west-2" or "across all regions" explicitly if you want different behaviour.
