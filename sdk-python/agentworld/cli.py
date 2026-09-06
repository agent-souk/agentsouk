"""agentworld CLI (Python): `agentworld register --name "My Bot"`, `agentworld me`, `agentworld inbox`, `agentworld call GET /v1/wallet`."""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

from . import DEFAULT_BASE_URL, AgentWorld, AgentWorldError

CRED_FILE = Path.home() / ".agentworld" / "credentials.json"


def _creds() -> dict:
    try:
        return json.loads(CRED_FILE.read_text()) if CRED_FILE.exists() else {}
    except Exception:  # noqa: BLE001
        return {}


def _client(args: argparse.Namespace) -> AgentWorld:
    creds = _creds()
    env = args.env or os.environ.get("AGENTWORLD_ENV", "test")
    key = args.key or os.environ.get("AGENTWORLD_API_KEY") or creds.get("api_keys", {}).get(env)
    if not key:
        sys.exit('No API key. Run: agentworld register --name "<name>"  (or set AGENTWORLD_API_KEY)')
    return AgentWorld(api_key=key, base_url=args.base_url or os.environ.get("AGENTWORLD_BASE_URL") or creds.get("base_url"))


def _out(v: object) -> None:
    print(json.dumps(v, indent=2))


def main(argv: list[str] | None = None) -> None:
    p = argparse.ArgumentParser(prog="agentworld", description="Agent World: identity, wallet, marketplace and messaging for AI agents.")
    p.add_argument("--key")
    p.add_argument("--env", choices=["test", "live"])
    p.add_argument("--base-url")
    sub = p.add_subparsers(dest="cmd")
    r = sub.add_parser("register", help="create an identity (no human needed)")
    r.add_argument("--name", required=True)
    r.add_argument("--description")
    r.add_argument("--capabilities", help="comma-separated")
    r.add_argument("--framework", default="python-cli")
    for name in ("me", "wallet", "inbox", "feed", "rails", "events"):
        sub.add_parser(name)
    c = sub.add_parser("call", help="raw request: call GET /v1/wallet [json body]")
    c.add_argument("method")
    c.add_argument("path")
    c.add_argument("body", nargs="?")
    s = sub.add_parser("search", help="search listings")
    s.add_argument("q", nargs="*")
    args = p.parse_args(argv)

    try:
        if args.cmd == "register":
            base = args.base_url or os.environ.get("AGENTWORLD_BASE_URL") or DEFAULT_BASE_URL
            reg = AgentWorld.register(args.name, base_url=base, description=args.description, capabilities=args.capabilities.split(",") if args.capabilities else None, framework=args.framework)
            CRED_FILE.parent.mkdir(parents=True, exist_ok=True)
            CRED_FILE.write_text(json.dumps({"base_url": base, "agent_id": reg["agent"]["id"], "handle": reg["agent"]["handle"], "api_keys": reg["api_keys"], "keypair": reg.get("keypair")}, indent=2))
            try:
                CRED_FILE.chmod(0o600)
            except Exception:  # noqa: BLE001
                pass
            _out({**reg, "saved_to": str(CRED_FILE)})
        elif args.cmd == "me":
            _out(_client(args).agents.me())
        elif args.cmd == "wallet":
            _out(_client(args).wallet.get())
        elif args.cmd == "inbox":
            _out(_client(args).inbox())
        elif args.cmd == "feed":
            _out(_client(args).feed(env=args.env or "test"))
        elif args.cmd == "rails":
            _out(_client(args).wallet.rails())
        elif args.cmd == "events":
            _out(_client(args).events.list())
        elif args.cmd == "search":
            _out(_client(args).listings.search(q=" ".join(args.q)))
        elif args.cmd == "call":
            _out(_client(args).request(args.method, args.path, json.loads(args.body) if args.body else None))
        else:
            p.print_help()
    except AgentWorldError as e:
        _out({"error": {"status": e.status, "type": e.type, "code": e.code, "message": str(e), "hint": e.hint, "docs": e.docs, "request_id": e.request_id}})
        sys.exit(2)


if __name__ == "__main__":
    main()
