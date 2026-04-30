"""truffle — EC2 instance discovery: search, spot prices, quota checks."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import List, Optional, TYPE_CHECKING

if TYPE_CHECKING:
    from .client import Client


@dataclass
class InstanceType:
    instance_type: str
    region: str
    vcpus: int
    memory_gib: float
    architecture: str
    on_demand_price: float = 0.0
    gpus: int = 0
    gpu_model: str = ""
    gpu_memory_gib: float = 0.0
    available_azs: List[str] = field(default_factory=list)

    @property
    def memory_gb(self) -> float:
        return self.memory_gib

    def __repr__(self) -> str:
        gpu = f"  {self.gpus}×{self.gpu_model}" if self.gpus else ""
        price = f"  ${self.on_demand_price:.4f}/hr" if self.on_demand_price else ""
        return f"<InstanceType {self.instance_type} {self.vcpus}vCPU {self.memory_gib:.0f}GiB{gpu}{price}>"


@dataclass
class SpotPrice:
    instance_type: str
    region: str
    availability_zone: str
    spot_price: float
    on_demand_price: float
    savings_pct: float


@dataclass
class QuotaInfo:
    instance_type: str
    region: str
    vcpus: int
    can_launch: bool
    message: str
    spot: bool = False


class TruffleClient:
    def __init__(self, client: "Client"):
        self._c = client

    def find(
        self,
        query: str,
        region: Optional[str] = None,
        regions: Optional[List[str]] = None,
    ) -> List[InstanceType]:
        """
        Find EC2 instance types matching a natural language query.

        Args:
            query:   Natural language description, e.g. "nvidia h100 8gpu",
                     "amd epyc genoa", "arm64 64gb memory".
            region:  Single region to search (e.g. "us-east-1").
            regions: Multiple regions (overrides region).

        Returns:
            List of InstanceType objects sorted by price.

        Example:
            >>> results = spore.truffle.find("amd epyc genoa", region="us-east-1")
            >>> for r in results:
            ...     print(r.instance_type, f"${r.on_demand_price:.4f}/hr")
        """
        params: dict = {"q": query}
        if regions:
            params["region"] = ",".join(regions)
        elif region:
            params["region"] = region

        data = self._c.get("/v1/search", params=params)
        return [self._parse(r) for r in data.get("results", [])]

    def spot(
        self,
        instance_type: str,
        region: Optional[str] = None,
        regions: Optional[List[str]] = None,
    ) -> List[SpotPrice]:
        """
        Get current Spot prices for an instance type across regions/AZs.

        Example:
            >>> prices = spore.truffle.spot("c8a.2xlarge", region="us-east-1")
            >>> cheapest = min(prices, key=lambda p: p.spot_price)
        """
        params: dict = {"type": instance_type}
        if regions:
            params["region"] = ",".join(regions)
        elif region:
            params["region"] = region

        data = self._c.get("/v1/spot", params=params)
        return [
            SpotPrice(
                instance_type=p["instance_type"],
                region=p["region"],
                availability_zone=p["availability_zone"],
                spot_price=float(p["spot_price"]),
                on_demand_price=float(p.get("on_demand_price", 0)),
                savings_pct=float(p.get("savings_percent", 0)),
            )
            for p in data.get("prices", [])
        ]

    def quota(
        self,
        instance_type: str,
        region: str,
        spot: bool = False,
    ) -> QuotaInfo:
        """
        Check whether your AWS account has enough quota to launch an instance type.

        Example:
            >>> q = spore.truffle.quota("p4d.24xlarge", region="us-east-1")
            >>> if not q.can_launch:
            ...     print(q.message)
        """
        params = {"type": instance_type, "region": region, "spot": str(spot).lower()}
        data = self._c.get("/v1/quota", params=params)
        return QuotaInfo(
            instance_type=instance_type,
            region=region,
            vcpus=int(data.get("vcpus", 0)),
            can_launch=bool(data.get("can_launch", False)),
            message=data.get("message", ""),
            spot=spot,
        )

    def _parse(self, r: dict) -> InstanceType:
        return InstanceType(
            instance_type=r.get("instance_type", ""),
            region=r.get("region", ""),
            vcpus=int(r.get("v_cp_us", r.get("vcpus", 0))),
            memory_gib=float(r.get("memory_mi_b", r.get("memory_gib", 0))) / 1024
                if r.get("memory_mi_b") else float(r.get("memory_gib", 0)),
            architecture=r.get("architecture", ""),
            on_demand_price=float(r.get("on_demand_price", 0)),
            gpus=int(r.get("gp_us", r.get("gpus", 0))),
            gpu_model=r.get("gpu_model", ""),
            gpu_memory_gib=float(r.get("gpu_memory_mi_b", 0)) / 1024,
            available_azs=r.get("available_a_zs", r.get("available_azs", [])),
        )

    # ── Notebook display ──────────────────────────────────────────────────────

    def _repr_html_(self) -> str:
        return "<em>spore.truffle — use .find(), .spot(), .quota()</em>"
