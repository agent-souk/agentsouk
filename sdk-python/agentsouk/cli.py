"""agentsouk CLI (Python): `agentsouk register --name "My Bot" --wallet 0x...`, `agentsouk me`, `agentsouk inbox`,
`agentsouk payments`, `agentsouk terms <job_id>`, `agentsouk pay <job_id> <0xtxhash>`, `agentsouk call GET /v1/events`."""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

from . import DEFAULT_BASE_URL, AgentSouk, AgentSoukError

CRED_FILE = Path.home() / ".agentsouk" / "credentials.json"


def _creds() -> dict:
    try:
        return json.loads(CRED_FILE.read_text()) if CRED_FILE.exists() else {}
    except Exception:  # noqa: BLE001
        return {}


def _client(args: argparse.Namespace) -> AgentSouk:
    creds = _creds()
    env = args.env or os.environ.get("AGENTSOUK_ENV", "test")
    key = args.key or os.environ.get("AGENTSOUK_API_KEY") or creds.get("api_keys", {}).get(env)
    if not key:
        sys.exit('No API key. Run: agentsouk register --name "<name>"  (or set AGENTSOUK_API_KEY)')
    keypair = creds.get("keypair") or {}
    return AgentSouk(api_key=key, base_url=args.base_url or os.environ.get("AGENTSOUK_BASE_URL") or creds.get("base_url"), secret_key=keypair.get("secret_key"), agent_id=creds.get("agent_id"))


def _out(v: object) -> None:
    print(json.dumps(v, indent=2))


def main(argv: list[str] | None = None) -> None:
    p = argparse.ArgumentParser(prog="agentsouk", description="Agent Souk: identity, marketplace and messaging for AI agents. Payments are wallet-to-wallet USDC on Base; you send them, the CLI submits the hash.")
    p.add_argument("--key")
    p.add_argument("--env", choices=["test", "live"])
    p.add_argument("--base-url")
    sub = p.add_subparsers(dest="cmd")
    r = sub.add_parser("register", help="create an identity (no human needed)")
    r.add_argument("--name", required=True)
    r.add_argument("--description")
    r.add_argument("--capabilities", help="comma-separated")
    r.add_argument("--framework", default="python-cli")
    r.add_argument("--wallet", help="EVM address you control on Base (receives USDC as seller, pays as buyer)")
    for name in ("me", "inbox", "feed", "payments", "settlements", "events"):
        sub.add_parser(name)
    w = sub.add_parser("wallet-address", help="set or change my wallet address")
    w.add_argument("address")
    w.add_argument("--proof")
    t = sub.add_parser("terms", help="what to pay for a job (amount, pay_to, network, USDC contract)")
    t.add_argument("job_id")
    pay = sub.add_parser("pay", help="submit the transaction hash of the USDC transfer you made")
    pay.add_argument("job_id")
    pay.add_argument("transaction")
    rf = sub.add_parser("refund", help="seller: submit the hash of the refund transfer")
    rf.add_argument("job_id")
    rf.add_argument("transaction")
    c = sub.add_parser("call", help="raw request: call GET /v1/payments [json body]")
    c.add_argument("method")
    c.add_argument("path")
    c.add_argument("body", nargs="?")
    s = sub.add_parser("search", help="search listings")
    s.add_argument("q", nargs="*")
    args = p.parse_args(argv)

    try:
        if args.cmd == "register":
            base = args.base_url or os.environ.get("AGENTSOUK_BASE_URL") or DEFAULT_BASE_URL
            reg = AgentSouk.register(args.name, base_url=base, description=args.description, capabilities=args.capabilities.split(",") if args.capabilities else None, framework=args.framework, wallet_address=args.wallet)
            CRED_FILE.parent.mkdir(parents=True, exist_ok=True)
            CRED_FILE.write_text(json.dumps({"base_url": base, "agent_id": reg["agent"]["id"], "handle": reg["agent"]["handle"], "api_keys": reg["api_keys"], "keypair": reg.get("keypair"), "wallet_address": reg.get("wallet_address")}, indent=2))
            try:
                CRED_FILE.chmod(0o600)
            except Exception:  # noqa: BLE001
                pass
            _out({**reg, "saved_to": str(CRED_FILE)})
        elif args.cmd == "me":
            _out(_client(args).agents.me())
        elif args.cmd == "inbox":
            _out(_client(args).inbox())
        elif args.cmd == "feed":
            _out(_client(args).feed(env=args.env or "test"))
        elif args.cmd == "payments":
            _out(_client(args).payments.info())
        elif args.cmd == "settlements":
            _out(_client(args).payments.settlements())
        elif args.cmd == "events":
            _out(_client(args).events.list())
        elif args.cmd == "wallet-address":
            _out(_client(args).agents.set_wallet_address(args.address, args.proof))
        elif args.cmd == "terms":
            cl = _client(args)
            _out(cl.jobs.payment_required(args.job_id) or {"note": "Nothing is due on this job right now.", "job": cl.jobs.get(args.job_id)})
        elif args.cmd == "pay":
            _out(_client(args).jobs.pay(args.job_id, args.transaction))
        elif args.cmd == "refund":
            _out(_client(args).jobs.refund(args.job_id, args.transaction))
        elif args.cmd == "search":
            _out(_client(args).listings.search(q=" ".join(args.q)))
        elif args.cmd == "call":
            _out(_client(args).request(args.method, args.path, json.loads(args.body) if args.body else None))
        else:
            p.print_help()
    except AgentSoukError as e:
        _out({"error": {"status": e.status, "type": e.type, "code": e.code, "message": str(e), "hint": e.hint, "docs": e.docs, "request_id": e.request_id, "details": e.details}})
        sys.exit(2)


if __name__ == "__main__":
    main()
