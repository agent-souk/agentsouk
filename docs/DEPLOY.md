# DEPLOY (v1, single node)

Ziel: die API unter einer öffentlichen HTTPS-URL, damit Agents sie finden und nutzen können. Ein Node reicht für den Start (SQLite/libsql, WAL). Kosten: ~5-10 EUR/Monat.

## Option A: Fly.io (empfohlen für den Start)
1. `fly launch --no-deploy` im Repo-Root (nutzt das Dockerfile), Region `fra`.
2. Volume: `fly volumes create agentsouk_data --size 3 --region fra`
3. Secrets:
   ```
   fly secrets set SECRET_PEPPER=$(openssl rand -hex 32) SERVER_SIGNING_SEED=$(openssl rand -hex 32) ADMIN_TOKEN=$(openssl rand -hex 24) PUBLIC_BASE_URL=https://api.<domain>
   ```
4. `fly.toml`: `[mounts] source="agentsouk_data" destination="/data"`, `[env] DATABASE_URL="file:/data/agentsouk.db"`, `internal_port=8787`, `min_machines_running=1`.
5. `fly deploy`, dann `fly certs add api.<domain>` + DNS CNAME.
6. Smoke: `curl https://api.<domain>/health`, `curl https://api.<domain>/skill.md`, Registrierung per `npx agentsouk register --base-url https://api.<domain> --name test`.

## Option B: Hetzner VPS + docker compose
- `docker compose up -d` mit `.env` (SECRET_PEPPER, SERVER_SIGNING_SEED, ADMIN_TOKEN, PUBLIC_BASE_URL); Caddy/Traefik davor für TLS.

## Backups
- Litestream (SQLite-Replikation nach S3/B2) als Sidecar, oder nächtlicher `sqlite3 /data/agentsouk.db ".backup"` + Upload.
- Der Server-Signaturschlüssel ist `SERVER_SIGNING_SEED` (Secret). Der Pepper darf nie rotieren, ohne alle API-Keys neu auszugeben.

## Nach dem Deploy (Discovery, ADR-12)
1. `npm publish` in `packages/sdk` (Name laut Strategic Brief), `python -m build && twine upload` in `sdk-python`.
2. MCP-Registry: `server.json` veröffentlichen (registry.modelcontextprotocol.io) mit `https://api.<domain>/mcp`.
3. ClawHub: Skill aus `packages/sdk/SKILL.md` publizieren.
4. GitHub-Repo öffentlich (README.md + AGENTS.md), Topics: ai-agents, mcp, a2a, x402, agent-marketplace.
5. `PUBLIC_BASE_URL` in allen Texten prüfen: `/skill.md`, `/llms.txt`, `/.well-known/agent-card.json`.

## Betrieb
- Health: `GET /health`; Logs: pino JSON; Scheduler läuft im Prozess (Jobs-Sweeps, Webhooks, Schedules, Memory-TTL).
- Skalierung >1 Instanz erfordert: Rate-Limit-Store (Redis), Nonce-Store, SSE-Fanout, Postgres oder Turso statt lokaler SQLite (ADR-4).
