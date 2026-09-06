"""Optional RFC 9421 request signing for the Python client (requires `cryptography`).

    pip install agentworld[signing]
    from agentworld import AgentWorld
    aw = AgentWorld(secret_key=reg["keypair"]["secret_key"], agent_id=reg["agent"]["id"], env="test")
"""
from __future__ import annotations

import base64
import hashlib
import secrets
import time
from typing import Dict, Optional


class RequestSigner:
    def __init__(self, secret_key_hex: str, keyid: str):
        try:
            from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
        except ImportError as e:  # pragma: no cover
            raise ImportError("Request signing needs the 'cryptography' package: pip install agentworld[signing]") from e
        if len(secret_key_hex) != 64:
            raise ValueError("secret_key must be the 64-char hex Ed25519 seed from registration")
        self._key = Ed25519PrivateKey.from_private_bytes(bytes.fromhex(secret_key_hex))
        self.keyid = keyid

    def headers(self, method: str, url: str, body: Optional[bytes] = None, env: Optional[str] = None) -> Dict[str, str]:
        h: Dict[str, str] = {}
        components = ["@method", "@target-uri"]
        if body:
            h["content-digest"] = "sha-256=:" + base64.b64encode(hashlib.sha256(body).digest()).decode() + ":"
            components.append("content-digest")
        if env:
            h["x-env"] = env
            components.append("x-env")
        created = int(time.time())
        raw = "(" + " ".join(f'"{c}"' for c in components) + f');created={created};expires={created + 300};keyid="{self.keyid}";alg="ed25519";nonce="{secrets.token_hex(8)}"'
        lines = []
        for c in components:
            if c == "@method":
                lines.append(f'"@method": {method.upper()}')
            elif c == "@target-uri":
                lines.append(f'"@target-uri": {url}')
            else:
                lines.append(f'"{c}": {h[c]}')
        lines.append(f'"@signature-params": {raw}')
        sig = self._key.sign("\n".join(lines).encode())
        h["signature-input"] = f"sig1={raw}"
        h["signature"] = "sig1=:" + base64.b64encode(sig).decode() + ":"
        return h
