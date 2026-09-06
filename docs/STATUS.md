# STATUS (bei Unterbrechung hier weiterlesen)

## Name: Agent Souk · Pakete `agentsouk` (npm, PyPI) · API `https://api.agentsouk.dev` · Keys `as_live_` / `as_test_` (ADR-19)

## Phase
6 → Review-Fixes + Naming fertig (2026-09-06). Als Nächstes: Deploy + Publikation (braucht Nick: Domains, Accounts).

## Erledigt (Auszug)
- Plattform: Identity (Ed25519/did:key, API-Keys, RFC-9421-Signaturen, Recovery, Rotation nur signiert, OAuth `client_credentials`+`private_key_jwt` Token-Endpunkt, JWKS/CIMD/DID pro Agent)
- Geld: Double-Entry-Ledger mit Prozess-Mutex, Wallet, Sandbox-Rail, x402-Deposit-Rail (config-gated), Operator-Auszahlungen
- Markt: Listings, Escrow-Jobs mit bedingten Übergängen, Quotes, Revisions, Disputes/Arbiter, Bounties, Reputation (Bayes, T1-Beförderung)
- Kommunikation: Threads/Inbox, Events (Poll/SSE/Webhooks HMAC+Retry), Feed, Memory, Schedules
- Interop: /skill.md, /llms.txt, /llms-full.txt, OpenAPI, MCP (/mcp, 35 Tools), A2A (/a2a Concierge, Cards pro Agent, Messaging-Bridge), Well-Knowns, server.json (MCP-Registry)
- SDKs: npm `agentsouk` (Client+CLI, Signing via WebCrypto), PyPI `agentsouk` (Client+CLI, Signing via cryptography-Extra)
- Sicherheit: Review docs/REVIEW-2026-09-06.md, alle Findings gefixt, Regressionstests; Body-Limit 1 MB; Content-Scan; Rate-Limits (TRUST_PROXY)
- 115+ Tests grün; Strategic Brief research/00-STRATEGIC-BRIEF.md (12 Abschnitte)

## Offene Entscheidungen / Aufgaben für Nick (nicht automatisierbar)
1. Domains registrieren: agentsouk.dev (API/Docs), agentsouk.ai, agentsouk.io (+ Variante agentsouq); .com ist geparkt
2. Accounts: npm (Publish `packages/sdk`), PyPI (Publish `sdk-python`), Fly.io oder Hetzner (docs/DEPLOY.md), GitHub-Org `agentsouk`
3. Custody-Stellungnahme (ADR-10, Brief §4/§12): Live-Credits nicht übertragbar halten oder lizenzierter Partner; Rechtsberatung DE (PSD2/ZAG, MiCA)
4. x402: EVM-Adresse (X402_PAY_TO) für USDC-Eingänge; Base zuerst
5. Fee-Modell bestätigen (3 % auf Escrow-Jobs)

## Nächste Schritte (Claude, sobald Accounts da sind)
1. Deploy (fly.toml vorhanden), PUBLIC_BASE_URL setzen, Smoke über echte URL
2. Publish npm + PyPI, MCP-Registry (packages/api/server.json), ClawHub-Skill (packages/sdk/SKILL.md), GitHub-Repo mit README/AGENTS.md
3. Discovery-Playbook aus Brief §6 abarbeiten (Registries, Search-Crawler, x402 Bazaar sobald Live-Rail)
4. Danach: Stripe-Rail, Evaluator/Dispute-Panel, semantische Suche, Signature-Agent-Header, T2/T3-Attestierungen

## Befehle
- `npm install` (Root) · `npm run dev` · `npm test` · `npm run typecheck`
- Migration: `cd packages/api && npx drizzle-kit generate --name <name>`
- Windows: `netstat` ist deutsch ("ABHÖREN"); Serverprozesse per `wmic process where "CommandLine like '%src/index.ts%'"` finden und `taskkill //F //PID` beenden
- Session-Limit: große parallele Subagent-Workflows scheitern; selbst bauen, Subagents einzeln, früh auf Disk schreiben
