"""
spore.host — marimo notebook example

Run with:
    pip install marimo spore-host
    marimo edit marimo_example.py
"""

import marimo as mo

app = mo.App(width="medium")


@app.cell
def _():
    import spore
    mo.md(f"**spore-host** {spore.__version__} — ephemeral EC2 compute")


@app.cell
def _(mo):
    mo.md("""
    ## Find instances

    Search for EC2 instance types using natural language.
    """)


@app.cell
def _(mo):
    query = mo.ui.text(
        value="amd epyc genoa",
        label="Search query",
        placeholder="e.g. nvidia h100, arm64 32gb, amd genoa",
    )
    region = mo.ui.dropdown(
        options=["us-east-1", "us-west-2", "eu-west-1", "ap-northeast-1"],
        value="us-east-1",
        label="Region",
    )
    mo.hstack([query, region])


@app.cell
def _(mo, query, region):
    import spore

    results = spore.truffle.find(query.value, region=region.value)

    if not results:
        mo.callout(mo.md("No results. Try a different query."), kind="warn")
    else:
        mo.table([
            {
                "Instance": r.instance_type,
                "vCPUs": r.vcpus,
                "Memory (GiB)": f"{r.memory_gib:.0f}",
                "$/hr": f"${r.on_demand_price:.4f}" if r.on_demand_price else "—",
                "AZs": len(r.available_azs),
            }
            for r in results
        ])


@app.cell
def _(mo):
    mo.md("""
    ## Running instances

    Current spawn-managed instances in your account.
    """)


@app.cell
def _(mo):
    refresh_btn = mo.ui.button(label="Refresh", kind="neutral")
    refresh_btn


@app.cell
def _(mo, refresh_btn):
    import spore
    _ = refresh_btn.value  # re-run when button clicked

    instances = spore.spawn.list(state="all")

    if not instances:
        mo.callout(mo.md("No instances found."), kind="info")
    else:
        rows = []
        for inst in instances:
            rows.append({
                "Name": inst.name,
                "Type": inst.instance_type,
                "State": inst.state,
                "Region": inst.region,
                "IP": inst.public_ip or "—",
                "TTL": inst.ttl or "—",
            })
        mo.table(rows)


@app.cell
def _(mo):
    mo.md("""
    ## Manage an instance

    Enter an instance name or ID to manage it.
    """)


@app.cell
def _(mo):
    inst_input = mo.ui.text(label="Instance name or ID", placeholder="sim-run-42")
    inst_input


@app.cell
def _(inst_input, mo):
    import spore

    if not inst_input.value:
        mo.stop(True, mo.md("Enter an instance name above."))

    try:
        inst = spore.spawn.status(inst_input.value)
        state_color = {
            "running": "green", "stopped": "orange",
            "terminated": "gray", "pending": "blue",
        }.get(inst.state, "gray")

        mo.md(f"""
        **{inst.name}** `{inst.instance_id}`

        | Field | Value |
        |-------|-------|
        | Type | {inst.instance_type} |
        | State | **{inst.state}** |
        | Region | {inst.region} |
        | IP | {inst.public_ip or "—"} |
        | TTL | {inst.ttl or "—"} |
        | Idle timeout | {inst.idle_timeout or "—"} |
        """)
    except Exception as e:
        mo.callout(mo.md(f"Error: {e}"), kind="danger")


if __name__ == "__main__":
    app.run()
