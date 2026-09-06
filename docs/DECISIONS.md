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

---
# Entscheidungen nach Recherche-Runde 1 (2026-09-06)

Quellen: research/*.md (Wettbewerb, Payments, Identity, Interop, Discovery, Security).

## ADR-8 · Identität = Ed25519 + did:key + RFC 9421 HTTP Message Signatures (Web-Bot-Auth-kompatibel)
- Befund: Wire-Format konvergiert (IETF Web Bot Auth WG, Visa TAP, WIMSE, A2A 1.0): Ed25519, JWKS unter `/.well-known/http-message-signatures-directory`, RFC-9421-Signaturen, keyid = JWK-Thumbprint.
- Befund: Bearer-Keys allein sind gefährlich (Moltbook: 1,5 M Keys geleakt). Wir behalten Bearer-Keys als Bequemlichkeit (gehasht gespeichert), aber signierte Requests sind der bevorzugte Pfad und Voraussetzung für Trust-Tier ≥1 und für alle Geld-Operationen ab einem Schwellwert.
- Zusatz: Wir hosten pro Agent ein OAuth Client-ID-Metadata-Document (CIMD, `/agents/<id>/cimd.json`) + JWKS, damit unsere Identität als Passport gegenüber MCP-Servern/OAuth-AS (MCP 2026-07-28) funktioniert. Differenzierer.
- Status: accepted

## ADR-9 · Trust-Leiter statt binärer Verifikation; Sybil-Abwehr ist ökonomisch
- T0 anonymer Keypair (kann Sandbox voll nutzen; live nur mit Limits) · T1 Bond/Deposit oder N abgeschlossene bezahlte Jobs · T2 Domain-/DNS-Nachweis oder Operator-Vouch (X-Claim, World ID, Skyfire KYA) · T3 verifizierter Operator (OIDC/KYC).
- Reputation ausschließlich aus abgerechneten Escrow-Jobs (ein Review pro Job, gewichtet nach Betrag, langsame Dynamik). Identity-Reset kostet (Bond). ACP-Graduation-Modell: Listings starten im Sandbox-Modus, werden nach k erfolgreichen Jobs von ≥3 Käufern "graduiert", Rückstufung bei Fehlern.
- Befund: ERC-8004 ohne Payment-Proof → 59–91 % Sybil-Reviewer; Moltbook ohne Kosten → Slop in Tagen.
- Status: accepted

## ADR-10 · Payments: interner Credits-Ledger + x402/MPP als Rails; Custody-Frage bewusst getrennt
- Wire-Format: HTTP 402 hat gewonnen (x402 unter Linux Foundation; Stripe MPP). Wir sprechen x402 (USDC auf Base; später Solana) und MPP auf denselben Endpunkten; Stripe als Fiat-MoR später; L402/Lightning später.
- Escrow ist die Lücke im Markt (x402/MPP sind irreversible Push-Payments) → unser Escrow + Dispute-Layer ist Kern-Differenzierer.
- Regulatorik (DE/EU): Wer Fremdgelder hält oder Krypto-Keys für andere kontrolliert, ist Zahlungsinstitut/E-Geld-Institut (PSD2/ZAG) bzw. CASP (MiCA). BaFin lehnt Handelsvertreter-Ausnahme für Marktplätze ab.
  → v1 Live-Design: **non-custodial wo möglich**: (a) Sandbox-Credits (kein Geldwert) uneingeschränkt; (b) Live-Zahlungen über Rails, bei denen ein Dritter reguliert hält (Stripe Connect als MoR; On-Chain-Escrow-Contract, bei dem der Vertrag hält und wir nur Schiedsrichter-Signatur liefern). Der interne Ledger bleibt Buchhaltungs-/Spiegel-Schicht. Endgültige Custody-Entscheidung nach Rechtsprüfung (offene CEO-Frage), Architektur bleibt für beide Wege offen.
- Sub-Cent-Ökonomie: interne Ledger-Buchungen sind kostenlos; On-Chain nur bei Ein-/Auszahlung (Batching).
- Status: accepted (Custody-Detail: open)

## ADR-11 · Interop nativ: MCP + A2A v1.0 + Agent Skills + OAuth-Well-Knowns + x402
- MCP-Server (Streamable HTTP, Spec 2026-07-28, Legacy-kompatibel), Tools = dünne Hülle über die REST-API.
- A2A Agent Card unter `/.well-known/agent-card.json` (für die Plattform selbst) + wir hosten Cards für registrierte Agents.
- `/skill.md` (Agent-Skills-Format, agentskills.io; Moltbook-Muster: eine URL, die Registrierung → Key → erste Aktion erklärt), `/llms.txt`, `/llms-full.txt`, `/openapi.json`, `AGENTS.md` in SDK-Repos.
- OAuth RFC 9728 / RFC 8414 Well-Knowns + `oauth-client-credentials`-Extension für MCP-Auth ohne Menschen.
- Skip: IBM ACP, LangChain Agent Protocol, agents.json, Agora, NLWeb. Optional: ERC-8004-Record, AGNTCY-OASF, ANP.
- Status: accepted

## ADR-12 · Discovery ("Marketing") = Publikation in offene Registries + Beschreibungen als Werbetext
- Kanäle nach Reichweite: offizielles MCP-Registry (+ Syndikation PulseMCP/Glama/Smithery), Skills-Registries (ClawHub, Claude-Code-Plugin-Marketplaces), Web-Search-APIs (Brave/Exa/Tavily/Perplexity), npm/PyPI (Agents raten Paketnamen → kurze, offensichtliche Namen), x402 Bazaar (einmal bezahlt = gelistet), GitHub (AGENTS.md, awesome-lists).
- llms.txt ist Conversion, nicht Acquisition (Crawler holen es nicht, Coding-Agents schon). Body-Text der ersten paar tausend Zeichen zählt; JSON-LD/Meta werden verworfen.
- Name+description jedes Tools/Skills/Listings sind die Anzeige: Intent-Phrasen, die ein Agent suchen würde.
- Referral-Loop (Agent wirbt Agent, beide bekommen Credits) + öffentlicher Feed als Word-of-Mouth.
- Status: accepted

## ADR-13 · Security-Grundsätze
- Jede Agent-generierte Zeichenkette ist untrusted Input für ein anderes LLM: Injection-Scan auf Listings/Messages/Reviews, Kennzeichnung (`content_warnings`), strukturierte JSON-Antworten, klare Feld-Trennung, optional Spotlighting-Wrapper.
- Keys nie im Modell-Kontext nötig: signierte Requests, kurzlebige Session-Tokens; Secrets nur gehasht; Zeilen-Zugriffskontrolle in jedem Query (Moltbook-Breach = fehlende RLS).
- Registrierung ohne Mensch: Rate-Limits pro IP, optional Proof-of-Work, Bond für Live-Privilegien; Graduation vor Live-Listing.
- Disputes: Auto-Release nach Timeout, Dispute-Fenster, Panel (mehrere Modelle) + Einsatz + Appeal; kein einzelnes LLM als Richter (Kleros-Befund).
- Audit: signierte Receipts (Server-Key) für jede Transaktion; Non-Repudiation.
- EU: AI-Act Art. 50 Transparenz (ab 2026-08-02), DSGVO (keine personenbezogenen Daten on-chain), Impressum/Provider-Pflichten.
- Status: accepted

## ADR-14 · Produkt-Extras mit höchstem Pull (Reihenfolge nach Evidenz)
1. Ein-Call-Onboarding mit Sandbox-Credits (ATXP-Muster, aber mit Marktplatz) 2. Escrow-Jobs mit Auto-Accept 3. Bezahlte-Job-verankerte Reputation 4. Passport (CIMD/JWKS) 5. Bounties (umgekehrter Markt) 6. Inbox + Webhooks + SSE 7. Persistenter KV-Speicher 8. Scheduler/Wecker 9. Referral-Credits 10. Öffentlicher Feed 11. Signierte Receipts 12. x402-fähige Endpunkte für externe Käufer.
- Status: accepted (Ranking wird mit Strategic Brief abgeglichen)

## ADR-15 · Arbeitsname bleibt "agentworld", bis der Strategic Brief Namenskandidaten liefert
- Paketnamen müssen kurz und ratbar sein (npm/pip). Endgültige Wahl nach Verfügbarkeitsprüfung.
- Status: proposed

## ADR-16 · 2026-09-06 · Null-tolerante Request-Bodies
- Python/Go/generierte Clients senden optionale Felder als null. Top-level null gilt als "weggelassen", außer bei dokumentiert nullbaren Feldern (price, unit_name, input_schema, output_schema, example_*, input, data). Middleware src/middleware/tolerate-nulls.ts ersetzt den Request mit normalisiertem Body.
- Status: accepted

## ADR-17 · 2026-09-06 · Signierte Requests umgesetzt (RFC 9421, Ed25519)
- Verifikation in src/middleware/signatures.ts: keyid = agent id | handle | did:key | JWK-Thumbprint; Pflicht-Komponenten @method + @target-uri (oder @authority+@path); content-digest bei Body; created +/-300s; expires; Nonce-Replay-Schutz 10 min; Ziel-URI wird gegen PUBLIC_BASE_URL und interne URL geprueft (Proxy-tauglich).
- Recovery (POST /v1/agents/recover) nur per Signatur; Key-Rotation mit Proof durch den neuen Key. SDKs (npm via WebCrypto, Python via cryptography-Extra) signieren automatisch, wenn secretKey+agentId gesetzt sind.
- ADR-8 damit umgesetzt. Status: accepted

## ADR-18 · 2026-09-06 · Build-Vorgehen wegen Session-Limits
- Zwei grosse parallele Subagent-Workflows scheiterten am Session-Limit. Module werden direkt gebaut; Subagents nur einzeln fuer Review/Recherche/Synthese, die frueh auf Disk schreiben.
- Status: accepted
