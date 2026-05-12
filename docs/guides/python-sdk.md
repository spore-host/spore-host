# Python SDK

The `spore-host` Python package lets you discover EC2 instances, check status, and manage running compute from Python scripts, Jupyter notebooks, and reactive notebooks like marimo.

## Installation

```sh
pip install spore-host
```

For notebook extras (IPython rich display):
```sh
pip install "spore-host[jupyter]"
```

::: tip Not on PyPI yet?
Until the package is published, install directly from the repository:
```sh
pip install "git+https://github.com/spore-host/spore-host.git#subdirectory=sdk/python"
```
:::

## Authentication

The SDK uses the same AWS credential chain as the CLI — `~/.aws/credentials`, environment variables, or instance metadata. No separate login needed.

```python
import spore   # uses ambient AWS credentials automatically
```

To use a specific profile or API key:

```python
client = spore.Client(
    profile="my-research-account",  # AWS profile name
    region="us-east-1",
)
# or
client = spore.Client(api_key="sk_...")  # spore.host hosted API
```

The module-level `spore.truffle` and `spore.spawn` are shortcuts to a default `Client()`.

## Finding instances — `spore.truffle`

### Search

```python
results = spore.truffle.find("amd epyc genoa", region="us-east-1")
for r in results:
    print(r.instance_type, f"${r.on_demand_price:.4f}/hr")
```

Natural language queries work: `"nvidia h100 8gpu"`, `"arm64 64gb memory"`, `"cheap compute"`.

The returned `InstanceType` objects have:

| Field | Type | Description |
|-------|------|-------------|
| `instance_type` | str | e.g. `"c8a.2xlarge"` |
| `vcpus` | int | Number of vCPUs |
| `memory_gib` | float | Memory in GiB |
| `architecture` | str | `"x86_64"` or `"arm64"` |
| `on_demand_price` | float | On-demand $/hr |
| `gpus` | int | GPU count |
| `gpu_model` | str | e.g. `"A100"` |
| `available_azs` | list[str] | Availability zones |

### Spot prices

```python
prices = spore.truffle.spot("c8a.2xlarge", region="us-east-1")
cheapest = min(prices, key=lambda p: p.spot_price)
print(f"{cheapest.availability_zone}: ${cheapest.spot_price:.4f}/hr ({cheapest.savings_pct:.0f}% savings)")
```

### Quota check

```python
q = spore.truffle.quota("p4d.24xlarge", region="us-east-1")
if not q.can_launch:
    print(f"Quota insufficient: {q.message}")
```

## Managing instances — `spore.spawn`

### List running instances

```python
instances = spore.spawn.list()              # running only (default)
all_insts  = spore.spawn.list(state="all")  # include stopped/terminated
```

### Get instance status

```python
inst = spore.spawn.status("sim-run-42")    # by name or instance ID
print(inst.state, inst.ttl, inst.public_ip)
```

### Instance actions

```python
inst = spore.spawn.status("sim-run-42")

inst.stop()           # stop (preserves instance)
inst.stop(hibernate=True)  # hibernate instead
inst.start()          # wake a stopped/hibernated instance
inst.extend("2h")     # push the TTL deadline forward by 2h
inst.terminate()      # permanent — cannot be undone
```

Actions can also be called directly:

```python
spore.spawn.stop("sim-run-42")
spore.spawn.start("sim-run-42")
spore.spawn.extend("sim-run-42", "4h")
spore.spawn.terminate("sim-run-42")
```

### Waiting for state changes

```python
# Block until terminated (job done or TTL fired)
inst.wait("terminated")

# Poll with a callback — useful in scripts
inst.wait(
    "terminated",
    poll_interval=60,
    on_status=lambda i: print(f"{i.name}: {i.state}"),
)
```

## Launching instances

```python
inst = spore.spawn.launch(
    "c8a.2xlarge",
    name="my-analysis",
    ttl="12h",
    idle_timeout="30m",
    on_complete="terminate",
)
print(inst.instance_id, inst.public_ip)

# Block until the instance is running
inst.wait_running()
```

Full parameter reference:

```python
spore.spawn.launch(
    instance_type,          # required — e.g. "c8a.2xlarge"
    name=None,              # instance name tag
    region=None,            # AWS region; defaults to client region
    ttl="4h",               # hard termination deadline
    idle_timeout=None,      # stop if idle for this duration, e.g. "30m"
    spot=False,             # use Spot pricing
    on_complete="terminate",# action on SPAWN_COMPLETE: "terminate", "stop", "hibernate"
    slack_workspace=None,   # Slack workspace ID for lifecycle SMS/DM notifications
    active_processes=None,  # list of process names that indicate activity, e.g. ["rsession"]
    wait=False,             # if True, block until instance is running
)
```

::: tip TTL vs idle timeout
`ttl` is the hard deadline — the instance terminates at `launch_time + ttl` regardless of activity. `idle_timeout` stops the instance when idle; the timer resets on each wake. See [TTL vs idle timeout](/reference/configuration#ttl-vs-idle-timeout-how-they-interact).
:::

## Jupyter notebooks

Install with notebook extras and import:

```python
import spore

# Display instance as a rich HTML card
inst = spore.spawn.status("sim-run-42")
display(inst)  # or just `inst` as the last cell expression

# Truffle results as a pandas DataFrame
import pandas as pd
results = spore.truffle.find("nvidia h100", region="us-east-1")
df = pd.DataFrame([{
    "Instance": r.instance_type,
    "vCPUs": r.vcpus,
    "Memory (GiB)": r.memory_gib,
    "$/hr": r.on_demand_price,
    "GPUs": r.gpus,
} for r in results])
df
```

Poll with a progress bar:
```python
from tqdm.notebook import tqdm

inst = spore.spawn.status("my-job")
with tqdm(desc="Waiting for job to finish") as pbar:
    inst.wait("terminated", on_status=lambda i: pbar.set_postfix(state=i.state))

print("Done!")
```

A [full Jupyter example notebook](https://github.com/spore-host/spore-host/blob/main/sdk/python/examples/jupyter_example.ipynb) is in the repository.

## marimo notebooks

marimo's reactive model works well with spore.host — UI elements re-trigger searches automatically:

```python
import marimo as mo
import spore

# Search input updates results reactively
query = mo.ui.text(label="Search query", value="amd epyc genoa")
region = mo.ui.dropdown(["us-east-1", "us-west-2"], value="us-east-1")

# This cell re-runs whenever query or region changes
results = spore.truffle.find(query.value, region=region.value)
mo.table([{
    "Instance": r.instance_type,
    "vCPUs": r.vcpus,
    "$/hr": f"${r.on_demand_price:.4f}",
} for r in results])
```

A [full marimo example](https://github.com/spore-host/spore-host/blob/main/sdk/python/examples/marimo_example.py) is in the repository — run it with `marimo edit marimo_example.py`.

## Configuration

The SDK reads the same `~/.spawn/config.yaml` as the CLI, so defaults you've set (region, Slack workspace, etc.) apply automatically.

You can also pass a custom API URL for self-hosted deployments:

```python
client = spore.Client(api_url="https://my-api.internal")
```

## Reference

### `spore.Client`

```python
Client(
    api_key=None,      # SPORE_API_KEY env var or sk_... string
    api_url=None,      # SPORE_API_URL env var or custom URL
    profile=None,      # AWS_PROFILE env var or profile name
    region="us-east-1",
)
```

### `spore.truffle`

| Method | Returns | Description |
|--------|---------|-------------|
| `.find(query, region=None, regions=None)` | `list[InstanceType]` | Natural language search |
| `.spot(instance_type, region=None, regions=None)` | `list[SpotPrice]` | Current Spot prices |
| `.quota(instance_type, region, spot=False)` | `QuotaInfo` | Quota check |

### `spore.spawn`

| Method | Returns | Description |
|--------|---------|-------------|
| `.list(state="running", region=None)` | `list[Instance]` | List instances |
| `.status(id_or_name)` | `Instance` | Single instance status |
| `.stop(id_or_name, hibernate=False)` | `Instance` | Stop instance |
| `.start(id_or_name)` | `Instance` | Start stopped instance |
| `.extend(id_or_name, duration)` | `dict` | Extend TTL |
| `.terminate(id_or_name)` | `dict` | Terminate instance |

### `Instance`

| Method | Description |
|--------|-------------|
| `.stop(hibernate=False)` | Stop this instance |
| `.start()` | Wake this instance |
| `.extend(duration)` | Extend TTL deadline |
| `.terminate()` | Permanently terminate |
| `.refresh()` | Fetch latest state |
| `.wait(state, poll_interval=30, timeout=43200, on_status=None)` | Block until state reached |
| `.wait_running()` | Shortcut: wait for "running" |
| `.wait_done()` | Shortcut: wait for "terminated" |
