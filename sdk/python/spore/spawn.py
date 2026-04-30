"""spawn — EC2 instance lifecycle: launch, status, stop, extend, terminate."""

from __future__ import annotations

import time
import threading
from dataclasses import dataclass, field
from datetime import datetime
from typing import Callable, List, Optional, TYPE_CHECKING

if TYPE_CHECKING:
    from .client import Client


@dataclass
class Instance:
    """A spawn-managed EC2 instance."""

    instance_id: str
    name: str
    instance_type: str
    state: str
    region: str
    public_ip: str = ""
    dns: str = ""
    launch_time: Optional[datetime] = None
    ttl: str = ""
    idle_timeout: str = ""
    _client: Optional["SpawnClient"] = field(default=None, repr=False)

    # ── Actions ───────────────────────────────────────────────────────────────

    def stop(self, hibernate: bool = False) -> "Instance":
        """Stop the instance (preserves it; use start() to resume)."""
        action = "hibernate" if hibernate else "stop"
        self._client._action(self.instance_id, action, self.region)
        self.state = "stopping"
        return self

    def start(self) -> "Instance":
        """Start a stopped instance."""
        self._client._action(self.instance_id, "start", self.region)
        self.state = "pending"
        return self

    def terminate(self) -> "Instance":
        """Permanently terminate the instance."""
        self._client._action(self.instance_id, "terminate", self.region)
        self.state = "shutting-down"
        return self

    def extend(self, duration: str) -> "Instance":
        """
        Extend the TTL deadline.

        Args:
            duration: Duration to add, e.g. "2h", "30m", "1d".

        Example:
            >>> instance.extend("4h")
        """
        self._client._action(self.instance_id, "extend", self.region, {"duration": duration})
        self.ttl = duration
        return self

    def refresh(self) -> "Instance":
        """Fetch current state from the API."""
        updated = self._client.status(self.instance_id)
        self.state = updated.state
        self.public_ip = updated.public_ip
        self.ttl = updated.ttl
        return self

    # ── Waiting ───────────────────────────────────────────────────────────────

    def wait(
        self,
        state: str = "terminated",
        poll_interval: int = 30,
        timeout: int = 43200,
        on_status: Optional[Callable[["Instance"], None]] = None,
    ) -> "Instance":
        """
        Block until the instance reaches a target state.

        Args:
            state:         Target state: "running", "stopped", "terminated".
            poll_interval: Seconds between polls (default 30).
            timeout:       Max seconds to wait (default 12h).
            on_status:     Optional callback called on each poll with the Instance.

        Example:
            >>> instance.wait("terminated", on_status=lambda i: print(i.state))
        """
        deadline = time.time() + timeout
        while time.time() < deadline:
            self.refresh()
            if on_status:
                on_status(self)
            if self.state == state:
                return self
            if self.state in ("terminated", "shutting-down") and state != "terminated":
                raise RuntimeError(f"Instance terminated before reaching {state!r}")
            time.sleep(poll_interval)
        raise TimeoutError(f"Instance did not reach {state!r} within {timeout}s")

    def wait_running(self, **kwargs) -> "Instance":
        """Block until running."""
        return self.wait("running", **kwargs)

    def wait_done(self, **kwargs) -> "Instance":
        """Block until terminated (job complete or TTL fired)."""
        return self.wait("terminated", **kwargs)

    # ── Notebook display ──────────────────────────────────────────────────────

    def _repr_html_(self) -> str:
        state_colour = {
            "running": "#059669", "stopped": "#d97706",
            "terminated": "#6b7280", "pending": "#4059E5",
        }.get(self.state, "#6b7280")
        return (
            f'<div style="font-family:monospace;font-size:0.9rem;padding:8px;'
            f'border:1px solid #e5e7eb;border-radius:6px;background:#f8f9fa">'
            f'<b>{self.name}</b> <code style="font-size:0.8em">{self.instance_id}</code><br>'
            f'Type: {self.instance_type} &nbsp;|&nbsp; '
            f'State: <span style="color:{state_colour};font-weight:600">{self.state}</span><br>'
            f'Region: {self.region} &nbsp;|&nbsp; IP: {self.public_ip or "—"}<br>'
            f'TTL: {self.ttl or "—"} &nbsp;|&nbsp; Idle timeout: {self.idle_timeout or "—"}'
            f'</div>'
        )

    def __repr__(self) -> str:
        return f"<Instance {self.name} ({self.instance_id}) {self.state} {self.region}>"


class SpawnClient:
    def __init__(self, client: "Client"):
        self._c = client

    def launch(
        self,
        instance_type: str,
        *,
        name: Optional[str] = None,
        region: Optional[str] = None,
        ttl: str = "4h",
        idle_timeout: Optional[str] = None,
        spot: bool = False,
        on_complete: str = "terminate",
        slack_workspace: Optional[str] = None,
        active_processes: Optional[List[str]] = None,
        phone: Optional[str] = None,
        wait: bool = False,
    ) -> Instance:
        """
        Launch an EC2 instance.

        Args:
            instance_type:    EC2 instance type, e.g. "c8a.2xlarge".
            name:             Instance name (auto-generated if omitted).
            region:           AWS region (default: client region).
            ttl:              Time-to-live, e.g. "8h", "2d". Hard termination deadline.
            idle_timeout:     Stop if idle for this duration, e.g. "30m".
            spot:             Use Spot pricing.
            on_complete:      Action on SPAWN_COMPLETE: "terminate", "stop", "hibernate".
            slack_workspace:  Slack workspace ID for lifecycle notifications.
            active_processes: Process names that indicate active work (e.g. ["rsession"]).
            phone:            Phone number for SMS notifications (+1XXXXXXXXXX).
            wait:             If True, block until instance is running.

        Returns:
            Instance object.

        Example:
            >>> inst = spore.spawn.launch(
            ...     "c8a.2xlarge",
            ...     name="my-analysis",
            ...     ttl="12h",
            ...     idle_timeout="30m",
            ... )
        """
        raise NotImplementedError(
            "spawn.launch() requires the spore.host CLI or spored on an EC2 instance. "
            "Use the CLI: spawn launch --instance-type c8a.2xlarge --ttl 12h\n"
            "This SDK method will be implemented when the REST API launch endpoint is complete."
        )

    def list(
        self,
        state: str = "running",
        region: Optional[str] = None,
    ) -> List[Instance]:
        """
        List spawn-managed instances.

        Args:
            state:  Filter by state: "running", "stopped", "all".
            region: AWS region (all regions if omitted).

        Example:
            >>> running = spore.spawn.list()
            >>> for inst in running:
            ...     print(inst.name, inst.state)
        """
        params: dict = {"state": state}
        if region:
            params["region"] = region
        data = self._c.get("/v1/instances", params=params)
        return [self._parse(i) for i in data.get("instances", [])]

    def status(self, instance_id_or_name: str) -> Instance:
        """
        Get detailed status for a single instance.

        Example:
            >>> inst = spore.spawn.status("sim-run-42")
            >>> print(inst.state, inst.ttl)
        """
        data = self._c.get(f"/v1/instances/{instance_id_or_name}")
        return self._parse(data)

    def stop(self, instance_id_or_name: str, hibernate: bool = False) -> Instance:
        """Stop a running instance."""
        action = "hibernate" if hibernate else "stop"
        data = self._action(instance_id_or_name, action)
        return self.status(instance_id_or_name)

    def start(self, instance_id_or_name: str) -> Instance:
        """Start a stopped instance."""
        self._action(instance_id_or_name, "start")
        return self.status(instance_id_or_name)

    def terminate(self, instance_id_or_name: str) -> dict:
        """Permanently terminate an instance."""
        return self._action(instance_id_or_name, "terminate")

    def extend(self, instance_id_or_name: str, duration: str) -> dict:
        """
        Extend an instance's TTL deadline.

        Example:
            >>> spore.spawn.extend("sim-run-42", "4h")
        """
        return self._action(instance_id_or_name, "extend", body={"duration": duration})

    # ── Internal ──────────────────────────────────────────────────────────────

    def _action(
        self,
        instance_id_or_name: str,
        action: str,
        region: Optional[str] = None,
        body: Optional[dict] = None,
    ) -> dict:
        path = f"/v1/instances/{instance_id_or_name}/{action}"
        return self._c.post(path, body or {})

    def _parse(self, d: dict) -> Instance:
        launch_time = None
        if d.get("launch_time"):
            try:
                launch_time = datetime.fromisoformat(d["launch_time"].replace("Z", "+00:00"))
            except Exception:
                pass
        inst = Instance(
            instance_id=d.get("instance_id", ""),
            name=d.get("name", ""),
            instance_type=d.get("instance_type", ""),
            state=d.get("state", ""),
            region=d.get("region", ""),
            public_ip=d.get("public_ip", ""),
            dns=d.get("dns", ""),
            launch_time=launch_time,
            ttl=d.get("ttl", ""),
            idle_timeout=d.get("idle_timeout", ""),
        )
        inst._client = self
        return inst
