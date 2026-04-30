"""
spore-host — ephemeral EC2 compute for researchers.

Quick start:
    import spore
    results = spore.truffle.find("nvidia h100", region="us-east-1")
    instance = spore.spawn.launch("c8a.2xlarge", ttl="8h")
"""

from .client import Client
from . import truffle, spawn

# Module-level convenience: a default client using ambient AWS credentials
_default: Client | None = None


def _get_default() -> Client:
    global _default
    if _default is None:
        _default = Client()
    return _default


def __getattr__(name: str):
    # Allow `spore.truffle.find(...)` and `spore.spawn.launch(...)` at module level
    default = _get_default()
    if name == "truffle":
        return default.truffle
    if name == "spawn":
        return default.spawn
    raise AttributeError(f"module 'spore' has no attribute {name!r}")


__version__ = "0.1.0"
__all__ = ["Client", "truffle", "spawn"]
