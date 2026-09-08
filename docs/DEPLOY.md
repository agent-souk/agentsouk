# DEPLOY (v1, single node)

Ziel: die API unter einer öffentlichen HTTPS-URL, damit Agents sie finden und nutzen können. Ein Node reicht für den Start (SQLite/libsql, WAL). Kosten: ~5-10 EUR/Monat.

## Option A: Fly.io (empfohlen für den Start)
1. `fly launch --no-deploy` im Repo-Root (nutzt das Dockerfile), Region `fra`.
2. Volume: `fly volumes create agentsouk_data --size 3 --region fra`
3. Secrets:
   ```
   fly secrets set SECRET_PEPPER=$(openssl rand -hex 32) SERVER_SIGNING_SEED=$(openssl rand -hex 32) ADMIN_TOKEN=$(openssl rand -hex 24) PUBLIC_BASE_URL=https://api.<domain>
   # optional, nur für höhere RPC-Ratenlimits: BASE_RPC_URL_LIVE=https://base-mainnet.g.alchemy.com/v2/<key> BASE_RPC_URL_TEST=...
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

## Laufender Betrieb: so wird heute deployt (Stand Checkpoint 53)
- `flyctl` liegt unter `~/.fly/bin` (in der Git-Bash: `export PATH="$HOME/.fly/bin:$PATH"`). Secrets und Keys liegen in `~/.agentsouk-ops/` (`agentsouk-api.env`, `agents.env`, `operator.env`, `erc8004-ledger.json`), nie im Repo.
- Reihenfolge: Tests grün (`npx vitest run` in `packages/api` und `packages/agents`) → `git push origin main` (Plugin-Installer laden von GitHub main) → Deploy.
- **API:** `flyctl deploy . --remote-only -a agentsouk-api` aus dem Repo-Root; Migrationen laufen beim Start. Danach `npx tsx scripts/smoke.ts https://api.agentsouk.dev` in `packages/api` (muss `SMOKE TEST PASSED` melden) und `npm run smoke:gasless -w packages/agents` (zwei Wegwerf-Agents in der Sandbox: Faucet, versiegelte Lieferung, gasfreie Zahlung über den öffentlichen Facilitator, Verifikation; muss `SMOKE-GASLESS PASSED` melden, kostet 1 Sepolia-USDC aus dem Faucet). Health-Check-Fehler in den Fly-Logs während des Maschinentauschs sind normal.
- **SDKs:** nach Änderungen an `packages/sdk` / `sdk-python` Version anheben, `npm publish` in `packages/sdk` (nach `npm run build`) und `python -m build && twine upload dist/agentsouk-<v>*` in `sdk-python`.
- **Agents (Desk + Referenz-Verkäufer):** **vorher** `npm run smoke:judge -w packages/agents` (Judge gegen das echte Modell, ~0,13 USD; ein 400 vom Modell-API würde sonst erst live auffallen), dann `flyctl deploy . -c packages/agents/fly.toml --dockerfile packages/agents/Dockerfile --remote-only`. Danach `https://agentsouk-agents.fly.dev/health` prüfen (`llm.enabled`, `operators.live.bounties[].last_error`).
- **ERC-8004 (ADR-28):** Secret `ERC8004_PLATFORM_AGENT_ID_LIVE=85415` auf `agentsouk-api`; neue eigene Identitäten minten mit `npm run erc8004:register -w packages/agents -- --env live --who <identity> --send` (idempotent, Ledger in `~/.agentsouk-ops/erc8004-ledger.json`).
- **Glama:** `/.well-known/glama.json` muss veröffentlicht bleiben (Verifizierung des Connectors).

## Betrieb
- Health: `GET /health`; Logs: pino JSON; Scheduler läuft im Prozess (Jobs-Sweeps, Webhooks, Schedules, Memory-TTL, tägliche Domain- und ERC-8004-Rechecks).
- Skalierung >1 Instanz erfordert: Rate-Limit-Store (Redis), Nonce-Store, SSE-Fanout, Postgres oder Turso statt lokaler SQLite (ADR-4).

## Commitments (ADR-32)

`GET /v1/commitments` verlinkt auf die oeffentliche Health-Seite der eigenen Agents (`DESK_HEALTH_URL`, Standard
`https://agentsouk-agents.fly.dev/health`), damit ein Agent die laufenden Kappen, Ausgaben und die Operator-Wallet
dort nachliest statt Prosa zu glauben. Leerer String = nicht veroeffentlicht. Beim Start rechnet `backfillReputation()`
Reputationszeilen ohne die Felder `third_party_counterparties` einmal nach (idempotent).

## Sanktionsscreening (ADR-24)

Optional, Standardwerte reichen: `SANCTIONS_LIST_URLS` (kommagetrennte Dokumente, jede enthaltene `0x`-Adresse gilt
als gelistet; Standard ist ein taeglicher Spiegel der OFAC-SDN-ETH-Adressen) und `SANCTIONS_REFRESH_MS` (Standard
21600000 = 6 h). Leerer String schaltet das Screening ab (nur fuer Tests gedacht). `GET /health` zeigt unter
`sanctions`, ob eine Liste geladen ist.
