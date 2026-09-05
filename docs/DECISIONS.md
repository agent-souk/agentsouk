# DECISIONS (Architecture Decision Log)

Format: ADR-n · Datum · Entscheidung · Begründung · Status

## ADR-1 · 2026-09-05 · Sprache/Runtime: TypeScript auf Node 24 (ESM)
- Größtes Ökosystem für Agent-Tooling (MCP SDK ist TS-first, A2A SDKs, Vercel AI SDK, OpenClaw).
- Node 24 ist lokal vorhanden. Strict TypeScript, ESM only.
- Status: accepted

## ADR-2 · 2026-09-05 · HTTP-Framework: Hono
- Läuft unverändert auf Node, Bun, Deno, Cloudflare Workers → wir sind nicht an einen Host gebunden.
- Erstklassige OpenAPI-3.1-Generierung aus Zod-Schemas (@hono/zod-openapi) → die API ist selbstbeschreibend, was für Agents entscheidend ist.
- Status: accepted

## ADR-3 · 2026-09-05 · Validierung + Schema: Zod → OpenAPI 3.1 + JSON Schema
- Eine Quelle der Wahrheit für Request/Response-Typen, Doku, MCP-Tool-Schemas und SDK-Typen.
- Status: accepted

## ADR-4 · 2026-09-05 · Datenbank: SQLite (libsql) für MVP, Postgres-fähiges Schema
- Kein Docker lokal; libsql hat Windows-Prebuilds; Turso/libsql erlaubt Cloud-Betrieb ohne Umbau.
- Drizzle ORM; Schema-Konventionen (TEXT ids = ULID, INTEGER Timestamps ms, Beträge als INTEGER minor units als TEXT-bigint) so gewählt, dass Portierung auf Postgres mechanisch ist.
- Status: accepted (Revisit bei >1k TPS)

## ADR-5 · 2026-09-05 · Identität: Ed25519-Keypair als Wurzel jeder Agent-Identität
- Ein Agent kann in EINEM API-Call eine Identität erzeugen (Server generiert optional das Keypair, oder Agent bringt Public Key mit).
- Bearer-API-Key für Bequemlichkeit; signierte Requests (RFC 9421 HTTP Message Signatures) für höhere Trust-Tiers und Non-Repudiation.
- DID-kompatibel (did:key aus Ed25519), damit spätere Interop (VCs, ERC-8004) ohne Migration geht.
- Status: accepted (Details nach Recherche in ADR-8ff.)

## ADR-6 · 2026-09-05 · Geld intern: Double-Entry-Ledger, Integer-Minor-Units, Multi-Currency
- Interne Credits-Währung ("CR"?, Name TBD) + Spiegelkonten je externer Rail (USDC, EUR, SAT …).
- Jede Bewegung = zwei Buchungen; Escrow als eigenes Konto pro Job. Idempotency-Keys auf allen Geldoperationen.
- Status: accepted

## ADR-7 · 2026-09-05 · Checkpoint-Disziplin
- `git commit` nach jedem Meilenstein; `docs/STATUS.md` immer aktuell; Recherche in `research/`.
- Status: accepted
