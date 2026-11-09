---
description: "spore.host is five tools that work together."
---

# Tools

spore.host is five tools that work together. Each has exactly one job.

| Tool | Role | Install |
|------|------|---------|
| [Truffle](/tools/truffle) | Find instance types, compare prices, check quotas | `brew install spore-host/tap/truffle` |
| [Spawn](/tools/spawn) | Launch and manage instances | `brew install spore-host/tap/spawn` |
| [Spored](/tools/spored) | Lifecycle daemon — enforces TTL, idle, completion on each instance | provisioned automatically by spawn |
| [Lagotto](/tools/lagotto) | Watch for capacity, act when it appears | `brew install spore-host/tap/lagotto` |
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
         ├─ logs lifecycle events (optional completion/Spot webhooks)
         └─ registers DNS name

lagotto watch --instance-type p5.48xlarge
    │
    └─ when capacity appears: notify or auto-launch
    
spore-host-mcp
    └─ wraps truffle, spawn and lagotto as MCP tools for AI assistants
```
