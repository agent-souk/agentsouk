# STATUS (bei Unterbrechung hier weiterlesen)

## Phase
3 → Marktplatz-Kern fertig (2026-09-06). Nächste Phase: Interop-Oberflächen (MCP, SDKs), Auth-Härtung, Review, Deploy.

## Erledigt
- Git-Repo, ADR-1..15 (docs/DECISIONS.md), Produkt-Hypothese, Spec (docs/SPEC-MARKETPLACE.md)
- Recherche Runde 1+2 in research/*.md (fehlt: agent-dx-patterns, 00-STRATEGIC-BRIEF)
- packages/api (TypeScript, Hono, Zod-OpenAPI, Drizzle+libsql, vitest), Migrationen 0000..0003
- Foundation: config, log, ids, errors (mit `hint`), crypto (Ed25519, did:key), server-keys (JWKS, signierte Receipts)
- Ledger (double-entry, Escrow), Identity (agents, api keys, auth, idempotency, rate limits)
- Wallet (balances, transfers, rails catalog, sandbox deposits/withdrawals)
- Listings (Suche, Sortierung, Graduation-Stats), Jobs (Escrow-State-Machine, Quotes, Revisions, Disputes, Arbiter, Sweeps)
- Messaging (Threads, Inbox), Reviews/Reputation (Bayes, Score, Trust-Tier T1), Events (Poll, SSE, Webhooks mit HMAC + Retry, Feed), Bounties
- Discovery: /skill.md, /llms.txt, /llms-full.txt, /docs/quickstart, /docs/errors, A2A-Card, JWKS, CIMD, DID-Doc, OAuth-Well-Knowns
- ~75 Tests grün, Integrationstest src/integration.test.ts

## Nächste Schritte (Reihenfolge)
1. MCP-Server (/mcp, Streamable HTTP) als dünne Hülle über die REST-API
2. SDKs: npm `agentworld` (+ CLI) und pip `agentworld`; AGENTS.md; Skill-Paket für ClawHub
3. Auth-Härtung: RFC 9421 signierte Requests, Recovery via Signatur, Session-Tokens
4. Adversarial Review (1 Agent) + Fixes; Security-Review
5. Strategic Brief + Naming (research/00-STRATEGIC-BRIEF.md), Domain
6. Deploy: Dockerfile, Fly.io/Hetzner, PUBLIC_BASE_URL, Backups; dann Registries (MCP, ClawHub, npm, PyPI, x402 Bazaar)
7. Live-Rails: x402 (USDC Base) Deposit/Withdraw, Stripe

## Befehle
- `npm install` (Root) · `npm run dev` · `npm test` · `npm run typecheck`
- Migration erzeugen: `cd packages/api && npx drizzle-kit generate --name <name>`
- Session-Limit-Hinweis: große parallele Subagent-Workflows sind 2x am Limit gescheitert; Module lieber selbst bauen, Subagents nur für Review/Recherche einzeln.
