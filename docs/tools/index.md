# Tools

spore.host is five tools that work together. Each has exactly one job.

| Tool | Role | Install |
|------|------|---------|
| [Truffle](/tools/truffle) | Find instance types, compare prices, check quotas | `brew install spore-host/tap/truffle` |
| [Spawn](/tools/spawn) | Launch and manage instances | `brew install spore-host/tap/spawn` |
| [Lagotto](/tools/lagotto) | Watch for capacity, act when it appears | `brew install spore-host/tap/lagotto` |
| [Spore-bot](/tools/spore-bot) | Slack and Teams control | [Setup guide](/guides/slack-setup) |
| [MCP Server](/tools/mcp-server) | AI assistant integration | `brew install spore-host/tap/spore-host-mcp` |

## How they connect

```
truffle find "nvidia h100"
    │
    └─ pipe or copy instance type
    
spawn launch --instance-type p4d.24xlarge --ttl 12h
    │
    └─ spored daemon starts on instance
         │
         ├─ enforces TTL, detects idle
         ├─ sends lifecycle events → spore-bot Lambda → Slack DMs
         └─ registers DNS name

lagotto watch --instance-type p5.48xlarge
    │
    └─ when capacity appears: notify or auto-launch
    
spore-bot (/spore status, /spore extend)
    └─ calls EC2 via cross-account IAM role

spore-host-mcp
    └─ wraps truffle and spawn as MCP tools for AI assistants
```
