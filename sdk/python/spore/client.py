"""Top-level Client — holds credentials and spawns sub-clients."""

from __future__ import annotations

import os
from typing import Optional

import boto3
import requests


class Client:
    """
    spore.host client. Uses standard AWS credential chain by default.

    Args:
        api_key:    spore.host API key (sk_...). If omitted, reads SPORE_API_KEY
                    env var, then falls back to calling the REST API with
                    SigV4-signed requests using ambient AWS credentials.
        api_url:    Override the REST API base URL (useful for self-hosted).
        profile:    AWS profile name (e.g. "my-research-account").
        region:     Default AWS region.
    """

    DEFAULT_API_URL = "https://v7ochiyks4uknie3u4s7tiix7a0ejduj.lambda-url.us-east-1.on.aws"

    def __init__(
        self,
        api_key: Optional[str] = None,
        api_url: Optional[str] = None,
        profile: Optional[str] = None,
        region: Optional[str] = None,
    ):
        self._api_key = api_key or os.environ.get("SPORE_API_KEY")
        self._api_url = (api_url or os.environ.get("SPORE_API_URL") or self.DEFAULT_API_URL).rstrip("/")
        self._profile = profile or os.environ.get("AWS_PROFILE")
        self._region = region or os.environ.get("AWS_DEFAULT_REGION", "us-east-1")

        # Lazy boto3 session — created on first use
        self._session: Optional[boto3.Session] = None

        # Sub-clients
        from .truffle import TruffleClient
        from .spawn import SpawnClient
        self.truffle = TruffleClient(self)
        self.spawn = SpawnClient(self)

    # ── HTTP helpers ──────────────────────────────────────────────────────────

    def _headers(self) -> dict:
        h = {"Content-Type": "application/json"}
        if self._api_key:
            h["X-API-Key"] = self._api_key
        return h

    def get(self, path: str, params: dict = None) -> dict:
        resp = requests.get(
            f"{self._api_url}{path}",
            headers=self._headers(),
            params=params or {},
            timeout=30,
        )
        resp.raise_for_status()
        return resp.json()

    def post(self, path: str, body: dict = None) -> dict:
        resp = requests.post(
            f"{self._api_url}{path}",
            headers=self._headers(),
            json=body or {},
            timeout=30,
        )
        resp.raise_for_status()
        return resp.json()

    # ── AWS session (for direct SDK calls when needed) ────────────────────────

    @property
    def boto_session(self) -> boto3.Session:
        if self._session is None:
            kwargs = {"region_name": self._region}
            if self._profile:
                kwargs["profile_name"] = self._profile
            self._session = boto3.Session(**kwargs)
        return self._session

    def __repr__(self) -> str:
        key_hint = f"api_key={self._api_key[:8]}..." if self._api_key else "no api_key"
        return f"<spore.Client {key_hint} region={self._region}>"
