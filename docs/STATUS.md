# STATUS (bei Unterbrechung hier weiterlesen)

## Phase
4 → Plattform-Kern + Interop-Oberflächen fertig (2026-09-06). Nächste Phase: Auth-Härtung, Review, Naming/Brief, Deploy.

## Erledigt
- Git-Repo, ADR-1..15 (docs/DECISIONS.md), Spec (docs/SPEC-MARKETPLACE.md), Recherche Runde 1+2 (research/*.md)
- packages/api: Foundation, Ledger, Identity, Wallet, Listings, Jobs (Escrow-State-Machine), Messaging, Reviews/Reputation, Events (Poll/SSE/Webhooks/Feed), Bounties
- Discovery: /skill.md, /llms.txt, /llms-full.txt, /docs/*, A2A-Card, JWKS, CIMD, DID-Doc, OAuth-Well-Knowns
- MCP-Server /mcp (30 Tools + Resources, stateless Streamable HTTP, Auth via Header oder ?api_key=)
- packages/sdk: npm `agentworld` (Client + CLI, SSE, Retries, AgentWorldError mit hint) · sdk-python: pip `agentworld` (Client + CLI) — beide gegen die App getestet
- Null-tolerante Request-Bodies (Python-Clients senden null), Dockerfile + docker-compose, AGENTS.md
- 82 Tests grün (vitest), Integrationstest, Python-Smoke-Test manuell grün

## Nächste Schritte (Reihenfolge)
1. Auth-Härtung: RFC 9421 signierte Requests (Web-Bot-Auth-kompatibel), Recovery per Signatur (`POST /v1/agents/recover`), Key-Rotation
2. Adversarial Review (1 Agent, Fokus Geld/Access/State) + Fixes
3. Strategic Brief + Naming (1 Agent liest research/, schreibt research/00-STRATEGIC-BRIEF.md); Domain-Check; ggf. Umbenennung "agentworld"
4. Deploy: Fly.io oder Hetzner (Dockerfile vorhanden), PUBLIC_BASE_URL, SECRET_PEPPER, SERVER_SIGNING_SEED, Backups (litestream)
5. Publikation: npm publish, PyPI publish, MCP-Registry (server.json), ClawHub-Skill, GitHub-Repo mit README/AGENTS.md, x402 Bazaar sobald Live-Rail
6. Live-Rails: x402 (USDC Base) Deposit/Withdraw, Stripe; Custody-Rechtsfrage (ADR-10)
7. Extras: Agent-KV-Speicher, Scheduler/Wecker, Referral-Bonus (Ledger-Typ existiert), semantische Suche

## Befehle
- `npm install` (Root) · `npm run dev` · `npm test` · `npm run typecheck`
- Migration: `cd packages/api && npx drizzle-kit generate --name <name>`
- Python-Smoke: Server mit `PORT=8791 DATABASE_URL=file:./data/x.db npx tsx src/index.ts`, dann Script gegen http://localhost:8791
- Windows-Hinweis: `netstat` ist deutsch ("ABHÖREN"); Serverprozesse per `wmic process where "CommandLine like '%src/index.ts%'"` finden und `taskkill //F //PID` beenden
- Session-Limit-Hinweis: große parallele Subagent-Workflows scheitern; Module selbst bauen, Subagents nur einzeln für Review/Recherche
