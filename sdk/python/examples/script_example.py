"""
spore.host — plain Python script example

Shows how to use spore-host in a data pipeline or batch script
without a notebook environment.

Usage:
    pip install spore-host
    export SPORE_API_KEY=sk_...
    python script_example.py
"""

import spore


def find_best_instance(query: str, region: str = "us-east-1"):
    """Find the best instance type for a workload."""
    print(f"Searching for: {query!r} in {region}")
    results = spore.truffle.find(query, region=region)

    if not results:
        print("No results found.")
        return None

    # Sort by price
    results.sort(key=lambda r: r.on_demand_price)

    print(f"\nFound {len(results)} instance type(s):\n")
    for r in results[:5]:
        gpu_info = f"  {r.gpus}× {r.gpu_model}" if r.gpus else ""
        print(f"  {r.instance_type:<16} {r.vcpus:>3} vCPU  {r.memory_gib:>6.0f} GiB{gpu_info}  ${r.on_demand_price:.4f}/hr")

    return results[0]


def check_running_instances():
    """Print all currently running instances and their costs."""
    instances = spore.spawn.list(state="running")

    if not instances:
        print("No running instances.")
        return

    print(f"\n{len(instances)} running instance(s):\n")
    for inst in instances:
        print(f"  {inst.name:<20} {inst.instance_type:<14} {inst.region}  TTL: {inst.ttl or '—'}")


def extend_if_needed(name: str, min_ttl_hours: float = 1.0):
    """Extend an instance's TTL if less than min_ttl_hours remain."""
    inst = spore.spawn.status(name)
    print(f"{inst.name}: {inst.state}  TTL: {inst.ttl or 'none'}")

    # In a real script you'd parse the TTL and check remaining time
    # For demo: just show how to extend
    if inst.state == "running":
        inst.extend("2h")
        print(f"  → Extended TTL by 2h")


if __name__ == "__main__":
    print("=" * 60)
    print("spore.host Python SDK — script example")
    print("=" * 60)

    # 1. Find instances
    best = find_best_instance("amd epyc genoa", region="us-east-1")

    # 2. Check what's running
    print("\n" + "=" * 60)
    check_running_instances()

    print("\nDone. Use `spawn launch` CLI to launch instances.")
