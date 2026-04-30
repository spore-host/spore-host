# How It Works

spore.host is a collection of five tools that cover the full lifecycle of ephemeral compute — from finding the right instance to cleaning it up when the work is done. This page explains how they fit together.

## The core idea

The biggest problem with cloud compute isn't launching instances — it's managing them. Instances get forgotten over weekends. Researchers SSH in, run a job, close the laptop, and come back on Monday to a bill. Someone accidentally leaves a p4d.24xlarge running for three days.

spore.host solves this with a simple contract: **every instance has a lifecycle that manages itself**. When you launch with spore.host, the instance knows when it should stop. You don't have to remember.

## The five tools

### <span class="tool-badge truffle">Truffle</span> — Find

Before you launch anything, you need to know what's available and what it costs. Truffle searches EC2 instance types across regions using plain language or filters, compares Spot prices in real time, and checks your service quotas so you don't get a launch failure after waiting for capacity.

```sh
truffle find "nvidia h100 8gpu" --region us-east-1
truffle spot g5.2xlarge --regions us-east-1,us-west-2
truffle quota --instance-type p4d.24xlarge --region us-east-1
```

Truffle doesn't launch anything — it's read-only. Think of it as the search and research tool.

### <span class="tool-badge spawn">Spawn</span> — Launch and manage

Spawn is the launcher. It takes truffle's output (or your own flags) and provisions an EC2 instance with everything spore.host needs to manage its lifecycle: the spored daemon, TTL tags, idle detection configuration, and notification hooks.

```sh
truffle find "t3.medium" | spawn --ttl 8h
spawn launch --name training --instance-type g5.2xlarge --ttl 24h
```

**Spored** is the daemon that runs on the instance itself. It's small, it runs in the background, and it handles:

- **TTL enforcement** — the instance terminates at the configured deadline
- **Idle detection** — CPU, network, process names, and SSH sessions are all monitored; if the instance has been idle too long, it stops or hibernates
- **Lifecycle notifications** — sends events (TTL warning, idle warning, completion) to the spore-bot Lambda so you get Slack/Teams messages
- **DNS registration** — registers a DNS name at launch and cleans it up on termination
- **Pre-stop hooks** — runs a shell command before any shutdown to save work, sync files, or send a completion signal

### <span class="tool-badge lagotto">Lagotto</span> — Watch for capacity

Some instance types — particularly high-demand GPU families — aren't always available. Lagotto runs as a serverless Lambda function that polls for capacity on a schedule and acts when something appears. You configure what to watch for, and Lagotto handles the rest.

```sh
lagotto watch --instance-type p5.48xlarge --region us-east-1 --notify slack
lagotto list   # see active watches
```

Lagotto is useful when you have a job queued but can't launch it yet — you want to be notified the moment capacity opens up, or you want the launch to happen automatically.

### <span class="tool-badge bot">Spore-bot</span> — Control from anywhere

Once an instance is running, you might not want to open a terminal to manage it. Spore-bot connects your Slack or Teams workspace to your running instances. Any team member you've authorized can type `/spore status`, `/spore stop`, or `/spore extend 4h` and it just works — from any device, any location.

Lifecycle events from spored are routed through spore-bot to your Slack DMs:

- *⏱️ training will terminate in 10 minutes* — with time to extend if you need more
- *✅ training has completed* — your job finished and the instance is terminating
- *⏹️ training has stopped — idle timeout reached — nothing was happening, so compute was paused

### <span class="tool-badge mcp">MCP Server</span> — Control from AI assistants

The spore.host MCP server exposes all of the above as tools for AI assistants that support the Model Context Protocol — Claude Desktop, Cursor, and others. Instead of running CLI commands, you describe what you need in plain language and the assistant handles it.

> *"What instances do I have running and how long until they terminate?"*

> *"Find me the cheapest A100 instance in us-east-1 and tell me the Spot savings."*

## The typical workflow

```
truffle find "nvidia a100"          # 1. Find the right instance type
    ↓
spawn launch                        # 2. Launch with TTL and idle config
    ↓
spored (on instance)                # 3. Daemon monitors, enforces TTL,
    │                                     detects idle, fires notifications
    ↓
spore-bot → Slack DM               # 4. You hear about events without
                                         polling or checking terminals
    ↓
Instance terminates automatically   # 5. No forgotten instances
```

## Configuration layers

spore.host has three layers of configuration:

1. **CLI flags** — highest priority, overrides everything (`--ttl 24h`)
2. **Defaults file** — `~/.spawn/config.yaml` — for settings you always want (`spawn defaults set idle-timeout 1h`)
3. **EC2 tags** — spored reads its configuration from tags on the instance at startup

This means you can set global defaults once and override per-launch without re-specifying everything every time.

## What spore.host doesn't do

- It doesn't manage your SSH keys beyond passing the one you specify at launch
- It doesn't modify your AWS account structure, VPCs, or security groups (beyond what's needed to launch)
- It doesn't store your AWS credentials — everything uses your existing credential chain
- It doesn't require any always-on infrastructure in your account (spored runs on the instance; the Lambda functions run in the spore.host-infra account)

## Next steps

- **[Installation guide](/guides/installation)** — get set up properly
- **[GPU Training](/guides/gpu-training)** — a complete worked example
- **[spawn launch reference](/tools/reference/spawn)** — every flag and EC2 tag explained
