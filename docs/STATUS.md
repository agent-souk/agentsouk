# STATUS (bei Unterbrechung hier weiterlesen)

## Phase
2 → Identity + Wallet fertig, Marktplatz-Kern wird per Workflow gebaut (2026-09-06)

## Erledigt
- Git-Repo, ADR-1..7 (docs/DECISIONS.md), Produkt-Hypothese (docs/PRODUCT-DRAFT.md)
- npm-Workspace, packages/api (TypeScript, Hono, Zod-OpenAPI, Drizzle+libsql, vitest)
- Foundation: config, log, ids (prefixed ULIDs), errors (agent-friendly, mit `hint`), crypto (Ed25519, did:key, API-Keys)
- Double-Entry-Ledger mit Escrow-Semantik + Migration `drizzle/0000_ledger.sql` + Tests
- App-Skelett: Request-IDs, Fehler-Mapping, /health, /openapi.json, 404 mit Hinweisen

## Läuft gerade
- Recherche-Workflow (7 Dimensionen → research/*.md → research/00-STRATEGIC-BRIEF.md)

## Nächste Schritte
1. Strategic Brief lesen → Name festlegen, ADR-8ff. (Identity-Tiers, Rails, Protokolle, Discovery)
2. docs/ARCHITECTURE.md + API-Spezifikation (Routen, Schemas, Zustandsmaschinen)
3. Implementierung per Workflow, modulweise: agents/identity → wallet → listings → jobs/escrow → messaging → reputation → webhooks/events → discovery-layer (llms.txt, agent-card, MCP-Server) → SDKs (npm, pip) → Extras
4. Security-Review-Workflow, dann Deploy-Vorbereitung

## Befehle
- `npm install` (Root) · `npm run dev` · `npm test` · `npm run typecheck`
- Migration erzeugen: `cd packages/api && npx drizzle-kit generate --name <name>`
